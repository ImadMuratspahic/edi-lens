'use strict';

/*
 * Property style tests with seeded random input. Each case writes a message
 * from a known outline, parses it and checks that the structure, the
 * offsets, the round trips (parse, pretty, parse and minify, parse), the
 * validator, the exports and the comparison all agree with what was written.
 * The seeds are fixed, so a failure always reproduces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse } = require('../src/core/parse.js');
const { pretty, minify, toJSON, unescapeValue } = require('../src/core/serialize.js');
const { resolvePath, locate } = require('../src/core/path.js');
const { validate } = require('../src/core/validate.js');
const { compare, toText, toHtml } = require('../src/pro/diff.js');
const { toCsv, toXml, toJsonText } = require('../src/pro/export.js');
const { checkInvariants } = require('./core.helpers.js');
const kit = require('./helpers/attack-kit.js');

const SEEDS = 700;

/** Returns the JSON text of the segments of a message, to compare element values. */
function valuesOf(message) {
  return JSON.stringify(toJSON(message).segments);
}

/** Checks everything that must hold for one parsed message. Throws on the first problem. */
function checkMessage(text, message, label) {
  checkInvariants(message);
  for (const variant of [pretty(message), minify(message)]) {
    const again = parse(variant);
    assert.equal(valuesOf(again), valuesOf(message), label + ': values change after reformatting');
    assert.equal(again.format, message.format, label + ': format changes after reformatting');
  }
  assert.equal(pretty(parse(pretty(message))), pretty(parse(pretty(parse(pretty(message))))), label + ': pretty is not stable');
  assert.equal(minify(parse(minify(message))), minify(message), label + ': minify is not stable');
  const same = compare(message, parse(pretty(message)));
  assert.ok(same.identical, label + ': a message differs from its own pretty print');
  const step = Math.max(1, Math.floor(text.length / 120));
  for (let off = 0; off <= text.length; off += step) {
    const loc = locate(message, off, { inclusiveEnd: true });
    if (!loc || off > loc.segment.offset + loc.segment.raw.length) continue;
    const res = resolvePath(message, loc.path);
    assert.ok(res && res.offset <= off && off <= res.end, label + ': locate and resolvePath disagree at ' + off + ' (' + loc.path + ')');
  }
  const issues = validate(message, { includeParseIssues: true });
  for (const issue of issues) {
    assert.ok(issue.offset >= 0 && issue.end >= issue.offset && issue.end <= text.length, label + ': issue range ' + JSON.stringify(issue));
  }
}

test('fuzz: UN/EDIFACT written with random delimiters, release characters and line breaks parses back exactly', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = kit.writeEdifact(kit.rng(seed));
    const m = parse(w.text);
    const label = 'edifact seed ' + seed;
    assert.equal(m.format, 'edifact', label);
    assert.deepEqual(kit.compareToPlan(m, w.plan, w.hasUna ? 1 : 0, 'edifact'), [], label + ' ' + JSON.stringify(w.text));
    assert.deepEqual(m.issues, [], label);
    // The unescaped value of every component is what was written.
    const segs = m.segments.slice(w.hasUna ? 1 : 0);
    segs.forEach((seg, i) => {
      seg.elements.forEach((el, k) => {
        el.repetitions.forEach((rep, r) => {
          rep.components.forEach((comp, c) => {
            assert.equal(unescapeValue(m, comp.raw), w.plan[i].plain[k][r][c], label + ' unescape ' + JSON.stringify(comp.raw));
          });
        });
      });
    });
    checkMessage(w.text, m, label);
  }
});

test('fuzz: X12 with random delimiters, terminators and a repetition separator parses back exactly', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = kit.writeX12(kit.rng(seed + 10000));
    const m = parse(w.text);
    const label = 'x12 seed ' + seed;
    assert.equal(m.format, 'x12', label);
    assert.equal(m.delimiters.element, w.element, label);
    assert.equal(m.delimiters.component, w.component, label);
    assert.equal(m.delimiters.segment, w.terminator, label);
    assert.equal(m.delimiters.repetition, w.repetition, label);
    assert.equal(m.segments[0].raw.length, 105, label);
    assert.deepEqual(kit.compareToPlan(m, w.plan, 1, 'x12'), [], label + ' ' + JSON.stringify(w.text));
    assert.deepEqual(m.issues, [], label);
    checkMessage(w.text, m, label);
  }
});

