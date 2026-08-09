/**
 * Tennis stats bot. Separate process, separate token, separate Discord application.
 *
 * Deliberately independent of the crypto bot: it shares no state file, no client and
 * no command registry. Registering global commands from two processes on one
 * application silently deletes the other's commands, and that class of accident is
 * avoided most cheaply by not sharing the application at all.
 *
 * ── what it can tell you ──
 *
 * Everything derivable from set-by-set match history: per-set win rates, the
 * conditional records that actually decide matches ("set 3 after losing set 2"),
 * surface splits, recent form, streaks and head-to-head. Source is
 * tennis-data.co.uk, one workbook per tour per season.
 *
 * ── what it cannot ──
 *
 * Anything below set level. There are no aces, no double faults, no service games,
 * no point sequences in this source, so "5 double faults and 0 aces this match" and
 * "hasn't held serve two games in a row" are out of reach. Those need point-by-point
 * data, and the free feeds carrying it are not reachable from here.
 *
 * ── on the prediction ──
 *
 * Measured against 4,617 matches with no lookahead: 64.1% accuracy and 0.6428 log
 * loss, against the closing market's 67.6% and 0.5922. So it beats a coin flip and
 * LOSES to the book. It is presented as an explanation of a matchup, never as an
 * edge over the price, because that is what the measurement supports.
 *
 *   node tennis-bot.js
 */

/**
 * Load .env into process.env, without a dependency.
 *
 * Resolved against __dirname rather than the working directory. A CWD-relative path
 * silently finds nothing when the process is started from anywhere other than the
 * project root — a systemd unit, a scheduler, or `node ~/tennis/tennis-bot.js` — and
 * the symptom is an unset token rather than a missing file, which is a needlessly
 * confusing way to learn about it.
 *
 * Existing environment variables win, so a value set by the host is never
 * overwritten by a stale local file.
 */
(function loadEnv() {
  const fs = require('fs');
  const file = require('path').join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;      // environment wins
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (e) {
    console.error(`[tennis] could not read .env: ${e.message}`);
  }
})();

const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes,
        SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const data = require('./src/tennisdata');
const stats = require('./src/tennisstats');
const predictor = require('./src/tennispredict');
const live = require('./src/tennislive');
const core = require('./src/tenniscore');

/**
 * Token for THIS application. TENNIS_BOT_TOKEN only — never DISCORD_TOKEN.
 *
 * There is deliberately no fallback to DISCORD_TOKEN. That variable holds the CRYPTO
 * bot's token in this workspace (application 1534343128176267372, against the tennis
 * application 1535837744025043005), and onReady does a GLOBAL applicationCommands
 * PUT. Falling back would have quietly registered /compare, /player, /h2h,
 * /accuracy and /matches onto the crypto application and deleted /results, /weekly,
 * /picks, /btc and /status — the precise accident this file's header describes, made
 * more likely rather than less by a convenience fallback.
 *
 * Set it in the environment, or in a .env file next to this script:
 *   TENNIS_BOT_TOKEN=...
 */
const TOKEN = (process.env.TENNIS_BOT_TOKEN || '').trim().replace(/^Bot\s+/i, '');

