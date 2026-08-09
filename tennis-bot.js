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
const api = require('./src/tennisapi');
const board = require('./src/tennisboard');

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

  // Same 38-column, label-first layout as comparisonBlock, for the same reason.
  const L = 18, V = 10;
  const out = [];
  const pct1 = v => v == null ? '—' : `${Math.round(v * 100)}%`;
  const n1 = v => v == null ? '—' : Number(v).toFixed(1);
  const withN = r => (r == null || r.pct == null) ? '—'
    : `${Math.round(r.pct * 100)}%(${r.n})${r.n < 10 ? '*' : ''}`;

  const row = (label, va, vb, fmt, higherIsBetter = true) => {
    const na = va == null ? null : Number(va.pct != null ? va.pct : va);
    const nb = vb == null ? null : Number(vb.pct != null ? vb.pct : vb);
    let aw = false, bw = false;
    if (na != null && nb != null && na !== nb) {
      const aBigger = na > nb;
      aw = higherIsBetter ? aBigger : !aBigger;
      bw = !aw;
    }
    const fa = fmt(va) + (aw ? '^' : ''), fb = fmt(vb) + (bw ? '^' : '');
    out.push(
      label.padEnd(L) +
      padVisible(aw ? `${ANSI.green}${fa}${ANSI.reset}` : fa, V) +
      (bw ? `${ANSI.green}${fb}${ANSI.reset}` : fb)
    );
  };

  out.push(`${ANSI.bold}POINT-LEVEL (charted only)${ANSI.reset}`);
  out.push('─'.repeat(L + V + V));
  row('Win, opp MORE aces', pa?.winWhenOppMoreAces, pb?.winWhenOppMoreAces, withN);
  row('Win, opp FEWER aces', pa?.winWhenOppFewerAces, pb?.winWhenOppFewerAces, withN);
  row('Aces / match', pa?.avgAces, pb?.avgAces, n1);
  out.push('─'.repeat(L + V + V));
  row('Break pot / match', pa?.breakPotentialPerMatch, pb?.breakPotentialPerMatch, n1);
  row('Break pot / rtn gm', pa?.breakPotentialRate, pb?.breakPotentialRate, pct1);
  // Lower is better: this is what they allow on their OWN serve.
  row('Conceded / match', pa?.concededPerMatch, pb?.concededPerMatch, n1, false);
  row('Conceded / svc gm', pa?.concededRate, pb?.concededRate, pct1, false);
  out.push('─'.repeat(L + V + V));
  out.push('Charted matches'.padEnd(L) +
    String(pa ? pa.breakPotentialMatches : '—').padEnd(V) +
    String(pb ? pb.breakPotentialMatches : '—'));

  return '```ansi\n' + out.join('\n') + '\n```';
}

// ── live match detail embed ─────────────────────────────────────

/**
 * Point score with advantage spelled out.
 *
 * api-tennis writes advantage as "A" in the point score, so "A - 40" is the server
 * holding advantage. Left as-is rather than converted to "AD" because that is what
 * the source says and inventing a different notation for the same thing invites a
 * mismatch when the raw value is also shown.
 */
function fmtPoints(game) {
  if (!game) return null;
  const s = String(game).trim();
  return (!s || s === '-') ? null : s.replace(/\s+/g, ' ');
}

