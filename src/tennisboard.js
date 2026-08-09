/**
 * The live tennis board: what is on court now, what is next, and the market on both.
 *
 * ── why this replaced the Kalshi fixture list ──
 *
 * Kalshi could say a match existed and roughly when, and nothing else. It has no
 * score, no server, no game state, and its `occurrence_datetime` goes stale the
 * moment play starts — the two Tianjin finals advertised a slot 4.5 hours in the
 * future while they were visibly in progress, which forced a workaround comparing
 * the event-ticker date against the occurrence date just to detect "started".
 *
 * api-tennis answers all of it directly. Measured 2026-08-09:
 *   get_livescore   6 live singles, each with per-set games, the current game score
 *                   ("30 - 40"), which player is serving, and up to 98 statistics
 *                   rows at Challenger level.
 *   get_fixtures    157 singles over two days against Kalshi's 130 across five
 *                   series, and it includes Boys/Girls and Exhibition that Kalshi
 *                   does not list at all.
 *   get_odds        one call by date covered 51 matches, every one carrying a
 *                   Home/Away market.
 *   get_live_odds   342 live prices per match across set, game and handicap markets.
 *
 * Kalshi is still the venue the crypto side trades, but for TENNIS it was strictly
 * less informative than the source that also supplies the statistics.
 *
 * ── shape ──
 *
 * snapshot() returns one object holding both lists, already sorted and already
 * carrying odds, so a caller renders it without making further decisions about what
 * to fetch. It is cheap to call repeatedly: livescore and live odds are deliberately
 * NOT disk-cached, because a stale live score is worse than no live score, while
 * fixtures and pre-match odds are memoised briefly.
 */

const api = require('./tennisapi');

/** Levels worth showing, and how to label them. Order is display priority. */
const LEVELS = [
  [/^atp singles$/i, 'ATP'],
  [/^wta singles$/i, 'WTA'],
  [/challenger men singles/i, 'Challenger M'],
  [/challenger women singles/i, 'Challenger W'],
  [/itf men singles/i, 'ITF M'],
  [/itf women singles/i, 'ITF W'],
  [/^boys singles$/i, 'Boys'],
  [/^girls singles$/i, 'Girls'],
  [/exhibition/i, 'Exhibition']
];

function levelOf(eventType) {
  for (const [re, label] of LEVELS) if (re.test(String(eventType || ''))) return label;
  return String(eventType || '').replace(/\s*singles\s*/i, '').trim() || 'Other';
}

/** Singles only, and never a doubles pair masquerading as a player. */
function isSingles(r) {
  if (!/singles/i.test(String(r.event_type_type || ''))) return false;
  return !String(r.event_first_player || '').includes('/') &&
         !String(r.event_second_player || '').includes('/');
}

/**
 * Which of three states a fixture is in.
 *
 * `event_status` is the authority: it reads "Set 2" while playing, "Finished",
 * "Retired", "Walk Over", "Cancelled", or empty before the start. `event_live` is
 * checked as a secondary signal because livescore rows keep event_live=1 for a short
 * while after a match finishes, and a finished match must not be reported as live.
 */
function stateOf(r) {
  const s = String(r.event_status || '').trim();
  if (/finished|retired|walk\s*over|cancel|abandon|awarded/i.test(s)) return 'done';
  if (/^set\b/i.test(s) || /^\d+(st|nd|rd|th)?\s*set/i.test(s)) return 'live';
  if (String(r.event_live) === '1' && s) return 'live';
  return 'upcoming';
}

/** Round, with the tournament prefix api-tennis repeats stripped off. */
function roundOf(r) {
  const t = String(r.tournament_round || '').trim();
  if (!t) return '';
  const dash = t.lastIndexOf(' - ');
  return dash >= 0 ? t.slice(dash + 3).trim() : t;
}

/**
 * Per-set games, tiebreaks truncated and 0-0 padding dropped.
 *
 * Both corrections are the same ones the history path needs: api-tennis pads `scores`
 * out to five entries with 0-0 placeholders on some responses, and writes a tiebreak
 * set as "7.8-6.6" meaning 7-6 with the breaker at 8-6. A live set legitimately
 * starts 0-0 though, so padding is only dropped from the END — trimming it anywhere
 * would delete the set currently being played.
 */
