/**
 * Match history for ANY level, from api-tennis.com.
 *
 * ── why this exists ──
 *
 * tennis-data.co.uk covers ATP and WTA tour level only, and Kalshi's tennis board is
 * mostly ITF and Challenger — 238 of 254 open markets, measured 2026-08-09. So the
 * players actually on screen were usually absent from the history, and /matches
 * could list a live match it could say nothing about.
 *
 * Jeff Sackmann's tennis_atp / tennis_wta repos would have covered it and are GONE:
 * every raw file 404s on both master and main, users/JeffSackmann/repos now lists
 * only tennis_MatchChartingProject, and the sole exact-name mirror
 * (stakah/tennis_atp) last committed in 2018 with no post-2019 futures. Kalshi's own
 * settled markets name a winner but carry no score, so they cannot support any
 * set-level statistic.
 *
 * api-tennis.com does. Verified against this key on 2026-08-09:
 *   27 event types, including Itf Men Singles, Itf Women Singles, Challenger Men
 *   Singles and Challenger Women Singles.
 *   Every fixture carries a `scores` array of per-set games.
 *   M. Dellavedova alone returned 96 matches for 2026, 82 for 2025 and 104 for 2024,
 *   all with set scores.
 *
 * ── what it can and cannot say ──
 *
 * CAN: everything the tour-level table shows except surface. Set-by-set records and
 *      the conditional records that matter ("set 3 after losing set 2") come straight
 *      out of `scores`, so ITF players get the same analysis rather than a reduced
 *      one. Per-season rank, win/loss and surface splits come from get_players.
 *      Head-to-head comes from get_H2H.
 *
 * CANNOT: per-match surface. Fixtures do not carry it, so surface-filtered figures
 *      are not offered here and the absence is reported rather than guessed. Serve
 *      statistics are also thin below tour level: the `statistics` array came back
 *      EMPTY for every ITF fixture checked, even though `pointbypoint` was populated
 *      with 15-23 games. So aces and first-serve percentage are not claimed.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./config');

const HOST = 'api.api-tennis.com';
const CACHE_DIR = path.join(DATA_DIR, 'tennis-api');

const KEY = () => (process.env.API_TENNIS_KEY || '').trim();

/** Is this source usable at all? Callers fall back to tour-level history when not. */
const available = () => KEY().length > 0;

// ── throttle ────────────────────────────────────────
//
// A paid plan has a request budget, and a /compare can touch several seasons for two
// players. Everything is serialised behind one queue with a floor on the gap, and
// results are cached to disk, so repeated commands cost nothing.

const MIN_GAP_MS = 250;
let queue = Promise.resolve();
let lastAt = 0;

const delay = ms => new Promise(r => setTimeout(r, ms));

function enqueue(fn) {
  const run = async () => {
    const since = Date.now() - lastAt;
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since);
    lastAt = Date.now();
    return fn();
  };
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'node' } }, r => {
      let b = '';
      r.on('data', d => { b += d; });
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`HTTP ${r.statusCode}`));
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error(`bad JSON: ${b.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * One API call. The key is injected here and never logged.
 *
 * `success` is checked because the API answers 200 with `success: 0` for a bad key
 * or an out-of-plan request, and treating that as data yields silent empty results.
 */
async function call(method, params = {}, { retries = 2 } = {}) {
  if (!available()) throw new Error('API_TENNIS_KEY is not set');

  const q = new URLSearchParams({ method, APIkey: KEY() });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const url = `https://${HOST}/tennis/?${q}`;

  let attempt = 0;
  while (true) {
    try {
      const d = await enqueue(() => rawGet(url));
      if (!d || d.success !== 1) {
        // Never include the URL: it carries the key.
        throw new Error(`${method} returned success=${d && d.success}`);
      }
      return d.result;
    } catch (e) {
      if (attempt++ >= retries) throw new Error(`${method}: ${e.message}`);
      await delay(600 * attempt);
    }
  }
}

// ── disk cache ──────────────────────────────────────

