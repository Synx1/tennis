/**
 * Tennis whale scanner (Polymarket).
 *
 * Two jobs, no predicting:
 *   1. find tennis matches that are actually tradeable
 *   2. for each one, find the big wallets and report which player they backed
 *
 * Why Polymarket only: Kalshi lists tennis (KXATPMATCH / KXWTAMATCH, ~80 open
 * markets) but they are empty. Measured 2026-08-05: every open ATP match market
 * had volume 0 and open interest 0, and the busiest market's entire trade tape
 * was 23 trades with a median notional of $0.71 and a maximum of $17.51. There
 * are no whales to find. Kalshi's tape is also anonymous — trades carry size and
 * an is_block_trade flag but no counterparty — so even with volume you could
 * only ever say "something big happened", never who did it.
 *
 * Polymarket settles on-chain, so every trade carries a proxyWallet. That makes
 * it possible to say who bought what, and to look up that wallet's history.
 *
 * Endpoints (both public, no auth):
 *   GET gamma-api.polymarket.com/events?tag_slug=tennis&closed=false
 *   GET data-api.polymarket.com/trades?market=<conditionId>
 *   GET data-api.polymarket.com/positions?user=<wallet>
 */

const axios = require('axios');

const GAMMA = 'https://gamma-api.polymarket.com';
const PMDATA = 'https://data-api.polymarket.com';

// ── tuning ──────────────────────────────────────────

const CFG = {
  // A market needs this much volume before it's worth pulling the tape for
  MIN_MARKET_VOLUME: 1000,
  // Net USD on one player before a wallet counts as a whale
  WHALE_MIN_USD: 400,
  // Matches to scan per run, highest volume first. Each costs one request.
  MAX_MATCHES: 20,
  // Wallets to look up history for. Deduped across matches.
  MAX_GRADES: 12,
  // Trades pulled per market
  TRADE_LIMIT: 1000,
  // Both sides must sit inside this band, which drops settled markets and
  // longshot dust where "underdog" stops meaning anything
  MIN_PRICE: 0.02,
  MAX_PRICE: 0.98,
  // A wallet needs this much lifetime turnover before its ROI means anything
  GRADE_MIN_DEPLOYED: 5000
};

// ── throttle ────────────────────────────────────────

// Polymarket doesn't publish a hard public limit, so this stays deliberately
// gentle. A full scan is ~35 requests; at 150ms that's about 5 seconds.
const MIN_GAP_MS = 150;
let lastRequestAt = 0;
let queue = Promise.resolve();

const delay = ms => new Promise(r => setTimeout(r, ms));

function enqueue(fn) {
  const run = async () => {
    const since = Date.now() - lastRequestAt;
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since);
    lastRequestAt = Date.now();
    return fn();
  };
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function get(url, params, label) {
  try {
    const { data } = await enqueue(() => axios.get(url, { params, timeout: 25000 }));
    return data;
  } catch (e) {
    console.error(`[tennis] ${label}: ${e.response?.status || ''} ${e.message}`);
    return null;
  }
}

const arr = d => (Array.isArray(d) ? d : (d?.data || []));

// ── match discovery ─────────────────────────────────

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Is this a head-to-head match rather than a tournament outright?
 *
 * This filter matters more than it looks. The highest-volume tennis markets on
 * Polymarket are outrights like "Will Katie Boulter win the 2026 US Open?"
 * ($1.6M volume, priced at 0.15c). On those, every player is an underdog and
 * the flow is people selling longshots for yield, not conviction. Scanning them
 * produces pure noise, so they're excluded.
 */
function isHeadToHead(eventTitle, market) {
  if (!/\svs\.?\s/i.test(eventTitle || '')) return false;
  if (/winner|champion|will .* win the \d{4}/i.test(eventTitle)) return false;

  const outcomes = safeJson(market.outcomes, []);
  const prices = safeJson(market.outcomePrices, []).map(Number);
  if (outcomes.length !== 2 || prices.length !== 2) return false;
  if (prices.some(p => !isFinite(p))) return false;

  return prices.every(p => p > CFG.MIN_PRICE && p < CFG.MAX_PRICE);
}

