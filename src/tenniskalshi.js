/**
 * Match history for players BELOW tour level, built from Kalshi's settled markets.
 *
 * ── why this exists ──
 *
 * tennis-data.co.uk covers ATP and WTA tour level only. Kalshi's tennis board is
 * mostly ITF and Challenger — measured 2026-08-09, 238 of 254 open markets — so the
 * players actually on screen are usually absent from that history. Asking for
 * Mochizuki vs Dellavedova returned nothing, correctly, and that is useless.
 *
 * The obvious fix was Jeff Sackmann's tennis_atp / tennis_wta repos, which publish
 * futures and qualifying/challenger match files with set scores AND serve stats.
 * They are GONE: raw.githubusercontent.com returns 404 for every file on both
 * master and main, and users/JeffSackmann/repos now lists only
 * tennis_MatchChartingProject. The surviving forks are stale — stakah/tennis_atp,
 * the only exact-name mirror, last committed in 2018 and has no post-2019 futures.
 * Every ITF-capable feed that still works is commercial: Sportradar, matchstat,
 * livetennisapi, Apify.
 *
 * What is left, and already reachable with no new credentials, is Kalshi itself.
 * A settled market IS a played match with a declared winner.
 *
 * ── what this can and cannot say ──
 *
 * CAN: win/loss, recent form, streaks, head-to-head, how deep into draws a player
 *      goes, and the level they play at (W15 against W100 against Challenger).
 *
 * CANNOT: anything set-level. There is no score on a settled market — checked every
 *      field on both sides of an event and on the event itself; `expiration_value`
 *      carries the winner's NAME and nothing more. So "set 3 after losing set 2",
 *      the whole point of the tour-level table, is not derivable here and is not
 *      faked. No surface either, and no serve statistics.
 *
 * Depth is short and Kalshi prunes: ITF women reached back 32 days, ATP 76, at the
 * deepest pagination allowed. That is why this persists to disk and merges on every
 * refresh — the store grows past what the API will still return, and a record that
 * only ever spans five weeks is not worth much.
 *
 * ── one thing that gets easier ──
 *
 * Names here are Kalshi's own on both sides, so a fixture matches its history by
 * exact string. None of the surname-and-initial reconstruction the tour-level path
 * needs applies, and none of its failure modes either.
 */

const fs = require('fs');
const path = require('path');
const kalshi = require('./kalshi');
const { DATA_DIR } = require('./config');

const STORE = path.join(DATA_DIR, 'tennis-kalshi.json');

/** Series to harvest, with the label to show for each. */
const SERIES = [
  { ticker: 'KXATPMATCH', level: 'ATP', tour: 'atp' },
  { ticker: 'KXWTAMATCH', level: 'WTA', tour: 'wta' },
  { ticker: 'KXATPCHALLENGERMATCH', level: 'Challenger', tour: 'atp' },
  { ticker: 'KXITFMATCH', level: 'ITF M', tour: 'atp' },
  { ticker: 'KXITFWMATCH', level: 'ITF W', tour: 'wta' }
];

/** How many settled markets to request per series per refresh. Two per match. */
const FETCH_LIMIT = 6000;

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

