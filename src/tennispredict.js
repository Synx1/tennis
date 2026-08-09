/**
 * Match prediction from set-level history.
 *
 * ── the honest framing ──
 *
 * The market is the benchmark, not a baseline to ignore. Closing odds on a tennis
 * match are set by people with more data than this has, and any model that cannot
 * beat them is a model that should defer to them. So `predict()` returns its own
 * probability AND the market's, and the only figure that matters is whether the
 * edge between them is real — which `backtest()` measures rather than assumes.
 *
 * ── why the features are shrunk ──
 *
 * Every input is a rate over a small sample, and the small ones are the most
 * tempting: "80% in set 3 after losing set 2" over five matches looks like a
 * finding and is noise. Each feature is therefore shrunk toward the population mean
 * in proportion to its sample size, so a five-match split contributes almost
 * nothing and a hundred-match record contributes most of its face value.
 *
 * That is the same Beta-Binomial shrinkage the crypto learner uses, for the same
 * reason: the failure mode of these systems is reacting confidently to thin data.
 */

const stats = require('./tennisstats');

/** Pseudo-observations of prior. A rate needs this many matches to earn half weight. */
const PRIOR_STRENGTH = 20;

/**
 * Shrink a rate toward a prior mean.
 *
 * At n = 0 this returns the prior exactly, so a missing split contributes no signal
 * rather than a spurious 0% or 100%.
 */
function shrink(r, prior = 0.5, k = PRIOR_STRENGTH) {
  if (!r || r.n === 0 || r.pct == null) return prior;
  return (r.wins + k * prior) / (r.n + k);
}

/**
 * Feature weights.
 *
 * Deliberately few and deliberately flat. With no validated fit, a handful of
 * roughly equal weights is more defensible than a precise-looking set that was
 * chosen by hand — and `backtest()` exists to say whether even this much is
 * justified. Surface record is weighted highest because it conditions on the thing
 * that most changes tennis outcomes.
 */
const WEIGHTS = {
  surface: 1.4,
  career: 1.0,
  year: 1.0,
  recent: 0.8,
  set1: 0.8,
  h2h: 1.2
};

/**
 * Predicted probability that A beats B.
 *
 * Built as a weighted average of paired rate differences mapped through a logistic,
 * which keeps the output a probability without pretending to more precision than a
 * linear blend of six shrunk rates can carry.
 */
function predict(profA, profB, h2h, opts = {}) {
  const surfacePrior = 0.5;
  const parts = [];

  const add = (name, a, b, prior = 0.5) => {
    const sa = shrink(a, prior), sb = shrink(b, prior);
    parts.push({ name, diff: sa - sb, weight: WEIGHTS[name] || 1, a: sa, b: sb, ra: a, rb: b });
  };

  add('surface', profA.surfaceCareer, profB.surfaceCareer, surfacePrior);
  add('career', profA.winCareer, profB.winCareer);
  add('year', profA.winYear, profB.winYear);
  add('recent', profA.lastTen, profB.lastTen);
  add('set1', profA.set1, profB.set1);

  // Head-to-head is one rate, not a pair, so it is centred on a half directly.
  if (h2h && h2h.n) {
    const sh = shrink(h2h.rate, 0.5, 4);   // small prior: h2h samples are tiny but pointed
    parts.push({ name: 'h2h', diff: (sh - 0.5) * 2, weight: WEIGHTS.h2h,
                 a: sh, b: 1 - sh, ra: h2h.rate, rb: null });
  }

  const wsum = parts.reduce((s, p) => s + p.weight, 0);
  const score = wsum ? parts.reduce((s, p) => s + p.diff * p.weight, 0) / wsum : 0;

  // Scale chosen so a 20-point shrunk edge lands near 70%, which is about the most
  // these features should ever claim on their own.
  const K = 4.2;
  const p = 1 / (1 + Math.exp(-K * score));

  return {
    pA: p,
    pB: 1 - p,
    score,
    parts: parts.sort((x, y) => Math.abs(y.diff * y.weight) - Math.abs(x.diff * x.weight)),
    // How much of the input was real evidence rather than prior. Low means the
    // prediction is mostly a coin flip dressed up.
    evidence: parts.reduce((s, p2) =>
      s + (p2.ra && p2.ra.n ? Math.min(1, p2.ra.n / PRIOR_STRENGTH) * p2.weight : 0), 0) /
      (wsum || 1)
  };
}