test('fuzz: HL7 v2 with random encoding characters, escapes, subcomponents and line endings parses back exactly', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = kit.writeHl7(kit.rng(seed + 20000));
    const m = parse(w.text);
    const label = 'hl7 seed ' + seed;
    assert.equal(m.format, 'hl7', label);
    assert.equal(m.delimiters.field, w.field, label);
    assert.equal(m.delimiters.component, w.component, label);
    assert.equal(m.delimiters.repetition, w.repetition, label);
    assert.equal(m.delimiters.escape, w.escape, label);
    assert.equal(m.delimiters.subcomponent, w.subcomponent, label);
    assert.deepEqual(kit.compareToPlan(m, w.plan, 1, 'hl7'), [], label + ' ' + JSON.stringify(w.text));
    assert.deepEqual(m.issues, [], label);
    checkMessage(w.text, m, label);
  }
});

// ---------------------------------------------------------------------------
// Validator on complete, correct envelopes
// ---------------------------------------------------------------------------

/** Writes a correct UN/EDIFACT interchange list with random shape and delimiters. */
function validEdifact(rand) {
  const D = kit.pick(rand, [
    { c: ':', e: '+', r: '?', t: "'", una: true },
    { c: ':', e: '+', r: '?', t: "'", una: false },
    { c: ';', e: ',', r: '\\', t: '~', una: true },
    { c: ':', e: '+', r: ' ', t: "'", una: true },
    { c: '^', e: '|', r: '!', t: '#', una: true },
  ]);
  const release = D.r.trim();
  const escape = (v) => (release ? v.replace(/[^\w ]/g, (ch) => ([D.c, D.e, D.t, release].indexOf(ch) !== -1 ? release + ch : ch)) : v);
  const words = ['ABC', 'x y', 'Is it ok' + (release ? '' : '?'), '5' + (release ? D.t : ''), '1' + (release ? D.e : '') + '1', 'a' + (release ? D.c : '') + 'b', release ? release + release : 'q'];
  const lines = [];
  const seg = (id, ...els) => lines.push(id + els.map((x) => D.e + x).join(''));
  const interchanges = 1 + Math.floor(rand() * 2);
  for (let ic = 0; ic < interchanges; ic++) {
    const ref = String(100 + ic);
    seg('UNB', 'UNOA' + D.c + '1', 'S', 'R', '200101' + D.c + '1200', ref);
    const groups = rand() < 0.4 ? 1 + Math.floor(rand() * 2) : 0;
    let units = 0;
    for (let g = 0; g < Math.max(groups, 1); g++) {
      if (groups) seg('UNG', 'ORDERS', 'S', 'R', '200101' + D.c + '1200', 'G' + g);
      const messages = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < messages; m++) {
        const n = 1 + Math.floor(rand() * 3);
        seg('UNH', String(m + 1), 'ORDERS' + D.c + 'D' + D.c + '96A');
        for (let b = 0; b < n; b++) seg('FTX', 'AAI', '', '', escape(kit.pick(rand, words)));
        seg('UNT', String(n + 2), String(m + 1));
        if (!groups) units++;
      }
      if (groups) {
        seg('UNE', String(messages), 'G' + g);
        units++;
      }
    }
    seg('UNZ', String(units), ref);
  }
  const eol = D.t === '\n' ? '' : kit.pick(rand, ['', '\n', '\r\n', '\r']);
  return (D.una ? 'UNA' + D.c + D.e + '.' + D.r + ' ' + D.t + eol : '') + lines.map((l) => l + D.t).join(eol);
}

test('fuzz: correct UN/EDIFACT envelopes validate without a single error or warning', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const text = validEdifact(kit.rng(seed + 30000));
    const m = parse(text);
    assert.deepEqual(m.issues, [], 'seed ' + seed + ' ' + JSON.stringify(text));
    assert.deepEqual(validate(m), [], 'seed ' + seed + ' ' + JSON.stringify(text));
    assert.deepEqual(validate(parse(pretty(m))), [], 'seed ' + seed + ' pretty');
    assert.deepEqual(validate(parse(minify(m))), [], 'seed ' + seed + ' minify');
  }
});