function setsOf(r) {
  const raw = [];
  for (const s of (r.scores || [])) {
    const a = Number(s.score_first), b = Number(s.score_second);
    if (!isFinite(a) || !isFinite(b)) continue;
    raw.push([Math.trunc(a), Math.trunc(b)]);
  }
  while (raw.length && raw[raw.length - 1][0] === 0 && raw[raw.length - 1][1] === 0) {
    raw.pop();
  }
  return raw;
}

/**
 * Decimal odds to a de-vigged pair of probabilities.
 *
 * Several books per market; the MEDIAN is taken rather than the best price, because
 * the point here is to describe the consensus rather than to find the sharpest line.
 */
function median(xs) {
  const v = xs.filter(n => isFinite(n) && n > 1).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function priceFromHomeAway(block) {
  if (!block || !block['Home/Away']) return null;
  const ha = block['Home/Away'];
  const home = median(Object.values(ha.Home || {}).map(Number));
  const away = median(Object.values(ha.Away || {}).map(Number));
  if (!home || !away) return null;

  const ih = 1 / home, ia = 1 / away;
  const sum = ih + ia;
  return {
    decimalA: home, decimalB: away,
    pA: sum > 0 ? ih / sum : null,
    pB: sum > 0 ? ia / sum : null,
    books: Object.keys(ha.Home || {}).length
  };
}

/** Normalise a fixture or livescore row into one board entry. */
function toEntry(r) {
  const state = stateOf(r);
  const sets = setsOf(r);
  return {
    eventKey: String(r.event_key || ''),
    state,
    level: levelOf(r.event_type_type),
    eventType: String(r.event_type_type || ''),
    tournament: String(r.tournament_name || '').trim(),
    tournamentKey: String(r.tournament_key || ''),
    round: roundOf(r),
    qualifying: String(r.event_qualification || '') === 'True',
    date: String(r.event_date || ''),
    time: String(r.event_time || ''),
    playerA: String(r.event_first_player || '').trim(),
    playerB: String(r.event_second_player || '').trim(),
    keyA: String(r.first_player_key || ''),
    keyB: String(r.second_player_key || ''),
    sets,
    // "30 - 40" during a game, "-" otherwise.
    game: (() => {
      const g = String(r.event_game_result || '').trim();
      return (!g || g === '-') ? null : g;
    })(),
    // 'A' | 'B' | null
    serving: /first/i.test(String(r.event_serve || '')) ? 'A'
      : /second/i.test(String(r.event_serve || '')) ? 'B' : null,
    setsWonA: sets.filter(([a, b]) => a > b).length,
    setsWonB: sets.filter(([a, b]) => b > a).length,
    status: String(r.event_status || '').trim(),
    finalResult: String(r.event_final_result || '').trim(),
    winner: /first/i.test(String(r.event_winner || '')) ? 'A'
      : /second/i.test(String(r.event_winner || '')) ? 'B' : null,
    statsCount: (r.statistics || []).length,
    odds: null,
    startMs: (() => {
      // event_time is already in the requested timezone, so the two are combined and
      // parsed as local — which is what a caller formatting for display wants.
      const d = String(r.event_date || ''), t = String(r.event_time || '00:00');
      const ms = Date.parse(`${d}T${t}:00`);
      return isFinite(ms) ? ms : null;
    })()
  };
}

/** Live first, then soonest. Within live, the match furthest along leads. */
function boardOrder(a, b) {
  if (a.state !== b.state) return a.state === 'live' ? -1 : 1;
  if (a.state === 'live') {
    const played = x => x.sets.reduce((n, [p, q]) => n + p + q, 0);
    return played(b) - played(a);
  }
  const ta = a.startMs == null ? Infinity : a.startMs;
  const tb = b.startMs == null ? Infinity : b.startMs;
  if (ta !== tb) return ta - tb;
  return String(a.tournament).localeCompare(String(b.tournament));
}

const iso = d => new Date(d).toISOString().slice(0, 10);

// Fixtures and pre-match odds change slowly and are cached for two minutes.
let fixtureCache = { at: 0, rows: null };
let oddsCache = { at: 0, map: null };
const FIXTURE_TTL = 120000;
const ODDS_TTL = 120000;

/**
 * Live data gets a very short cache — long enough to be shared, short enough to stay
 * live.
 *
 * At a 5-second refresh a single board costs two calls per tick (livescore plus live
 * odds), which is 24 a minute; three people watching at once would be 72 for the same
 * information. A 4-second TTL means concurrent loops and the per-match refresh all
 * collapse onto one poll, while still being shorter than the refresh interval so no
 * tick ever renders data it has already shown.
 *
 * Deliberately not longer. A cached live score is a wrong live score, and the whole
 * point of this module is the score being current.
 */
const LIVE_TTL = 4000;
let liveCache = { at: 0, rows: null, inflight: null };
let liveOddsCache = { at: 0, map: null, inflight: null };

/**
 * Livescore rows, shared across callers within the TTL.
 *
 * `inflight` matters as much as the cache: at a 5-second cadence several loops can ask
 * within the same few milliseconds, and without it each would open its own request.
 * They now all await the same promise.
 */
async function liveRows({ timezone = 'America/New_York' } = {}) {
  const now = Date.now();
  if (liveCache.rows && now - liveCache.at < LIVE_TTL) return liveCache.rows;
  if (liveCache.inflight) return liveCache.inflight;

  liveCache.inflight = (async () => {
    try {
      const r = await api.call('get_livescore', { timezone });
      const rows = (Array.isArray(r) ? r : []).filter(isSingles);
      liveCache = { at: Date.now(), rows, inflight: null };
      return rows;
    } catch (e) {
      liveCache.inflight = null;
      // Serve the last good rows rather than blanking a live board on one failure.
      return liveCache.rows || [];
    }
  })();
  return liveCache.inflight;
}

/**
 * One snapshot of the whole board.
 *
 * @param {object} opts
 *   timezone   tz name for event_time, e.g. 'America/New_York'
 *   days       how far ahead to look for upcoming matches
 *   withOdds   fetch and attach the market (one extra call per day of range)
 *   levels     restrict to these level labels, e.g. ['ATP','WTA']
 */
async function snapshot({
  timezone = 'America/New_York', days = 2, withOdds = true, levels = null
} = {}) {
  const now = Date.now();

  // ── live: 4-second shared cache, so concurrent watchers cost one poll ──
  const liveNow = await liveRows({ timezone });

  // ── fixtures: briefly cached ──
  let fxRows = fixtureCache.rows;
  if (!fxRows || now - fixtureCache.at > FIXTURE_TTL) {
    try {
      const r = await api.call('get_fixtures', {
        date_start: iso(new Date()),
        date_stop: iso(new Date(Date.now() + days * 86400000)),
        timezone
      });
      fxRows = (Array.isArray(r) ? r : []).filter(isSingles);
      fixtureCache = { at: now, rows: fxRows };
    } catch (e) {
      fxRows = fxRows || [];
    }
  }

  // Livescore wins on conflict: it is the fresher view of the same match.
  const byKey = new Map();
  for (const r of fxRows) byKey.set(String(r.event_key), toEntry(r));
  for (const r of liveNow) byKey.set(String(r.event_key), toEntry(r));

  let entries = [...byKey.values()];
  if (levels && levels.length) {
    const want = new Set(levels.map(s => s.toLowerCase()));
    entries = entries.filter(e => want.has(e.level.toLowerCase()));
  }

  // ── odds ──
  if (withOdds) {
    let map = oddsCache.map;
    if (!map || now - oddsCache.at > ODDS_TTL) {
      map = {};
      try {
        const o = await api.call('get_odds', {
          date_start: iso(new Date()),
          date_stop: iso(new Date(Date.now() + days * 86400000))
        });
        for (const [k, block] of Object.entries(o || {})) {
          const p = priceFromHomeAway(block);
          if (p) map[String(k)] = p;
        }
      } catch (_) { /* odds are a nicety, never a hard failure */ }
      oddsCache = { at: now, map };
    }
    for (const e of entries) if (map[e.eventKey]) e.odds = map[e.eventKey];

    /**
     * Live prices override the pre-match line on anything in progress, because a
     * price from before the first serve describes a match that is no longer the one
     * being played. One call covers every live match, so this is cheap.
     */
    if (entries.some(e => e.state === 'live')) {
      const lo = await liveOddsAll();
      for (const e of entries) {
        const x = lo[e.eventKey];
        if (!x) continue;
        e.liveOdds = x;
        if (x.outright) e.odds = { ...x.outright, live: true };
      }
    }
  }

  const live = entries.filter(e => e.state === 'live').sort(boardOrder);
  const upcoming = entries.filter(e => e.state === 'upcoming').sort(boardOrder);
  const done = entries.filter(e => e.state === 'done').sort(boardOrder);

  const byLevel = {};
  for (const e of [...live, ...upcoming]) byLevel[e.level] = (byLevel[e.level] || 0) + 1;

  return { updatedAt: new Date(), timezone, live, upcoming, done, byLevel };
}

/**
 * Pull one Home/Away market out of a live_odds array and de-vig it.
 *
 * The outright is called "To Win" — NOT "Home/Away", which is the pre-match name, and
 * not "Match Winner", which does not exist. A live match carries 34 to 59 markets and
 * guessing at that name returned nothing at all on the first attempt.
 */
function marketFrom(rows, nameRe) {
  const wanted = rows.filter(o => nameRe.test(String(o.odd_name || '').trim()));
  if (!wanted.length) return null;

  const side = s => {
    const hit = wanted.find(o => new RegExp(`^${s}$`, 'i').test(String(o.type || '').trim()));
    return hit ? Number(hit.value) : null;
  };
  const home = side('Home') ?? side('1');
  const away = side('Away') ?? side('2');
  if (!home || !away || home <= 1 || away <= 1) return null;

  const ih = 1 / home, ia = 1 / away, sum = ih + ia;
  return {
    decimalA: home, decimalB: away,
    pA: sum ? ih / sum : null, pB: sum ? ia / sum : null,
    suspended: wanted.some(o => /yes/i.test(String(o.suspended || ''))),
    updated: wanted[0].upd || null
  };
}

/**
 * Live prices for every in-progress match, keyed by event.
 *
 * One call covers the whole live board — get_live_odds without a match_key returns
 * all of them — so this costs the same whether one match is on or twenty.
 *
 * Note the rows here carry `event_first_player: undefined`, so nothing about who is
 * playing can be read from this endpoint; it is joined on event_key alone.
 */
async function liveOddsAll() {
  const now = Date.now();
  if (liveOddsCache.map && now - liveOddsCache.at < LIVE_TTL) return liveOddsCache.map;
  if (liveOddsCache.inflight) return liveOddsCache.inflight;

  liveOddsCache.inflight = (async () => {
    const map = await fetchLiveOdds();
    liveOddsCache = { at: Date.now(), map, inflight: null };
    return map;
  })();
  return liveOddsCache.inflight;
}

async function fetchLiveOdds() {
  const out = {};
  let r;
  try { r = await api.call('get_live_odds', { timezone: 'UTC' }); }
  catch (_) { return liveOddsCache.map || out; }

  for (const [k, m] of Object.entries(r || {})) {
    const rows = m.live_odds || [];
    if (!rows.length) continue;

    // Which set is being played, so the right set market can be picked out.
    const setNo = (() => {
      const mm = String(m.event_status || '').match(/set\s*(\d+)/i);
      return mm ? Number(mm[1]) : null;
    })();
    const ordinal = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' }[setNo];

    out[String(k)] = {
      outright: marketFrom(rows, /^to win$/i),
      setWinner: setNo ? marketFrom(rows, new RegExp(`^set ${setNo} winner$`, 'i')) : null,
      gameWinner: ordinal ? marketFrom(rows, new RegExp(`^game winner \\(${ordinal} set\\)$`, 'i')) : null,
      goesToDecider: (() => {
        const hit = rows.find(o => /^go the distance/i.test(String(o.odd_name || '')));
        return hit ? { type: hit.type, value: Number(hit.value) } : null;
      })(),
      setNo,
      markets: new Set(rows.map(o => o.odd_name)).size
    };
  }
  return out;
}

/** Live prices for a single match. Convenience wrapper over liveOddsAll(). */
async function liveOddsFor(eventKey) {
  const all = await liveOddsAll();
  return all[String(eventKey)] || null;
}

// ── live match detail ───────────────────────────────

/**
 * The statistics array, indexed by period then by stat name.
 *
 * Rows look like { player_key, stat_period, stat_type, stat_name, stat_value,
 * stat_won, stat_total }, one per player per stat per period. Measured on a live
 * Challenger match: 98 rows across periods match/set1/set2 and types
 * Service/Return/Points/Games, giving 17 distinct names including aces, double
 * faults, first-serve percentage, break points saved and converted, and points won.
 *
 * ITF matches return an EMPTY array even while point-by-point is populated, so every
 * caller has to treat this as optional rather than assume it is there.
 */
function indexStats(rows, keyA, keyB) {
  const out = {};
  for (const s of (rows || [])) {
    const period = String(s.stat_period || 'match');
    const name = String(s.stat_name || '').trim();
    if (!name) continue;
    out[period] = out[period] || new Map();
    if (!out[period].has(name)) out[period].set(name, { name, type: s.stat_type, A: null, B: null });

    const side = String(s.player_key) === String(keyA) ? 'A'
      : String(s.player_key) === String(keyB) ? 'B' : null;
    if (!side) continue;

    out[period].get(name)[side] = {
      value: s.stat_value,
      won: s.stat_won == null ? null : Number(s.stat_won),
      total: s.stat_total == null ? null : Number(s.stat_total)
    };
  }
  return out;
}

/**
 * The game currently being played, and the games just finished.
 *
 * The in-progress game is identifiable because its `score` and `serve_winner` are
 * still null while its `points` array grows. Advantage arrives as "A - 40" in the
 * point score, which is why the raw string is passed through rather than parsed into
 * numbers.
 */
function readPointByPoint(pbp, { servingSide } = {}) {
  const games = (pbp || []).map(g => ({
    set: String(g.set_number || '').trim(),
    game: Number(g.number_game),
    servedBy: /first/i.test(String(g.player_served || '')) ? 'A'
      : /second/i.test(String(g.player_served || '')) ? 'B' : null,
    wonBy: /first/i.test(String(g.serve_winner || '')) ? 'A'
      : /second/i.test(String(g.serve_winner || '')) ? 'B' : null,
    after: g.score == null ? null : String(g.score),
    points: (g.points || []).map(p => ({
      score: String(p.score || ''),
      bp: !!p.break_point, sp: !!p.set_point, mp: !!p.match_point
    }))
  }));

  const inProgress = games.length && games[games.length - 1].after == null
    ? games[games.length - 1] : null;

  // A break is the server losing their own service game.
  const finished = games.filter(g => g.after != null && g.wonBy && g.servedBy);
  const recent = finished.slice(-6).map(g => ({
    ...g, broken: g.wonBy !== g.servedBy
  }));

  const cur = inProgress || (finished.length ? finished[finished.length - 1] : null);
  const lastPoint = cur && cur.points.length ? cur.points[cur.points.length - 1] : null;

  return {
    games, inProgress, recent, lastPoint,
    // Flags on the CURRENT point, which is what a viewer wants shouted at them.
    flags: lastPoint ? { bp: lastPoint.bp, sp: lastPoint.sp, mp: lastPoint.mp } : null,
    breaks: {
      A: finished.filter(g => g.servedBy === 'B' && g.wonBy === 'A').length,
      B: finished.filter(g => g.servedBy === 'A' && g.wonBy === 'B').length
    },
    servingSide: servingSide || (inProgress ? inProgress.servedBy : null)
  };
}

/** Rank a point value so "did they reach 30" is a comparison. */
function pointRank(token) {
  const t = String(token || '').trim().toUpperCase();
  if (t === 'A' || t === 'AD') return 4;      // advantage
  if (t === '40') return 3;
  if (t === '30') return 2;
  if (t === '15') return 1;
  if (t === '0' || t === '') return 0;
  const n = Number(t);                        // tiebreaks count numerically
  return isFinite(n) ? Math.min(4, n) : 0;
}

/**
 * Break potential and return pressure, derived from the point sequence.
 *
 * ── why derive it ──
 *
 * ITF matches return an EMPTY `statistics` array while `pointbypoint` is fully
 * populated — 25 games on the W15 Tianjin final with no stats at all. So at the level
 * that makes up most of the board, points are the ONLY source for anything below the
 * scoreline. Everything here is computed from them.
 *
 * ── what break potential means ──
 *
 * A return game where the returner reached 30 or 40 is a game where the break was
 * live, whether or not a break point was ever formally reached. Counted once per game,
 * so a long deuce game does not outweigh a routine one. This mirrors the definition
 * already used for charted historical data in src/tenniscore.js, which keeps the live
 * figure and the career figure comparable.
 *
 * Break POINTS are counted separately, from the API's own `break_point` flag, because
 * "reached 40" and "held a break point" are not the same thing — 40-40 is not a break
 * point, and the flag knows that.
 *
 * Point scores read "<first player> - <second player>", matching score_first/second, so
 * the returner's side is chosen by which player served.
 */
function derivePointStats(games) {
  const blank = () => ({
    returnGames: 0, reached30: 0, reached40: 0, bpGames: 0, breaks: 0,
    serviceGames: 0, holds: 0, deuceGames: 0, pointsWon: 0
  });
  const out = { A: blank(), B: blank() };

  for (const g of games) {
    if (!g.servedBy) continue;
    const server = g.servedBy;
    const returner = server === 'A' ? 'B' : 'A';
    const decided = g.after != null && g.wonBy;

    if (decided) {
      out[server].serviceGames++;
      out[returner].returnGames++;
      if (g.wonBy === server) out[server].holds++;
      else out[returner].breaks++;
    }

    // How far the returner got, and whether a break point ever existed.
    let best = 0, sawBP = false, sawDeuce = false;
    for (const p of g.points) {
      const parts = String(p.score || '').split('-');
      if (parts.length !== 2) continue;
      const a = pointRank(parts[0]), b = pointRank(parts[1]);
      const mine = returner === 'A' ? a : b;
      if (mine > best) best = mine;
      if (a >= 3 && b >= 3) sawDeuce = true;
      if (p.bp) sawBP = true;
    }

    // Only completed games count toward rates, so an in-progress game cannot inflate
    // a denominator that its own outcome has not yet joined.
    if (decided) {
      if (best >= 2) out[returner].reached30++;
      if (best >= 3) out[returner].reached40++;
      if (sawBP) out[returner].bpGames++;
      if (sawDeuce) { out.A.deuceGames++; out.B.deuceGames++; }
    }
  }

  for (const side of ['A', 'B']) {
    const s = out[side];
    s.breakPotentialRate = s.returnGames ? s.reached30 / s.returnGames : null;
    s.reached40Rate = s.returnGames ? s.reached40 / s.returnGames : null;
    s.bpGameRate = s.returnGames ? s.bpGames / s.returnGames : null;
    s.holdRate = s.serviceGames ? s.holds / s.serviceGames : null;
    s.breakRate = s.returnGames ? s.breaks / s.returnGames : null;
    // Of the games where the break was live, how many were actually taken.
    s.conversion = s.reached30 ? s.breaks / s.reached30 : null;
  }
  return out;
}

/**
 * Everything known about one live match, in one object.
 *
 * Sourced from get_livescore rather than get_fixtures because only livescore is
 * refreshed continuously; fixtures is a schedule that happens to carry a score.
 * Falls back to fixtures so a match that has just finished still renders.
 */
async function liveDetail(eventKey, { timezone = 'America/New_York' } = {}) {
  const want = String(eventKey);
  let row = null;

  // Shared cache: a per-match refresh and the board refresh both land on one poll.
  const rows = await liveRows({ timezone });
  row = rows.find(r => String(r.event_key) === want) || null;

  if (!row) {
    try {
      const rows = await api.call('get_fixtures', { match_key: want, timezone });
      row = (Array.isArray(rows) ? rows : [])[0] || null;
    } catch (_) { /* nothing else to try */ }
  }
  if (!row) return null;

  const entry = toEntry(row);
  const stats = indexStats(row.statistics, row.first_player_key, row.second_player_key);
  const pbp = readPointByPoint(row.pointbypoint, { servingSide: entry.serving });
  const derived = derivePointStats(pbp.games);
  const odds = await liveOddsFor(want);

  return {
    entry, stats, pbp, derived, odds,
    hasStats: !!(stats.match && stats.match.size),
    // Points are present at every level, statistics are not, so a caller can always
    // show the derived block and only sometimes the published one.
    hasPoints: pbp.games.length > 0
  };
}

module.exports = {
  snapshot, liveOddsAll, liveOddsFor, liveDetail, liveRows, indexStats,
  readPointByPoint, derivePointStats, pointRank, marketFrom, toEntry, stateOf,
  levelOf, setsOf, roundOf, priceFromHomeAway, boardOrder, isSingles,
  LEVELS, LIVE_TTL
};