/** The application id a bot token belongs to, or null if it is not decodable. */
function applicationIdOf(token) {
  const seg = String(token).split('.')[0] || '';
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const id = Buffer.from(b64, 'base64').toString('utf8');
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

if (!TOKEN) {
  console.error('[tennis] TENNIS_BOT_TOKEN is not set.');
  console.error('[tennis] Put it in a .env file beside tennis-bot.js:');
  console.error('[tennis]     TENNIS_BOT_TOKEN=...');
  console.error('[tennis] or set it in the environment. DISCORD_TOKEN is NOT used:');
  console.error('[tennis] it belongs to a different application, and registering this');
  console.error('[tennis] bot\'s commands there would delete that bot\'s commands.');
  process.exit(1);
}
if (TOKEN.split('.').length !== 3) {
  console.error(`[tennis] TENNIS_BOT_TOKEN has ${TOKEN.split('.').length} dot-separated ` +
    `segment(s), expected 3 — this looks like a client secret or an application id, ` +
    `not a bot token.`);
  process.exit(1);
}
// console.log, not `line`: that binding is declared further down and is still in
// its temporal dead zone here.
console.log(`[tennis] token resolves to application ${applicationIdOf(TOKEN) || '(undecodable)'}`);

/** How many seasons of history to load. Career figures need depth; loading is cached. */
const CAREER_FROM = new Date().getFullYear() - 6;
const CAREER_TO = new Date().getFullYear();

const line = console.log;

// ── name resolution ────────────────────────────────────────────
//
// The source stores names as "Sinner J." — surname, initial. Users type "Sinner",
// "sinner j", or "Jannik Sinner". All three have to land on the same player, and an
// ambiguous surname has to say so rather than silently picking one.

function normaliseName(s) {
  return String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a typed query to candidate history names.
 *
 * `exact` was previously read without being declared anywhere, which threw a
 * ReferenceError rather than doing anything. The three branches guarded by it are
 * only reached when none of the exact tiers match, so the crash was invisible for
 * exact surnames and certain for everything else — including every menu pick of a
 * particled name, because `surnameOf('Botic Van de Zandschulp')` yields
 * "zandschulp" while the history is keyed on the leading token, "van".
 *
 * It is now a real parameter, defaulting to allowing prefixes for TYPED queries
 * (where a user half-remembering a spelling is the normal case) and set true for
 * anything resolved from a fixture, where a silent near-miss means showing the
 * wrong player's statistics.
 *
 * @param {string} query
 * @param {string[]} allNames
 * @param {object} opts
 *   exact  when true, only exact-tier matches count; no prefix or substring fallback
 */
function resolvePlayer(query, allNames, { exact = false } = {}) {
  const q = normaliseName(query);
  if (!q) return { matches: [] };

  const scored = [];
  for (const name of allNames) {
    const n = normaliseName(name);          // "sinner j"
    const surname = n.split(' ')[0];
    const qWords = q.split(' ');

    let score = 0;
    if (n === q) score = 100;
    else if (surname === q) score = 90;
    else if (qWords.includes(surname)) score = 80;      // "jannik sinner" -> sinner
    // Prefix matches score below the exact tiers and are excluded entirely when
    // `exact` is set. This is the rule that turned "zhu" into "Zhukayev B." — a
    // different player, silently, because no exact "zhu" existed in that tour.
    else if (!exact && surname.startsWith(q)) score = 60;
    else if (!exact && n.startsWith(q)) score = 55;
    else if (!exact && n.includes(q)) score = 30;

    if (score) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Keep only the best tier, so "sinner" does not return every partial match.
  const best = scored.length ? scored[0].score : 0;
  return { matches: scored.filter(s => s.score === best).map(s => s.name) };
}

// ── formatting ─────────────────────────────────────────────────
//
// Discord renders ANSI colour inside ```ansi fences, which is the only way to get
// the green highlighting the request asks for. Embeds cannot colour individual
// cells, so the comparison table is a fenced block and the embed carries the summary.

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[0;32m',
  bold: '\u001b[1;37m',
  dim: '\u001b[0;30m',
  red: '\u001b[0;31m'
};

/** A rate as "73% (11)", dimmed when the sample cannot support it. */
function fmtRate(r, { highlight = false } = {}) {
  if (!r || r.pct == null || r.n === 0) return '—';
  const body = `${(r.pct * 100).toFixed(0)}% (${r.n})`;
  const thin = !r.reliable ? '*' : '';
  if (highlight) return `${ANSI.green}${body}${thin}${ANSI.reset}`;
  return `${body}${thin}`;
}

const padVisible = (s, w) => {
  // Pad on VISIBLE length, ignoring ANSI escapes, or coloured cells misalign.
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '').length;
  return s + ' '.repeat(Math.max(0, w - visible));
};

/**
 * The comparison table.
 *
 * Higher percentage highlighted green per row, which is what the request asked for
 * and what makes the table readable at a glance. A row where both are equal or
 * either is missing highlights neither — inventing a winner there would be worse
 * than leaving it plain.
 */
/**
 * The point-level rows: ace splits and break potential.
 *
 * Kept in a separate block from the set-level table because they come from a
 * different source with materially thinner coverage, and running them together would
 * imply the whole table rests on the same evidence. Every row carries its own
 * denominator for that reason.
 *
 * For break potential CONCEDED, lower is better — so the highlight is inverted on
 * that row. Highlighting the higher number there would praise the worse server.
 */
function pointBlock(nameA, nameB, pa, pb) {
  if (!pa && !pb) return null;

  const W = 17, M = 36;
  const out = [];
  const pct1 = v => v == null ? '—' : `${(v * 100).toFixed(0)}%`;
  const n1 = v => v == null ? '—' : v.toFixed(1);
  const withN = (r) => r == null || r.pct == null ? '—'
    : `${(r.pct * 100).toFixed(0)}% (${r.n})${r.n < 10 ? '*' : ''}`;

  const row = (label, va, vb, fmt, higherIsBetter = true) => {
    const na = va == null ? null : Number(va.pct != null ? va.pct : va);
    const nb = vb == null ? null : Number(vb.pct != null ? vb.pct : vb);
    let aWin = false, bWin = false;
    if (na != null && nb != null && na !== nb) {
      const aBigger = na > nb;
      aWin = higherIsBetter ? aBigger : !aBigger;
      bWin = !aWin;
    }
    const fa = fmt(va), fb = fmt(vb);
    out.push(
      padVisible(aWin ? `${ANSI.green}${fa}${ANSI.reset}` : fa, W) +
      padVisible(label, M) +
      (bWin ? `${ANSI.green}${fb}${ANSI.reset}` : fb)
    );
  };

  out.push(`${ANSI.bold}${padVisible('POINT-LEVEL', W)}` +
    `${padVisible('(charted matches only)', M)}${ANSI.reset}`);
  out.push('─'.repeat(W + M + W));

  row('Win % when opp hit MORE aces', pa?.winWhenOppMoreAces, pb?.winWhenOppMoreAces, withN);
  row('Win % when opp hit FEWER aces', pa?.winWhenOppFewerAces, pb?.winWhenOppFewerAces, withN);
  row('Aces per match', pa?.avgAces, pb?.avgAces, n1);
  out.push('─'.repeat(W + M + W));
  row('Break potential per match', pa?.breakPotentialPerMatch, pb?.breakPotentialPerMatch, n1);
  row('Break potential per rtn game', pa?.breakPotentialRate, pb?.breakPotentialRate, pct1);
  // Lower is better: this is what they allow on their OWN serve.
  row('Conceded per match (lower=better)', pa?.concededPerMatch, pb?.concededPerMatch, n1, false);
  row('Conceded per svc game', pa?.concededRate, pb?.concededRate, pct1, false);

  out.push('─'.repeat(W + M + W));
  out.push(padVisible(String(pa ? pa.breakPotentialMatches : '—'), W) +
    padVisible('Charted matches w/ point data', M) +
    String(pb ? pb.breakPotentialMatches : '—'));

  return '```ansi\n' + out.join('\n') + '\n```';
}

function comparisonBlock(nameA, nameB, a, b, surface) {
  const ROWS = [
    ['Last 10', 'lastTen'],
    ['Win after winning set 1', 'winAfterSet1Won'],
    ['Win after losing set 1', 'winAfterSet1Lost'],
    ['Set 1 win %', 'set1'],
    ['Set 2 win %', 'set2'],
    ['Set 3 win %', 'set3'],
    ['Set 2 after winning set 1', 'set2AfterSet1Won'],
    ['Set 2 after losing set 1', 'set2AfterSet1Lost'],
    ['Set 3 after winning set 2 · yr', 'set3AfterSet2WonYear'],
    ['Set 3 after winning set 2 · career', 'set3AfterSet2WonCareer'],
    ['Set 3 after losing set 2 · yr', 'set3AfterSet2LostYear'],
    ['Set 3 after losing set 2 · career', 'set3AfterSet2LostCareer'],
    ['Win % this year', 'winYear'],
    ['Win % career', 'winCareer']
  ];
  if (surface) ROWS.push([`Surface (${surface}) · career`, 'surfaceCareer']);

  const W = 17, M = 36;
  const out = [];
  out.push(`${ANSI.bold}${padVisible(shortName(nameA), W)}${padVisible('', 2)}` +
    `${padVisible('', M - 2)}${shortName(nameB)}${ANSI.reset}`);
  out.push('─'.repeat(W + M + W));

  for (const [label, key] of ROWS) {
    const ra = a[key], rb = b[key];
    const pa = ra && ra.pct, pb = rb && rb.pct;
    const aWins = pa != null && pb != null && pa > pb;
    const bWins = pa != null && pb != null && pb > pa;
    out.push(
      padVisible(fmtRate(ra, { highlight: aWins }), W) +
      padVisible(label, M) +
      fmtRate(rb, { highlight: bWins })
    );
  }

  // Streaks are not rates, so they sit below the table rather than inside it.
  const stk = s => s.streak.type ? `${s.streak.type}${s.streak.n}` : '—';
  const s3 = s => s.set3Streak.type ? `${s.set3Streak.type}${s.set3Streak.n}` : '—';
  out.push('─'.repeat(W + M + W));
  out.push(padVisible(stk(a), W) + padVisible('Current run', M) + stk(b));
  out.push(padVisible(s3(a), W) + padVisible('Set-3 run', M) + s3(b));
  out.push(padVisible(String(a.decidersPlayed), W) +
    padVisible('Deciders played', M) + String(b.decidersPlayed));

  return '```ansi\n' + out.join('\n') + '\n```';
}

const shortName = n => n.length > 16 ? n.slice(0, 15) + '…' : n;

/** Why the model leans the way it does, strongest factors first. */
function reasoning(pred, nameA, nameB) {
  const out = [];
  for (const p of pred.parts.slice(0, 4)) {
    if (Math.abs(p.diff) < 0.01) continue;
    const who = p.diff > 0 ? nameA : nameB;
    const label = {
      surface: 'surface record', career: 'career win rate', year: 'form this year',
      recent: 'last 10', set1: 'set 1 win rate', h2h: 'head to head'
    }[p.name] || p.name;
    out.push(`**${who}** on ${label} (${(Math.abs(p.diff) * 100).toFixed(0)}pt after shrinkage)`);
  }
  return out.length ? out.join('\n') : 'No factor separates them meaningfully.';
}

// ── commands ───────────────────────────────────────────────────

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('compare')
    .setDescription('Full stat comparison of two players, with a prediction')
    .addStringOption(o => o.setName('player1').setDescription('e.g. Sinner').setRequired(true))
    .addStringOption(o => o.setName('player2').setDescription('e.g. Alcaraz').setRequired(true))
    .addStringOption(o => o.setName('tour').setDescription('atp or wta')
      .addChoices({ name: 'ATP', value: 'atp' }, { name: 'WTA', value: 'wta' }))
    .addStringOption(o => o.setName('surface').setDescription('Hard, Clay, Grass, Carpet')
      .addChoices({ name: 'Hard', value: 'Hard' }, { name: 'Clay', value: 'Clay' },
                  { name: 'Grass', value: 'Grass' }, { name: 'Carpet', value: 'Carpet' })),

  new SlashCommandBuilder()
    .setName('player')
    .setDescription('One player\'s full set-by-set profile')
    .addStringOption(o => o.setName('name').setDescription('e.g. Swiatek').setRequired(true))
    .addStringOption(o => o.setName('tour').setDescription('atp or wta')
      .addChoices({ name: 'ATP', value: 'atp' }, { name: 'WTA', value: 'wta' }))
    .addStringOption(o => o.setName('surface').setDescription('Hard, Clay, Grass, Carpet')
      .addChoices({ name: 'Hard', value: 'Hard' }, { name: 'Clay', value: 'Clay' },
                  { name: 'Grass', value: 'Grass' }, { name: 'Carpet', value: 'Carpet' })),

  new SlashCommandBuilder()
    .setName('h2h')
    .setDescription('Head-to-head match history between two players')
    .addStringOption(o => o.setName('player1').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('player2').setDescription('Player').setRequired(true))
    .addStringOption(o => o.setName('tour').setDescription('atp or wta')
      .addChoices({ name: 'ATP', value: 'atp' }, { name: 'WTA', value: 'wta' })),

  new SlashCommandBuilder()
    .setName('accuracy')
    .setDescription('How well the prediction model scores against the closing market')
    .addStringOption(o => o.setName('tour').setDescription('atp or wta')
      .addChoices({ name: 'ATP', value: 'atp' }, { name: 'WTA', value: 'wta' })),

  new SlashCommandBuilder()
    .setName('matches')
    .setDescription('Live and upcoming matches across ATP, WTA, Challenger and ITF')
    .addBooleanOption(o => o.setName('live')
      .setDescription('Only matches already in progress (default: off)'))
    .addBooleanOption(o => o.setName('all')
      .setDescription('Also include scheduled matches with no history (default: off)'))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Cached history per tour, loaded on demand. */
const loaded = new Map();
async function history(tour) {
  if (loaded.has(tour)) return loaded.get(tour);
  const { matches, missing } = await data.seasons(tour, CAREER_FROM, CAREER_TO, { log: line });
  const rec = { matches, missing, names: data.players(matches) };
  loaded.set(tour, rec);
  return rec;
}

/**
 * Point-level statistics for a player, or null if they are not charted.
 *
 * Two sources have to be joined here: the charting project supplies aces and point
 * scores under "Jannik Sinner", the set-level history supplies win/loss under
 * "Sinner J.". The join is on date and opponent surname, and it is partial by
 * nature — Djokovic joins at 29% because much of his charted career predates the
 * seasons loaded here, while Sinner joins at 82%.
 *
 * Returns the denominators so the caller can show how thin the sample is, which for
 * these two statistics matters more than for any other row in the table.
 */
async function pointProfile(tour, setLevelName, setLevelViews) {
  // Charting names are "First Last"; the set-level name is "Last F.".
  const surname = String(setLevelName).trim().toLowerCase().split(/[\s.]+/)[0];
  let idx;
  try {
    idx = await core.matchIndex(tour, { log: line });
  } catch (e) {
    return null;
  }

  // Find the charting spelling that shares this surname.
  const candidates = new Set();
  for (const [, m] of idx) {
    for (const p of [m.p1, m.p2]) {
      const last = String(p).trim().toLowerCase().split(/\s+/).pop();
      if (last === surname) candidates.add(p);
    }
  }
  if (!candidates.size) return null;

  // A surname shared by several charted players cannot be resolved from a surname
  // alone, so the most-charted one is used and the ambiguity is reported.
  let best = null, bestN = -1;
  for (const c of candidates) {
    let n = 0;
    for (const [, m] of idx) if (m.p1 === c || m.p2 === c) n++;
    if (n > bestN) { bestN = n; best = c; }
  }

  let records;
  try {
    records = await core.playerMatches(tour, best, { log: line });
  } catch (e) {
    return null;
  }
  if (!records.length) return null;

  const join = core.attachOutcomes(records, best, setLevelViews);
  const ps = core.pointStats(records);
  return { ...ps, chartedAs: best, ambiguous: candidates.size > 1, join };
}

/** Resolve a query to one player, or explain why it could not be done. */
function pick(query, names, { exact = false } = {}) {
  const r = resolvePlayer(query, names, { exact });
  if (!r.matches.length) return { error: `No player matching **${query}**.` };
  if (r.matches.length > 4) {
    return { error: `**${query}** matches ${r.matches.length} players. Be more specific.` };
  }
  if (r.matches.length > 1) {
    return { error: `**${query}** is ambiguous: ${r.matches.map(m => `\`${m}\``).join(', ')}` };
  }
  return { name: r.matches[0] };
}

async function onCompare(i) {
  const tour = i.options.getString('tour') || 'atp';
  const surface = i.options.getString('surface') || null;
  const { matches, names, missing } = await history(tour);

  const a = pick(i.options.getString('player1'), names);
  const b = pick(i.options.getString('player2'), names);
  if (a.error || b.error) {
    return i.editReply(`${a.error || ''}${a.error && b.error ? '\n' : ''}${b.error || ''}`);
  }
  if (a.name === b.name) return i.editReply('Those are the same player.');

  const vA = stats.forPlayer(matches, a.name);
  const vB = stats.forPlayer(matches, b.name);
  const opts = { year: CAREER_TO, surface };
  const pA = stats.profile(vA, opts);
  const pB = stats.profile(vB, opts);
  const h2h = stats.headToHead(matches, a.name, b.name);
  const pred = predictor.predict(pA, pB, h2h);

  // Point-level rows come from a second source and can legitimately be missing.
  const [ptA, ptB] = await Promise.all([
    pointProfile(tour, a.name, vA).catch(() => null),
    pointProfile(tour, b.name, vB).catch(() => null)
  ]);

  const favourite = pred.pA >= 0.5 ? a.name : b.name;
  const favP = Math.max(pred.pA, pred.pB);

  const e = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${a.name}  vs  ${b.name}`)
    .setDescription(
      `**${favourite}** favoured at **${(favP * 100).toFixed(0)}%**` +
      (surface ? ` on ${surface}` : '') + '\n' +
      `Head to head: **${h2h.aWins}-${h2h.bWins}**` +
      (h2h.n ? ` in ${h2h.n} meeting${h2h.n === 1 ? '' : 's'}` : ' — never met') + '\n' +
      `_${CAREER_FROM}-${CAREER_TO} · ${tour.toUpperCase()} · ` +
      `${vA.length} and ${vB.length} matches on record_'`.replace(/'$/, '')
    )
    .addFields(
      { name: 'Why', value: reasoning(pred, a.name, b.name) },
      {
        name: 'How much to trust this',
        value:
          `Evidence weight **${(pred.evidence * 100).toFixed(0)}%** — how much of the ` +
          `read is real sample rather than prior.\n` +
          `Measured on 4,617 past matches with no lookahead, this model scores ` +
          `**64.1%** accuracy against the closing market's **67.6%**. It beats a coin ` +
          `flip and loses to the book, so treat it as an explanation of the matchup, ` +
          `not an edge over the price.` +
          (missing.length ? `\n_Seasons unavailable: ${missing.join(', ')}_` : '')
      }
    )
    .setFooter({ text: 'Green = better.  * = under 10 matches, rate not reliable.' });

  const blocks = [comparisonBlock(a.name, b.name, pA, pB, surface)];
  const pb = pointBlock(a.name, b.name, ptA, ptB);
  if (pb) {
    blocks.push(pb);
  } else {
    blocks.push('_No charted point data for either player — ace splits and break ' +
      'potential need the Match Charting Project, which covers a subset of matches._');
  }

  // Point-level coverage stated explicitly: these two rows rest on far less data
  // than the rest of the table and saying so is the difference between a statistic
  // and a decoration.
  if (ptA || ptB) {
    const cov = [];
    if (ptA) cov.push(`${a.name}: ${ptA.join.joined}/${ptA.charted} matches joined`);
    if (ptB) cov.push(`${b.name}: ${ptB.join.joined}/${ptB.charted} matches joined`);
    e.addFields({ name: 'Point-data coverage', value:
      cov.join(' · ') +
      `\nAce splits need a win/loss join between two sources with different name ` +
      `formats and it is partial by nature. Break potential = returner reached ` +
      `0-30, 0-40 or 15-40, counted once per game.` });
  }

  return i.editReply({ content: blocks.join('\n'), embeds: [e] });
}

async function onPlayer(i) {
  const tour = i.options.getString('tour') || 'atp';
  const surface = i.options.getString('surface') || null;
  const { matches, names } = await history(tour);
  const p = pick(i.options.getString('name'), names);
  if (p.error) return i.editReply(p.error);

  const views = stats.forPlayer(matches, p.name);
  const s = stats.profile(views, { year: CAREER_TO, surface });

  const row = (label, r) => `\`${label.padEnd(34)}\` ${fmtRate(r).replace(/\u001b\[[0-9;]*m/g, '')}`;
  const recent = views.slice(0, 8).map(v => {
    const sc = v.sets.map(([m2, o]) => `${m2}-${o}`).join(' ');
    return `${v.won ? '✅' : '❌'} vs ${v.opponent} · ${sc || v.match.comment}` +
      ` · ${v.match.surface} · ${v.match.tournament}`;
  }).join('\n') || 'no matches on record';

  const e = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${p.name} — ${tour.toUpperCase()}`)
    .setDescription(
      `${views.length} matches ${CAREER_FROM}-${CAREER_TO}\n` +
      `Current run **${s.streak.type || '—'}${s.streak.n}** · ` +
      `set-3 run **${s.set3Streak.type || '—'}${s.set3Streak.n}** over ` +
      `${s.decidersPlayed} decider${s.decidersPlayed === 1 ? '' : 's'}`
    )
    .addFields(
      { name: 'Overall', value: [
        row('Win % career', s.winCareer),
        row('Win % this year', s.winYear),
        row('Last 10', s.lastTen),
        surface ? row(`Surface (${surface})`, s.surfaceCareer) : null
      ].filter(Boolean).join('\n') },
      { name: 'By set', value: [
        row('Set 1 win %', s.set1),
        row('Set 2 win %', s.set2),
        row('Set 3 win %', s.set3)
      ].join('\n') },
      { name: 'Conditional', value: [
        row('Win after winning set 1', s.winAfterSet1Won),
        row('Win after losing set 1', s.winAfterSet1Lost),
        row('Set 2 after winning set 1', s.set2AfterSet1Won),
        row('Set 2 after losing set 1', s.set2AfterSet1Lost),
        row('Set 3 after winning set 2 · career', s.set3AfterSet2WonCareer),
        row('Set 3 after losing set 2 · career', s.set3AfterSet2LostCareer)
      ].join('\n') },
      { name: 'Recent matches', value: recent.slice(0, 1024) }
    )
    .setFooter({ text: '* = under 10 matches. Set stats exclude retirements.' });

  return i.editReply({ embeds: [e] });
}

async function onH2H(i) {
  const tour = i.options.getString('tour') || 'atp';
  const { matches, names } = await history(tour);
  const a = pick(i.options.getString('player1'), names);
  const b = pick(i.options.getString('player2'), names);
  if (a.error || b.error) return i.editReply(a.error || b.error);

  const h = stats.headToHead(matches, a.name, b.name);
  const list = h.matches.slice(0, 12).map(m => {
    const sc = m.sets.map(([w, l]) => `${w}-${l}`).join(' ');
    const d = m.date ? m.date.toISOString().slice(0, 10) : '';
    return `\`${d}\` **${m.winner}** beat ${m.loser} ${sc} · ${m.surface} · ${m.tournament}`;
  }).join('\n') || 'These two have never met in the loaded seasons.';

  const e = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`${a.name} vs ${b.name} — head to head`)
    .setDescription(`**${h.aWins}-${h.bWins}**` +
      (h.n ? ` across ${h.n} meeting${h.n === 1 ? '' : 's'}` : '') +
      (h.n && h.n < 5 ? '\n_Small sample — a head-to-head this short says little._' : ''))
    .addFields({ name: 'Meetings', value: list.slice(0, 1024) });

  return i.editReply({ embeds: [e] });
}

