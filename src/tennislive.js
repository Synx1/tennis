/**
 * Current and upcoming tennis matches, from Kalshi.
 *
 * The historical source publishes only COMPLETED matches, so it cannot answer "what
 * is on now". Kalshi's KXATPMATCH / KXWTAMATCH series can, and it is a better feed
 * for this than Polymarket for three specific reasons found by comparing them:
 *
 *   1. CORRECT MATCH TIME. Polymarket's endDate returned values months in the past
 *      for open markets. Kalshi carries `occurrence_datetime`, the scheduled start,
 *      which is the field a fixture list actually wants. Note that `close_time` is
 *      NOT that — it is the settlement deadline and sits about two weeks later, so
 *      reading it as the match time puts every fixture a fortnight out. That is the
 *      mistake that made the dates look wrong.
 *
 *   2. FULL NAMES. `yes_sub_title` is "Botic Van de Zandschulp", not a surname
 *      fragment, which matters because a surname alone is what caused "Zhu" to
 *      resolve to "Zhukayev".
 *
 *   3. CLEAN PAIRING. Both sides of one match share an `event_ticker`, so the two
 *      players are grouped without inferring anything from the title. Polymarket
 *      listed the same fixture several ways and needed de-duplication.
 *
 * The title also carries the round ("Round Of 16"), and the two markets' yes prices
 * give a de-vigged market probability for free.
 *
 * ── which series, and why five rather than two ──
 *
 * Querying only KXATPMATCH and KXWTAMATCH was hiding almost everything. Measured
 * 2026-08-09 against /series?category=Sports, the open board is:
 *
 *   KXITFWMATCH           106 open   ITF Women's Match
 *   KXATPCHALLENGERMATCH   92 open   Challenger ATP
 *   KXITFMATCH             40 open   ITF Men's Match
 *   KXATPMATCH              8 open   ATP Tennis Match
 *   KXWTAMATCH              8 open   WTA Tennis Match
 *
 * So the two tour-level series are 16 of 254 open markets, about 6%. Every ongoing
 * match a user could see on Kalshi's tennis page and not in `/matches` was in one of
 * the three missing series. KXCHALLENGERMATCH and KXWTACHALLENGERMATCH also exist as
 * series but returned 0 open markets, so they are listed and skipped for free rather
 * than special-cased.
 *
 * `historyTour` is separate from the series key on purpose. Name resolution has to
 * happen inside ONE tour's player list — that is the fix that stopped "Zhu" resolving
 * to "Zhukayev" — so ITF men and Challengers resolve against the ATP list and ITF
 * women against the WTA list, while `level` keeps the real competition visible in the
 * UI. Most ITF and Challenger players are not in tour-level history at all, which is
 * expected and is reported rather than hidden.
 */

const kalshi = require('./kalshi');

/**
 * Every tennis match series on Kalshi that carries open markets.
 *
 *   ticker       Kalshi series ticker
 *   label        what to show a user
 *   historyTour  which player list to resolve names against ('atp' | 'wta')
 */
const SERIES_DEFS = {
  atp:        { ticker: 'KXATPMATCH',           label: 'ATP',       historyTour: 'atp' },
  wta:        { ticker: 'KXWTAMATCH',           label: 'WTA',       historyTour: 'wta' },
  challenger: { ticker: 'KXATPCHALLENGERMATCH', label: 'Challenger', historyTour: 'atp' },
  itfm:       { ticker: 'KXITFMATCH',           label: 'ITF M',     historyTour: 'atp' },
  itfw:       { ticker: 'KXITFWMATCH',          label: 'ITF W',     historyTour: 'wta' }
};

/** Back-compat: the old shape was { atp: 'KXATPMATCH', wta: 'KXWTAMATCH' }. */
const SERIES = Object.fromEntries(
  Object.entries(SERIES_DEFS).map(([k, v]) => [k, v.ticker]));

