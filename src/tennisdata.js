/**
 * Tennis match history, from tennis-data.co.uk.
 *
 * One workbook per tour per season, each row a completed match with PER-SET game
 * scores. That last part is what makes the requested statistics possible at all:
 * "set 3 after losing set 2" cannot be derived from a win/loss column, only from
 * the sequence of sets.
 *
 * ── what this source can and cannot answer ──
 *
 * CAN: set-by-set records, conditional records (set 2 after losing set 1, set 3
 * after winning set 2), win rate by surface, by season, by round, recent form and
 * streaks, and the closing odds four books offered — which is the benchmark any
 * prediction has to beat to mean anything.
 *
 * CANNOT: anything below set level. There are no aces, no double faults, no
 * service games, no point sequences. So "5 double faults and 0 aces this match" and
 * "hasn't held serve two games in a row" are not derivable here, and neither is
 * "serve first" — that is not recorded. Those need point-by-point data, which the
 * free sources reachable from here do not carry.
 *
 * ── why HTTP and not HTTPS ──
 *
 * tennis-data.co.uk fails the TLS handshake from here (EPROTO) and serves the same
 * files fine over HTTP. This is public, unauthenticated, read-only sports data with
 * no credentials attached, so the exposure is that a network observer learns which
 * tennis season was downloaded. Worth stating plainly rather than leaving as an
 * unexplained `http://`.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const xlsx = require('./xlsx');
const { DATA_DIR } = require('./config');

const CACHE_DIR = path.join(DATA_DIR, 'tennis');

/** Seasons are refetched once a day; a finished season never changes again. */
const CURRENT_YEAR_TTL_MS = 6 * 60 * 60 * 1000;

const memory = new Map();       // `${tour}-${year}` -> normalised match array

function urlFor(tour, year) {
  // ATP lives at /YYYY/YYYY.xlsx, WTA at /YYYYw/YYYY.xlsx.
  return tour === 'wta'
    ? `http://www.tennis-data.co.uk/${year}w/${year}.xlsx`
    : `http://www.tennis-data.co.uk/${year}/${year}.xlsx`;
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error(`HTTP ${r.statusCode} for ${url}`));
      }
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error(`timeout for ${url}`)); });
  });
}

/**
 * Excel serial date to a real Date.
 *
 * Serials count days from 1899-12-30, not 1900-01-01, because Excel deliberately
 * reproduces a Lotus 1-2-3 bug that treats 1900 as a leap year. Using the obvious
 * epoch puts every date two days out.
 */
function excelDate(serial) {
  const n = Number(serial);
  if (!isFinite(n) || n <= 0) return null;
  return new Date(Math.round((n - 25569) * 86400000));
}

/**
 * Numeric cell, or null.
 *
 * The empty-string guard is load-bearing. `Number('')` is 0, not NaN, so without it
 * an absent W3/L3 became a real 0-0 third set — which made every straight-sets match
 * look like it went the distance. The visible symptom was "set 3 win %" reporting a
 * denominator equal to the player's TOTAL matches, and 151 deciders from 156
 * matches. Every conditional statistic downstream was wrong.
 */
const num = v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

/**
 * One row into a shape the stats layer can work with.
 *
 * Sets are stored as an ordered list of [winnerGames, loserGames] from the match
 * winner's perspective, plus a `wonSet` boolean list, so a conditional like "set 3
 * after losing set 2" is a lookup rather than a re-parse.
 *
 * Retirements are kept but flagged. A walkover or a mid-match retirement is a real
 * result for a win/loss record and misleading for a set-by-set one, so the consumer
 * gets to decide instead of the loader silently dropping or including them.
 */
function normalise(row, tour, year) {
  const winner = String(row.Winner || '').trim();
  const loser = String(row.Loser || '').trim();
  if (!winner || !loser) return null;

  const sets = [];
  for (let i = 1; i <= 5; i++) {
    const w = num(row[`W${i}`]);
    const l = num(row[`L${i}`]);
    if (w == null || l == null) break;
    sets.push([w, l]);
  }

  const comment = String(row.Comment || '').trim();
  const completed = /^completed$/i.test(comment);

  return {
    tour,
    year,
    date: excelDate(row.Date),
    tournament: String(row.Tournament || '').trim(),
    location: String(row.Location || '').trim(),
    series: String(row.Series || row.Tier || '').trim(),
    surface: String(row.Surface || '').trim(),
    court: String(row.Court || '').trim(),
    round: String(row.Round || '').trim(),
    bestOf: num(row['Best of']) || 3,
    winner,
    loser,
    winnerRank: num(row.WRank),
    loserRank: num(row.LRank),
    sets,                                   // winner's perspective
    setsWon: num(row.Wsets),
    setsLost: num(row.Lsets),
    completed,
    comment,
    // Closing average odds, the market's own view. The benchmark for any model.
    oddsWinner: num(row.AvgW) || num(row.PSW) || num(row.B365W),
    oddsLoser: num(row.AvgL) || num(row.PSL) || num(row.B365L)
  };
}

function cachePath(tour, year) {
  return path.join(CACHE_DIR, `${tour}-${year}.json`);
}

/**
 * Matches for one tour and season, memory-cached then disk-cached then fetched.
 *
 * Disk cache matters more than it looks: a career statistic spans a decade, so a
 * single command can touch ten workbooks at roughly 400KB each. Refetching those on
 * every invocation would make the bot unusable and hammer a free host that is doing
 * nobody any favours by hosting them.
 */
async function season(tour, year, { log = () => {} } = {}) {
  const key = `${tour}-${year}`;
  if (memory.has(key)) return memory.get(key);

  const file = cachePath(tour, year);
  const thisYear = new Date().getFullYear();
  if (fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      const fresh = year < thisYear || (Date.now() - st.mtimeMs) < CURRENT_YEAR_TTL_MS;
      if (fresh) {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
          .map(m => ({ ...m, date: m.date ? new Date(m.date) : null }));
        memory.set(key, rows);
        return rows;
      }
    } catch (_) { /* fall through to refetch */ }
  }

  log(`[tennis] fetching ${tour.toUpperCase()} ${year}`);
  const buf = await fetchBuffer(urlFor(tour, year));
  const parsed = xlsx.parse(buf);
  const rows = parsed.rows
    .map(r => normalise(r, tour, year))
    .filter(Boolean);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, file);

  memory.set(key, rows);
  log(`[tennis] ${tour.toUpperCase()} ${year}: ${rows.length} matches`);
  return rows;
}

/**
 * Matches across a span of seasons.
 *
 * A season that fails to load is skipped rather than failing the whole request —
 * tennis-data.co.uk does not publish every tour for every year, and a missing 2011
 * WTA workbook should narrow a career statistic, not break the command.
 */
async function seasons(tour, fromYear, toYear, opts = {}) {
  const out = [];
  const missing = [];
  for (let y = fromYear; y <= toYear; y++) {
    try {
      out.push(...await season(tour, y, opts));
    } catch (e) {
      missing.push(y);
    }
  }
  return { matches: out, missing };
}

/** Every distinct player name in a set of matches, for name resolution. */
function players(matches) {
  const s = new Set();
  for (const m of matches) { s.add(m.winner); s.add(m.loser); }
  return [...s];
}

module.exports = {
  season, seasons, players, excelDate, normalise, urlFor,
  CACHE_DIR, CURRENT_YEAR_TTL_MS
};
