/**
 * Kalshi REST client. Public market-data endpoints only — no auth needed.
 *
 * Everything goes through a single serialised queue with a minimum gap between
 * requests, plus backoff-and-retry on 429. Without this the bot fell over:
 * the BTC poll, the 5-minute starter check, the settle pass and any backtest
 * all fired independently and Kalshi started rejecting every request, which
 * showed up as BTC silently never posting.
 */

const axios = require('axios');
const { KALSHI_API_BASE } = require('./config');

const api = axios.create({
  baseURL: KALSHI_API_BASE,
  timeout: 25000,
  headers: { Accept: 'application/json' }
});

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── throttle ────────────────────────────────────────

// Minimum spacing between requests. Deliberately conservative: market data is
// never so urgent that it's worth being throttled into uselessness.
const MIN_GAP_MS = 260;
const MAX_RETRIES = 4;

let queue = Promise.resolve();
let lastRequestAt = 0;
let cooldownUntil = 0;      // set when Kalshi asks us to back off

/** Serialise every call and keep a floor on the gap between them. */
function enqueue(fn) {
  const run = async () => {
    // Honour any active cooldown from a previous 429
    const now = Date.now();
    if (cooldownUntil > now) await delay(cooldownUntil - now);

    const since = Date.now() - lastRequestAt;
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since);

    lastRequestAt = Date.now();
    return fn();
  };

  // Chain onto the queue but don't let one failure poison the rest
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * GET with throttling and retry. Handles 429 by respecting Retry-After when
 * present, otherwise backing off exponentially.
 */
async function get(path, params = undefined, label = path) {
  let attempt = 0;

  while (true) {
    try {
      return await enqueue(() => api.get(path, params ? { params } : undefined));
    } catch (err) {
      const status = err.response?.status;

      // Rate limited — back off and try again
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseFloat(err.response?.headers?.['retry-after']);
        const waitMs = !isNaN(retryAfter)
          ? Math.min(retryAfter * 1000, 30000)
          : Math.min(1200 * Math.pow(2, attempt), 20000);

        // Make every queued caller wait too, not just this one
        cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
        attempt++;
        if (attempt === 1) {
          console.warn(`[kalshi] rate limited on ${label} — backing off ${Math.round(waitMs)}ms`);
        }
        await delay(waitMs);
        continue;
      }

      // Transient server-side problems are worth one or two retries
      if ((status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') &&
          attempt < 2) {
        attempt++;
        await delay(700 * attempt);
        continue;
      }

      throw err;
    }
  }
}

// ── endpoints ───────────────────────────────────────

/** All open markets for a series, following pagination. */
async function getOpenMarkets(seriesTicker) {
  const out = [];
  let cursor = null;
  try {
    do {
      const params = { series_ticker: seriesTicker, status: 'open', limit: 200 };
      if (cursor) params.cursor = cursor;
      const { data } = await get('/markets', params, `open ${seriesTicker}`);
      out.push(...(data.markets || []));
      cursor = data.cursor || null;
    } while (cursor);
  } catch (e) {
    console.error(`[kalshi] open markets ${seriesTicker}: ${e.message}`);
  }
  return out;
}

async function getSettledMarkets(seriesTicker, limit = 200) {
  const out = [];
  let cursor = null;
  try {
    do {
      const params = { series_ticker: seriesTicker, status: 'settled', limit: 200 };
      if (cursor) params.cursor = cursor;
      const { data } = await get('/markets', params, `settled ${seriesTicker}`);
      const batch = data.markets || [];
      out.push(...batch);
      cursor = data.cursor || null;
      if (!batch.length) break;
    } while (cursor && out.length < limit);
  } catch (e) {
    console.error(`[kalshi] settled ${seriesTicker}: ${e.message}`);
  }
  return out.slice(0, limit);
}

async function getMarket(ticker) {
  try {
    const { data } = await get(`/markets/${ticker}`, undefined, `market ${ticker}`);
    return data.market || data;
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error(`[kalshi] market ${ticker}: ${e.message}`);
    }
    return null;
  }
}

/**
 * The single currently-open BTC 15m market.
 *
 * Cached briefly: the poll runs every 45 seconds but the market only rolls over
 * every 15 minutes, so most of those calls were asking the same question.
 */
let btcCache = { at: 0, ticker: null, market: null };
const BTC_CACHE_MS = 20000;

async function getOpenBtcMarket(series = 'KXBTC15M') {
  const now = Date.now();
  if (btcCache.market && now - btcCache.at < BTC_CACHE_MS) {
    // Don't serve a cached market that has already closed
    const close = new Date(btcCache.market.close_time).getTime();
    if (close > now) return btcCache.market;
  }

  try {
    const { data } = await get('/markets',
      { series_ticker: series, status: 'open', limit: 1 }, 'btc market');
    const m = (data.markets || [])[0] || null;
    btcCache = { at: now, ticker: m?.ticker || null, market: m };
    return m;
  } catch (e) {
    console.error(`[kalshi] btc market: ${e.message}`);
    // Fall back to a slightly stale market rather than losing the round
    if (btcCache.market && new Date(btcCache.market.close_time).getTime() > now) {
      return btcCache.market;
    }
    return null;
  }
}

/**
 * Per-minute quote history for one market.
 *
 * This is what makes an honest backtest possible without waiting for live
 * rounds: it returns yes_bid and yes_ask at 1-minute granularity across the
 * round, so the book as it stood N minutes before close is the real one rather
 * than a reconstruction from the last trade.
 *
 * Keyed by MINUTES LEFT rather than by timestamp, because that is what every
 * caller actually wants and computing it in two places invites off-by-one
 * disagreements between the collector and the analyser.
 *
 * @param {string} series   e.g. 'KXBTC15M'
 * @param {string} ticker   full market ticker
 * @param {number} closeSec close time, unix seconds
 * @returns {Promise<Object<number, {bid:number, ask:number, mid:number,
 *          price:number|null, volume:number|null, oi:number|null}>|null>}
 */
async function getCandlesticks(series, ticker, closeSec, windowMin = 15) {
  const num = v => {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  };

  try {
    const { data } = await get(
      `/series/${series}/markets/${ticker}/candlesticks`,
      {
        start_ts: closeSec - windowMin * 60 - 120,
        end_ts: closeSec + 60,
        period_interval: 1
      },
      `candlesticks ${ticker}`);

    const rows = data?.candlesticks || [];
    const byMinutesLeft = {};
    for (const r of rows) {
      const ts = Number(r.end_period_ts);
      if (!isFinite(ts)) continue;
      const left = Math.round((closeSec - ts) / 60);
      if (left < 0 || left > windowMin) continue;

      const bid = num(r.yes_bid?.close_dollars);
      const ask = num(r.yes_ask?.close_dollars);
      if (bid == null || ask == null) continue;

      byMinutesLeft[left] = {
        bid, ask,
        mid: (bid + ask) / 2,
        price: num(r.price?.close_dollars),
        volume: num(r.volume_fp),
        oi: num(r.open_interest_fp)
      };
    }
    return byMinutesLeft;
  } catch (e) {
    return null;
  }
}

module.exports = {
  api,
  get,
  delay,
  getOpenMarkets,
  getSettledMarkets,
  getMarket,
  getOpenBtcMarket,
  getCandlesticks
};
