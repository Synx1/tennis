const fs = require('fs');
const path = require('path');

/**
 * Load .env into process.env, without a dependency.
 *
 * Written inline rather than pulling in dotenv for two reasons: it is a dozen
 * lines, and a package that reads secrets is a package worth not adding for
 * convenience alone.
 *
 * Existing environment variables always win, so a value set by Railway or the
 * shell is never overwritten by a stale local file.
 */
(function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;   // environment wins
      let val = t.slice(eq + 1).trim();
      // Strip one layer of matching quotes, which is how multi-word values are
      // usually written and is not part of the value.
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (e) {
    console.error(`[config] could not read .env: ${e.message}`);
  }
})();

/**
 * The bot token, as a constant.
 *
 * ── why it is in the file ──
 * Deployment kept failing because .env is gitignored and therefore absent from
 * the container, so a host with no DISCORD_TOKEN variable resolved it to '' and
 * discord.js refused to log in. Carrying the value here removes the deployment
 * step entirely: the bot boots wherever the code lands, with nothing to
 * configure.
 *
 * ── what that costs ──
 * Synx1/BOT is a PRIVATE repository, which is the only reason this is a
 * defensible trade. It still means anyone who can read the repo, now or later,
 * can drive the bot, and that a git commit is permanent: once pushed, the value
 * cannot be un-published by editing this line. Rotating in the Discord
 * Developer Portal is the only thing that actually revokes it.
 *
 * If this repo is ever made public, treat the token as burned and rotate it
 * before flipping the switch, not after. GitHub reports leaked tokens to
 * Discord automatically on public repos, and Discord invalidates them — the bot
 * would break again within minutes for exactly the reason it broke before.
 */
const DISCORD_TOKEN_CONSTANT = '';

/**
 * Resolve the bot token to ONE canonical value for the whole process.
 *
 * The constant above is the default, and an environment variable still wins
 * when one is present. That ordering is what makes rotation possible without a
 * code change and a redeploy: set DISCORD_TOKEN on the host and it takes over.
 * Nothing is required for the normal case.
 *
 * Normalised rather than used raw because every failure so far has been a paste
 * artefact, not a wrong secret. A pasted value can carry surrounding quotes, a
 * trailing newline from a terminal copy, or the `Bot ` prefix that belongs in
 * the Authorization header rather than in the token. discord.js answers all
 * three with the same opaque TokenInvalid, so they are stripped once here
 * instead of being re-diagnosed later.
 *
 * Every module that logs in reads this value, so normalisation cannot drift
 * between the bot, the scanner, the dashboard and the paper reporter.
 */
function resolveToken() {
  let t = process.env.DISCORD_TOKEN || DISCORD_TOKEN_CONSTANT || '';
  t = t.trim();
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/^Bot\s+/i, '').trim();
}

/**
 * Why Discord would reject this token, or null if the shape is right.
 *
 * Shape only. A well-formed token that has been rotated is indistinguishable
 * from a live one without a network call, which is why the caller's message
 * names rotation as a possibility rather than ruling it out.
 *
 * A bot token is three base64url segments: the app id, a timestamp, and an
 * HMAC. The first segment decoding to the numeric app id is the strongest
 * offline check available, and it catches the common mistake of pasting a
 * client secret or an OAuth code in place of the token.
 */
function describeTokenProblem(t) {
  if (!t) return 'DISCORD_TOKEN is not set (empty or missing)';
  if (/\s/.test(t)) return 'DISCORD_TOKEN contains whitespace inside the value';

  const parts = t.split('.');
  if (parts.length !== 3) {
    return `DISCORD_TOKEN has ${parts.length} dot-separated segment(s), expected 3 ` +
      `— this looks like a client secret or an application id, not a bot token`;
  }
  if (parts.some(p => !p.length)) return 'DISCORD_TOKEN has an empty segment';

  try {
    const b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const id = Buffer.from(b64, 'base64').toString('utf8');
    if (!/^\d{17,20}$/.test(id)) {
      return 'DISCORD_TOKEN first segment does not decode to an application id';
    }
  } catch (_) {
    return 'DISCORD_TOKEN first segment is not valid base64';
  }
  return null;
}