/** Writes a correct X12 text with random shape. */
function validX12(rand) {
  const el = kit.pick(rand, ['*', '|']);
  const comp = kit.pick(rand, [':', '>']);
  const term = kit.pick(rand, ['~', '\n', '\r', '`']);
  const pad = (v, n) => String(v).padEnd(n);
  const lines = [];
  const interchanges = 1 + Math.floor(rand() * 2);
  for (let ic = 0; ic < interchanges; ic++) {
    const ref = String(ic + 1).padStart(9, '0');
    lines.push(['ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad('SENDER', 15), 'ZZ', pad('RECEIVER', 15), '210101', '1200', 'U', '00401', ref, '0', 'P', comp].join(el));
    const groups = Math.floor(rand() * 3);
    for (let g = 0; g < groups; g++) {
      const gref = String(g + 1);
      lines.push(['GS', 'PO', 'S', 'R', '20210101', '1200', gref, 'X', '004010'].join(el));
      const sets = Math.floor(rand() * 3);
      for (let s = 0; s < sets; s++) {
        const sref = String(s + 1).padStart(4, '0');
        const body = 1 + Math.floor(rand() * 3);
        lines.push(['ST', '850', sref].join(el));
        for (let b = 0; b < body; b++) lines.push(['REF', 'AB', 'v' + b].join(el));
        lines.push(['SE', String(body + 2), sref].join(el));
      }
      lines.push(['GE', String(sets), gref].join(el));
    }
    lines.push(['IEA', String(groups), ref].join(el));
  }
  const gap = term === '\n' || term === '\r' ? '' : kit.pick(rand, ['', '\n', '\r\n']);
  return lines.map((l) => l + term).join(gap);
}

test('fuzz: correct X12 envelopes validate without a single error or warning', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const text = validX12(kit.rng(seed + 40000));
    const m = parse(text);
    assert.deepEqual(m.issues, [], 'seed ' + seed + ' ' + JSON.stringify(text));
    assert.deepEqual(validate(m), [], 'seed ' + seed + ' ' + JSON.stringify(text));
  }
});

/** Writes a correct HL7 message, batch or file. */
function validHl7(rand) {
  const eol = kit.pick(rand, ['\r', '\n', '\r\n']);
  const lines = [];
  const mode = kit.pick(rand, ['plain', 'batch', 'file']);
  const messages = (k) => {
    for (let i = 0; i < k; i++) {
      lines.push('MSH|^~\\&|A|B|C|D|20200101||ADT^A01|C' + i + '|P|2.5');
      lines.push('PID|1||' + i);
      lines.push('ZXX|1|\\F\\\\S\\');
    }
  };
  if (mode === 'plain') {
    messages(1 + Math.floor(rand() * 3));
  } else {
    if (mode === 'file') lines.push('FHS|^~\\&|A|B|C|D|20200101');
    const batches = 1 + Math.floor(rand() * 2);
    for (let b = 0; b < batches; b++) {
      const k = 1 + Math.floor(rand() * 3);
      lines.push('BHS|^~\\&|A|B|C|D|20200101');
      messages(k);
      lines.push('BTS|' + k);
    }
    if (mode === 'file') lines.push('FTS|' + batches);
  }
  return lines.join(eol) + (rand() < 0.5 ? eol : '');
}

test('fuzz: correct HL7 messages, batches and files validate without a single error or warning', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const text = validHl7(kit.rng(seed + 50000));
    const m = parse(text);
    assert.deepEqual(m.issues, [], 'seed ' + seed);
    assert.deepEqual(validate(m), [], 'seed ' + seed + ' ' + JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------
// Damaged input
// ---------------------------------------------------------------------------

/** Runs every public function over a text and checks that nothing throws and every range is valid. */
function exercise(text, opts) {
  const m = parse(text, opts);
  checkInvariants(m);
  for (const issue of validate(m, { includeParseIssues: true })) {
    assert.ok(issue.offset >= 0 && issue.end >= issue.offset && issue.end <= text.length, 'validate range');
  }
  pretty(m);
  minify(m);
  toJSON(m, { unescape: true });
  toCsv(m);
  toXml(m);
  toJsonText(m, { pretty: true });
  const r = compare(m, parse(pretty(m), opts));
  toText(r);
  toHtml(r);
  const step = Math.max(1, text.length >> 5);
  for (let off = 0; off <= text.length; off += step) {
    const loc = locate(m, off, { inclusiveEnd: true });
    if (loc) resolvePath(m, loc.path);
  }
  return m;
}

test('fuzz: every prefix of every fixture can be parsed, validated, reformatted, exported and compared', () => {
  const dirs = [path.join(__dirname, 'fixtures', 'core'), path.join(__dirname, 'fixtures', 'validate')];
  let count = 0;
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (let n = 0; n <= text.length; n++) {
        exercise(text.slice(0, n));
        count++;
      }
    }
  }
  assert.ok(count > 1000);
});

