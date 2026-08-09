/**
 * Minimal .xlsx reader. Enough to read a flat data sheet, nothing more.
 *
 * Written inline rather than adding a dependency, for the same reason config.js
 * parses .env by hand: this is a hundred lines of well-specified format, the only
 * consumer is one data feed, and a spreadsheet library is a large surface to take
 * on for the ability to read a table of tennis results.
 *
 * An .xlsx file is a ZIP archive of XML. Two members matter:
 *
 *   xl/worksheets/sheet1.xml   the cells, as <c r="A2" t="s"><v>7</v></c>
 *   xl/sharedStrings.xml       the string table those t="s" values index into
 *
 * Numbers are stored inline; strings are interned in the shared table, which is
 * why a naive reader that ignores sharedStrings returns a sheet full of integers
 * where the text should be.
 *
 * Only STORED (method 0) and DEFLATE (method 8) entries are handled, which is what
 * every writer in practice produces. Anything else throws rather than returning a
 * partial sheet quietly.
 */

const zlib = require('zlib');

// ── ZIP ────────────────────────────────────────────────────────

/**
 * Entries in a ZIP buffer, read from the END OF CENTRAL DIRECTORY record.
 *
 * Walking local file headers from the front is the obvious approach and is wrong:
 * a streamed archive can carry sizes of 0 in the local header with the real values
 * in a trailing data descriptor. The central directory is authoritative.
 */
function zipEntries(buf) {
  // Find the EOCD signature, scanning back from the end. The comment field is
  // variable length, so its position is not fixed.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);      // offset of first central-directory entry

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Decompress one entry, located via its local header. */
function readEntry(buf, entry) {
  const off = entry.localOffset;
  if (buf.readUInt32LE(off) !== 0x04034b50) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data;                 // stored
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

// ── XML ────────────────────────────────────────────────────────

const XML_ENT = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
};
const unescapeXml = s => s
  .replace(/&(amp|lt|gt|quot|apos);/g, m => XML_ENT[m])
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * The shared string table, in order.
 *
 * Each <si> may hold one <t> or several inside <r> runs when a cell mixes
 * formatting. Concatenating every <t> within the <si> is what reassembles the
 * value; taking only the first would silently truncate such cells.
 */
function sharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1] || '';
    let s = '';
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(inner)) !== null) s += t[1];
    out.push(unescapeXml(s));
  }
  return out;
}

/** Column letters to a zero-based index: A->0, Z->25, AA->26. */
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Rows of a worksheet as arrays of strings.
 *
 * Cells are placed by their `r` reference rather than by encounter order, because
 * empty cells are simply absent from the XML — appending in order would shift every
 * value after a gap into the wrong column, which is the classic way a spreadsheet
 * reader appears to work and returns misaligned data.
 */
function sheetRows(xml, strings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const inner = rm[1] || '';
    const cells = [];
    const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(inner)) !== null) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      const type = (attrs.match(/t="([^"]+)"/) || [, ''])[1];

      let value = '';
      if (type === 'inlineStr') {
        const t = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = t ? unescapeXml(t[1]) : '';
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        const raw = v ? v[1] : '';
        if (type === 's') {
          const i = Number(raw);
          value = Number.isInteger(i) && strings[i] != null ? strings[i] : '';
        } else {
          value = unescapeXml(raw);
        }
      }
      cells[idx] = value;
    }
    // Normalise holes to empty strings so consumers can index without guarding.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/**
 * Read the first worksheet of an .xlsx buffer as objects keyed by header row.
 *
 * @param {Buffer} buf
 * @returns {{headers: string[], rows: object[]}}
 */
function parse(buf) {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map(e => [e.name, e]));

  // Writers vary on the sheet path; take sheet1 if present, else the first sheet.
  const sheetEntry = byName.get('xl/worksheets/sheet1.xml')
    || entries.find(e => /^xl\/worksheets\/.*\.xml$/.test(e.name));
  if (!sheetEntry) throw new Error('no worksheet found in workbook');

  const ssEntry = byName.get('xl/sharedStrings.xml');
  const strings = ssEntry ? sharedStrings(readEntry(buf, ssEntry).toString('utf8')) : [];
  const rows = sheetRows(readEntry(buf, sheetEntry).toString('utf8'), strings);

  if (!rows.length) return { headers: [], rows: [] };

  // Strip a BOM from the first header, which is how "ATP" arrives as "\uFEFFATP".
  const headers = rows[0].map((h, i) =>
    (i === 0 ? String(h).replace(/^\uFEFF/, '') : String(h)).trim());

  const out = [];
  for (const r of rows.slice(1)) {
    if (!r.length || r.every(c => c === '')) continue;
    const o = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) o[headers[i]] = r[i] != null ? r[i] : '';
    }
    out.push(o);
  }
  return { headers, rows: out };
}

module.exports = { parse, zipEntries, readEntry, sharedStrings, sheetRows, colIndex };