/** Both tours' player lists, keyed by tour so coverage never crosses them. */
async function allNames() {
  const [atp, wta] = await Promise.all([history('atp'), history('wta')]);
  return { atp, wta, byTour: { atp: atp.names, wta: wta.names } };
}

async function onMatches(i) {
  const showAll = i.options.getBoolean('all') || false;
  const liveOnly = i.options.getBoolean('live') || false;

  // No limit here. Filtering happens AFTER coverage is known, so truncating the
  // fetch would silently drop analysable matches in favour of unanalysable ones
  // that merely start sooner.
  let fixtures = await live.upcoming({ limit: Infinity });
  if (!fixtures.length) {
    return i.editReply('No open tennis matches on Kalshi right now.');
  }

  const ongoing = fixtures.filter(f => f.isLive);
  if (liveOnly) {
    fixtures = ongoing;
    if (!fixtures.length) {
      return i.editReply(
        `No tennis match has started in the last ${live.LIVE_WINDOW_MS / 3600000} hours. ` +
        `Run \`/matches\` without \`live:true\` to see what is scheduled.`);
    }
  }

  const { byTour } = await allNames();
  const { covered, uncovered } = live.splitByCoverage(fixtures, byTour);

  /**
   * A LIVE match is shown whether or not we hold history for it.
   *
   * "What is on right now" is the question being asked, and answering it with an
   * empty list because the players are ITF-level would be technically consistent
   * and useless. ITF and Challenger make up 238 of the 254 open markets and almost
   * none of those players appear in tour-level history, so the coverage filter alone
   * hid every ongoing match. Unanalysable ones are still marked, so picking one
   * explains itself rather than failing mysteriously.
   */
  // Keyed on eventTicker, not object identity. splitByCoverage returns spread
  // COPIES of the covered fixtures, so an identity check against the original
  // array silently reports every match as unanalysable.
  const analysableIds = new Set(covered.map(f => f.eventTicker));
  const shown = [
    ...covered,
    ...uncovered.filter(f => showAll || f.isLive)
  ].sort(live.byLiveThenSoonest);

  // Discord allows 25 options in one select menu.
  const list = shown.slice(0, 25);

  if (!list.length) {
    return i.editReply(
      `Found ${fixtures.length} open match(es), none of them in progress and none ` +
      `with both players in the loaded history. Kalshi lists mostly ITF and ` +
      `Challenger, and this history covers tour level. Try \`/matches all:true\`.`);
  }

  const fmtWhen = ms => {
    if (!ms) return 'TBC';
    const d = new Date(ms);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
    
    const time = d.toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York'
    });
    
    if (isToday) return `Today ${time}`;
    if (isTomorrow) return `Tomorrow ${time}`;
    
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York'
    });
  };
  
  const fmtStatus = f => {
    if (!f.isLive) return fmtWhen(f.startMs);

    // When the schedule is stale the timestamp points into the future, so an
    // elapsed time computed from it would be negative or nonsense. Say LIVE and
    // stop, rather than printing a number that is known to be wrong.
    if (f.startUnreliable) return 'LIVE now';

    const elapsed = Math.floor((Date.now() - f.startMs) / 60000);
    if (elapsed < 60) return `LIVE ${elapsed}m in`;
    return `LIVE ${Math.floor(elapsed / 60)}h${String(elapsed % 60).padStart(2, '0')} in`;
  };

  const menu = new StringSelectMenuBuilder()
    .setCustomId('pickmatch')
    .setPlaceholder('Choose a match…')
    .addOptions(list.map(f => {
      const label = `${f.playerA} vs ${f.playerB}`.slice(0, 100);
      const analysable = analysableIds.has(f.eventTicker);

      /**
       * What the menu hands back when this option is chosen.
       *
       * The TOUR is carried explicitly rather than inferred later. Inferring it from
       * a surname is what resolved "Zhu" to "Zhukayev": the surname existed in the
       * wrong tour's list and was prefix-matched to a different player.
       *
       * The NAMES are the exact history names that coverage already resolved, joined
       * with '~' when the history spells one player several ways. Nothing is
       * re-derived here. Passing a surname KEY instead is what produced
       * "zhang is ambiguous: Zhang R., Zhang S." — the key had thrown away the
       * forename initial that resolution had just used.
       *
       * Unanalysable fixtures are listed too (live ones always are), and for those
       * there is no resolved name to send. The full Kalshi name goes instead so the
       * failure message can name the player the user actually clicked.
       */
      const side = (resolved, fallback) =>
        (resolved && resolved.length) ? resolved.join('~') : fallback;
      const value = [
        f.tour,
        side(f.resolvedA, f.playerA),
        side(f.resolvedB, f.playerB)
      ].join('|').slice(0, 100);

      // Status/time first, then the competition, round, price, and any warning.
      // `level` distinguishes ATP from ITF W, which matters now that five series
      // are merged into one list.
      const parts = [fmtStatus(f), f.level];
      if (f.tournament) parts.push(f.tournament);
      if (f.round) parts.push(f.round);
      parts.push(`${(f.priceA * 100).toFixed(0)}/${(f.priceB * 100).toFixed(0)}`);
      if (!analysable) parts.push('no history');

      return {
        label,
        value,
        description: parts.join(' · ').slice(0, 100),
        emoji: f.isLive ? '🔴' : (analysable ? '🎾' : '❔')
      };
    }));

  // Count by level so the mix is visible; ATP/WTA are a small slice of the board.
  const byLevel = {};
  for (const f of fixtures) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  const levelLine = Object.entries(byLevel)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');

  const hiddenCount = shown.length - list.length;

  const e = new EmbedBuilder()
    .setColor(ongoing.length ? 0xed4245 : 0x1abc9c)
    .setTitle(ongoing.length
      ? `${ongoing.length} match${ongoing.length === 1 ? '' : 'es'} in progress`
      : 'Upcoming matches')
    .setDescription(
      `**${fixtures.length}** open match${fixtures.length === 1 ? '' : 'es'} across ` +
      `ATP, WTA, Challenger and ITF — ${levelLine}.\n` +
      `**${ongoing.length}** in progress · **${covered.length}** with both players in ` +
      `their own tour's history.` +
      (hiddenCount > 0
        ? `\n_Showing the first 25; ${hiddenCount} more not listed (Discord menu limit)._`
        : '') +
      (!showAll && uncovered.some(f => !f.isLive)
        ? `\n_${uncovered.filter(f => !f.isLive).length} scheduled match(es) hidden ` +
          `for having no history. Use \`all:true\` to include them._`
        : '') +
      `\n\n🔴 in progress · 🎾 analysable · ❔ no tour-level history\n` +
      `Live matches are always listed, with or without history.\n\n` +
      `Times are ET, from Kalshi's \`occurrence_datetime\`. Prices are Kalshi's, ` +
      `normalised to sum to 100 — the benchmark, not this bot's prediction.`
    )
    .setFooter({ text: 'Fixtures from Kalshi · stats from tennis-data.co.uk + MCP' });

  return i.editReply({ embeds: [e], components: [new ActionRowBuilder().addComponents(menu)] });
}