/** Match date from the event ticker, e.g. KXITFWMATCH-26AUG08VANGOR -> 2026-08-08. */
function dateFromTicker(eventTicker) {
  const m = String(eventTicker || '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || !(m[2] in MONTHS)) return null;
  return new Date(Date.UTC(2000 + Number(m[1]), MONTHS[m[2]], Number(m[3])));
}

/**
 * Tournament and round from a settled title.
 *
 * "Will Hanne Vandewinkel win the Vandewinkel vs Gorgodze: W100 Landisville PA
 * Semifinal match?" -> tournament "W100 Landisville PA", round "Semifinal".
 *
 * Identical in shape to the open-market titles, so the same anchoring rule applies:
 * the round is the TRAILING part and the tournament is whatever precedes it.
 */
const ROUND_RE = new RegExp(
  '(' + [
    'Round\\s*Of\\s*\\d+', 'Round\\s*\\d+', 'R\\d+',
    'Qualifying\\s+(?:Final|Round\\s*\\d+|\\d+)',
    'Quarterfinals?', 'Quarter\\s*Final', 'QF',
    'Semifinals?', 'Semi\\s*Final', 'SF',
    'Final'
  ].join('|') + ')\\s*$', 'i');

function detailFrom(title) {
  const m = String(title || '').match(/:\s*([^?]+?)\s+match\?/i);
  if (!m) return { tournament: null, round: null };
  const detail = m[1].trim();
  const r = detail.match(ROUND_RE);
  if (!r) return { tournament: detail || null, round: null };
  return {
    tournament: detail.slice(0, r.index).trim() || null,
    round: r[1].trim()
  };
}

/**
 * Collapse settled markets into one record per match.
 *
 * `expiration_value` holds the winner's name and appears on BOTH markets of an
 * event, so the winner is read from it directly rather than by locating the side
 * whose `result` is 'yes'. That tolerates an event where only one side came back.
 */
function toMatches(markets, level, tour) {
  const byEvent = new Map();
  for (const m of markets) {
    if (!m.event_ticker) continue;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
    byEvent.get(m.event_ticker).push(m);
  }

  const out = [];
  for (const [ev, ms] of byEvent) {
    const winner = String(ms.find(m => m.expiration_value)?.expiration_value || '').trim();
    if (!winner) continue;

    // Both players are the two distinct yes_sub_titles on the event.
    const names = [...new Set(ms.map(m => String(m.yes_sub_title || '').trim()).filter(Boolean))];
    const loser = names.find(n => n !== winner);
    // A voided or mis-shaped event cannot name both sides; skip rather than guess.
    if (!loser || !names.includes(winner)) continue;

    const { tournament, round } = detailFrom(ms[0].title);
    const date = dateFromTicker(ev);

    out.push({
      eventTicker: ev,
      date: date ? date.toISOString().slice(0, 10) : null,
      winner,
      loser,
      level,
      tour,
      tournament,
      round,
      // Settlement time is the only precise timestamp; the ticker gives only a day.
      settledAt: ms[0].settlement_ts || null
    });
  }
  return out;
}

// ── persistence ─────────────────────────────────────
//
// Kalshi prunes settled markets, so the API alone cannot build depth. Every refresh
// merges into the file and keeps whatever the API has stopped returning.

function readStore() {
  try {
    if (!fs.existsSync(STORE)) return { updatedAt: null, matches: [] };
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return {
      updatedAt: j.updatedAt || null,
      matches: Array.isArray(j.matches) ? j.matches : []
    };
  } catch (e) {
    console.error(`[tenniskalshi] store unreadable, starting empty: ${e.message}`);
    return { updatedAt: null, matches: [] };
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store));
    return true;
  } catch (e) {
    console.error(`[tenniskalshi] could not write store: ${e.message}`);
    return false;
  }
}

/**
 * Fetch every series' settled markets and merge into the store.
 *
 * Deduped on eventTicker, with the freshly fetched copy winning so a corrected
 * settlement replaces an earlier read.
 */
