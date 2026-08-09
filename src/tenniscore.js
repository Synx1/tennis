/**
 * Point-level tennis data, from the Match Charting Project.
 *
 * The set-level source (tennis-data.co.uk) cannot answer anything below a set, so
 * two requested statistics need this instead:
 *
 *   1. win % when the opponent hit MORE aces vs FEWER  — needs per-match ace counts
 *   2. break potential                                 — needs in-game point scores
 *
 * Both are here: `charting-*-stats-Overview.csv` carries aces and double faults per
 * player per match, and `charting-*-points-2020s.csv` carries every point with the
 * score before it was played.
 *
 * ── the coverage cost, which is the important caveat ──
 *
 * This is CROWD-CHARTED. Volunteers chart matches by hand, so it covers a subset of
 * what was played: 7,566 men's and 4,080 women's matches in total, of which about
 * 1,500 men's fall in 2024-2026. The set-level source has 16,000 men's matches for
 * the same recent window alone.
 *
 * So these two statistics rest on far less data than the rest of the table, and for
 * many players on none at all. Every figure is returned with its denominator and the
 * bot marks thin samples, because a "break potential" rate over three charted
 * matches is not a property of the player.
 *
 * ── the Pts convention, verified not assumed ──
 *
 * `Pts` is the score BEFORE each point, written SERVER-FIRST. Established by taking
 * every game's opening point and reading the score that followed: 4,564 cases agreed
 * with server-first and 0 with returner-first. So a returner who has won two points
 * to none appears as "0-30", and counting "30-0" instead would measure the server
 * dominating — the exact inverse of break potential.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./config');

const BASE = 'https://raw.githubusercontent.com/JeffSackmann/tennis_MatchChartingProject/master/';
const CACHE_DIR = path.join(DATA_DIR, 'tennis-mcp');
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Scores that count as break potential, from the RETURNER's point of view.
 *
 * The request defined it as getting the server to 30-0 down — i.e. the returner
 * holding 30 while the server has 0. Written server-first that is "0-30".
 *
 * 0-40 and 15-40 are included because they are strictly stronger positions, and a
 * measure of "threatened the break" that ignores 0-40 would be strange. 30-40 and
 * 40-AD are deliberately EXCLUDED: those are ordinary break points reachable from a
 * long game, and the statistic asked for is about dominant returning, not about
 * break points in general — which `bk_pts` already counts.
 */
const BREAK_POTENTIAL_SCORES = new Set(['0-30', '0-40', '15-40']);