/** The one-line score summary: sets, then the game in progress. */
function fmtLiveScoreLine(e) {
  const sets = e.sets.map(([a, b]) => `${a}-${b}`).join('  ');
  const pts = fmtPoints(e.game);
  return `\`${sets || '—'}\`${pts ? `   pts \`${pts}\`` : ''}`;
}

/**
 * The live statistics table, when the level publishes any.
 *
 * ITF returns an empty statistics array even with point-by-point populated, so this
 * returns null there rather than rendering an empty frame. Challenger and above gave
 * 17 match-period stats across Service, Return, Points and Games.
 *
 * Double faults are the one row where LOWER is better, so the marker is inverted.
 */
const LIVE_STAT_ROWS = [
  ['Aces', 'Aces', true],
  ['Double faults', 'Double Faults', false],
  ['1st serve in', '1st serve percentage', true],
  ['1st serve won', '1st serve points won', true],
  ['2nd serve won', '2nd serve points won', true],
  ['BP saved', 'Break Points Saved', true],
  ['BP converted', 'Break Points Converted', true],
  ['Service pts won', 'Service Points Won', true],
  ['Return pts won', 'Return Points Won', true],
  ['Total pts won', 'Total Points Won', true],
  ['Service games', 'Service games won', true],
  ['Last 10 balls', 'Last 10 balls', true]
];

function liveStatsBlock(detail) {
  const m = detail.stats && detail.stats.match;
  if (!m || !m.size) return null;

  const L = 18, V = 10;
  const out = [];
  out.push(`${ANSI.bold}${'MATCH STATS'.padEnd(L)}${'A'.padEnd(V)}B${ANSI.reset}`);
  out.push('─'.repeat(L + V + V));

  const numOf = v => {
    if (!v || v.value == null) return null;
    const n = parseFloat(String(v.value).replace('%', ''));
    return isFinite(n) ? n : null;
  };

  let rendered = 0;
  for (const [label, name, higherBetter] of LIVE_STAT_ROWS) {
    const row = m.get(name);
    if (!row || (!row.A && !row.B)) continue;
    rendered++;

    const na = numOf(row.A), nb = numOf(row.B);
    let aw = false, bw = false;
    if (na != null && nb != null && na !== nb) {
      const aBigger = na > nb;
      aw = higherBetter ? aBigger : !aBigger;
      bw = !aw;
    }
    const show = v => v && v.value != null ? String(v.value) : '—';
    const ca = show(row.A) + (aw ? '^' : ''), cb = show(row.B) + (bw ? '^' : '');
    out.push(
      label.padEnd(L) +
      padVisible(aw ? `${ANSI.green}${ca}${ANSI.reset}` : ca, V) +
      (bw ? `${ANSI.green}${cb}${ANSI.reset}` : cb)
    );
  }
  if (!rendered) return null;

  out.push('');
  out.push('^ = better this match');
  return '```ansi\n' + out.join('\n') + '\n```';
}

/**
 * The live embed that sits under the comparison.
 *
 * Deliberately a SECOND embed rather than more fields on the first: one describes
 * career form and does not change, the other is the current state of a match and is
 * rewritten every refresh. Merging them would mean re-sending static content on every
 * tick and make it unclear which numbers are live.
 */
function liveDetailEmbed(detail) {
  const e = detail.entry;
  const A = e.playerA, B = e.playerB;
  const serving = s => e.serving === s ? '🎾 ' : '';
  const lead = s => (s === 'A' ? e.setsWonA > e.setsWonB : e.setsWonB > e.setsWonA);

  const em = new EmbedBuilder()
    .setColor(e.state === 'live' ? 0xed4245 : 0x2b2d31)
    .setTitle(e.state === 'live' ? `🔴 LIVE · ${e.status}` : `${e.status || 'Not started'}`)
    .setDescription(
      `**${e.level}** · ${e.tournament}${e.round ? ' · ' + e.round : ''}` +
      (e.qualifying ? ' _(qualifying)_' : '') + '\n\n' +
      `${serving('A')}${lead('A') ? `**${A}**` : A}\n` +
      `${serving('B')}${lead('B') ? `**${B}**` : B}\n\n` +
      fmtLiveScoreLine(e) +
      (e.serving ? `\n🎾 ${e.serving === 'A' ? A : B} serving` : '')
    );

  // Break point / set point / match point on the current point.
  const flags = detail.pbp && detail.pbp.flags;
  if (flags && (flags.bp || flags.sp || flags.mp)) {
    const which = [flags.mp && 'MATCH POINT', flags.sp && 'SET POINT', flags.bp && 'BREAK POINT']
      .filter(Boolean);
    em.addFields({ name: '⚠️ ' + which.join(' · '), value: '\u200b' });
  }

  // Breaks of serve so far, which the scoreline alone does not show.
  if (detail.pbp && (detail.pbp.breaks.A || detail.pbp.breaks.B)) {
    em.addFields({
      name: 'Breaks of serve',
      value: `${A} **${detail.pbp.breaks.A}** · ${B} **${detail.pbp.breaks.B}**`,
      inline: true
    });
  }

  // Live market.
  if (detail.odds) {
    const o = detail.odds.outright;
    const pc = p => p == null ? '—' : `${Math.round(p * 100)}%`;
    const bits = [];
    if (o && o.decimalA) {
      bits.push(`**${o.decimalA.toFixed(2)}** / **${o.decimalB.toFixed(2)}**  (${pc(o.pA)} / ${pc(o.pB)})`);
    }
    const sw = detail.odds.setWinner;
    if (sw && sw.pA != null) bits.push(`set ${detail.odds.setNo}: ${pc(sw.pA)} / ${pc(sw.pB)}`);
    const gw = detail.odds.gameWinner;
    if (gw && gw.pA != null) bits.push(`this game: ${pc(gw.pA)} / ${pc(gw.pB)}`);
    if (detail.odds.goesToDecider && isFinite(detail.odds.goesToDecider.value)) {
      bits.push(`goes to a decider: ${detail.odds.goesToDecider.value.toFixed(2)}`);
    }
    if (o && o.suspended) bits.push('_betting suspended_');
    if (bits.length) em.addFields({ name: 'Live market', value: bits.join('\n') });
  }

  /**
   * Recent games, newest last, so a run of holds or a break is visible.
   *
   * The SET is labelled because `after` restarts each set: a tail spanning a set
   * boundary otherwise reads "4-2" then "4-1" and looks like the score went
   * backwards. Newest first would be worse — a game sequence is read forwards.
   */
  if (detail.pbp && detail.pbp.recent.length) {
    const setNum = s => {
      const m = String(s || '').match(/(\d+)/);
      return m ? `S${m[1]}` : '--';
    };
    const lines = detail.pbp.recent.slice(-5).map(g => {
      const who = g.servedBy === 'A' ? A : B;
      return `\`${setNum(g.set)} ${String(g.after || '').padEnd(5)}\` ` +
        `${g.broken ? '**BREAK**' : 'held'} · ${who}`;
    });
    em.addFields({ name: 'Recent games (oldest first)', value: lines.join('\n').slice(0, 1024) });
  }

  /**
   * Break potential, derived from the points rather than read from a stats feed.
   *
   * This is the block that makes ITF useful: that level publishes no statistics at
   * all, but the point sequence is there, so return pressure can be counted directly.
   * A return game where the returner reached 30 or 40 is a game where the break was
   * live, counted once per game — the same definition used for charted career data, so
   * the live figure and the career figure mean the same thing.
   */
  if (detail.hasPoints && detail.derived) {
    const d = detail.derived;
    const pct = v => v == null ? '—' : `${Math.round(v * 100)}%`;
    const side = (s, name) => {
      const x = d[s];
      if (!x.returnGames && !x.serviceGames) return null;
      return `**${name}**\n` +
        `· reached 30+ in **${x.reached30}/${x.returnGames}** return games (${pct(x.breakPotentialRate)})\n` +
        `· reached 40+ in **${x.reached40}/${x.returnGames}** · break pts in **${x.bpGames}**\n` +
        `· broke **${x.breaks}** of those, taking ${pct(x.conversion)} of live chances\n` +
        `· held **${x.holds}/${x.serviceGames}** (${pct(x.holdRate)})`;
    };
    const parts = [side('A', A), side('B', B)].filter(Boolean);
    if (parts.length) {
      /**
       * The number of games counted is named, because point-by-point does not always
       * cover every game played — a Challenger match showing 14 games on the scoreline
       * came back with 12 in the point array. Every rate here therefore carries its own
       * denominator, and the total is stated, so a partial window reads as a partial
       * window rather than as the whole match.
       */
      const counted = d.A.serviceGames + d.B.serviceGames;
      em.addFields({
        name: `Break potential — counted from ${counted} completed game${counted === 1 ? '' : 's'} of point data`,
        value: parts.join('\n\n').slice(0, 1024)
      });
    }
  }

  if (!detail.hasStats) {
    em.addFields({ name: 'Published statistics', value:
      `_Not available at ${e.level} level — the API returns an empty statistics array ` +
      `here even though point-by-point is present, so aces and serve percentages are ` +
      `not offered. The break-potential figures above are counted from the points ` +
      `directly and are real._` });
  }

  em.setFooter({ text: 'api-tennis live' }).setTimestamp(new Date());
  return em;
}