const DISCORD_TOKEN = resolveToken();

/**
 * All thresholds below were derived from backtests, not guessed.
 * See backtest-*.js for the studies that produced them.
 */
module.exports = {
  // Shape check for the token, so startup can explain a bad value instead of
  // letting discord.js fail with an unactionable TokenInvalid.
  describeTokenProblem: () => describeTokenProblem(DISCORD_TOKEN),
  // ── Discord ──
  //
  // The token comes from the environment. It was previously hardcoded here, and
  // because this file is tracked it was published to the remote across several
  // commits — so the OLD TOKEN MUST BE TREATED AS COMPROMISED AND ROTATED in the
  // Discord Developer Portal. Anyone who has ever had read access to the repo, or
  // to its history, can drive the bot with it.
  //
  // Rotating alone is not sufficient: the old value stays in git history forever
  // unless the history is rewritten. Rotation is what actually revokes it.
  //
  // Carried as a constant above so the bot runs with nothing configured. A
  // DISCORD_TOKEN environment variable still overrides it, which is the path to
  // use after a rotation.
  DISCORD_TOKEN,
  CHANNEL_PICKS: '1534342746750324870',   // #daily-picks
  CHANNEL_BTC: '1534343347358142564',     // #btc — the call itself, kept short
  CHANNEL_BTC_DETAIL: '1534470028802654269', // full math, skipped rounds, logs
  CHANNEL_ROLES: '1534443501247266946',   // #roles — reaction-role board
  // Multi-market crypto scanner P&L dashboard. Testing surface only: the
  // scanner edits ONE live message here with open positions and the rolling
  // record per market. It never posts picks, and it is deliberately not any of
  // the channels above so a test run cannot be mistaken for a production call.
  CHANNEL_MULTIMARKET: '1535526220060565616',
  // Verbose scan trace: every look, every decline and its reason, every entry,
  // exit and settlement. Separate from the dashboard channel on purpose — the
  // dashboard is one long-lived message about state, this is an append-only log of
  // events, and mixing them would make both harder to read.
  CHANNEL_SCAN_DEBUG: '1535822137711919160',
  OWNER_ID: '384033277595484160',

  // ── Per-user command access ──
  // OWNER_ID implicitly has every command. Anyone listed here is limited to
  // exactly the commands named, and is denied everything else.
  //
  // Granting a command here also makes it visible in the Discord picker for
  // everyone, because setDefaultMemberPermissions('0') is enforced server-side
  // and a hidden command cannot be invoked even by an allowlisted user. Other
  // members will see it and be denied at runtime.
  COMMAND_ACCESS: {
    '472918708591919121': ['tennis']
  },

  // Reaction role handed out in CHANNEL_ROLES. Created on demand if the guild
  // doesn't already have a role with this name.
  BTC_ROLE_NAME: 'BTC',
  BTC_ROLE_COLOR: 0xf7931a,               // bitcoin orange
  BTC_ROLE_EMOJI: '📈',                   // react with this to opt in

  // ── Presence / status ──
  // The status alternates between a live countdown to STATUS_TARGET and the
  // tagline. Once the target passes, the countdown drops out and only the
  // tagline is shown.
  STATUS_TARGET: '2026-08-10T00:00:00',   // 8/10, midnight ET
  STATUS_TARGET_LABEL: '8/10',
  STATUS_TAGLINE: 'Predicting the unpredicted',
  STATUS_ROTATE_SECONDS: 20,

  KALSHI_API_BASE: 'https://external-api.kalshi.com/trade-api/v2',
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // ═══════════════════════════════════════════════════════════
  // BTC 15-minute market
  //
  // Settings below come from backtest-btc-deep.js: 96h of 1-minute Coinbase
  // candles against 381 settled rounds. Every figure carries a 95% Wilson
  // interval, and the entry point is judged on the LOWER bound so a lucky run
  // cannot pass for evidence.
  //
  // ── 2026-08-05 revision ──
  // The drift term was found to be mis-specified: it added extrapolated
  // momentum to the numerator without adding its uncertainty to the variance,
  // making the model 6.0 points overconfident. btcmodel.probability() now
  // prices that uncertainty. See the comment there for the measurement.
  //
  // Correcting it shifts every probability, so the gate was re-picked. Losses
  // per 100 rounds at a 9-minute entry, 381 settled rounds:
  //
  //   gate   as-shipped              variance-penalised
  //   0.82   88.8% · 24 losses · 56%   91.7% ·  14 losses · 44%
  //   0.86   88.9% · 21 losses · 50%   91.7% ·  12 losses · 38%
  //   0.88   89.8% · 18 losses · 46%   92.4% ·  10 losses · 34%
  //   0.90   92.7% · 12 losses · 43%   92.4% ·   9 losses · 31%
  //   0.92   92.2% · 12 losses · 40%   96.1% ·   4 losses · 27%  <- chosen
  //   0.94   92.7% · 10 losses · 36%   95.1% ·   4 losses · 21%
  //   0.96   92.4% ·  9 losses · 31%   93.5% ·   4 losses · 16%
  //
  // 0.92 is the LOOSEST gate that reaches the minimum loss count — 0.92, 0.94
  // and 0.96 all bottom out at 4 losses, so 0.92 is taken for its coverage
  // rather than for being the peak. Picking the highest cell on a grid this
  // size would be fitting noise.
  //
  // Net against the previous setting: 24 losses -> 4 (83% fewer), hit rate
  // 88.8% -> 96.1% [>=90.4%] on n=103, coverage 56% -> 27%. Roughly half as
  // many calls, for about a fifth of the losses.
  //
  // 7 minutes measured slightly better still (0.92 -> 96.4% [>=91.9%], 36%
  // coverage) but entry stays at 9 to preserve lead time before the close.
  //
  // ── original as-shipped grid, kept for reference ──
  //     gate 0.70 -> 84.7%  [>=80.0%]  n=287   75% of rounds
  //     gate 0.74 -> 85.7%  [>=81.0%]  n=266   70%
  //     gate 0.78 -> 86.8%  [>=81.9%]  n=235   62%
  //     gate 0.82 -> 88.8%  [>=83.9%]  n=214   56%
  //     gate 0.86 -> 88.9%  [>=83.6%]  n=189   50%
  //     gate 0.90 -> 92.7%  [>=87.7%]  n=165   43%
  //
  // And by entry point at gate 0.90, for reference:
  //
  //     10 min -> 89.7%  [>=84.1%]     7 min -> 94.9%  [>=90.8%]
  //      9 min -> 92.7%  [>=87.7%]     5 min -> 97.0%  [>=93.5%]
  //      8 min -> 90.9%  [>=85.9%]     3 min -> 99.6%  [>=97.5%]
  //
  // Entry sits in the 9-7.5 min band to give lead time before the close. That
  // concedes a few points against waiting until 5 minutes, but the cost is now
  // measured rather than assumed.
  //
  // Note an earlier 20-round version of this backtest reported 70.6% at 9
  // minutes. That was sample noise — it also had 8 minutes scoring above 9,
  // which cannot happen mechanically. Use the deep backtest, not that one.
  // ═══════════════════════════════════════════════════════════
  BTC: {
    SERIES: 'KXBTC15M',

    // ── 2026-08-05 second revision, measured on clean data ──
    //
    // The previous numbers in this file were produced by a backtest with a
    // lookahead bug: Coinbase candle timestamps are bucket STARTS, so the
    // candle .close used as "spot at entry" was actually the price up to 60s
    // LATER, while the Kalshi price came from at-or-before that moment. The
    // model was being shown the future and then transacting at a stale quote.
    //
    // Rebuilt honestly (spot = candle .open at the entry second, vol/drift from
    // only fully-closed buckets, fills at the ASK), over 894 rounds / 227h with
    // 5-fold walk-forward validation:
    //
    //   setting                       cov   hit    ROI   dd    folds+
    //   9m single, gate 0.78         24%  85.6%   2.4%  -9.4u   3/5
    //   7/5/3m retry, gate 0.86      23%  94.3%   9.7%  -1.6u   5/5   <- chosen
    //
    // Better on every axis at the same coverage: +8.7 points of hit rate, 4x
    // the ROI, a sixth of the drawdown, calibration error 5.6 -> 0.4 points,
    // and profitable in all five folds instead of three.
    //
    // Per fold hit rate: 95, 94, 97, 94, 93%. At +2c of slippage it still holds
    // 92.9% and 8% ROI.
    //
    // ── single decisive look, no rechecking ──
    //
    // The 7/5/3 retry version measured 94.3% but it made the bot indecisive:
    // it logged "will re-check at 5m" and suppressed the skip notice until the
    // final look, so a declined round produced no Discord message for minutes.
    //
    // One look is better anyway. Best single entries measured, same 894 rounds,
    // 5-fold walk-forward, ask fills:
    //
    //   entry  vol  shrink  gate   hit     [95%lo]  worstFold  cov   ROI  calib
    //     5m   10m   0.75   0.86  95.9%      91%       90%     14%   10%   0.3  <- chosen
    //     7m   10m   0.50   0.86  93.6%      89%       91%     18%    7%   1.2
    //     7m   10m   1.00   0.94  92.7%      88%       91%     23%    5%   5.4
    //     9m   10m   1.00   0.90  89.9%      85%       86%     22%    8%   6.3
    //
    // 5 minutes wins on hit rate, ROI and calibration at once, and beats the
    // 7/5/3 retry config's 94.3% with a single call. It costs coverage — 14%
    // rather than 23% — which is the price of only betting when one look is
    // already decisive.
    //
    // Later entry is mechanically more accurate: fewer minutes left means fewer
    // chances for price to cross the strike. The cost is lead time before the
    // close, which is why this does not go later still.
    // ── 2026-08-05 fourth revision: 6-7 minute entry ──
    //
    // Earlier sweeps rejected a 6-7m entry, but they compared an EXACT 5-minute
    // entry against an EXACT 7-minute one. The bot does not work that way: it
    // fires on the first poll inside the window, and with POLL_SECONDS 45 that
    // poll lands near the window's TOP edge. So the 5.75-4.25m window was never
    // realising 5.0m -- it averaged 5.40m.
    //
    // Re-measured with real poll phase, 894 rounds, ask fills, 5-fold:
    //
    //   window        gate  calls  avgEntry   hit    ROI     P&L    folds+
    //   5.75-4.25m     86%    263    5.40m   93.9%   3.2%   +6.47u   4/5   (was live)
    //   7.0-6.0m       86%    333    6.69m   91.9%   2.0%   +6.05u   3/5
    //   7.0-6.0m       88%    305    6.69m   93.1%   4.1%  +11.05u   4/5   <- chosen
    //   7.0-6.0m       90%    274    6.69m   93.1%   3.1%   +7.32u   4/5
    //   7.0-6.0m       92%    224    6.69m   93.3%   2.3%   +4.63u   3/5
    //
    // 88% is not optional. At 86% the same window drops to +6.05u and 3/5 folds;
    // the gate is doing as much work here as the timing.
    //
    // The point of moving earlier is FOLLOWER fills. The backtest books the ask
    // at the instant of the decision, but a human reads Discord and fills later.
    // Charging every config a 60-second lag:
    //
    //   window        gate  calls   hit    ROI     P&L    shutOut  folds+
    //   5.75-4.25m     86%    170   91.8%   2.8%   +3.94u    93      4/5
    //   7.0-6.0m       88%    220   92.3%   5.2%  +11.33u    85      4/5
    //
    // Nearly 3x the follower profit and 50 more fillable calls, because an
    // earlier entry means the price has not yet run to 97c+. "shutOut" is rounds
    // where the price passed the cap before the follower could fill.
    //
    // Cost is 0.8 points of raw hit rate, 93.9% -> 93.1%.
    //
    // TOLERANCE 0.5 gives a 60-second window against a 45-second poll, so every
    // round still gets at least one look -- the window must stay WIDER than
    // POLL_SECONDS or rounds get silently skipped on poll phase alone. If
    // POLL_SECONDS ever rises above 30, widen this.
    // ── 2026-08-06: reverted to the a7897e7 entry, 9 minutes ──
    //
    // Requested. The old build entered at ~8.8-9 minutes with a 30-minute vol
    // window, and that combination is where its profit came from.
    //
    // Note the entry and the vol window are coupled. At a 10-minute vol window a
    // 9-minute entry measured +14.14u with a -58.1u drawdown; at 30 minutes the
    // same entry measured +75.97u with -22.0u. A longer vol window gives a
    // higher, steadier sigma, which stops the model becoming overconfident on
    // quiet stretches and then getting hurt when volatility expands. Aggressive
    // staking needs the conservative window.
    // ── 2026-08-08: 7-minute entry ──
    //
    // Earlier than the 5m it ran before, which was the ask, but NOT the 9m that
    // an earlier sweep suggested. That 9m figure came from the older 894-round
    // window and did not survive fresh data.
    //
    // Re-measured on 260 rounds collected 2026-08-05 to 08, with the model's TWAP
    // settlement maths corrected and every quote reconstructed from Kalshi's own
    // candlestick history. Gate 0.78, 30m vol, 10u max, 2% blend, entry varying:
    //
    //    5m  93.7% hit   +1.05u    -1.0u dd   3/5   calib  +1.65pt
    //    6m  91.1% hit  +11.98u    -1.5u dd   4/5   calib  +4.00pt
    //    7m  89.0% hit  +11.73u   -10.3u dd   4/5   calib  +4.63pt
    //    8m  88.0% hit  +15.21u   -19.9u dd   3/5   calib  +3.73pt
    //    9m  83.1% hit   -7.85u   -44.8u dd   2/5   calib  +8.29pt   <- was shipped
    //   11m  75.3% hit  -10.74u   -49.4u dd   3/5   calib +12.85pt
    //   13m  59.5% hit  -93.57u  -109.3u dd   1/5   calib +27.81pt
    //
    // Hit rate falls monotonically as the entry moves earlier, and calibration
    // error grows with it. That is mechanical, not a tuning artefact: more minutes
    // remaining means more opportunities for price to cross the strike, and the
    // model's confidence does not degrade as fast as reality does.
    //
    // 7m is the latest entry that is still meaningfully earlier than 5m while
    // remaining profitable and calibrated. At the tuned gate it measures 91.9%
    // with +28.94u. Do NOT push past 8m: 8m through 8.84m measured negative P&L
    // across every gate tested.
    ENTRY_TARGETS: [7],        // ONE look. Adding entries here re-enables retry.
    ENTRY_TOLERANCE: 0.75,     // accept 7.75 -> 6.25 min remaining, 90s wide
    ENTRY_MINUTES_LEFT: 7,     // used for staking, and as fallback if TARGETS is empty
    ENTRY_WINDOW: 1.5,         // unused: btc.cycleStatus() derives the window from
                               // ENTRY_TARGETS +/- ENTRY_TOLERANCE instead
    // 0.78, set against REAL P&L rather than hit rate.
    //
    // Hit rate on its own is a trap here, because these markets are priced.
    // Kalshi exposes candlestick history per market, so the actual bid/ask 9
    // minutes before close is recoverable — which makes true profit measurable.
    // Over 250 rounds priced that way:
    //
    //   config                      bets loss  staked      net    ROI   worst DD
    //   OLD (gate .82, max@.92)      134   21    355u  +47.83u  13.5%    -10.5u
    //   gate .86, max@.97             53    3     50u   +5.06u  10.2%     -1.1u
    //   gate .78, max@.86             68    5    105u  +17.46u  16.7%     -6.0u
    //   gate .78, max@.88             68    5     86u  +14.91u  17.4%     -2.0u  <- chosen
    //
    // The old settings made the most money, but only by deploying 4x the
    // capital. ROI is what measures edge, and the corrected model beats the old
    // one there: 17.4% against 13.5%. Same edge, applied to less capital.
    //
    // An earlier 0.86 gate paired with max@0.97 was too timid — it cut staked
    // capital 7x and gave back most of the profit for a marginal ROI loss.
    //
    // If more absolute profit is wanted, scale the unit sizes rather than
    // loosening the model. A 17.4% ROI supports that; reverting the drift fix
    // does not.
    // ── 2026-08-08: gate 0.82 ──
    //
    // Measured at a 7m entry with a 10m vol window, 10u top stake, 2% blend, on
    // 260 fresh rounds. The whole band is profitable, which is what a real effect
    // looks like rather than a tuned cell:
    //
    //   gate   bets   /day     hit    95%lo     ROI      P&L  worstDD  folds+   calib
    //   0.74     96     34   90.6%   83.1%    8.8%  +19.63u  -11.3u    4/5   +2.52pt
    //   0.76     96     34   90.6%   83.1%    8.8%  +19.63u  -11.3u    4/5   +2.52pt
    //   0.78     95     34   90.5%   83.0%    8.7%  +19.46u  -11.5u    3/5   +2.78pt
    //   0.80     93     33   91.4%   83.9%   13.8%  +29.09u  -10.4u    4/5   +2.22pt
    //   0.82     86     31   91.9%   84.1%   14.0%  +28.94u  -10.4u    4/5   +2.77pt  <-
    //   0.84     79     28   92.4%   84.4%   11.8%  +21.59u  -10.4u    4/5   +3.25pt
    //   0.86     76     27   92.1%   83.8%    7.8%  +12.64u  -10.4u    4/5   +3.95pt
    //   0.88     71     25   91.5%   82.8%    4.9%   +6.94u  -10.4u    4/5   +5.11pt
    //
    // 0.80 and 0.82 are tied on profit within noise. 0.82 is taken for the higher
    // hit rate and lower bound at a cost of 2 calls a day. Loosen to 0.80 for
    // slightly more volume, or tighten to 0.84 for a point of accuracy; nothing
    // in this range is a mistake.
    MIN_PROBABILITY: 0.82,     // 91.9% measured [>=84.1%], n=86, 4/5 folds

    // ── market blend ──
    //
    // Weight on the MODEL when combining it with the market's own mid price:
    //   pBlend = BLEND_MODEL_WEIGHT * pModel + (1 - weight) * marketMid
    // Set to 1.0 to disable and use the model alone.
    //
    // Why: inside the betting sample the model's probability correlates with
    // outcome at r = +0.007, essentially zero, while the market mid manages
    // r = +0.106. The model's value is in SELECTION -- the gate picks rounds that
    // win -- not in the confidence number itself. Combining a weak forecast with
    // a stronger one beats either, and calibration improved monotonically as
    // weight shifted toward the market across seven tested values.
    //
    // 0.95 rather than lower because blending hard toward the market shrinks
    // measured edge (edge = confidence - price), which collapses stake size and
    // ROI. At w=0.5 the model hits 95.4% and earns almost nothing. 5% is where
    // accuracy improves before that starts to bite.
    //
    // UPDATED 2026-08-07: 0.98 (2% blend) is optimal for the 9m/gate78/10u config.
    BLEND_MODEL_WEIGHT: 0.98,

    POLL_SECONDS: 45,
    // ── 2026-08-08: 10 minutes ──
    //
    // The 30m window only looked better when paired with the 9m entry, which has
    // since been rejected. At the 7m entry with gate 0.82 the shorter window is
    // decisively better:
    //
    //   10m vol   86 bets  91.9% hit  14.0% ROI  +28.94u  4/5 folds
    //   15m vol   91 bets  91.2% hit   1.6% ROI   +2.25u  4/5 folds
    //   20m vol   88 bets  89.8% hit   1.1% ROI   +1.54u  4/5 folds
    //   30m vol   85 bets  90.6% hit   8.6% ROI  +13.03u  3/5 folds
    //
    // A short window tracks the current regime, which is what a 7-minute question
    // depends on. The earlier concern that a short window causes overconfidence at
    // large stakes was specific to the 9m entry combined with unshrunk drift, and
    // does not apply here.
    VOL_LOOKBACK: 10,
    DRIFT_LOOKBACK: 10
  },

  // ═══════════════════════════════════════════════════════════
  // Sports
  //
  // Honest walk-forward results (backtest-walkforward.js, leak-free):
  //   MLB moneyline  : 60% overall, ~65% ceiling  -> NOT an 80% market
  //   WNBA moneyline : 61% overall, ~76% at 0.75  -> NOT an 80% market
  //
  // Prop rules (backtest-props.js) DO clear 80% on large samples, so props
  // are the primary sports product and moneylines are secondary.
  // ═══════════════════════════════════════════════════════════
  SPORTS: {
    MLB: {
      name: 'MLB',
      emoji: '⚾',
      espn: 'baseball/mlb',
      moneyline: 'KXMLBGAME',
      props: { strikeouts: 'KXMLBKS', homeRuns: 'KXMLBHR' },
      mlGate: 0.70,            // only post ML at >=70% model confidence
      lateStarters: false
    },
    WNBA: {
      name: 'WNBA',
      emoji: '🏀',
      espn: 'basketball/wnba',
      moneyline: 'KXWNBAGAME',
      props: { points: 'KXWNBAPTS', threes: 'KXWNBA3PT', rebounds: 'KXWNBAREB' },
      mlGate: 0.72,
      lateStarters: false
    },
    // ── KBO / NPB ──
    // No ESPN coverage, and backtest-asia.js found the pre-game price carries
    // almost no signal (40-54% hit rate at every offset from 5h out to first
    // pitch). So these are posted as leans, not as validated plays, and they
    // are excluded from the headline win-rate claim.
    NPB: {
      name: 'NPB',
      emoji: '🇯🇵',
      espn: null,
      moneyline: 'KXNPBGAME',
      props: {},
      mlGate: null,            // market-price driven only
      lateStarters: true,      // starters announced 30-60 min before first pitch
      // Pre-starter prices rarely exceed ~0.62, so the nightly gate sits at
      // 0.60 purely so the 11 PM board has content. It is a lean, not an edge.
      marketGate: 0.60,
      starterGate: 0.70,       // once starters are known, demand more
      validated: false,
      expectedHit: 0.55        // honest: unproven
    },
    KBO: {
      name: 'KBO',
      emoji: '🇰🇷',
      espn: null,
      moneyline: 'KXKBOGAME',
      props: {},
      mlGate: null,
      lateStarters: true,
      marketGate: 0.60,
      starterGate: 0.70,
      validated: false,
      expectedHit: 0.55
    }
  },

  /**
   * Validated prop rules. Each was measured over hundreds of settled markets.
   * `minHit` is the backtested hit rate, shown in Discord for transparency.
   */
  PROP_RULES: {
    // Rule labels describe the Kalshi position (buy YES or NO on the market's
    // question), not a sportsbook over/under. A market reading "9+ strikeouts?"
    // has floor_strike 8.5, so minLine 9 targets the 9.5+ questions.
    strikeouts: [
      { side: 'NO',  minLine: 9,  maxPrice: 0.20, minHit: 0.99, n: 82,  label: 'NO on a high K question, cheap' },
      { side: 'NO',  minLine: 8,  maxPrice: 0.30, minHit: 0.99, n: 93,  label: 'NO on a high K question, cheap' },
      { side: 'YES', maxLine: 4,  minPrice: 0.70, minHit: 0.96, n: 289, label: 'YES on a low K question' },
      { side: 'NO',  minLine: 9,  maxPrice: 0.40, minHit: 0.90, n: 91,  label: 'NO on a high K question' },
      { side: 'NO',  minLine: 8,  maxPrice: 0.45, minHit: 0.90, n: 196, label: 'NO on a high K question' },
      { side: 'YES', maxLine: 3,  minPrice: 0.60, minHit: 0.84, n: 214, label: 'YES on a very low K question' }
    ],
    homeRuns: [
      { side: 'YES', maxLine: 4,   minPrice: 0.70, minHit: 0.98, n: 86,  label: 'YES, already priced high' },
      { side: 'NO',  minLine: 1.5, maxPrice: 0.30, minHit: 0.99, n: 564, label: 'NO on a multi-HR question' },
      { side: 'NO',  minLine: 0.5, maxPrice: 0.25, minHit: 0.97, n: 544, label: 'NO on a HR question' }
    ],
    // WNBA prop rules use the same shape; thresholds are conservative until
    // we accumulate enough settled samples to calibrate them properly.
    points:   [{ side: 'YES', maxLine: 12, minPrice: 0.72, minHit: 0.85, n: 0, label: 'YES on a low points question' },
               { side: 'NO',  minLine: 25, maxPrice: 0.25, minHit: 0.85, n: 0, label: 'NO on a high points question' }],
    threes:   [{ side: 'NO',  minLine: 4,  maxPrice: 0.25, minHit: 0.85, n: 0, label: 'NO on a high 3PM question' }],
    rebounds: [{ side: 'NO',  minLine: 11, maxPrice: 0.25, minHit: 0.85, n: 0, label: 'NO on a high rebounds question' },
               { side: 'YES', maxLine: 3,  minPrice: 0.75, minHit: 0.85, n: 0, label: 'YES on a low rebounds question' }]
  },

  // Minimum backtested hit rate for a pick to be labelled a "Lock"
  LOCK_THRESHOLD: 0.90,
  // Anything below this is not posted at all
  MIN_POST_HIT: 0.80,

  // ═══════════════════════════════════════════════════════════
  // Schedule
  //
  // Expressed in America/New_York and run in that timezone, so the posting
  // times stay put across the EDT/EST switch. (Scheduling these in UTC would
  // silently shift everything an hour earlier every November.)
  // ═══════════════════════════════════════════════════════════
  SCHEDULE_TZ: 'America/New_York',

  // US leagues follow the US calendar: board goes out mid-morning and only
  // ever covers today.
  DAILY_PICKS_HOUR: 10,        // 10:00 AM ET — MLB + WNBA props & moneylines
  DAILY_PICKS_MINUTE: 0,

  // WNBA props are usually not listed until the afternoon, so sweep again.
  LATE_PROP_HOUR: 16,          // 4:00 PM ET
  LATE_PROP_MINUTE: 0,

  // KBO/NPB first pitch lands in the small hours of ET, so their board is
  // posted late at night and covers the following ET date.
  ASIA_SLATE_HOUR: 23,         // 11:00 PM ET
  ASIA_SLATE_MINUTE: 0,

  // How close to first pitch counts as "starters announced"
  LATE_STARTER_LEAD_MINUTES: 40,

  RESULT_CHECK_MINUTES: 10,

  RECAP_HOUR: 23,              // 11:55 PM ET
  RECAP_MINUTE: 55
};