/** Decimal odds to an implied probability, with the book's margin removed. */
function impliedFromOdds(oddsA, oddsB) {
  if (!(oddsA > 1 && oddsB > 1)) return null;
  const rawA = 1 / oddsA, rawB = 1 / oddsB;
  const overround = rawA + rawB;
  return { pA: rawA / overround, pB: rawB / overround, overround };
}

/**
 * Walk history and score the model against the closing market.
 *
 * For each match, the profiles are built from matches STRICTLY BEFORE it, which is
 * what stops the model being told the answer. Getting this wrong is the single
 * easiest way to produce an impressive and worthless backtest.
 *
 * Reported on two measures:
 *   accuracy  — did it pick the winner
 *   log loss  — was it correctly confident, which accuracy cannot see
 *
 * The market's own numbers are scored identically on the same matches, because
 * "72% accurate" means nothing until you know the favourite wins 70% of the time.
 */
function backtest(matches, { minPrior = 20, surface = true } = {}) {
  const chron = [...matches]
    .filter(m => m.date)
    .sort((a, b) => a.date - b.date);

  let n = 0, correct = 0, loss = 0;
  let mktN = 0, mktCorrect = 0, mktLoss = 0;
  let bothN = 0, modelBeat = 0;

  const history = [];
  const clamp = p => Math.min(1 - 1e-6, Math.max(1e-6, p));

  for (const m of chron) {
    // EVERY view of the past is taken before the current match is appended.
    //
    // `history` is a live array and `past` was a reference to it, so an earlier
    // version of this loop computed head-to-head AFTER the push — handing the model
    // the very result it was predicting. It scored 80.5% accuracy against the
    // market's 67.6%, which is the shape a leak makes: not slightly better, absurdly
    // better. h2h carries weight 1.2 against a prior of only 4 pseudo-matches, so
    // one free win dominated it.
    const vA = stats.forPlayer(history, m.winner);
    const vB = stats.forPlayer(history, m.loser);
    const h2h = stats.headToHead(history, m.winner, m.loser);

    history.push(m);          // only now

    if (vA.length < minPrior || vB.length < minPrior) continue;

    const opts = { year: m.date.getFullYear(), surface: surface ? m.surface : null };
    const pA = stats.profile(vA, opts);
    const pB = stats.profile(vB, opts);
    const pred = predict(pA, pB, h2h);

    // `m.winner` is A by construction, so a correct call is pA > 0.5.
    n++;
    if (pred.pA > 0.5) correct++;
    loss += -Math.log(clamp(pred.pA));

    const imp = impliedFromOdds(m.oddsWinner, m.oddsLoser);
    if (imp) {
      mktN++;
      if (imp.pA > 0.5) mktCorrect++;
      mktLoss += -Math.log(clamp(imp.pA));
      bothN++;
      if (-Math.log(clamp(pred.pA)) < -Math.log(clamp(imp.pA))) modelBeat++;
    }
  }

  return {
    n,
    accuracy: n ? correct / n : null,
    logLoss: n ? loss / n : null,
    market: {
      n: mktN,
      accuracy: mktN ? mktCorrect / mktN : null,
      logLoss: mktN ? mktLoss / mktN : null
    },
    // Share of matches where the model was better calibrated than the book.
    beatMarketShare: bothN ? modelBeat / bothN : null
  };
}

module.exports = { predict, impliedFromOdds, backtest, shrink, WEIGHTS, PRIOR_STRENGTH };
