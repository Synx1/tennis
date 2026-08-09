/**
 * Player statistics, derived from set-by-set match history.
 *
 * Every figure here is computed from the sequence of sets in a match rather than
 * read from a column, because the interesting statistics are all conditional:
 * "set 3 after losing set 2" is a rate over the subset of matches that reached a
 * third set having lost the second.
 *
 * ── the sample-size problem, which is the whole difficulty ──
 *
 * These splits shrink fast. A player with 40 matches in a season might have 12 that
 * reached a third set and 5 of those after losing the second, so "set 3 after
 * losing set 2 · yr" is a rate over FIVE matches. Reported bare, 60% off five
 * matches reads identically to 60% off two hundred, and the first is worthless.
 *
 * So every rate carries its denominator, and `reliable` marks whether the sample
 * can support a claim at all. The Wilson interval is reported for the same reason —
 * a 73% rate on 11 matches spans roughly 43-90%, which is most of the possible
 * range, and any prediction leaning on it is leaning on nothing.
 *
 * This is the failure mode the screenshots invite: a table of confident-looking
 * percentages where half are computed from single-digit samples.
 */

/** Wilson score interval, the same one the crypto side uses for hit rates. */
function wilson(wins, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = wins / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/**
 * A rate with everything needed to judge it.
 *
 * MIN_RELIABLE of 10 is a judgement, not a derivation: below it the Wilson interval
 * is wider than about 30 points for any rate near a half, which is too wide to
 * separate two players.
 */
const MIN_RELIABLE = 10;
function rate(wins, n) {
  const w = wilson(wins, n);
  return {
    wins, n,
    pct: n ? wins / n : null,
    lo: w.lo, hi: w.hi,
    reliable: n >= MIN_RELIABLE,
    // Interval width in points — the honest measure of how much this figure knows.
    spread: w.lo == null ? null : (w.hi - w.lo) * 100
  };
}

/**
 * One player's view of a match: did they win, and which sets did they take?
 *
 * Sets are stored winner-first in the source, so a loser's perspective is the same
 * list with each pair reversed. Getting this backwards silently inverts every
 * conditional statistic, which is why it lives in one place.
 */
function perspective(match, player, { side = null } = {}) {
  // `side` lets a caller state which player this is when identity is known from
  // something stronger than the name — an api-tennis player key, for instance.
  // Matching on the displayed name is unsafe there: api-tennis writes initial plus
  // surname, and "Y. Sun", "J. Lu" and "Y. Wang" were each measured covering TWO
  // different player keys inside a single pair of match histories. Merging two people
  // under one name corrupts every figure downstream, win/loss first.
  const isWinner = side ? side === 'winner' : match.winner === player;
  if (side) {
    if (side !== 'winner' && side !== 'loser') return null;
  } else if (!isWinner && match.loser !== player) {
    return null;
  }
  const sets = match.sets.map(([a, b]) => (isWinner ? [a, b] : [b, a]));
  return {
    match,
    won: isWinner,
    opponent: isWinner ? match.loser : match.winner,
    opponentRank: isWinner ? match.loserRank : match.winnerRank,
    ownRank: isWinner ? match.winnerRank : match.loserRank,
    sets,
    // A set is won by taking more games. Tie-break sets are already resolved in the
    // game count (7-6), so no special handling is needed.
    setsWon: sets.map(([m, o]) => m > o),
    odds: isWinner ? match.oddsWinner : match.oddsLoser
  };
}

const byDateDesc = (a, b) =>
  (b.match.date?.getTime() || 0) - (a.match.date?.getTime() || 0);

/** Every match a player appears in, newest first, matched on the displayed name. */
function forPlayer(matches, player) {
  return matches
    .map(m => perspective(m, player))
    .filter(Boolean)
    .sort(byDateDesc);
}

/**
 * Every match a player appears in, matched on a stable ID rather than a name.
 *
 * Used for api-tennis, where matches carry winnerKey/loserKey. Names there are
 * initial-plus-surname and demonstrably ambiguous — three collisions turned up inside
 * two players' histories alone — so identity comes from the key and the name is only
 * ever used for display.
 */
function forPlayerKey(matches, key) {
  const want = String(key);
  return matches
    .map(m => {
      const side = String(m.winnerKey) === want ? 'winner'
        : String(m.loserKey) === want ? 'loser' : null;
      if (!side) return null;
      return perspective(m, side === 'winner' ? m.winner : m.loser, { side });
    })
    .filter(Boolean)
    .sort(byDateDesc);
}

/** Head-to-head matched on IDs, for the same reason as forPlayerKey. */
function headToHeadKeys(matches, keyA, keyB) {
  const a = String(keyA), b = String(keyB);
  const met = matches.filter(m => {
    const w = String(m.winnerKey), l = String(m.loserKey);
    return (w === a && l === b) || (w === b && l === a);
  });
  const aWins = met.filter(m => String(m.winnerKey) === a).length;
  return {
    n: met.length,
    aWins,
    bWins: met.length - aWins,
    matches: met.slice().sort((x, y) => (y.date?.getTime() || 0) - (x.date?.getTime() || 0)),
    rate: rate(aWins, met.length)
  };
}

/**
 * The full statistical profile.
 *
 * @param {object[]} views      from forPlayer(), newest first
 * @param {object}  [opts]
 * @param {number}  [opts.year]     season for the "· yr" splits
 * @param {string}  [opts.surface]  surface for the surface split
 * @param {boolean} [opts.completedOnly]  exclude retirements from SET statistics
 */
function profile(views, opts = {}) {
  const year = opts.year != null ? opts.year : new Date().getFullYear();
  const completedOnly = opts.completedOnly !== false;

  const all = views;
  const thisYear = all.filter(v => v.match.year === year);
  // Retirements distort set statistics: a player who retired trailing 0-1 did not
  // "lose set 2", the match simply stopped. They still count for win/loss.
  const setSafe = completedOnly ? all.filter(v => v.match.completed) : all;
  const setSafeYear = setSafe.filter(v => v.match.year === year);

  const winsIn = list => list.filter(v => v.won).length;

  // ── set-level helpers ──
  const wonSet = (v, i) => v.setsWon[i] === true;
  const reachedSet = (v, i) => v.sets.length > i;

  const setRate = (list, i) => {
    const played = list.filter(v => reachedSet(v, i));
    return rate(played.filter(v => wonSet(v, i)).length, played.length);
  };

  /** Rate of winning set `then` among matches where set `given` went `gaveWin`. */
  const conditional = (list, given, gaveWin, then) => {
    const sub = list.filter(v =>
      reachedSet(v, given) && wonSet(v, given) === gaveWin && reachedSet(v, then));
    return rate(sub.filter(v => wonSet(v, then)).length, sub.length);
  };

  /** Match win rate among matches where set `given` went `gaveWin`. */
  const matchAfterSet = (list, given, gaveWin) => {
    const sub = list.filter(v => reachedSet(v, given) && wonSet(v, given) === gaveWin);
    return rate(sub.filter(v => v.won).length, sub.length);
  };

  // ── recent form ──
  const last10 = all.slice(0, 10);
  const streak = (() => {
    if (!all.length) return { type: null, n: 0 };
    const type = all[0].won ? 'W' : 'L';
    let n = 0;
    for (const v of all) { if ((v.won ? 'W' : 'L') !== type) break; n++; }
    return { type, n };
  })();

  // Third-set form specifically, which is what a decider question turns on.
  const deciders = setSafe.filter(v => v.sets.length >= 3);
  const set3Streak = (() => {
    if (!deciders.length) return { type: null, n: 0 };
    const first = deciders[0].setsWon[2] === true;
    let n = 0;
    for (const v of deciders) { if ((v.setsWon[2] === true) !== first) break; n++; }
    return { type: first ? 'W' : 'L', n };
  })();

  const surface = opts.surface
    ? all.filter(v => v.match.surface === opts.surface)
    : [];

  return {
    matches: all.length,
    year,

    // headline
    lastTen: rate(winsIn(last10), last10.length),
    streak,
    winYear: rate(winsIn(thisYear), thisYear.length),
    winCareer: rate(winsIn(all), all.length),
    surfaceCareer: opts.surface ? rate(winsIn(surface), surface.length) : null,
    surfaceName: opts.surface || null,

    // per-set
    set1: setRate(setSafe, 0),
    set2: setRate(setSafe, 1),
    set3: setRate(setSafe, 2),

    // match outcome conditioned on a set
    winAfterSet1Won: matchAfterSet(setSafe, 0, true),
    winAfterSet1Lost: matchAfterSet(setSafe, 0, false),
    winAfterSet2Won: matchAfterSet(setSafe, 1, true),
    winAfterSet2Lost: matchAfterSet(setSafe, 1, false),

    // set conditioned on the previous set — the screenshots' core rows
    set2AfterSet1Won: conditional(setSafe, 0, true, 1),
    set2AfterSet1Lost: conditional(setSafe, 0, false, 1),
    set3AfterSet2WonYear: conditional(setSafeYear, 1, true, 2),
    set3AfterSet2WonCareer: conditional(setSafe, 1, true, 2),
    set3AfterSet2LostYear: conditional(setSafeYear, 1, false, 2),
    set3AfterSet2LostCareer: conditional(setSafe, 1, false, 2),

    set3Streak,
    decidersPlayed: deciders.length
  };
}

/**
 * Head-to-head record between two players, from the shared match list.
 *
 * Reported separately from the profiles because it is the one statistic that is
 * about the pairing rather than about either player, and it is usually the smallest
 * sample on the board — two players may have met twice in a decade.
 */
function headToHead(matches, a, b) {
  const met = matches.filter(m =>
    (m.winner === a && m.loser === b) || (m.winner === b && m.loser === a));
  const aWins = met.filter(m => m.winner === a).length;
  return {
    n: met.length,
    aWins,
    bWins: met.length - aWins,
    matches: met.sort((x, y) => (y.date?.getTime() || 0) - (x.date?.getTime() || 0)),
    rate: rate(aWins, met.length)
  };
}

/**
 * Percentile of a rate against a peer population.
 *
 * The screenshots show "46th pctile" next to a set-3 rate, which is more useful
 * than the rate alone — 50% in a decider is unremarkable or excellent depending on
 * the field. Peers are restricted to players with a comparable sample so the
 * percentile is not diluted by everyone who played three matches.
 */
function percentile(value, population) {
  const pop = population.filter(x => x != null && isFinite(x));
  if (!pop.length || value == null) return null;
  const below = pop.filter(x => x < value).length;
  return below / pop.length;
}

module.exports = {
  wilson, rate, perspective, forPlayer, forPlayerKey, profile,
  headToHead, headToHeadKeys, percentile, MIN_RELIABLE
};