/**
 * A menu choice runs the same comparison /compare does.
 *
 * Replies rather than edits, so the picked match appears as a new message under the
 * menu and the menu stays usable for the next match — which is what "updates happen
 * with reply" asks for.
 */
/**
 * All of a player's matches, unioned across the spellings the source uses for them.
 *
 * forPlayer() compares names with ===, so "Fernandez L." and "Fernandez L.A." are two
 * different players to it and each holds part of one record. Concatenating and
 * re-sorting is what makes a variant pair behave as the single player it is.
 */
function viewsForNames(matches, names) {
  if (names.length === 1) return stats.forPlayer(matches, names[0]);
  return names
    .flatMap(n => stats.forPlayer(matches, n))
    .sort((x, y) => (y.match.date?.getTime() || 0) - (x.match.date?.getTime() || 0));
}

/** Head-to-head across every spelling of both players. */
function h2hForNames(matches, aNames, bNames) {
  if (aNames.length === 1 && bNames.length === 1) {
    return stats.headToHead(matches, aNames[0], bNames[0]);
  }
  const aSet = new Set(aNames), bSet = new Set(bNames);
  // Rewrite to one canonical spelling per side, then ask the normal question.
  const canonA = aNames[0], canonB = bNames[0];
  const rewritten = matches
    .filter(m => (aSet.has(m.winner) && bSet.has(m.loser)) ||
                 (bSet.has(m.winner) && aSet.has(m.loser)))
    .map(m => ({
      ...m,
      winner: aSet.has(m.winner) ? canonA : canonB,
      loser: aSet.has(m.loser) ? canonA : canonB
    }));
  return stats.headToHead(rewritten, canonA, canonB);
}