/**
 * The comparison table, sized for a phone.
 *
 * ── why it was rebuilt ──
 *
 * The previous layout was 17 + 36 + 17 = 70 monospace columns with the label in the
 * MIDDLE and a value either side. On a phone that is far past the width of a code
 * block, so every row soft-wrapped and the two value columns interleaved with the
 * labels — the table did not just look cramped, it became unreadable. And the green
 * highlight was ANSI, which did not render, so the one cue for "who is better" was
 * gone precisely where the layout needed it most.
 *
 * This version is 38 columns: label first, then both values, which is the ordering
 * that survives a wrap because a wrapped line breaks AFTER the data rather than
 * between the two numbers. The better value is marked with a caret, so the meaning
 * survives with no colour at all, and ANSI green is layered on top for clients that
 * do render it.
 *
 * Labels are abbreviated rather than truncated: "S3 after S2 won" is readable at a
 * glance, "Set 3 after winning set 2 · car…" is not.
 */
function comparisonBlock(nameA, nameB, a, b, surface) {
  const ROWS = [
    ['Last 10', 'lastTen'],
    ['Win % career', 'winCareer'],
    ['Win % this yr', 'winYear'],
    ['Set 1 win %', 'set1'],
    ['Set 2 win %', 'set2'],
    ['Set 3 win %', 'set3'],
    ['Win if won S1', 'winAfterSet1Won'],
    ['Win if lost S1', 'winAfterSet1Lost'],
    ['S2 if won S1', 'set2AfterSet1Won'],
    ['S2 if lost S1', 'set2AfterSet1Lost'],
    ['S3 if won S2 yr', 'set3AfterSet2WonYear'],
    ['S3 if won S2 car', 'set3AfterSet2WonCareer'],
    ['S3 if lost S2 yr', 'set3AfterSet2LostYear'],
    ['S3 if lost S2 car', 'set3AfterSet2LostCareer']
  ];
  if (surface) ROWS.push([`${surface} career`, 'surfaceCareer']);

  const L = 18, V = 10;
  const out = [];

  // Names go in the header, abbreviated hard so two fit in 20 columns.
  const tiny = n => {
    const s = String(n).trim();
    return s.length <= 9 ? s : s.slice(0, 8) + '.';
  };
  out.push(`${ANSI.bold}${'STAT'.padEnd(L)}${tiny(nameA).padEnd(V)}${tiny(nameB)}${ANSI.reset}`);
  out.push('─'.repeat(L + V + V));

  /** "60%(10)^" — the caret is the colour-free marker for the better side. */
  const cell = (r, better) => {
    if (!r || r.pct == null || r.n === 0) return '—';
    const body = `${Math.round(r.pct * 100)}%(${r.n})${r.reliable ? '' : '*'}`;
    return better ? `${body}^` : body;
  };

  for (const [label, key] of ROWS) {
    const ra = a[key], rb = b[key];
    const pa = ra && ra.pct, pb = rb && rb.pct;
    const aw = pa != null && pb != null && pa > pb;
    const bw = pa != null && pb != null && pb > pa;
    const ca = cell(ra, aw), cb = cell(rb, bw);
    out.push(
      label.padEnd(L) +
      padVisible(aw ? `${ANSI.green}${ca}${ANSI.reset}` : ca, V) +
      (bw ? `${ANSI.green}${cb}${ANSI.reset}` : cb)
    );
  }

  // Streaks are not rates, so they sit below rather than inside the table.
  const stk = s => s.streak.type ? `${s.streak.type}${s.streak.n}` : '—';
  const s3 = s => s.set3Streak.type ? `${s.set3Streak.type}${s.set3Streak.n}` : '—';
  out.push('─'.repeat(L + V + V));
  out.push('Current run'.padEnd(L) + String(stk(a)).padEnd(V) + stk(b));
  out.push('Set-3 run'.padEnd(L) + String(s3(a)).padEnd(V) + s3(b));
  out.push('Deciders'.padEnd(L) + String(a.decidersPlayed).padEnd(V) + String(b.decidersPlayed));
  out.push('');
  out.push('^ = better  * = under 10, unreliable');

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
    .setDescription('Live scores and upcoming matches — auto-refreshing')
    .addBooleanOption(o => o.setName('live')
      .setDescription('Only matches already in progress (default: off)'))
    .addStringOption(o => o.setName('level')
      .setDescription('Restrict to one level')
      .addChoices(
        { name: 'ATP', value: 'ATP' },
        { name: 'WTA', value: 'WTA' },
        { name: 'Challenger (men)', value: 'Challenger M' },
        { name: 'Challenger (women)', value: 'Challenger W' },
        { name: 'ITF (men)', value: 'ITF M' },
        { name: 'ITF (women)', value: 'ITF W' },
        { name: 'Boys', value: 'Boys' },
        { name: 'Girls', value: 'Girls' }))
    .addBooleanOption(o => o.setName('odds')
      .setDescription('Show bookmaker prices (default: on)'))
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

  const rawA = i.options.getString('player1');
  const rawB = i.options.getString('player2');
  const a = pick(rawA, names);
  const b = pick(rawB, names);

  /**
   * Not in tour-level history: try api-tennis before giving up.
   *
   * Only when a name is genuinely ABSENT, not when it is ambiguous — an ambiguous
   * query is a question for the user, and silently resolving it against a second
   * source would answer a different question than the one asked.
   */
  const absent = e => typeof e === 'string' && /^No player matching/.test(e);
  if ((a.error && absent(a.error)) || (b.error && absent(b.error))) {
    const c = await apiComparison(tour, rawA, rawB);
    if (!c.error) {
      return i.editReply({
        content: comparisonBlock(c.a.apiName, c.b.apiName, c.a.profile, c.b.profile, null),
        embeds: [apiEmbed(c)]
      });
    }
    return i.editReply(
      `${a.error || ''}${a.error && b.error ? '\n' : ''}${b.error || ''}\n\n${c.error}`);
  }

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

// ── below-tour-level comparison, via api-tennis ─────────────────
//
// tennis-data.co.uk stops at tour level, so ITF and Challenger players — the
// majority of Kalshi's board — had no statistics at all. api-tennis covers them and
// publishes per-set scores, which is what lets the SAME stats engine run on them
// rather than a reduced parallel one.

/** How many seasons of api-tennis history to pull. Each season is one cached call. */
const API_SEASONS_BACK = 3;

/**
 * Resolve one player and load their normalised match history from api-tennis.
 *
 * Widening windows because there is no player-search endpoint: a key can only be
 * discovered by finding the player in a fixture list. Coming from a live Kalshi
 * fixture the player is on court today and the first window hits immediately; a name
 * typed into /compare may belong to someone who last played weeks ago, so the search
 * widens before giving up.
 */
async function apiSideFor(fullName, tour, { around = new Date() } = {}) {
  for (const windowDays of [3, 14, 45]) {
    const found = await api.findPlayerKey(fullName, { tour, around, windowDays });
    if (found) return found;
  }
  return null;
}

/**
 * A full two-player comparison built from api-tennis.
 *
 * Both sides come from the same source deliberately. Mixing a tour-level profile with
 * an api-tennis one would compare figures drawn from different match populations
 * under different name spaces, and head-to-head would be impossible to compute at
 * all, so if either player needs api-tennis then both use it.
 */
async function apiComparison(tour, nameA, nameB, { around = new Date() } = {}) {
  if (!api.available()) {
    return { error: 'API_TENNIS_KEY is not configured, so below-tour-level players cannot be looked up.' };
  }

  const [ka, kb] = await Promise.all([
    apiSideFor(nameA, tour, { around }).catch(() => null),
    apiSideFor(nameB, tour, { around }).catch(() => null)
  ]);

  const missing = [!ka ? nameA : null, !kb ? nameB : null].filter(Boolean);
  if (missing.length) {
    return { error: `api-tennis has no ${tour.toUpperCase()} singles record for ` +
      `**${missing.join('** or **')}**.` };
  }
  return apiComparisonResolved(tour, ka, kb);
}

/**
 * The same comparison when both api-tennis keys are already known.
 *
 * The board hands these over directly, so the fixture-scanning lookup that
 * apiComparison needs is skipped entirely. The player's display name is taken from
 * their profile, since a key carries no name of its own.
 */
async function apiComparisonByKey(tour, keyA, keyB) {
  if (!api.available()) {
    return { error: 'API_TENNIS_KEY is not configured.' };
  }
  if (!keyA || !keyB) return { error: 'That match is missing a player id.' };

  const [prA, prB] = await Promise.all([
    api.playerProfile(keyA).catch(() => null),
    api.playerProfile(keyB).catch(() => null)
  ]);
  const nameOf = (pr, k) => (pr && pr.player_name) ? String(pr.player_name).trim() : `#${k}`;

  return apiComparisonResolved(
    tour,
    { key: String(keyA), apiName: nameOf(prA, keyA) },
    { key: String(keyB), apiName: nameOf(prB, keyB) },
    { prA, prB });
}

/** Shared body: load both histories, profile them, predict. */
async function apiComparisonResolved(tour, ka, kb, pre = {}) {
  if (ka.key === kb.key) return { error: 'Those resolve to the same player.' };

  const toYear = new Date().getUTCFullYear();
  const fromYear = toYear - API_SEASONS_BACK;

  const [mA, mB, prA, prB] = await Promise.all([
    api.playerMatches(ka.key, { fromYear, toYear, tour, log: line }),
    api.playerMatches(kb.key, { fromYear, toYear, tour, log: line }),
    pre.prA !== undefined ? Promise.resolve(pre.prA) : api.playerProfile(ka.key).catch(() => null),
    pre.prB !== undefined ? Promise.resolve(pre.prB) : api.playerProfile(kb.key).catch(() => null)
  ]);

  // One pool, so head-to-head sees both sides of every meeting exactly once.
  const byEvent = new Map();
  for (const m of [...mA, ...mB]) byEvent.set(m.eventKey || Math.random(), m);
  const pool = [...byEvent.values()];

  /**
   * The name to look the player up by, inferred from their own matches.
   *
   * playerMatches(key) returns only that player's fixtures, so their name is the one
   * appearing in EVERY row — which is a more reliable identifier than the profile's
   * `player_name`. Those two are usually identical, but the profile is a separate
   * endpoint and a spelling difference there would silently produce an empty record.
   */
  const nameFromMatches = (rows, fallback) => {
    const count = new Map();
    for (const m of rows) {
      for (const n of [m.winner, m.loser]) count.set(n, (count.get(n) || 0) + 1);
    }
    let best = fallback, bestN = 0;
    for (const [n, c] of count) if (c > bestN) { best = n; bestN = c; }
    return best;
  };

  const dispA = nameFromMatches(mA, ka.apiName);
  const dispB = nameFromMatches(mB, kb.apiName);

  const vA = stats.forPlayer(pool, dispA);
  const vB = stats.forPlayer(pool, dispB);
  if (!vA.length || !vB.length) {
    return { error: `api-tennis returned no completed singles matches for ` +
      `**${!vA.length ? dispA : dispB}** in ${fromYear}-${toYear}.` };
  }
  ka = { ...ka, apiName: dispA };
  kb = { ...kb, apiName: dispB };

  // No surface: api-tennis fixtures do not carry one, so a surface split here would
  // be an empty set dressed up as a statistic.
  const opts = { year: toYear, surface: null };
  const pA = stats.profile(vA, opts);
  const pB = stats.profile(vB, opts);
  const h2h = stats.headToHead(pool, ka.apiName, kb.apiName);
  const pred = predictor.predict(pA, pB, h2h);

  return {
    tour, fromYear, toYear,
    a: { ...ka, views: vA, profile: pA, meta: prA },
    b: { ...kb, views: vB, profile: pB, meta: prB },
    h2h, pred
  };
}

/** Rank and career surface record, the two things only get_players carries. */
function apiMetaLine(side) {
  if (!side.meta) return `${side.apiName}: no profile on record`;
  const r = api.rankSummary(side.meta);
  const s = api.surfaceTotals(side.meta);
  const rec = ([w, l]) => (w + l) ? `${w}-${l}` : '—';
  return `**${side.apiName}** · rank ${r.current ?? '—'}` +
    (r.best ? ` (best ${r.best} in ${r.bestSeason})` : '') +
    ` · hard ${rec(s.hard)} · clay ${rec(s.clay)} · grass ${rec(s.grass)}`;
}

/** Render an api-tennis comparison into the same shape /compare produces. */
function apiEmbed(c) {
  const favourite = c.pred.pA >= 0.5 ? c.a.apiName : c.b.apiName;
  const favP = Math.max(c.pred.pA, c.pred.pB);

  const e = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`${c.a.apiName}  vs  ${c.b.apiName}`)
    .setDescription(
      `**${favourite}** favoured at **${(favP * 100).toFixed(0)}%** on the stats\n` +
      `Head to head: **${c.h2h.aWins}-${c.h2h.bWins}**` +
      (c.h2h.n ? ` in ${c.h2h.n} meeting${c.h2h.n === 1 ? '' : 's'}` : ' — never met') + '\n' +
      `_${c.tour.toUpperCase()} · ${c.a.views.length} and ${c.b.views.length} matches ` +
      `on record, ${c.fromYear}-${c.toYear}_`
    )
    .addFields(
      { name: 'Rank and surface', value: `${apiMetaLine(c.a)}\n${apiMetaLine(c.b)}` },
      { name: 'Why', value: reasoning(c.pred, c.a.apiName, c.b.apiName) },
      { name: 'Source', value:
        `Below tour level, so this comes from **api-tennis**, not tennis-data.co.uk. ` +
        `Set-by-set records are real — every fixture carries per-set games — but ` +
        `there is **no surface on a match**, so the table is career-wide and the ` +
        `surface line above is a season total that cannot be crossed with anything ` +
        `else. Serve statistics are not offered: the API returned an empty ` +
        `statistics array for every match checked at this level.\n` +
        `The 64.1% accuracy figure was measured on tour-level data and has **not** ` +
        `been re-measured here, so treat the percentage as a description of these ` +
        `records rather than a validated forecast.` }
    )
    .setFooter({ text: 'Green = higher.  * = under 10 matches.  Source: api-tennis' });

  return e;
}