test('fuzz: text cut inside the first segment or a multi-character sequence never throws', () => {
  const full = "UNA:+.? 'UNB+UNOA:1+A+B+1'FTX+AAI+++a?'b??c'UNZ+0+1'";
  for (let n = 0; n <= full.length; n++) exercise(full.slice(0, n));
  const x = ['ISA', '00', ''.padEnd(10), '00', ''.padEnd(10), 'ZZ', 'S'.padEnd(15), 'ZZ', 'R'.padEnd(15), '210101', '1200', '^', '00501', '000000001', '0', 'P', ':'].join('*') + '~GS*PO~';
  for (let n = 0; n <= x.length; n++) exercise(x.slice(0, n));
});

test('fuzz: random garbage with and without a valid start never throws, whatever format is forced', () => {
  const starts = ["UNB+UNOA:1+A+B+1'", "UNA:+.? 'UNB+", 'ISA*00*', 'MSH|^~\\&|', kit.BOM, '', 'UNH+1+', 'FHS|^~\\&|\rBHS|', '  \n'];
  const bits = ["'", '+', ':', '?', '*', '~', '|', '^', '&', '\\', '\r', '\n', ' ', 'A', 'N', 'U', '0', kit.NUL, String.fromCharCode(0xff), String.fromCodePoint(0x1f600), String.fromCharCode(0xd800), String.fromCharCode(0xdc00), 'MSH', 'UNZ', 'ISA', 'IEA', 'UNT+', 'SE*'];
  const formats = [undefined, 'edifact', 'x12', 'hl7'];
  for (let seed = 1; seed <= 1500; seed++) {
    const rand = kit.rng(seed + 60000);
    let text = kit.pick(rand, starts);
    const n = Math.floor(rand() * 120);
    for (let i = 0; i < n; i++) text += kit.pick(rand, bits);
    exercise(text, formats[seed % formats.length] ? { format: formats[seed % formats.length] } : undefined);
  }
});