/** All open head-to-head tennis matches with meaningful volume. */
async function findMatches({ minVolume = CFG.MIN_MARKET_VOLUME } = {}) {
  const events = [];

  // Gamma pages at 100. Three pages covers the open tennis board comfortably.
  for (let offset = 0; offset < 400; offset += 100) {
    const d = await get(`${GAMMA}/events`,
      { tag_slug: 'tennis', closed: false, limit: 100, offset }, `events@${offset}`);
    const batch = arr(d);
    if (!batch.length) break;
    events.push(...batch);
    if (batch.length < 100) break;
  }

  const matches = [];
  for (const e of events) {
    for (const m of (e.markets || [])) {
      if (!isHeadToHead(e.title, m)) continue;

      const outcomes = safeJson(m.outcomes, []);
      const prices = safeJson(m.outcomePrices, []).map(Number);
      const dogIdx = prices[0] < prices[1] ? 0 : 1;

      matches.push({
        event: e.title,
        question: m.question,
        slug: e.slug,
        conditionId: m.conditionId,
        volume: Number(m.volumeNum ?? m.volume ?? 0),
        liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
        startDate: e.startDate || m.startDate || null,
        endDate: m.endDate || null,
        underdog: outcomes[dogIdx],
        underdogPrice: prices[dogIdx],
        favourite: outcomes[1 - dogIdx],
        favouritePrice: prices[1 - dogIdx]
      });
    }
  }

  return matches
    .filter(m => m.volume >= minVolume)
    .sort((a, b) => b.volume - a.volume);
}

// ── whale detection ─────────────────────────────────

/**
 * Net each wallet's exposure on one match.
 *
 * Netting BUY against SELL is the whole trick. On raw trade size a wallet that
 * bought $5k and sold $5k back looks identical to one holding $5k, but only the
 * second is actually betting on anything.
 */
async function scanMatch(match, { whaleMin = CFG.WHALE_MIN_USD } = {}) {
  const d = await get(`${PMDATA}/trades`,
    { market: match.conditionId, limit: CFG.TRADE_LIMIT }, `trades ${match.conditionId?.slice(0, 10)}`);
  const raw = arr(d);

  if (!raw.length) {
    return { ...match, trades: 0, wallets: 0, whales: [], flow: null, truncated: false };
  }

  const trades = raw.map(t => ({
    wallet: t.proxyWallet,
    name: t.pseudonym || t.name || '',
    side: t.side,
    outcome: t.outcome,
    size: Number(t.size),
    price: Number(t.price),
    usd: Number(t.size) * Number(t.price),
    ts: Number(t.timestamp)
  })).filter(t => t.wallet && isFinite(t.usd));

  // Net position per wallet per player
  const byWallet = new Map();
  for (const t of trades) {
    const key = `${t.wallet}|${t.outcome}`;
    const cur = byWallet.get(key) || {
      wallet: t.wallet,
      name: t.name,
      player: t.outcome,
      netUsd: 0,
      buyUsd: 0,
      sellUsd: 0,
      buys: 0,
      sells: 0,
      firstTs: t.ts,
      lastTs: t.ts,
      prices: []
    };
    if (t.side === 'BUY') {
      cur.netUsd += t.usd; cur.buyUsd += t.usd; cur.buys++; cur.prices.push(t.price);
    } else {
      cur.netUsd -= t.usd; cur.sellUsd += t.usd; cur.sells++;
    }
    cur.firstTs = Math.min(cur.firstTs, t.ts);
    cur.lastTs = Math.max(cur.lastTs, t.ts);
    byWallet.set(key, cur);
  }

  const whales = [...byWallet.values()]
    .filter(w => w.netUsd >= whaleMin)
    .map(w => {
      const avgPrice = w.prices.length
        ? w.prices.reduce((a, b) => a + b, 0) / w.prices.length
        : null;
      return {
        ...w,
        avgPrice,
        // Underdog by where the market sits NOW
        onUnderdog: w.player === match.underdog,
        // Underdog by what they actually paid. These disagree whenever the
        // price has moved since they bought, which is common in-play — a wallet
        // can show as backing the favourite while having bought at 0.30.
        boughtAsUnderdog: avgPrice != null ? avgPrice < 0.5 : null,
        // Rough mark-to-market against the current price of their side
        priceNow: w.player === match.underdog
          ? match.underdogPrice
          : match.favouritePrice
      };
    })
    .map(w => ({
      ...w,
      // Positive = the market has moved their way since they bought
      edgeVsEntry: w.avgPrice != null ? w.priceNow - w.avgPrice : null
    }))
    .sort((a, b) => b.netUsd - a.netUsd);

  // Directional flow, so a match can be read at a glance
  const buyOn = p => trades
    .filter(t => t.outcome === p && t.side === 'BUY')
    .reduce((s, t) => s + t.usd, 0);

  const dogBuy = buyOn(match.underdog);
  const favBuy = buyOn(match.favourite);

  return {
    ...match,
    trades: trades.length,
    wallets: new Set(trades.map(t => t.wallet)).size,
    whales,
    flow: {
      underdogBuyUsd: dogBuy,
      favouriteBuyUsd: favBuy,
      // >1 means more money going to the underdog than the favourite
      ratio: favBuy > 0 ? dogBuy / favBuy : null
    },
    // The tape is capped, so on very busy markets this is a recent-window view
    truncated: raw.length >= CFG.TRADE_LIMIT
  };
}

