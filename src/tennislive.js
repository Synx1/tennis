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
 */

const kalshi = require('./kalshi');

const SERIES = { atp: 'KXATPMATCH', wta: 'KXWTAMATCH' };

/** Last word of a name, lowercased. The usual surname. */
function surnameOf(name) {
  const parts = String(name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
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
 * Tournament name from a market title.
 * 
 * Titles like "Will Jannik Sinner win the Sinner vs Alcaraz: Round Of 16 match?"
 * The "win the X" portion before the colon often contains match info but not a clear
 * tournament. The event_ticker (e.g. KXATPMATCH-2026-08-09-R16-USOPEN) is more reliable.
 */
function tournamentFromTicker(ticker) {
  // Extract tournament from ticker like "KXATPMATCH-2026-08-09-R16-USOPEN"
  const parts = String(ticker || '').split('-');
  if (parts.length >= 5) {
    const tourney = parts.slice(4).join(' ');
    return tourney || null;
  }
  return null;
}

/**
 * Round from a market title.
 *
 * Titles read "Will X win the A vs B: Round Of 16 match?", so the round sits between
 * the colon and the trailing word. Absent on some listings, hence the null.
 */
function roundFrom(title) {
  const m = String(title || '').match(/:\s*([^?]+?)\s+match\?/i);
  return m ? m[1].trim() : null;
}

/** "A vs B" portion of the title, useful when sub-titles are missing. */
function pairFrom(title) {
  const m = String(title || '').match(/win the\s+(.+?)\s*:/i);
  return m ? m[1].trim() : null;
}

/**
 * Open matches for a tour, soonest first.
 *
 * One Kalshi EVENT is one match and holds two markets, one per player. Grouping by
 * event_ticker and taking each market's `yes_sub_title` gives both names with no
 * parsing of prose.
 */
async function upcomingForTour(tour) {
  const series = SERIES[tour];
  if (!series) return [];

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
    
    // Calculate match status
    const isUpcoming = !startMs || startMs > now;
    const isLive = startMs && startMs <= now && startMs > now - 6 * 3600 * 1000;
    const isFinished = startMs && startMs < now - 6 * 3600 * 1000;
    
    // Drop matches that finished more than six hours ago; Kalshi keeps them open
    // until settlement, which is up to two weeks after play.
    if (isFinished) continue;

    // Mid price per side, then normalised so the pair sums to one.
    const mid = s => {
      const b = s.yesBid, a = s.yesAsk;
      if (a > 0 && b >= 0) return (a + b) / 2;
      return a > 0 ? a : b;
    };
    const mA = mid(uniq[0]), mB = mid(uniq[1]);
    const sum = mA + mB;

    out.push({
      tour,
      eventTicker: ev,
      playerA: uniq[0].name,
      playerB: uniq[1].name,
      priceA: sum > 0 ? mA / sum : 0.5,
      priceB: sum > 0 ? mB / sum : 0.5,
      startMs,
      isLive,
      isUpcoming,
      round: roundFrom(uniq[0].title),
      pair: pairFrom(uniq[0].title),
      tournament: tournamentFromTicker(ev),
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

/** Open matches across both tours, live first then soonest upcoming. */
async function upcoming({ limit = 25 } = {}) {
  const [atp, wta] = await Promise.all([
    upcomingForTour('atp'),
    upcomingForTour('wta')
  ]);
  const all = [...atp, ...wta].sort((a, b) => {
    // Live matches first, then upcoming
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    
    const ta = a.startMs == null ? Infinity : a.startMs;
    const tb = b.startMs == null ? Infinity : b.startMs;
    if (ta !== tb) return ta - tb;
    return b.volume - a.volume;
  });
  return all.slice(0, limit);
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

  // Try each candidate key; still EXACT matches only, never a prefix.
  const lookup = (names, full) => {
    for (const k of surnameKeys(full)) {
      const hit = names.get(k);
      if (hit) return hit;
    }
    return null;
  };

  const covered = [], uncovered = [];
  for (const f of fixtures) {
    const names = idx[f.tour];
    if (!names) { uncovered.push(f); continue; }
    const a = lookup(names, f.playerA);
    const b = lookup(names, f.playerB);
    if (a && b) covered.push({ ...f, resolvedA: a, resolvedB: b });
    else uncovered.push(f);
  }
  return { covered, uncovered };
}

module.exports = {
  upcoming, upcomingForTour, implied, surnameOf, surnameKeys, splitByCoverage,
  indexBySurname, roundFrom, pairFrom, tournamentFromTicker, SERIES
};