async function onPickMatch(i) {
  // Everything in the value was produced by a lookup that already succeeded: the
  // tour comes from Kalshi, and the names are exact history names. Nothing is
  // re-resolved from a surname here, which is what previously reintroduced the
  // ambiguity that coverage had already settled.
  const [tourRaw, rawA, rawB] = String(i.values[0]).split('|');
  const tour = (tourRaw === 'atp' || tourRaw === 'wta') ? tourRaw : 'atp';
  const { matches, names } = await history(tour);

  const known = new Set(names);
  const parseSide = raw => {
    const parts = String(raw || '').split('~').filter(Boolean);
    const hits = parts.filter(p => known.has(p));
    return { hits, raw: parts.join(' / ') || String(raw || '') };
  };
  const a = parseSide(rawA);
  const b = parseSide(rawB);

  // A live ITF or Challenger match is listed whether or not history exists, so
  // arriving here with nothing to look up is expected rather than exceptional.
  if (!a.hits.length || !b.hits.length) {
    const missing = [!a.hits.length ? a.raw : null, !b.hits.length ? b.raw : null]
      .filter(Boolean);
    return i.editReply(
      `No ${tour.toUpperCase()} history for **${missing.join('** and **')}**.\n\n` +
      `_This match is listed because it is in progress on Kalshi, not because it can ` +
      `be analysed. Kalshi lists mostly ITF and Challenger, and this history covers ` +
      `tour level, so players below tour level are genuinely absent. Matching ` +
      `requires the surname AND the forename initial to agree, which is what stops a ` +
      `fixture for one player resolving to a different one who happens to share a ` +
      `surname._`);
  }

  // Surface is unknown from the fixture feed, so career-wide figures are used and
  // the absence is stated rather than a surface being guessed.
  const vA = viewsForNames(matches, a.hits);
  const vB = viewsForNames(matches, b.hits);
  const opts = { year: CAREER_TO, surface: null };
  const pA = stats.profile(vA, opts);
  const pB = stats.profile(vB, opts);
  const h2h = h2hForNames(matches, a.hits, b.hits);
  const pred = predictor.predict(pA, pB, h2h);

  // One spelling per side for display. Where the source uses several, the first is
  // shown and the rest are named in the footnote, so a merged record is visible
  // rather than implied.
  const nameA = a.hits[0], nameB = b.hits[0];
  const favourite = pred.pA >= 0.5 ? nameA : nameB;
  const favP = Math.max(pred.pA, pred.pB);

  const variantNote = [
    a.hits.length > 1 ? `${nameA} also recorded as ${a.hits.slice(1).join(', ')}` : null,
    b.hits.length > 1 ? `${nameB} also recorded as ${b.hits.slice(1).join(', ')}` : null
  ].filter(Boolean);

  const e = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${nameA}  vs  ${nameB}`)
    .setDescription(
      `**${favourite}** favoured at **${(favP * 100).toFixed(0)}%** on the stats\n` +
      `Head to head: **${h2h.aWins}-${h2h.bWins}**` +
      (h2h.n ? ` in ${h2h.n} meeting${h2h.n === 1 ? '' : 's'}` : ' — never met') +
      `\n_${tour.toUpperCase()} · ${vA.length} and ${vB.length} matches on record · ` +
      `surface not known from the fixture, so figures are career-wide_` +
      (variantNote.length
        ? `\n_Records combined across spellings — ${variantNote.join('; ')}._`
        : '')
    )
    .addFields(
      { name: 'Why', value: reasoning(pred, nameA, nameB) },
      { name: 'Trust', value:
        `Evidence weight **${(pred.evidence * 100).toFixed(0)}%**. This model scores ` +
        `**64.1%** accuracy against the market's **67.6%** over 4,617 past matches, ` +
        `so it explains a matchup rather than beating a price.` }
    )
    .setFooter({ text: 'Green = higher.  * = under 10 matches.' });

  return i.editReply({ content: comparisonBlock(nameA, nameB, pA, pB, null), embeds: [e] });
}