// ── wallet history ──────────────────────────────────

/**
 * Look up a wallet's track record.
 *
 * Reported, never used to filter. A whale being profitable historically is
 * context, not proof the current bet is right — most of the tennis whales
 * measured during the probe were down on the year.
 */
async function gradeWallet(wallet) {
  const d = await get(`${PMDATA}/positions`, { user: wallet, limit: 500 }, `positions ${wallet.slice(0, 10)}`);
  const positions = arr(d);
  if (!positions.length) return { wallet, known: false };

  const deployed = positions.reduce((s, p) => s + Number(p.totalBought || 0), 0);
  const cashPnl = positions.reduce((s, p) => s + Number(p.cashPnl || 0), 0);
  const realizedPnl = positions.reduce((s, p) => s + Number(p.realizedPnl || 0), 0);
  const roi = deployed ? (cashPnl / deployed) * 100 : null;

  let grade;
  if (deployed < CFG.GRADE_MIN_DEPLOYED) grade = 'unproven';
  else if (roi >= 15) grade = 'sharp';
  else if (roi <= -15) grade = 'losing';
  else grade = 'flat';

  return {
    wallet,
    known: true,
    positions: positions.length,
    deployed,
    cashPnl,
    realizedPnl,
    roi,
    grade
  };
}

// ── orchestration ───────────────────────────────────

/**
 * Full scan: find matches, find whales, attach wallet history.
 *
 * @param {object} opts
 *   maxMatches  how many markets to pull tapes for (volume ranked)
 *   whaleMin    net USD threshold for a whale
 *   minVolume   market volume floor
 *   grade       whether to look up wallet histories
 *   underdogOnly only report whales sitting on the underdog
 */
async function scanAll({
  maxMatches = CFG.MAX_MATCHES,
  whaleMin = CFG.WHALE_MIN_USD,
  minVolume = CFG.MIN_MARKET_VOLUME,
  grade = true,
  underdogOnly = false
} = {}) {
  const started = Date.now();

  const all = await findMatches({ minVolume });
  const targets = all.slice(0, maxMatches);

  const scanned = [];
  for (const m of targets) {
    const r = await scanMatch(m, { whaleMin });
    if (underdogOnly) r.whales = r.whales.filter(w => w.onUnderdog);
    scanned.push(r);
  }

  // Grade the biggest whales, deduped across matches
  const grades = new Map();
  if (grade) {
    const ranked = scanned
      .flatMap(m => m.whales)
      .sort((a, b) => b.netUsd - a.netUsd);

    for (const w of ranked) {
      if (grades.size >= CFG.MAX_GRADES) break;
      if (grades.has(w.wallet)) continue;
      grades.set(w.wallet, await gradeWallet(w.wallet));
    }

    for (const m of scanned) {
      for (const w of m.whales) w.history = grades.get(w.wallet) || null;
    }
  }

  const withWhales = scanned.filter(m => m.whales.length);

  return {
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    matchesFound: all.length,
    matchesScanned: scanned.length,
    matchesWithWhales: withWhales.length,
    whaleCount: scanned.reduce((s, m) => s + m.whales.length, 0),
    uniqueWhales: new Set(scanned.flatMap(m => m.whales.map(w => w.wallet))).size,
    thresholds: { whaleMin, minVolume, maxMatches },
    matches: scanned,
    withWhales
  };
}

module.exports = {
  CFG,
  findMatches,
  scanMatch,
  gradeWallet,
  scanAll
};