function cacheRead(name, ttlMs) {
  try {
    const f = path.join(CACHE_DIR, name);
    if (!fs.existsSync(f)) return null;
    if (ttlMs != null && Date.now() - fs.statSync(f).mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { return null; }
}

function cacheWrite(name, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const f = path.join(CACHE_DIR, name);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value));
    fs.renameSync(`${f}.tmp`, f);
  } catch (e) {
    console.error(`[tennisapi] cache write ${name}: ${e.message}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;

// ── event types ─────────────────────────────────────

/** Event types in this plan, cached for a day. */
async function eventTypes() {
  const hit = cacheRead('event-types.json', 7 * DAY);
  if (hit) return hit;
  const list = await call('get_events');
  cacheWrite('event-types.json', list);
  return list;
}

/**
 * Singles event-type keys relevant to one tour.
 *
 * Doubles is excluded deliberately: a doubles result says nothing about a singles
 * matchup, and `event_first_player` there is a pair ("Cervantes Tomas/ Ferrer
 * Adria"), which would corrupt both name resolution and any win/loss record.
 */
async function singlesTypeKeys(tour) {
  const types = await eventTypes();
  const wantWomen = tour === 'wta';
  return types
    .filter(t => {
      const n = String(t.event_type_type || '');
      if (!/singles/i.test(n)) return false;
      if (/doubles/i.test(n)) return false;
      const isWomen = /women|wta|girls/i.test(n);
      return wantWomen ? isWomen : !isWomen;
    })
    .map(t => String(t.event_type_key));
}

// ── name matching ───────────────────────────────────
//
// api-tennis writes "M. Dellavedova" — initial FIRST, then surname. Kalshi writes
// "Matthew Dellavedova". So the join is the forename initial plus the surname, the
// same rule the tour-level path uses, with the components in the other order.

const clean = s => String(s || '').toLowerCase().replace(/[^a-z\s.]/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** { initial, surname } from an api-tennis name like "M. Dellavedova". */
function parseApiName(name) {
  const c = clean(name).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const parts = c.split(' ').filter(Boolean);
  if (!parts.length) return { initial: null, surname: '' };
  if (parts.length === 1) return { initial: null, surname: parts[0] };
  return { initial: parts[0][0], surname: parts.slice(1).join(' ') };
}

/** { initial, surname } from a Kalshi name like "Matthew Dellavedova". */
function parseFullName(name) {
  const parts = clean(name).replace(/\./g, ' ').split(' ').filter(Boolean);
  if (!parts.length) return { initial: null, surname: '' };
  if (parts.length === 1) return { initial: null, surname: parts[0] };
  return { initial: parts[0][0], surname: parts.slice(1).join(' ') };
}

/**
 * Does an api-tennis name refer to the same player as this full name?
 *
 * Surname must match exactly. The initial must match when both sides have one —
 * requiring it is what stops "J. Zhang" being accepted for "Ying Zhang" when the
 * board also holds a Junhan Zhang.
 *
 * A trailing-token fallback handles particled surnames, where api-tennis may keep
 * only the last word ("B. Van De Zandschulp" against "Van de Zandschulp").
 */
function namesMatch(apiName, fullName) {
  const a = parseApiName(apiName);
  const f = parseFullName(fullName);
  if (!a.surname || !f.surname) return false;
  if (a.initial && f.initial && a.initial !== f.initial) return false;

  if (a.surname === f.surname) return true;
  const at = a.surname.split(' ').pop();
  const ft = f.surname.split(' ').pop();
  return at === ft && at.length > 2;
}

// ── fixtures ────────────────────────────────────────

async function fixtures(params) {
  const r = await call('get_fixtures', params);
  return Array.isArray(r) ? r : [];
}

const iso = d => new Date(d).toISOString().slice(0, 10);

/**
 * Find a player's api-tennis key from a full name.
 *
 * There is no player-search endpoint, so the lookup goes through fixtures around a
 * date the player is known to be active — which, coming from a Kalshi fixture, is
 * always today. Resolved keys are cached by name so this is paid for once.
 *
 * @param {string} fullName  as Kalshi writes it, e.g. "Matthew Dellavedova"
 * @param {object} opts
 *   tour    'atp' | 'wta', to restrict to the right singles event types
 *   around  Date to search near (default: now)
 *   windowDays  how many days either side
 */
async function findPlayerKey(fullName, { tour = 'atp', around = new Date(), windowDays = 3 } = {}) {
  const cacheFile = 'player-keys.json';
  const keyName = `${tour}|${clean(fullName)}`;
  const cache = cacheRead(cacheFile, 30 * DAY) || {};
  if (cache[keyName]) return cache[keyName];

  const from = new Date(around.getTime() - windowDays * DAY);
  const to = new Date(around.getTime() + windowDays * DAY);
  const typeKeys = await singlesTypeKeys(tour);

  for (const tk of typeKeys) {
    let rows = [];
    try {
      rows = await fixtures({
        date_start: iso(from), date_stop: iso(to), event_type_key: tk
      });
    } catch (_) { continue; }

    for (const r of rows) {
      if (namesMatch(r.event_first_player, fullName)) {
        const found = { key: String(r.first_player_key), apiName: r.event_first_player };
        cache[keyName] = found; cacheWrite(cacheFile, cache);
        return found;
      }
      if (namesMatch(r.event_second_player, fullName)) {
        const found = { key: String(r.second_player_key), apiName: r.event_second_player };
        cache[keyName] = found; cacheWrite(cacheFile, cache);
        return found;
      }
    }
  }
  return null;
}

// ── normalisation ───────────────────────────────────

/** Round, with the tournament prefix api-tennis repeats stripped off. */
function roundOf(fixture) {
  const r = String(fixture.tournament_round || '').trim();
  if (!r) return '';
  const dash = r.lastIndexOf(' - ');
  return dash >= 0 ? r.slice(dash + 3).trim() : r;
}

/**
 * One api-tennis fixture into the shape src/tennisstats.js already consumes.
 *
 * Matching that shape exactly is the point: it means an ITF player runs through the
 * same profile(), the same conditional statistics and the same predictor as a tour
 * player, with no parallel implementation to drift out of agreement.
 *
 * Sets are stored winner-first, which is the convention perspective() relies on.
 * Unfinished matches return null — a live scoreline is not a result.
 */
function normalise(fixture, tour) {
  const winnerSide = String(fixture.event_winner || '');
  const firstWon = /first/i.test(winnerSide);
  const secondWon = /second/i.test(winnerSide);
  if (!firstWon && !secondWon) return null;

  const first = String(fixture.event_first_player || '').trim();
  const second = String(fixture.event_second_player || '').trim();
  if (!first || !second) return null;
  // Doubles slipped through some event types; a pair is not a player.
  if (first.includes('/') || second.includes('/')) return null;

  const winner = firstWon ? first : second;
  const loser = firstWon ? second : first;

  const sets = [];
  for (const s of (fixture.scores || [])) {
    let a = Number(s.score_first), b = Number(s.score_second);
    if (!isFinite(a) || !isFinite(b)) continue;

    /**
     * Drop 0-0 padding.
     *
     * api-tennis pads `scores` out to FIVE entries with 0-0 placeholders on older
     * seasons — 2025 returned five entries for 71 of 79 matches while 2026 returned
     * only the sets actually played. Taking them at face value invented sets: it put
     * decidersPlayed at 192 of 366 for a best-of-3 ITF player whose real rate is
     * 16 of 95, and dragged "set 3 win %" to 30% when a decider IS the match and the
     * figure has to sit near 50%. A played set cannot be 0-0, so this is unambiguous.
     *
     * A walkover or cancellation is all-zero and correctly ends up with no sets at
     * all: it still counts for win/loss, and `completed` keeps it out of every
     * set-level statistic.
     */
    if (a === 0 && b === 0) continue;

    /**
     * Tiebreak sets arrive as decimals — "7.8-6.6" is 7-6 with the breaker at 8-6,
     * and "6.3-7.7" is 6-7. The fractional part is the tiebreak score, not games.
     * Truncating keeps the games honest; who won the set is unaffected either way,
     * but a 7.8 shown to a user is just wrong.
     */
    a = Math.trunc(a);
    b = Math.trunc(b);

    sets.push(firstWon ? [a, b] : [b, a]);
  }

  const status = String(fixture.event_status || '').trim();
  const completed = /^finished$/i.test(status);
  const date = fixture.event_date ? new Date(`${fixture.event_date}T00:00:00Z`) : null;

  return {
    tour,
    year: date ? date.getUTCFullYear() : null,
    date,
    tournament: String(fixture.tournament_name || '').trim(),
    location: '',
    series: String(fixture.event_type_type || '').trim(),
    // Not published per fixture. Left empty so a surface filter matches nothing
    // rather than silently matching everything.
    surface: '',
    court: '',
    round: roundOf(fixture),
    bestOf: 3,
    winner,
    loser,
    winnerRank: null,
    loserRank: null,
    sets,
    setsWon: sets.filter(([w, l]) => w > l).length,
    setsLost: sets.filter(([w, l]) => l > w).length,
    completed,
    comment: status,
    oddsWinner: null,
    oddsLoser: null,
    source: 'api-tennis',
    eventKey: String(fixture.event_key || '')
  };
}

/**
 * Every normalised match for a player across a span of seasons.
 *
 * Cached per player-season. A finished season never changes, so only the current one
 * carries a TTL.
 */
async function playerMatches(playerKey, { fromYear, toYear, tour = 'atp', log = () => {} } = {}) {
  const nowYear = new Date().getUTCFullYear();
  const out = [];

  for (let y = fromYear; y <= toYear; y++) {
    const file = `matches-${tour}-${playerKey}-${y}.json`;
    const ttl = y < nowYear ? null : 6 * 60 * 60 * 1000;
    let rows = cacheRead(file, ttl);

    if (!rows) {
      try {
        const raw = await fixtures({
          date_start: `${y}-01-01`, date_stop: `${y}-12-31`, player_key: playerKey
        });
        rows = raw.map(f => normalise(f, tour)).filter(Boolean);
        cacheWrite(file, rows);
        log(`[tennisapi] ${playerKey} ${y}: ${raw.length} fixtures -> ${rows.length} results`);
      } catch (e) {
        log(`[tennisapi] ${playerKey} ${y}: ${e.message}`);
        rows = [];
      }
    }
    out.push(...rows.map(m => ({ ...m, date: m.date ? new Date(m.date) : null })));
  }

  return out.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
}

/** Per-season rank, win/loss and surface splits. This is where surface lives. */
async function playerProfile(playerKey) {
  const file = `profile-${playerKey}.json`;
  const hit = cacheRead(file, DAY);
  if (hit) return hit;

  const r = await call('get_players', { player_key: playerKey });
  const p = (Array.isArray(r) ? r : [])[0] || null;
  if (p) cacheWrite(file, p);
  return p;
}

/** Head-to-head plus each player's recent results, straight from the API. */
async function headToHead(keyA, keyB) {
  const r = await call('get_H2H', { first_player_key: keyA, second_player_key: keyB });
  return {
    meetings: (r && r.H2H) || [],
    firstRecent: (r && r.firstPlayerResults) || [],
    secondRecent: (r && r.secondPlayerResults) || []
  };
}

/**
 * Singles season rows only, newest first.
 *
 * Doubles rows are excluded because a doubles ranking says nothing about a singles
 * matchup. Rows whose `season` is not a four-digit year are also excluded: the API
 * mixes in junk where the season, the rank and the win count are all the same small
 * integer — C. Zhu came back with season "1" rank "1" W-L 1-1, season "2" rank "2"
 * W-L 2-2, and so on. Reading those as real put her "best rank" at 1.
 */
function singlesSeasons(profile) {
  return ((profile && profile.stats) || [])
    .filter(s => /singles/i.test(String(s.type || '')))
    .filter(s => /^\d{4}$/.test(String(s.season || '').trim()))
    .sort((a, b) => String(b.season).localeCompare(String(a.season)));
}

/**
 * Career surface record, summed across singles seasons.
 *
 * This is the only surface information available, and it is per SEASON rather than
 * per match, so it cannot be crossed with any other split. Reported on its own.
 */
function surfaceTotals(profile) {
  const t = { hard: [0, 0], clay: [0, 0], grass: [0, 0] };
  for (const s of singlesSeasons(profile)) {
    for (const k of ['hard', 'clay', 'grass']) {
      const w = Number(s[`${k}_won`]), l = Number(s[`${k}_lost`]);
      if (isFinite(w)) t[k][0] += w;
      if (isFinite(l)) t[k][1] += l;
    }
  }
  return t;
}

/** Best (lowest) singles rank on record, and the most recent one. */
function rankSummary(profile) {
  const rows = singlesSeasons(profile);
  const ranked = rows
    .map(s => ({ season: s.season, rank: Number(s.rank) }))
    .filter(x => isFinite(x.rank) && x.rank > 0);
  if (!ranked.length) return { current: null, best: null, bestSeason: null };
  const best = ranked.reduce((a, b) => (b.rank < a.rank ? b : a));
  return { current: ranked[0].rank, best: best.rank, bestSeason: best.season };
}

module.exports = {
  available, call, eventTypes, singlesTypeKeys, fixtures,
  findPlayerKey, namesMatch, parseApiName, parseFullName,
  normalise, roundOf, playerMatches, playerProfile, headToHead,
  singlesSeasons, surfaceTotals, rankSummary,
  CACHE_DIR
};