async function onAccuracy(i) {
  const tour = i.options.getString('tour') || 'atp';
  const { matches } = await history(tour);
  const r = predictor.backtest(matches, { minPrior: 20 });
  const pc = x => x == null ? '—' : `${(x * 100).toFixed(1)}%`;

  const e = new EmbedBuilder()
    .setColor(r.logLoss < r.market.logLoss ? 0x2ecc71 : 0xe67e22)
    .setTitle(`Prediction accuracy — ${tour.toUpperCase()}`)
    .setDescription(
      `Scored on **${r.n}** matches. Each prediction uses only matches that ` +
      `happened EARLIER, so there is no lookahead.`
    )
    .addFields(
      { name: 'Model', value: `Accuracy **${pc(r.accuracy)}**\nLog loss **${r.logLoss?.toFixed(4)}**`, inline: true },
      { name: 'Closing market', value: `Accuracy **${pc(r.market.accuracy)}**\nLog loss **${r.market.logLoss?.toFixed(4)}**`, inline: true },
      { name: 'Read', value:
        `Log loss is the figure that matters — accuracy cannot tell a confident ` +
        `correct call from a marginal one.\n` +
        (r.logLoss < r.market.logLoss
          ? `The model is better calibrated than the book here, which is a strong ` +
            `claim and deserves suspicion before it deserves money.`
          : `The book is better calibrated, which is the expected result. It has ` +
            `injury news, late scratches and money on the line; this has six shrunk ` +
            `rates. Use it to understand a matchup, not to overrule a price.`) +
        `\n\nA coin flip scores 50% and 0.6931.` }
    );

  return i.editReply({ embeds: [e] });
}