// ── the live board ──────────────────────────────────────────────

/** "6-3 3-6 4-1", with the set in progress marked. */
function fmtSets(e) {
  if (!e.sets.length) return '';
  return e.sets.map(([a, b], idx) => {
    const last = idx === e.sets.length - 1;
    const decided = a > b || b > a ? Math.max(a, b) >= 6 : false;
    const s = `${a}-${b}`;
    return (e.state === 'live' && last && !decided) ? `__${s}__` : s;
  }).join(' ');
}

/** A player's name with a serve marker and set count. */
function fmtSide(e, side) {
  const name = side === 'A' ? e.playerA : e.playerB;
  const serving = e.state === 'live' && e.serving === side;
  const leading = side === 'A' ? e.setsWonA > e.setsWonB : e.setsWonB > e.setsWonA;
  const label = leading ? `**${name}**` : name;
  return `${serving ? '🎾 ' : ''}${label}`;
}

/** Market prices as decimals plus the de-vigged percentage. */
function fmtOdds(o) {
  if (!o || !o.decimalA || !o.decimalB) return null;
  const pc = p => p == null ? '—' : `${Math.round(p * 100)}%`;
  return `${o.decimalA.toFixed(2)} / ${o.decimalB.toFixed(2)}  (${pc(o.pA)} / ${pc(o.pB)})`;
}