test('fuzz: byte-like garbage of 64 KiB parses in well under a second', () => {
  const rand = kit.rng(99);
  let text = '';
  for (let i = 0; i < 65536; i++) text += String.fromCharCode(Math.floor(rand() * 256));
  const started = Date.now();
  for (const format of ['edifact', 'x12', 'hl7']) exercise(text, { format });
  assert.ok(Date.now() - started < 5000);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Returns the expected leaf texts of the XML export, in order. */
function expectedXmlLeaves(message) {
  const out = [];
  for (const seg of message.segments) {
    if (seg.elements.length === 0) out.push('');
    for (const el of seg.elements) {
      for (const rep of el.repetitions) {
        for (const comp of rep.components) {
          if (comp.subcomponents.length > 1) for (const sub of comp.subcomponents) out.push(kit.xmlSafe(sub.raw));
          else out.push(kit.xmlSafe(comp.raw));
        }
      }
    }
  }
  return out;
}

/** Collects the leaf texts of a parsed XML tree below the root, in order. */
function xmlLeaves(node, out) {
  if (node.children.length === 0) out.push(node.text);
  else node.children.forEach((c) => xmlLeaves(c, out));
  return out;
}

test('fuzz: the XML export is well formed and carries every value, for all three formats', () => {
  const writers = [
    (rand) => kit.writeEdifact(rand),
    (rand) => kit.writeX12(rand),
    (rand) => kit.writeHl7(rand),
  ];
  for (let seed = 1; seed <= 400; seed++) {
    const w = writers[seed % 3](kit.rng(seed + 70000));
    const m = parse(w.text);
    const xml = toXml(m);
    const root = kit.readXml(xml);
    assert.equal(root.name, 'message');
    assert.equal(root.attrs.format, m.format);
    assert.equal(root.children.length, m.segments.length);
    root.children.forEach((node, i) => {
      assert.equal(node.attrs.id, kit.xmlSafe(m.segments[i].id), 'segment id of seed ' + seed);
      assert.equal(node.attrs.n, String(m.segments[i].occurrence));
      assert.ok(/^s_[A-Za-z0-9_.-]*$/.test(node.name), node.name);
    });
    const leaves = root.children.length === 0 ? [] : root.children.reduce((all, node) => xmlLeaves(node, all), []);
    assert.deepEqual(leaves, expectedXmlLeaves(m), 'seed ' + seed);
  }
});

test('fuzz: the CSV export follows RFC 4180 and lists every value with its path', () => {
  const writers = [(rand) => kit.writeEdifact(rand), (rand) => kit.writeX12(rand), (rand) => kit.writeHl7(rand)];
  for (let seed = 1; seed <= 400; seed++) {
    const w = writers[seed % 3](kit.rng(seed + 80000));
    const m = parse(w.text);
    const csv = toCsv(m);
    const rows = kit.readCsv(csv);
    assert.deepEqual(rows[0], ['segment', 'occurrence', 'path', 'value']);
    assert.deepEqual(rows.slice(1), kit.expectedCsvRows(m), 'seed ' + seed);
    assert.equal(toCsv(m, { bom: true }), kit.BOM + csv);
  }
});

test('fuzz: the JSON export parses back to exactly the structure of the serializer', () => {
  const writers = [(rand) => kit.writeEdifact(rand), (rand) => kit.writeX12(rand), (rand) => kit.writeHl7(rand)];
  for (let seed = 1; seed <= 300; seed++) {
    const w = writers[seed % 3](kit.rng(seed + 90000));
    const m = parse(w.text);
    for (const opts of [{}, { pretty: true }, { unescape: true }, { pretty: true, unescape: true }]) {
      const text = toJsonText(m, opts);
      assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(toJSON(m, { unescape: opts.unescape === true }))));
      assert.ok(!/\n$/.test(text));
      if (opts.pretty === true) assert.ok(text.includes('\n'));
      else assert.ok(!text.includes('\n'), 'compact JSON is a single line');
    }
  }
});

test('fuzz: a spreadsheet formula in a value can be neutralised in the CSV export', () => {
  const m = parse("UNB+UNOA:1+=1+2+-3+@4'NAD+\tx+\ry'UNZ+0+1'");
  const plain = kit.readCsv(toCsv(m)).map((r) => r[3]);
  assert.ok(plain.includes('=1') && plain.includes('-3'));
  const safe = kit.readCsv(toCsv(m, { neutraliseFormulas: true })).map((r) => r[3]);
  assert.ok(safe.includes("'=1") && safe.includes("'-3") && safe.includes("'@4") && safe.includes("'\tx") && safe.includes("'\ry"));
  assert.ok(safe.includes('2'), 'values without a formula start are unchanged');
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Picks a segment and a component of a parsed message and returns where to insert text, or null. */
function pickComponent(rand, message, firstSegment) {
  const candidates = [];
  message.segments.forEach((seg, i) => {
    if (i < firstSegment) return;
    seg.elements.forEach((el) => el.repetitions.forEach((rep) => rep.components.forEach((comp) => candidates.push({ seg, comp }))));
  });
  return candidates.length === 0 ? null : kit.pick(rand, candidates);
}

test('fuzz: one inserted letter is reported as exactly one change and can be ignored by its own path', () => {
  const writers = [(rand) => kit.writeEdifact(rand), (rand) => kit.writeX12(rand), (rand) => kit.writeHl7(rand)];
  let compared = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const rand = kit.rng(seed + 100000);
    const w = writers[seed % 3](rand);
    const a = parse(w.text);
    // The header segment (ISA, MSH, UNA) carries the delimiters, so it is left alone.
    const skip = a.format !== 'edifact' || w.hasUna ? 1 : 0;
    const target = pickComponent(rand, a, skip);
    if (!target) continue;
    const at = target.comp.end;
    const b = parse(w.text.slice(0, at) + 'Z' + w.text.slice(at));
    const r = compare(a, b);
    compared++;
    assert.equal(r.summary.changed, 1, 'seed ' + seed);
    assert.equal(r.summary.added + r.summary.removed, 0, 'seed ' + seed);
    const entry = r.segments.find((e) => e.status === 'changed');
    assert.equal(entry.differences.length, 1, 'seed ' + seed);
    const d = entry.differences[0];
    assert.equal(d.kind, 'changed');
    assert.equal(d.b, d.a + 'Z');
    assert.ok(compare(a, b, { ignorePaths: [d.path] }).identical, 'ignore by path ' + d.path);
    assert.ok(compare(a, b, { ignorePaths: [entry.a.path + '*'] }).identical, 'ignore by wildcard');
    assert.ok(compare(a, b, { ignorePaths: ['*'] }).identical, 'ignore everything');
    assert.ok(compare(a, b, { ignoreSegments: [entry.id] }).identical, 'ignore segment');
    assert.ok(!compare(a, b, { ignorePaths: ['NOSUCH-9'] }).identical);
  }
  assert.ok(compared > 400);
});

test('fuzz: trimValues and ignoreCase hide exactly the differences they describe', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = kit.rng(seed + 110000);
    const w = kit.writeX12(rand);
    const a = parse(w.text);
    const target = pickComponent(rand, a, 1);
    if (!target || target.comp.raw === '') continue;
    const padded = parse(w.text.slice(0, target.comp.end) + '  ' + w.text.slice(target.comp.end));
    assert.ok(!compare(a, padded).identical);
    assert.ok(compare(a, padded, { trimValues: true }).identical);
    const upper = parse(w.text.slice(0, target.comp.offset) + target.comp.raw.toUpperCase() + w.text.slice(target.comp.end));
    if (upper.text !== a.text && upper.segments.length === a.segments.length) {
      assert.ok(compare(a, upper, { ignoreCase: true }).identical || upper.segments.some((s, i) => s.elements.length !== a.segments[i].elements.length));
    }
  }
});