async function refresh({ log = () => {} } = {}) {
  const store = readStore();
  const before = store.matches.length;
  const merged = new Map(store.matches.map(m => [m.eventTicker, m]));

  for (const s of SERIES) {
    let markets = [];
    try {
      markets = await kalshi.getSettledMarkets(s.ticker, FETCH_LIMIT);
    } catch (e) {
      log(`[tenniskalshi] ${s.ticker}: ${e.message}`);
      continue;
    }
    const found = toMatches(markets, s.level, s.tour);
    for (const m of found) merged.set(m.eventTicker, m);
    log(`[tenniskalshi] ${s.ticker}: ${markets.length} markets -> ${found.length} matches`);
  }

  const next = {
    updatedAt: new Date().toISOString(),
    matches: [...merged.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  };
  writeStore(next);
  log(`[tenniskalshi] store ${before} -> ${next.matches.length} matches`);
  return next;
}

/** The store as it stands, without touching the network. */
function load() {
  return readStore();
}

// ── queries ─────────────────────────────────────────

/** Case-insensitive exact name match. Kalshi is self-consistent, so this suffices. */
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Every distinct player in the store. */
function players(store) {
  const s = new Set();
  for (const m of store.matches) { s.add(m.winner); s.add(m.loser); }
  return [...s];
}

/**
 * Resolve a query to player names present in the store.
 *
 * Exact first. A surname-only query is allowed to match on the LAST token, because
 * Kalshi writes forename-first full names and "Dellavedova" is a reasonable thing to
 * type. Several hits are returned rather than one being chosen.
 */
function resolve(store, query) {
  const q = norm(query);
  if (!q) return [];
  const all = players(store);

  const exact = all.filter(n => norm(n) === q);
  if (exact.length) return exact;

  const bySurname = all.filter(n => norm(n).split(' ').pop() === q);
  if (bySurname.length) return bySurname;

  // Every token of the query present in the name, so "yuki mochizuki" still lands.
  const words = q.split(' ');
  const byWords = all.filter(n => {
    const parts = norm(n).split(' ');
    return words.every(w => parts.includes(w));
  });
  if (byWords.length) return byWords;

  return all.filter(n => norm(n).includes(q));
}

/**
 * One player's record, newest first.
 *
 * Shaped deliberately unlike the tour-level profile: there is no set data here, so
 * offering the same fields would imply evidence that does not exist.
 */
function recordFor(store, player) {
  const p = norm(player);
  const played = store.matches
    .filter(m => norm(m.winner) === p || norm(m.loser) === p)
    .map(m => ({
      ...m,
      won: norm(m.winner) === p,
      opponent: norm(m.winner) === p ? m.loser : m.winner
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const wins = played.filter(m => m.won).length;

  // Current run, from the most recent match backwards.
  let streak = { type: null, n: 0 };
  if (played.length) {
    const type = played[0].won ? 'W' : 'L';
    let n = 0;
    for (const m of played) { if ((m.won ? 'W' : 'L') !== type) break; n++; }
    streak = { type, n };
  }

  const byLevel = {};
  for (const m of played) {
    const k = m.level || 'unknown';
    byLevel[k] = byLevel[k] || { w: 0, n: 0 };
    byLevel[k].n++;
    if (m.won) byLevel[k].w++;
  }

  const last5 = played.slice(0, 5);

  return {
    player,
    n: played.length,
    wins,
    losses: played.length - wins,
    pct: played.length ? wins / played.length : null,
    streak,
    byLevel,
    last5,
    matches: played,
    // Deepest round reached, as a crude ceiling on how far they go in draws.
    rounds: [...new Set(played.map(m => m.round).filter(Boolean))]
  };
}

/** Head-to-head between two players in the store. */
function headToHead(store, a, b) {
  const x = norm(a), y = norm(b);
  const met = store.matches.filter(m => {
    const w = norm(m.winner), l = norm(m.loser);
    return (w === x && l === y) || (w === y && l === x);
  }).sort((p, q) => String(q.date).localeCompare(String(p.date)));

  return {
    n: met.length,
    aWins: met.filter(m => norm(m.winner) === x).length,
    bWins: met.filter(m => norm(m.winner) === y).length,
    matches: met
  };
}

/** Coverage summary, for telling a user what the store actually holds. */
function summary(store) {
  const dates = store.matches.map(m => m.date).filter(Boolean).sort();
  const byLevel = {};
  for (const m of store.matches) byLevel[m.level] = (byLevel[m.level] || 0) + 1;
  return {
    matches: store.matches.length,
    players: players(store).length,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    byLevel,
    updatedAt: store.updatedAt
  };
}

module.exports = {
  refresh, load, players, resolve, recordFor, headToHead, summary,
  toMatches, detailFrom, dateFromTicker,
  SERIES, STORE
};