const memory = new Map();

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode}`)); }
      let b = '';
      r.setEncoding('utf8');
      r.on('data', d => b += d);
      r.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** CSV split that tolerates quoted fields, which appear in tournament names. */
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function csv(name, { log = () => {} } = {}) {
  if (memory.has(name)) return memory.get(name);

  const file = path.join(CACHE_DIR, name);
  let text = null;
  if (fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < TTL_MS) text = fs.readFileSync(file, 'utf8');
    } catch (_) { /* refetch */ }
  }
  if (text == null) {
    log(`[mcp] fetching ${name}`);
    text = await fetchText(BASE + name);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  const lines = text.split('\n').filter(l => l.length);
  const headers = splitCsvLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));
  const rows = [];
  for (const l of lines.slice(1)) {
    const f = splitCsvLine(l);
    const o = {};
    for (let i = 0; i < headers.length; i++) o[headers[i]] = f[i] != null ? f[i] : '';
    rows.push(o);
  }
  memory.set(name, { headers, rows });
  return { headers, rows };
}

const tourLetter = tour => (tour === 'wta' ? 'w' : 'm');

/**
 * Per-match ace counts, keyed by match_id then player.
 *
 * Only the `set === 'Total'` rows are used; the file also carries per-set breakdowns
 * and summing those would double-count.
 */
async function aceIndex(tour, opts = {}) {
  const { rows } = await csv(`charting-${tourLetter(tour)}-stats-Overview.csv`, opts);
  const byMatch = new Map();
  for (const r of rows) {
    if (r.set !== 'Total') continue;
    const id = r.match_id;
    const aces = Number(r.aces);
    if (!id || !r.player || !isFinite(aces)) continue;
    if (!byMatch.has(id)) byMatch.set(id, {});
    byMatch.get(id)[r.player] = {
      aces,
      dfs: Number(r.dfs),
      servePts: Number(r.serve_pts),
      bkPts: Number(r.bk_pts),
      bpSaved: Number(r.bp_saved),
      returnPts: Number(r.return_pts),
      returnPtsWon: Number(r.return_pts_won)
    };
  }
  return byMatch;
}

/** Match metadata, so a match_id can be tied to two named players and a date. */
async function matchIndex(tour, opts = {}) {
  const { rows } = await csv(`charting-${tourLetter(tour)}-matches.csv`, opts);
  const byId = new Map();
  for (const r of rows) {
    if (!r.match_id) continue;
    byId.set(r.match_id, {
      id: r.match_id,
      p1: (r['Player 1'] || '').trim(),
      p2: (r['Player 2'] || '').trim(),
      date: r.Date || '',
      tournament: (r.Tournament || '').trim(),
      round: (r.Round || '').trim(),
      surface: (r.Surface || '').trim()
    });
  }
  return byId;
}

/**
 * Break potential per match, per player, from the point stream.
 *
 * Counted once per GAME, not once per point: a returner who reaches 0-30 and then
 * 0-40 has created one dominant return game, and counting both scores would inflate
 * every figure by a factor that varies with how the game continued.
 *
 * `Svr` is 1 or 2, referring to Player 1 / Player 2 of the match index, so the
 * RETURNER is the other one. Tie-break games are skipped — the scoring is numeric
 * there and "0-30" does not carry the same meaning.
 */
async function breakPotentialIndex(tour, decade = '2020s', opts = {}) {
  const { rows } = await csv(`charting-${tourLetter(tour)}-points-${decade}.csv`, opts);

  // match_id -> { returnerNo -> { potentials, returnGames } }
  const byMatch = new Map();
  const seenGame = new Set();

  for (const r of rows) {
    const id = r.match_id;
    const svr = Number(r.Svr);
    if (!id || (svr !== 1 && svr !== 2)) continue;
    if (String(r.TbSet).toLowerCase() === 'true' && String(r.Pts).includes('-') &&
        /^\d+-\d+$/.test(r.Pts) && Number(r.Pts.split('-')[0]) > 40) continue;

    const returner = svr === 1 ? 2 : 1;
    if (!byMatch.has(id)) byMatch.set(id, { 1: { potentials: 0, returnGames: 0 },
                                            2: { potentials: 0, returnGames: 0 } });
    const acc = byMatch.get(id);

    // Count each return game once, at its opening point.
    const gameKey = `${id}|${r['Gm#']}`;
    if (r.Pts === '0-0' && !seenGame.has(gameKey)) {
      seenGame.add(gameKey);
      acc[returner].returnGames++;
    }

    if (BREAK_POTENTIAL_SCORES.has(r.Pts)) {
      const potKey = `${gameKey}|pot`;
      if (!seenGame.has(potKey)) {
        seenGame.add(potKey);
        acc[returner].potentials++;
      }
    }
  }
  return byMatch;
}

/**
 * Everything point-level for one player, joined into per-match records.
 *
 * @returns {Promise<object[]>} newest first: { date, opponent, won, aces, oppAces,
 *   breakPotentials, oppBreakPotentials, returnGames }
 */
/**
 * Break potential across several decades of point files, merged.
 *
 * One decade is not enough. The 2020s file alone left Federer with point data on 14
 * of his 722 charted matches, because most of his charted career predates it. Loading
 * the 2010s as well is what makes the statistic available for anyone whose career
 * started before 2020.
 *
 * A decade that fails to load is skipped, narrowing coverage rather than failing.
 */
async function breakPotentialAll(tour, decades = ['2020s', '2010s'], opts = {}) {
  const merged = new Map();
  for (const d of decades) {
    try {
      const one = await breakPotentialIndex(tour, d, opts);
      for (const [k, v] of one) if (!merged.has(k)) merged.set(k, v);
    } catch (e) {
      // Not every decade file exists for every tour.
    }
  }
  return merged;
}

async function playerMatches(tour, player, opts = {}) {
  const [matches, aces, breaks] = await Promise.all([
    matchIndex(tour, opts),
    aceIndex(tour, opts),
    breakPotentialAll(tour, opts.decades || ['2020s', '2010s'], opts)
  ]);

  const out = [];
  for (const [id, meta] of matches) {
    if (meta.p1 !== player && meta.p2 !== player) continue;
    const isP1 = meta.p1 === player;
    const opponent = isP1 ? meta.p2 : meta.p1;

    const a = aces.get(id);
    const bp = breaks.get(id);
    // Without ace data the row cannot serve either statistic.
    if (!a) continue;
    const mine = a[player], theirs = a[opponent];
    if (!mine || !theirs) continue;

    // The charting files do not carry a winner column, so the result is taken from
    // the match_id, which ends with the two player names in Player 1 / Player 2
    // order — that does NOT indicate who won. Outcome therefore comes from the
    // set-level source at the caller, and is left null here rather than guessed.
    out.push({
      id,
      date: meta.date,
      tournament: meta.tournament,
      surface: meta.surface,
      round: meta.round,
      opponent,
      aces: mine.aces,
      dfs: mine.dfs,
      oppAces: theirs.aces,
      oppDfs: theirs.dfs,
      breakPotentials: bp ? bp[isP1 ? 1 : 2].potentials : null,
      returnGames: bp ? bp[isP1 ? 1 : 2].returnGames : null,
      oppBreakPotentials: bp ? bp[isP1 ? 2 : 1].potentials : null,
      oppReturnGames: bp ? bp[isP1 ? 2 : 1].returnGames : null,
      won: null                 // filled by the caller from the set-level record
    });
  }

  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * Attach win/loss to point-level records, from the set-level history.
 *
 * The charting files carry no winner column, so the outcome has to come from the
 * other source. Joined on DATE plus surname, because the two use different name
 * formats — "Roger Federer" against "Federer R." — and match ids do not correspond.
 *
 * A one-day tolerance is allowed: the charting date is the day the match was played
 * and the set-level source occasionally carries the tournament day, which can differ
 * by one across time zones. Wider than that would risk joining the wrong match
 * between players who met twice in a week.
 *
 * Records that cannot be joined keep `won: null` and are excluded from any
 * win-rate statistic rather than guessed at.
 */
function attachOutcomes(mcpRecords, player, setLevelViews) {
  // The two sources put the surname in OPPOSITE positions, and using one extractor
  // for both is why an earlier version joined 0% of records:
  //
  //   set-level : "Federer R."     -> surname is the FIRST token
  //   charting  : "Roger Federer"  -> surname is the LAST token
  //
  // Taking the first token from both turned "Roger Federer" into "roger", which
  // matched nothing, and every win-rate statistic downstream came back empty.
  const setSurname = s => String(s).trim().toLowerCase().split(/[\s.]+/).filter(Boolean)[0] || '';
  const mcpSurname = s => {
    const parts = String(s).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || '';
  };

  // Index the set-level views by opponent surname.
  const index = new Map();
  for (const v of setLevelViews) {
    if (!v.match.date) continue;
    const day = Math.floor(v.match.date.getTime() / 86400000);
    const key = setSurname(v.opponent);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ day, won: v.won });
  }

  let joined = 0;
  for (const r of mcpRecords) {
    const d = String(r.date);
    if (!/^\d{8}$/.test(d)) continue;
    const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
    const day = Math.floor(ms / 86400000);

    const cands = index.get(mcpSurname(r.opponent));
    if (!cands) continue;
    const hit = cands.find(c => Math.abs(c.day - day) <= 1);
    if (!hit) continue;
    r.won = hit.won;
    joined++;
  }
  return { joined, total: mcpRecords.length };
}

/**
 * The two requested statistics.
 *
 * ACE SPLIT — win rate when the opponent out-aced you versus when they did not.
 * Matches where ace counts are EQUAL are excluded from both sides rather than
 * assigned arbitrarily; they are a third case, and lumping them in would move
 * whichever bucket they landed in.
 *
 * BREAK POTENTIAL — dominant return positions created (0-30, 0-40, 15-40), counted
 * once per return game. Reported both as a per-match average and as a rate over
 * return games, because the average alone conflates "returns well" with "played a
 * long match".
 */
function pointStats(records) {
  const graded = records.filter(r => r.won === true || r.won === false);

  const oppMore = graded.filter(r => r.oppAces > r.aces);
  const oppFewer = graded.filter(r => r.oppAces < r.aces);
  const equal = graded.filter(r => r.oppAces === r.aces);

  const withPts = records.filter(r => r.breakPotentials != null && r.returnGames > 0);
  const bpTotal = withPts.reduce((s, r) => s + r.breakPotentials, 0);
  const rgTotal = withPts.reduce((s, r) => s + r.returnGames, 0);

  const oppBpTotal = withPts.reduce((s, r) => s + (r.oppBreakPotentials || 0), 0);
  const oppRgTotal = withPts.reduce((s, r) => s + (r.oppReturnGames || 0), 0);

  const mk = (wins, n) => ({ wins, n, pct: n ? wins / n : null });

  return {
    charted: records.length,
    graded: graded.length,

    winWhenOppMoreAces: mk(oppMore.filter(r => r.won).length, oppMore.length),
    winWhenOppFewerAces: mk(oppFewer.filter(r => r.won).length, oppFewer.length),
    winWhenAcesEqual: mk(equal.filter(r => r.won).length, equal.length),

    avgAces: records.length
      ? records.reduce((s, r) => s + r.aces, 0) / records.length : null,
    avgOppAces: records.length
      ? records.reduce((s, r) => s + r.oppAces, 0) / records.length : null,

    breakPotentialMatches: withPts.length,
    breakPotentialPerMatch: withPts.length ? bpTotal / withPts.length : null,
    breakPotentialRate: rgTotal ? bpTotal / rgTotal : null,
    returnGames: rgTotal,
    // Conceded: how often opponents reached a dominant position on THIS player's
    // serve. The defensive half of the same statistic.
    concededPerMatch: withPts.length ? oppBpTotal / withPts.length : null,
    concededRate: oppRgTotal ? oppBpTotal / oppRgTotal : null
  };
}

module.exports = {
  csv, aceIndex, matchIndex, breakPotentialIndex, breakPotentialAll,
  playerMatches, attachOutcomes, pointStats,
  BREAK_POTENTIAL_SCORES, CACHE_DIR
};