/**
 * The live markets worth showing beneath a scoreline.
 *
 * The outright already appears on the odds line, so this adds only what is specific
 * to being in play: who the book favours for the CURRENT set and the current game,
 * and whether it expects a decider.
 */
function fmtLiveMarkets(m) {
  const lo = m.liveOdds;
  if (!lo) return null;
  const bits = [];
  const short = (o) => o && o.pA != null
    ? `${Math.round(o.pA * 100)}/${Math.round(o.pB * 100)}` : null;

  const sw = short(lo.setWinner);
  if (sw && lo.setNo) bits.push(`set ${lo.setNo} \`${sw}\``);
  const gw = short(lo.gameWinner);
  if (gw) bits.push(`game \`${gw}\``);
  if (lo.goesToDecider && isFinite(lo.goesToDecider.value)) {
    bits.push(`decider ${lo.goesToDecider.value.toFixed(2)}`);
  }
  if (lo.outright && lo.outright.suspended) bits.push('_suspended_');
  return bits.length ? bits.join(' · ') : null;
}

function fmtClock(ms, tz) {
  if (!ms) return 'TBC';
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const t = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  if (sameDay) return t;
  if (tomorrow) return `tmrw ${t}`;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });
}

/**
 * The board as an embed.
 *
 * Live matches get their own field each, because a scoreline plus a server plus a
 * game score plus a price does not survive being squeezed onto one line. Upcoming
 * matches are one line each, since only the time and the price matter before play.
 */