/**
 * Ready handler, bound to BOTH event names.
 *
 * discord.js v14 emits 'ready' and v15 renamed it 'clientReady'. Installed here is
 * 14.16.3, so listening only for 'clientReady' meant this never ran: the bot logged
 * in, sat there, and registered zero commands with no error to explain it. src/bot.js
 * already binds both for exactly this reason. `settled` keeps it idempotent when a
 * version fires both.
 */
let readyDone = false;
const onReady = async () => {
  if (readyDone) return;
  readyDone = true;
  line(`[tennis] logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
    line(`[tennis] registered ${COMMANDS.length} commands: ` +
      COMMANDS.map(c => '/' + c.name).join(', '));
  } catch (e) {
    line(`[tennis] command registration failed: ${e.message}`);
  }
  // Warm the ATP cache so the first command is not a 30-second wait.
  history('atp').then(h => line(`[tennis] ATP ready: ${h.matches.length} matches, ` +
    `${h.names.length} players`)).catch(e => line(`[tennis] preload failed: ${e.message}`));
};

client.once('ready', onReady);
client.once('clientReady', onReady);

client.on('interactionCreate', async i => {
  // ── menu selections ──
  //
  // deferReply rather than deferUpdate, so the result posts as a NEW message under
  // the menu and the menu itself survives for the next pick. deferUpdate would
  // replace the menu with the result and end the session after one match.
  if (i.isStringSelectMenu()) {
    if (i.customId !== 'pickmatch') return;
    try { await i.deferReply(); } catch (_) { return; }
    try {
      await onPickMatch(i);
      line(`[tennis] match picked by ${i.user.tag}: ${i.values[0]}`);
    } catch (e) {
      line(`[tennis] pick failed: ${e.message}`);
      try { await i.editReply(`Failed: ${e.message}`); } catch (_) {}
    }
    return;
  }

  if (!i.isChatInputCommand()) return;
  // Deferred immediately: loading six seasons can exceed Discord's 3-second window.
  try { await i.deferReply(); } catch (_) { return; }

  const handlers = {
    compare: onCompare, player: onPlayer, h2h: onH2H,
    accuracy: onAccuracy, matches: onMatches
  };
  const fn = handlers[i.commandName];
  if (!fn) return i.editReply('Unknown command.');

  try {
    await fn(i);
    line(`[tennis] /${i.commandName} by ${i.user.tag}`);
  } catch (e) {
    line(`[tennis] /${i.commandName} failed: ${e.message}`);
    try { await i.editReply(`\`/${i.commandName}\` failed: ${e.message}`); } catch (_) {}
  }
});

client.on('error', e => line(`[tennis] client error: ${e.message}`));
process.on('unhandledRejection', e => line(`[tennis] unhandled: ${e?.message || e}`));

client.login(TOKEN).catch(e => {
  line(`[tennis] login failed: ${e.message}`);
  process.exit(1);
});