/**
 * How long after the scheduled start a match is still treated as possibly ongoing.
 *
 * Kalshi leaves a market open until settlement, up to two weeks after play, so the
 * feed cannot say "finished" and this window is the only thing standing in for it.
 * Five sets can run past four hours and start times slip, so six hours is the point
 * past which "still playing" stops being credible.
 */
const LIVE_WINDOW_MS = 6 * 3600 * 1000;

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

/**
 * The UTC date encoded in an event ticker, at midnight, or null.
 *
 * Tickers are "KXITFWMATCH-26AUG08ZHAZHU" — series, then a 2-digit year, a 3-letter
 * month and a 2-digit day, then the two players' name fragments.
 */
function tickerDateUTC(eventTicker) {
  const m = String(eventTicker || '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  if (!(mon in MONTHS)) return null;
  return Date.UTC(2000 + Number(yy), MONTHS[mon], Number(dd));
}

/** Midnight UTC of the day containing a timestamp. */
function dayUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Has this match begun, judged on Kalshi disagreeing with itself?
 *
 * `occurrence_datetime` goes STALE once a match is under way: it keeps advertising a
 * scheduled slot that has already been overtaken, while the event ticker keeps the
 * real date. Measured across all five series on 2026-08-09T04:30Z:
 *
 *   ticker date == occurrence date   127 events   max combined volume    110,595
 *   ticker date EARLIER              2 events     combined volume  1,171,946 and 1,062,586
 *   ticker date LATER                0 events
 *
 * The two disagreeing events were the W15 and M15 Tianjin finals, both of which
 * Kalshi's own web UI was showing with a live set-by-set score while their
 * occurrence_datetime sat four and a half hours in the FUTURE. Their volume is an
 * order of magnitude above the busiest agreeing event, which is what being traded
 * in play looks like. Nothing disagrees in the other direction, so this is not noise.
 *
 * The market being OPEN is the second half of the argument. Every one of these
 * carries `can_close_early` with the condition "This market will close and expire
 * after a winner is declared", so an open market is a match with no winner yet.
 * Ticker date before occurrence date, plus still open, means started and unfinished.
 *
 * This is a workaround for a feed inconsistency, not a documented field, so it is
 * isolated here and named for what it detects rather than being inlined.
 */
function scheduleIsStale(eventTicker, startMs) {
  const td = tickerDateUTC(eventTicker);
  if (td == null || startMs == null || !isFinite(startMs)) return false;
  return td < dayUTC(startMs);
}

/** Last word of a name, lowercased. The usual surname. */
function surnameOf(name) {
  const parts = String(name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * The forename initial Kalshi gives us, lowercased, or null.
 *
 * `yes_sub_title` is forename-first ("Chenting Zhu", "Botic Van de Zandschulp"), so
 * the first token is the forename and its first letter is the thing the history
 * abbreviates. This is the field that separates two players sharing a surname, and
 * not using it is what let a fixture for Junhan Zhang resolve against Zhang R.
 */
function forenameInitialOf(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  const ch = first.replace(/[^A-Za-z]/g, '')[0];
  return ch ? ch.toLowerCase() : null;
}

/**
 * Split a history name into its surname and its initials.
 *
 * The source writes "<surname> <initials>.", where the surname may itself contain
 * spaces and the initials may be several letters:
 *
 *   "Zhu C."                -> { surname: 'zhu',                initials: 'c'  }
 *   "Van De Zandschulp B."  -> { surname: 'van de zandschulp',  initials: 'b'  }
 *   "Tirante T.A."          -> { surname: 'tirante',            initials: 'ta' }
 *   "Fernandez L. A."       -> { surname: 'fernandez',          initials: 'la' }
 *
 * A name carrying no initials returns initials '' rather than null, so callers can
 * compare without special-casing.
 */
function splitHistoryName(historyName) {
  const s = String(historyName || '').trim();
  const m = s.match(/^(.*?)\s+([A-Za-z](?:\s*\.\s*[A-Za-z])*)\s*\.?\s*$/);
  if (!m) return { surname: s.toLowerCase(), initials: '' };
  return {
    surname: m[1].trim().toLowerCase(),
    initials: m[2].replace(/[^A-Za-z]/g, '').toLowerCase()
  };
}

/**
 * Are these two history names the same player recorded two ways?
 *
 * The source is inconsistent about middle initials, so one player appears as both
 * "Fernandez L." and "Fernandez L.A.", and as both "Tirante T.A." and "Tirante T. A.".
 * Identical surname plus prefix-compatible initials is the available evidence for
 * that, and it is deliberately strict: "Zhang S." and "Zhang R." share a surname but
 * their initials are not prefix-compatible, so they stay separate players.
 *
 * The residual risk is a real pair like "Zhang S." and "Zhang S.Q." being merged.
 * Nothing in this data distinguishes that case from a middle initial recorded
 * intermittently, so it is accepted and stated rather than silently assumed away.
 */
function isSpellingVariant(a, b) {
  const x = splitHistoryName(a), y = splitHistoryName(b);
  if (x.surname !== y.surname) return false;
  const [short, long] = x.initials.length <= y.initials.length
    ? [x.initials, y.initials] : [y.initials, x.initials];
  return short.length > 0 && long.startsWith(short);
}

/**
 * Resolve one Kalshi full name to history names, using the forename initial.
 *
 * Returns null when nothing matches, which is the common and correct answer: Kalshi
 * lists mostly ITF and Challenger and this history covers tour level, so most
 * players below tour level are genuinely absent.
 *
 * The initial is REQUIRED to agree. Matching on surname alone reported Junhan Zhang
 * and Yuki Mochizuki as analysable when the history holds only Zhang R./Zhang S. and
 * Mochizuki S., and picking one of those showed a different person's career with no
 * warning. It also let "Martin VAN DER MEERSCHEN" reach Van de Zandschulp, Van
 * Rijthoven and Van Assche through the shared "van" key.
 *
 * Keys are tried in order and a key whose candidates all fail the initial test does
 * not stop the search, because "Botic Van de Zandschulp" has to fall through
 * "zandschulp" (absent) to "van" (present) to be found at all.
 *
 * @returns {{key: string, names: string[], variant: boolean}|null}
 *   names holds one player. More than one entry means spelling variants of that
 *   same player, which the caller must union rather than choose between.
 */
function resolveInTour(index, fullName) {
  const initial = forenameInitialOf(fullName);

  for (const key of surnameKeys(fullName)) {
    const candidates = index.get(key);
    if (!candidates || !candidates.length) continue;

    // Without an initial from Kalshi there is nothing to discriminate with, so a
    // single candidate is accepted and anything more is left unresolved.
    if (!initial) {
      if (candidates.length === 1) return { key, names: [candidates[0]], variant: false };
      continue;
    }

    const matching = candidates.filter(n => splitHistoryName(n).initials[0] === initial);
    if (!matching.length) continue;
    if (matching.length === 1) return { key, names: [matching[0]], variant: false };

    // Several survive. Same player spelled differently is fine; genuinely different
    // players sharing surname and initial are not resolvable and stay unresolved.
    const allVariants = matching.every(n => isSpellingVariant(n, matching[0]));
    if (allVariants) return { key, names: matching, variant: true };
  }

  return null;
}

/**
 * Every plausible surname key for a full name, because no single rule works.
 *
 * The history stores surname first ("Tirante T.A."), so its key is the LEADING token.
 * Deriving that from a full name breaks in two opposite ways:
 *
 *   "Thiago Agustin Tirante"    two forenames  -> last token is right ("tirante")
 *   "Botic Van de Zandschulp"   particled name -> last token is WRONG ("zandschulp"),
 *                                                 the history key is "van"
 *
 * A rule that takes the last token loses Van de Zandschulp; a rule that takes
 * everything after the first forename loses Tirante. So both candidates are produced
 * and whichever exists in the history wins. That is why Mensik vs Van de Zandschulp
 * was reported unanalysable while both players are in fact present.
 */
function surnameKeys(name) {
  const parts = String(name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const keys = new Set();
  keys.add(parts[parts.length - 1]);          // Tirante
  if (parts.length > 1) keys.add(parts[1]);   // Van (first token after the forename)
  return [...keys];
}

/**
 * The segment of a title between the colon and "match?".
 *
 * Titles are "Will <player> win the <A> vs <B>: <segment> match?" and the segment
 * carries the tournament and the round together, or just the round at tour level:
 *
 *   ATP  "...Van de Zandschulp vs Mensik: Round Of 16 match?"        -> "Round Of 16"
 *   ITF  "...Laborde vs Senn: M25 Muttenz Round of 32 match?"        -> "M25 Muttenz Round of 32"
 *   ITF  "...Vandewinkel vs Zakharova: W100 Landisville PA Final match?"
 *                                                    -> "W100 Landisville PA Final"
 */
function detailFrom(title) {
  const m = String(title || '').match(/:\s*([^?]+?)\s+match\?/i);
  return m ? m[1].trim() : null;
}

/**
 * Round names Kalshi uses, longest first so "Round of 128" is not clipped to
 * "Round of 12" and "Quarterfinal" is preferred over a bare "Final" suffix match.
 */
const ROUND_RE = new RegExp(
  '(' + [
    'Round\\s*Of\\s*\\d+',
    'Round\\s*\\d+',
    'R\\d+',
    'Qualifying\\s+(?:Final|Round\\s*\\d+|\\d+)',
    'Quarterfinals?', 'Quarter\\s*Final', 'QF',
    'Semifinals?', 'Semi\\s*Final', 'SF',
    'Final'
  ].join('|') + ')\\s*$', 'i');

/**
 * Split the title's detail segment into tournament and round.
 *
 * The round is always the TRAILING part, so it is matched at the end of the string
 * and whatever precedes it is the tournament. Anchoring at the end is what keeps
 * "W100 Landisville PA Final" from reading "Landisville" as a round, and stops the
 * tournament swallowing the round on ITF titles.
 *
 * At tour level there is no tournament in the title, so the whole segment is a round
 * and the tournament comes back null rather than being invented.
 */
function splitDetail(detail) {
  if (!detail) return { tournament: null, round: null };

  const m = detail.match(ROUND_RE);
  if (!m) return { tournament: detail || null, round: null };

  const round = m[1].trim();
  const tournament = detail.slice(0, m.index).trim();
  return { tournament: tournament || null, round };
}

/**
 * Round from a market title.
 *
 * Titles read "Will X win the A vs B: Round Of 16 match?", so the round sits between
 * the colon and the trailing word. Absent on some listings, hence the null.
 */
function roundFrom(title) {
  return splitDetail(detailFrom(title)).round;
}

/** Tournament from a market title, or null at tour level where the title omits it. */
function tournamentFrom(title) {
  return splitDetail(detailFrom(title)).tournament;
}

/** "A vs B" portion of the title, useful when sub-titles are missing. */
function pairFrom(title) {
  const m = String(title || '').match(/win the\s+(.+?)\s*:/i);
  return m ? m[1].trim() : null;
}

/**
 * Open matches for one series, live first then soonest.
 *
 * One Kalshi EVENT is one match and holds two markets, one per player. Grouping by
 * event_ticker and taking each market's `yes_sub_title` gives both names with no
 * parsing of prose.
 *
 * @param {string} key  a key of SERIES_DEFS ('atp' | 'wta' | 'challenger' | 'itfm' | 'itfw')
 */
async function upcomingForTour(key) {
  const def = SERIES_DEFS[key];
  if (!def) return [];
  const series = def.ticker;

  let open;
  try { open = await kalshi.getOpenMarkets(series) || []; }
  catch (e) { return []; }

  const byEvent = new Map();
  for (const m of open) {
    const ev = m.event_ticker;
    if (!ev) continue;
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev).push(m);
  }

  const now = Date.now();
  const out = [];

  for (const [ev, markets] of byEvent) {
    // A match needs both sides to price it; a lone market cannot say who the
    // opponent is with confidence.
    if (markets.length < 2) continue;

    const sides = markets
      .map(m => ({
        name: String(m.yes_sub_title || '').trim(),
        yesBid: parseFloat(m.yes_bid_dollars) || 0,
        yesAsk: parseFloat(m.yes_ask_dollars) || 0,
        ticker: m.ticker,
        volume: Number(m.volume_fp || 0),
        title: m.title || '',
        // The scheduled start. NOT close_time.
        startMs: Date.parse(m.occurrence_datetime || m.expected_expiration_time || '')
      }))
      .filter(s => s.name);

    if (sides.length < 2) continue;

    // Two distinct players. Some events carry extra markets; take the two with the
    // most volume so a stray listing cannot displace a real side.
    const uniq = [];
    const seenName = new Set();
    for (const s of sides.sort((a, b) => b.volume - a.volume)) {
      if (seenName.has(s.name)) continue;
      seenName.add(s.name);
      uniq.push(s);
      if (uniq.length === 2) break;
    }
    if (uniq.length < 2) continue;

    const startMs = uniq.map(s => s.startMs).find(t => isFinite(t)) || null;

    // A stale schedule is positive evidence the match has begun, and it overrides
    // the clock — for these, occurrence_datetime points into the future even though
    // play has started, so a purely time-based test calls them "upcoming" and sorts
    // them below matches that have not begun.
    const stale = scheduleIsStale(ev, startMs);

    // Started per the clock, and recently enough that "still playing" is credible.
    const startedRecently = startMs != null &&
      startMs <= now && startMs > now - LIVE_WINDOW_MS;

    const isLive = stale || startedRecently;
    const isUpcoming = !isLive && (startMs == null || startMs > now);

    // Finished: the clock says it began long enough ago to be over, and there is no
    // stale-schedule evidence that it is still going. Kalshi keeps markets open
    // until settlement, up to two weeks after play, so this has to be inferred.
    if (!isLive && startMs != null && startMs <= now - LIVE_WINDOW_MS) continue;

    // Mid price per side, then normalised so the pair sums to one.
    const mid = s => {
      const b = s.yesBid, a = s.yesAsk;
      if (a > 0 && b >= 0) return (a + b) / 2;
      return a > 0 ? a : b;
    };
    const mA = mid(uniq[0]), mB = mid(uniq[1]);
    const sum = mA + mB;

    const detail = splitDetail(detailFrom(uniq[0].title));

    out.push({
      // `tour` stays 'atp' or 'wta' because it selects the player list to resolve
      // names against, and it is what the menu round-trips to /compare.
      tour: def.historyTour,
      series: key,
      level: def.label,
      eventTicker: ev,
      playerA: uniq[0].name,
      playerB: uniq[1].name,
      priceA: sum > 0 ? mA / sum : 0.5,
      priceB: sum > 0 ? mB / sum : 0.5,
      startMs,
      isLive,
      isUpcoming,
      // True when startMs is known to be unreliable, so callers do not present an
      // elapsed time computed from a timestamp in the future.
      startUnreliable: stale,
      round: detail.round,
      tournament: detail.tournament,
      pair: pairFrom(uniq[0].title),
      volume: uniq.reduce((s2, x) => s2 + x.volume, 0)
    });
  }

  out.sort((a, b) => {
    // Live matches first, then upcoming, sorted by time within each group
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    
    const ta = a.startMs == null ? Infinity : a.startMs;
    const tb = b.startMs == null ? Infinity : b.startMs;
    if (ta !== tb) return ta - tb;
    return b.volume - a.volume;
  });
  return out;
}

/**
 * Live matches first, then soonest upcoming; ties broken on volume.
 *
 * Inside the live group the timestamp is not used. A stale-schedule match has a
 * startMs pointing into the future, so ordering the live group by time would put the
 * matches that are definitely under way BELOW ones that merely started late, which
 * is backwards. Volume is the meaningful ranking there: in-play markets are the
 * heavily traded ones.
 */
function byLiveThenSoonest(a, b) {
  if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
  if (a.isLive) return b.volume - a.volume;

  const ta = a.startMs == null ? Infinity : a.startMs;
  const tb = b.startMs == null ? Infinity : b.startMs;
  if (ta !== tb) return ta - tb;
  return b.volume - a.volume;
}

/**
 * Open matches across every tennis series, live first then soonest upcoming.
 *
 * All five series are fetched concurrently. `kalshi.get` serialises and throttles
 * internally, so the concurrency here queues rather than bursting and cannot trip
 * the rate limiter.
 *
 * @param {object} opts
 *   limit   how many fixtures to return
 *   series  restrict to specific SERIES_DEFS keys (default: all)
 */
async function upcoming({ limit = 25, series = Object.keys(SERIES_DEFS) } = {}) {
  const lists = await Promise.all(series.map(k => upcomingForTour(k)));
  return lists.flat().sort(byLiveThenSoonest).slice(0, limit);
}

/** Same as upcoming(), but only matches that have already started. */
async function live({ limit = 25 } = {}) {
  const all = await upcoming({ limit: Infinity });
  return all.filter(f => f.isLive).slice(0, limit);
}

/** Market-implied probability. Kalshi prices are already normalised above. */
function implied(match) {
  return { pA: match.priceA, pB: match.priceB };
}

function indexBySurname(names) {
  const m = new Map();
  for (const n of names) {
    // History format is "Fils A." — surname is the LEADING token.
    const sn = String(n).trim().toLowerCase().split(/[\s.]+/).filter(Boolean)[0];
    if (!sn) continue;
    if (!m.has(sn)) m.set(sn, []);
    m.get(sn).push(n);
  }
  return m;
}

/**
 * Split fixtures by whether both players are in the history for their OWN tour.
 *
 * Resolving inside a single tour is the fix for a bug with a silent, wrong outcome.
 * "Chenting Zhu" exists in the WTA history and not the ATP; "Zhang" exists in both.
 * Checking the two tours combined passed the fixture, the tour was then guessed from
 * the first surname and came back ATP, and "zhu" prefix-matched inside the ATP list
 * to **Zhukayev** — a different person, shown without any warning.
 *
 * Kalshi tells us the tour directly, so it is used rather than inferred, and the
 * combined-list check is gone. Matching is on EXACT surname with no prefix fallback.
 *
 * @param {object[]} fixtures  each carrying its own `tour`
 * @param {object} byTour      { atp: string[], wta: string[] }
 */
function splitByCoverage(fixtures, byTour) {
  const idx = {};
  for (const t of Object.keys(byTour)) idx[t] = indexBySurname(byTour[t] || []);

  const covered = [], uncovered = [];
  for (const f of fixtures) {
    const names = idx[f.tour];
    if (!names) { uncovered.push(f); continue; }

    // Surname AND forename initial must both agree, inside this fixture's own tour.
    const a = resolveInTour(names, f.playerA);
    const b = resolveInTour(names, f.playerB);

    if (a && b) {
      covered.push({
        ...f,
        resolvedA: a.names, resolvedB: b.names,
        keyA: a.key, keyB: b.key,
        // True when the history spells this player more than one way, so the caller
        // unions the records instead of picking a spelling and losing the rest.
        variantA: a.variant, variantB: b.variant
      });
    } else uncovered.push(f);
  }
  return { covered, uncovered };
}

module.exports = {
  upcoming, live, upcomingForTour, implied, surnameOf, surnameKeys, splitByCoverage,
  indexBySurname, roundFrom, tournamentFrom, detailFrom, splitDetail, pairFrom,
  byLiveThenSoonest, tickerDateUTC, dayUTC, scheduleIsStale,
  forenameInitialOf, splitHistoryName, isSpellingVariant, resolveInTour,
  SERIES, SERIES_DEFS, LIVE_WINDOW_MS
};