function boardEmbed(snap, { liveOnly, level, withOdds }) {
  const TZ = snap.timezone;
  const e = new EmbedBuilder()
    .setColor(snap.live.length ? 0xed4245 : 0x1abc9c)
    .setTitle(snap.live.length
      ? `🔴 ${snap.live.length} match${snap.live.length === 1 ? '' : 'es'} in progress`
      : 'Upcoming tennis');

  const mix = Object.entries(snap.byLevel).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(' · ');

  e.setDescription(
    (level ? `Filtered to **${level}**. ` : '') +
    `${snap.live.length} live · ${snap.upcoming.length} upcoming` +
    (mix ? `\n${mix}` : '') +
    `\n\n🎾 marks the server. Times ${TZ.split('/')[1].replace('_', ' ')}.` +
    (withOdds ? ' Prices are the median across books, de-vigged.' : '')
  );

  // Discord allows 25 fields; live detail is worth more than upcoming volume.
  const liveShown = snap.live.slice(0, 10);
  for (const m of liveShown) {
    const line1 = [];
    const sets = fmtSets(m);
    if (sets) line1.push(`\`${sets}\``);
    if (m.game) line1.push(`pts \`${m.game}\``);
    const o = withOdds ? fmtOdds(m.odds) : null;
    if (o) line1.push(`${o}${m.odds && m.odds.live ? ' · live' : ''}`);

    const lines = [
      `${fmtSide(m, 'A')}  vs  ${fmtSide(m, 'B')}`,
      line1.join(' · ') || m.status
    ];
    const lm = withOdds ? fmtLiveMarkets(m) : null;
    if (lm) lines.push(lm);

    e.addFields({
      name: `${m.level} · ${m.tournament}${m.round ? ' · ' + m.round : ''}` +
        (m.qualifying ? ' (Q)' : ''),
      value: lines.join('\n').slice(0, 1024)
    });
  }
  if (snap.live.length > liveShown.length) {
    e.addFields({ name: '\u200b', value: `_+${snap.live.length - liveShown.length} more live_` });
  }

  if (!liveOnly && snap.upcoming.length) {
    const room = Math.max(0, 24 - e.data.fields.length);
    const lines = snap.upcoming.slice(0, 12).map(m => {
      const o = withOdds ? fmtOdds(m.odds) : null;
      return `\`${fmtClock(m.startMs, TZ).padEnd(9)}\` ${m.playerA} vs ${m.playerB}` +
        ` · ${m.level}${o ? ` · ${o.split('  ')[0]}` : ''}`;
    });
    if (room > 0 && lines.length) {
      e.addFields({
        name: `Next up (${snap.upcoming.length})`,
        value: lines.join('\n').slice(0, 1024)
      });
    }
  }

  e.setFooter({ text: 'api-tennis · refreshes automatically for ~14 min' });
  e.setTimestamp(snap.updatedAt);
  return e;
}

/** The picker, carrying api-tennis player keys so nothing is re-resolved by name. */
function boardMenu(snap, liveOnly) {
  const pool = [...snap.live, ...(liveOnly ? [] : snap.upcoming)].slice(0, 25);
  if (!pool.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('pickmatch')
      .setPlaceholder('Compare a match…')
      .addOptions(pool.map(m => {
        // Player KEYS, not names. api-tennis gives them on every row, so the pick
        // needs no surname reconstruction and cannot resolve to the wrong person.
        // The EVENT key rides along so the pick can also pull live match state.
        const tour = /women|wta|girls/i.test(m.eventType) ? 'wta' : 'atp';
        const value = `k|${tour}|${m.keyA}|${m.keyB}|${m.eventKey}`.slice(0, 100);
        const bits = [m.level];
        if (m.state === 'live') {
          const s = fmtSets(m).replace(/__/g, '');
          bits.push(s ? `LIVE ${s}` : 'LIVE');
        } else {
          bits.push(fmtClock(m.startMs, snap.timezone));
        }
        if (m.round) bits.push(m.round);
        return {
          label: `${m.playerA} vs ${m.playerB}`.slice(0, 100),
          value,
          description: bits.join(' · ').slice(0, 100),
          emoji: m.state === 'live' ? '🔴' : '🎾'
        };
      })));
}