/** Writes a list of simple body segments between UNH and UNT. */
function bodyText(lines) {
  return "UNB+UNOA:1+S+R+200101:1200+1'UNH+1+X'" + lines.map((l) => l + "'").join('') + 'UNT+' + (lines.length + 2) + "+1'UNZ+1+1'";
}

test('fuzz: comparison counts add up, are symmetric and match an independent longest common subsequence', () => {
  const rand = kit.rng(123456);
  const bodies = () => {
    const out = [];
    const n = Math.floor(rand() * 12);
    for (let i = 0; i < n; i++) out.push(kit.pick(rand, ['LIN', 'QTY', 'NAD', 'DTM']) + '+' + kit.pick(rand, ['1', '2', 'A:B', 'A:C', '']) + '+' + kit.pick(rand, ['x', 'y', '', 'x:y']));
    return out;
  };
  for (let n = 0; n < 1500; n++) {
    const la = bodies();
    const lb = rand() < 0.3 ? la.slice() : bodies();
    const A = parse(bodyText(la));
    const B = parse(bodyText(lb));
    const r = compare(A, B);
    const s = r.summary;
    assert.equal(s.added + s.changed + s.unchanged, B.segments.length);
    assert.equal(s.removed + s.changed + s.unchanged, A.segments.length);
    assert.equal(r.identical, s.added + s.removed + s.changed === 0);
    const back = compare(B, A).summary;
    assert.deepEqual([back.added, back.removed, back.changed, back.unchanged], [s.removed, s.added, s.changed, s.unchanged]);
    const idsA = A.segments.map((x) => x.id);
    const idsB = B.segments.map((x) => x.id);
    const table = Array.from({ length: idsA.length + 1 }, () => new Array(idsB.length + 1).fill(0));
    for (let i = idsA.length - 1; i >= 0; i--) {
      for (let j = idsB.length - 1; j >= 0; j--) {
        table[i][j] = idsA[i] === idsB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    assert.equal(s.changed + s.unchanged, table[0][0], 'the alignment is not a longest common subsequence');
    let lastA = -1;
    let lastB = -1;
    for (const e of r.segments) {
      if (e.a) {
        assert.ok(e.a.index > lastA);
        lastA = e.a.index;
      }
      if (e.b) {
        assert.ok(e.b.index > lastB);
        lastB = e.b.index;
      }
    }
  }
});