/**
 * Refresh cadence and the hard ceiling on any refresh loop.
 *
 * 5 seconds, which is roughly a point. The cost of that is handled in two places
 * rather than by slowing it down:
 *
 *   src/tennisboard.js holds a 4-second shared cache over the two live endpoints, so
 *   several watchers — and the board loop plus a per-match loop — collapse onto one
 *   poll instead of multiplying calls.
 *
 *   Every loop here compares a signature of what it is about to render against what it
 *   last rendered and SKIPS the edit when nothing moved. Tennis spends most of its time
 *   between points, so most ticks change nothing and cost no Discord traffic at all.
 *   That also keeps well clear of the per-message edit rate limit.
 *
 * 14 minutes because a Discord interaction token expires at 15 and every edit after
 * that fails with an unhelpful 401. There is no way to extend it, so the loop stops and
 * says so rather than dying silently mid-match.
 */
const REFRESH_MS = 5000;
const REFRESH_LIMIT_MS = 14 * 60 * 1000;

/**
 * A short string that changes exactly when something worth re-rendering changes.
 *
 * Scores, the point in play, the server, status and the market. Not the timestamp —
 * including it would make every tick look different and defeat the whole point.
 */
function liveSignature(e, odds) {
  const o = odds && odds.outright;
  return [
    e.status,
    e.sets.map(([a, b]) => `${a}-${b}`).join(','),
    e.game || '',
    e.serving || '',
    o && o.decimalA != null ? o.decimalA.toFixed(2) : '',
    o && o.decimalB != null ? o.decimalB.toFixed(2) : ''
  ].join('|');
}

function boardSignature(snap) {
  return snap.live.map(m => `${m.eventKey}:${liveSignature(m, { outright: m.odds })}`).join(';') +
    `#${snap.live.length}/${snap.upcoming.length}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One line explaining why a refresh loop ended, appended to the final edit. */
function stoppedNote(reason) {
  return {
    finished: '_Play finished — refresh stopped. Run `/matches` for the current board._',
    expired: '_Auto-refresh stopped after 14 minutes (Discord token limit). Run the command again._',
    quiet: '_Nothing live — refresh stopped._'
  }[reason] || '_Refresh stopped._';
}

/**
 * Keep the board embed current while matches are in progress.
 *
 * Stops as soon as NOTHING IS LIVE. The previous condition required both the live and
 * the upcoming list to be empty, and the upcoming list is never empty — 150-odd
 * matches are always scheduled — so the loop ran the full 14 minutes and kept polling
 * long after the last ball. It now renders one final frame showing the finished state
 * and stops there.
 *
 * A transient API failure retries on the next tick rather than ending the loop, but an
 * EDIT failure ends it: that means the message or the token is gone and every
 * subsequent attempt would fail the same way.
 */
function startBoardRefresh(interaction, opts, firstSnap) {
  const until = Date.now() + REFRESH_LIMIT_MS;
  let lastSig = firstSnap ? boardSignature(firstSnap) : null;

  const render = async (snap, note) => {
    const menu = boardMenu(snap, opts.liveOnly);
    await interaction.editReply({
      content: note || undefined,
      embeds: [boardEmbed(snap, opts)],
      components: note ? [] : (menu ? [menu] : [])
    });
  };

  const tick = async () => {
    await sleep(REFRESH_MS);

    if (Date.now() > until) {
      try { await interaction.editReply({ content: stoppedNote('expired') }); } catch (_) {}
      return;
    }

    let snap;
    try {
      snap = await board.snapshot({
        days: 2, withOdds: opts.withOdds,
        levels: opts.level ? [opts.level] : null
      });
    } catch (_) {
      return tick();                       // transient; try again next tick
    }

    // Play ended. Show the final state once, then stop.
    if (!snap.live.length) {
      try { await render(snap, stoppedNote(opts.liveOnly ? 'finished' : 'quiet')); } catch (_) {}
      return;
    }

    // Nothing moved between points, which is most ticks. Skip the edit entirely.
    const sig = boardSignature(snap);
    if (sig === lastSig) return tick();
    lastSig = sig;

    try { await render(snap); } catch (_) { return; }
    return tick();
  };

  tick().catch(() => {});
}

/**
 * Keep ONE picked match's live embed current until it finishes.
 *
 * The career comparison above it never changes, so it is captured once and re-sent
 * unchanged on every edit — editReply replaces the whole message, so the static parts
 * have to be carried along rather than left behind.
 *
 * Ends on the first snapshot where the match is no longer live, after rendering the
 * final score. That is the condition the board loop was missing.
 */
function startMatchRefresh(interaction, eventKey, staticParts, firstDetail) {
  const until = Date.now() + REFRESH_LIMIT_MS;
  let lastSig = firstDetail
    ? liveSignature(firstDetail.entry, firstDetail.odds) : null;

  const tick = async () => {
    await sleep(REFRESH_MS);

    if (Date.now() > until) {
      try {
        await interaction.editReply({
          content: ((staticParts.content || '') + '\n' + stoppedNote('expired')).slice(0, 2000),
          embeds: staticParts.embeds
        });
      } catch (_) {}
      return;
    }

    let detail;
    try { detail = await board.liveDetail(eventKey); }
    catch (_) { return tick(); }
    if (!detail) return tick();

    const over = detail.entry.state !== 'live';
    const sig = liveSignature(detail.entry, detail.odds);

    // Between points nothing changes; skip the edit unless the match just ended, which
    // always warrants a final render.
    if (!over && sig === lastSig) return tick();
    lastSig = sig;

    const embeds = [...staticParts.embeds, liveDetailEmbed(detail)];
    const sb = liveStatsBlock(detail);
    let body = (staticParts.content || '') + (sb ? '\n' + sb : '');
    if (over) body += '\n' + stoppedNote('finished');

    try {
      await interaction.editReply({ content: body.slice(0, 2000) || undefined, embeds });
    } catch (_) { return; }

    if (over) return;
    return tick();
  };

  tick().catch(() => {});
}

async function onMatches(i) {
  const liveOnly = i.options.getBoolean('live') || false;
  const level = i.options.getString('level') || null;
  const withOdds = i.options.getBoolean('odds') !== false;

  let snap;
  try {
    snap = await board.snapshot({
      days: 2, withOdds, levels: level ? [level] : null
    });
  } catch (e) {
    return i.editReply(
      `Could not reach api-tennis: ${e.message}\n` +
      `_Set \`API_TENNIS_KEY\` if it is not configured._`);
  }

  if (!snap.live.length && !snap.upcoming.length) {
    return i.editReply(level
      ? `Nothing live or scheduled at **${level}** in the next 2 days.`
      : 'No live or upcoming singles matches in the next 2 days.');
  }
  if (liveOnly && !snap.live.length) {
    return i.editReply(
      `Nothing in progress right now${level ? ` at ${level}` : ''}. ` +
      `${snap.upcoming.length} scheduled — run \`/matches\` without \`live:true\`.`);
  }

  const opts = { liveOnly, level, withOdds };
  const menu = boardMenu(snap, liveOnly);
  await i.editReply({
    embeds: [boardEmbed(snap, opts)],
    components: menu ? [menu] : []
  });

  // Only worth refreshing if something is actually in progress.
  if (snap.live.length) startBoardRefresh(i, opts, snap);
  return;
}

/** Retained for reference: the old Kalshi-sourced path. */
async function onMatchesKalshi(i) {
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
  const value = String(i.values[0]);

  /**
   * "k|tour|keyA|keyB" — api-tennis player keys, straight off the board.
   *
   * This is the whole point of sourcing fixtures from api-tennis: the row already
   * carries first_player_key and second_player_key, so a pick needs no name
   * reconstruction at all. Every wrong-person failure so far came from rebuilding a
   * name and re-resolving it; here there is nothing to rebuild.
   */
  if (value.startsWith('k|')) {
    const [, tourRaw, keyA, keyB, eventKey] = value.split('|');
    const tour = tourRaw === 'wta' ? 'wta' : 'atp';

    // Career comparison and live state are independent: a live match with no history
    // should still show its score, and a scheduled match with history should still
    // compare. So they are fetched together and rendered from whatever came back.
    const [c, detail] = await Promise.all([
      apiComparisonByKey(tour, keyA, keyB),
      eventKey ? board.liveDetail(eventKey).catch(() => null) : Promise.resolve(null)
    ]);

    // The career half never changes, so it is kept separately: a refresh re-sends it
    // untouched and only swaps the live embed and the live stats table.
    const staticEmbeds = [];
    let staticContent = '';
    if (!c.error) {
      staticContent = comparisonBlock(c.a.apiName, c.b.apiName, c.a.profile, c.b.profile, null);
      staticEmbeds.push(apiEmbed(c));
    }

    const embeds = [...staticEmbeds];
    let content = staticContent;
    if (detail) {
      embeds.push(liveDetailEmbed(detail));
      const sb = liveStatsBlock(detail);
      // The stats table goes in the message body, not the embed: a code block inside
      // an embed field is capped at 1024 characters and this table can exceed it.
      if (sb) content = (content ? content + '\n' : '') + sb;
    }

    if (!embeds.length) return i.editReply(c.error || 'Nothing to show for that match.');
    await i.editReply({ content: content || undefined, embeds });

    // Only follow a match that is actually being played.
    if (detail && detail.entry.state === 'live') {
      startMatchRefresh(i, eventKey, { content: staticContent, embeds: staticEmbeds }, detail);
    }
    return;
  }

  // Legacy Kalshi-sourced value: "tour|nameA|nameB", names already resolved against
  // tour-level history. Kept so a menu posted before a restart still works.
  const [tourRaw, rawA, rawB] = value.split('|');
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

  /**
   * Below tour level, fall through to api-tennis rather than refusing.
   *
   * This is the case for most of Kalshi's board, so refusing here is refusing the
   * common path. Both sides are re-resolved against api-tennis, using the ORIGINAL
   * Kalshi names carried in the menu value, because the two sources do not share a
   * name space and half a comparison from each would be meaningless.
   */
  if (!a.hits.length || !b.hits.length) {
    const c = await apiComparison(tour, a.raw, b.raw);
    if (c.error) {
      return i.editReply(
        `No ${tour.toUpperCase()} history for **${[
          !a.hits.length ? a.raw : null, !b.hits.length ? b.raw : null
        ].filter(Boolean).join('** and **')}**, and ${c.error}\n\n` +
        `_Listed because it is in progress on Kalshi, not because it can be analysed._`);
    }
    return i.editReply({
      content: comparisonBlock(c.a.apiName, c.b.apiName, c.a.profile, c.b.profile, null),
      embeds: [apiEmbed(c)]
    });
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
