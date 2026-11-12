'use strict';
// The sample corpus: 42 files per format in test/fixtures/corpus, written with invented values
// and covering the common message types, delimiter sets, line endings, groups, batches, escapes
// and repetitions. Every file must be clean (zero problems), and every feature of the extension
// must give a sensible, non-throwing result on it: outline, hover, paths, validation, formatting
// round trips, exports and comparison.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse } = require('../src/core/parse');
const { detectFormat } = require('../src/core/detect');
const { validate } = require('../src/core/validate');
const { pretty, minify, toJSON } = require('../src/core/serialize');
const { locate, resolvePath, formatPath } = require('../src/core/path');
const { compare, toHtml, toText } = require('../src/pro/diff');
const { toJsonText, toCsv, toXml } = require('../src/pro/export');
const tree = require('../src/tree');
const { hoverLines } = require('../src/hover');
const { statusContent } = require('../src/status');
const { formatMessage, countIssues, mergeIssues, getCore } = require('../src/format');
const { checkInvariants } = require('./core.helpers');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const FORMATS = ['edifact', 'x12', 'hl7'];

function corpusFiles(format) {
  return fs.readdirSync(path.join(CORPUS, format)).sort().map(function (name) {
    return { format: format, name: name, text: fs.readFileSync(path.join(CORPUS, format, name), 'utf8') };
  });
}

const ALL = FORMATS.reduce(function (acc, f) { return acc.concat(corpusFiles(f)); }, []);

test('the corpus holds 42 files per format with the required message types', () => {
  for (const f of FORMATS) assert.equal(corpusFiles(f).length, 42, f);
  const names = ALL.map((x) => x.name).join(' ');
  for (const t of ['orders', 'ordrsp', 'invoic', 'desadv', 'iftmin', 'cuscar', 'aperak', 'contrl', 'pricat', 'invrpt']) assert.match(names, new RegExp('\\b' + t + '-'), t);
  for (const t of ['810', '820', '830', '832', '850', '855', '856', '860', '997', '837p', '835', '270', '271']) assert.match(names, new RegExp('\\b' + t + '-'), t);
  for (const t of ['adt-a01', 'adt-a03', 'adt-a08', 'oru-r01', 'orm-o01', 'siu-s12', 'mdm-t02', 'dft-p03', 'ack']) assert.match(names, new RegExp('\\b' + t + '-'), t);
  assert.ok(ALL.some((x) => /batch|file-fhs/.test(x.name)), 'HL7 batches');
  assert.ok(ALL.some((x) => /escapes/.test(x.name)), 'HL7 escapes');
  assert.ok(ALL.some((x) => /group/.test(x.name)), 'EDIFACT groups');
  assert.ok(ALL.some((x) => /pipe|colon/.test(x.name)), 'X12 delimiter variants');
  // The files use several delimiter sets and all three line ending styles.
  const x12 = corpusFiles('x12').map((f) => parse(f.text).delimiters);
  assert.ok(new Set(x12.map((d) => d.element)).size >= 2 && new Set(x12.map((d) => d.component)).size >= 2 && new Set(x12.map((d) => d.segment)).size >= 2);
  assert.ok(x12.some((d) => d.repetition === '^') && x12.some((d) => d.repetition === ''), 'X12 with and without a repetition separator');
  const edi = corpusFiles('edifact').map((f) => parse(f.text).delimiters);
  assert.ok(new Set(edi.map((d) => d.element)).size >= 3 && edi.some((d) => d.repetition === '*'));
  const hl7 = corpusFiles('hl7').map((f) => parse(f.text).delimiters);
  assert.ok(hl7.some((d) => d.field === '#') && hl7.some((d) => d.field === '|'));
  const eols = new Set(ALL.map((f) => (/\r\n/.test(f.text) ? 'crlf' : /\n/.test(f.text) ? 'lf' : /\r/.test(f.text) ? 'cr' : 'none')));
  assert.deepEqual([...eols].sort(), ['cr', 'crlf', 'lf', 'none']);
});

test('corpus: every file is detected, parses without syntax issues and validates with zero problems', () => {
  for (const f of ALL) {
    const detected = detectFormat(f.text);
    assert.ok(detected && detected.format === f.format, f.name + ' detected as ' + JSON.stringify(detected));
    const m = parse(f.text);
    assert.equal(m.format, f.format, f.name);
    assert.deepEqual(m.issues, [], f.name + ' has syntax issues');
    assert.deepEqual(validate(m, { includeParseIssues: true }), [], f.name + ' has validation problems (false positive)');
    checkInvariants(m);
    assert.ok(m.segments.length >= 3, f.name);
  }
});

test('corpus: pretty print and minify round trips keep every value and stay clean', () => {
  for (const f of ALL) {
    const m = parse(f.text);
    const values = JSON.stringify(toJSON(m).segments);
    for (const eol of ['\n', '\r\n']) {
      const p = pretty(m, { eol: eol });
      const again = parse(p);
      assert.equal(JSON.stringify(toJSON(again).segments), values, f.name + ' pretty changes values');
      assert.deepEqual(validate(again, { includeParseIssues: true }), [], f.name + ' pretty is not clean');
      assert.equal(pretty(again, { eol: eol }), p, f.name + ' pretty is not stable');
      assert.equal(minify(again), minify(m), f.name + ' pretty then minify differs');
    }
    const mini = parse(minify(m));
    assert.equal(JSON.stringify(toJSON(mini).segments), values, f.name + ' minify changes values');
    assert.deepEqual(validate(mini, { includeParseIssues: true }), [], f.name + ' minify is not clean');
    assert.equal(minify(mini), minify(m), f.name + ' minify is not stable');
    // The shell path: formatMessage with both modes.
    for (const mode of ['pretty', 'minify']) {
      const r = formatMessage(m, mode, getCore(), { eol: '\n' });
      assert.equal(r.ok, true, f.name + ' ' + mode);
      assert.equal(r.format, f.format);
    }
    if (f.format !== 'hl7' && !/[\r\n]/.test(m.delimiters.segment)) assert.equal(minify(m).indexOf('\n'), -1, f.name + ' minified EDIFACT/X12 has no line breaks');
  }
});

// Walks the outline of a message and returns every descriptor.
function walkOutline(m) {
  const deps = { formatPath: formatPath };
  const out = [];
  function visit(desc) {
    out.push(desc);
    if (desc.collapsible) {
      const kids = tree.childDescriptors(desc, deps);
      assert.ok(kids.length > 0, 'a collapsible node has children: ' + desc.path);
      kids.forEach(visit);
    } else if (desc.kind !== 'more') {
      // The view never expands a leaf; asking anyway must not throw and must not nest further.
      for (const kid of tree.childDescriptors(desc, deps)) assert.equal(kid.collapsible, false, 'a leaf hides a nested tree: ' + desc.path);
    }
  }
  tree.segmentDescriptors(m, deps).forEach(visit);
  return out;
}

test('corpus: the outline lists every segment, every node has a valid range and a resolvable path', () => {
  for (const f of ALL) {
    const m = parse(f.text);
    const nodes = walkOutline(m);
    const roots = nodes.filter((n) => n.kind === 'segment');
    assert.equal(roots.length, m.segments.length, f.name);
    roots.forEach((n, i) => assert.equal(n.label, m.segments[i].id + '[' + m.segments[i].occurrence + ']', f.name));
    const ids = new Set();
    for (const n of nodes) {
      assert.ok(!ids.has(n.id), f.name + ' duplicate outline id ' + n.id);
      ids.add(n.id);
      assert.ok(typeof n.label === 'string' && n.label.length > 0, f.name);
      assert.ok(typeof n.description === 'string' && typeof n.tooltip === 'string', f.name);
      assert.ok(n.start >= 0 && n.end >= n.start && n.end <= f.text.length, f.name + ' range of ' + n.path);
      assert.ok(!/[\u0000-\u001f]/.test(n.description), f.name + ' control character in a description: ' + n.path);
      const r = resolvePath(m, n.path);
      assert.ok(r, f.name + ' path does not resolve: ' + n.path);
      assert.ok(r.offset <= n.start && r.end >= n.end, f.name + ' path range mismatch: ' + n.path);
      if (n.kind === 'subcomponent' || n.kind === 'component') assert.equal(f.text.slice(n.start, n.end), r.value, f.name + ' ' + n.path);
    }
    // Every non-empty value of the message appears somewhere in the outline.
    let leaves = 0;
    for (const seg of m.segments) for (const el of seg.elements) if (el.raw !== '') leaves++;
    assert.equal(nodes.filter((n) => n.kind === 'element').length, leaves, f.name + ' element nodes');
  }
});

test('corpus: hovering every character gives the path of the item under it, consistent with resolvePath', () => {
  for (const f of ALL) {
    const m = parse(f.text);
    const step = f.text.length > 6000 ? 3 : 1;
    let hovers = 0;
    for (let off = 0; off < f.text.length; off += step) {
      const loc = locate(m, off);
      if (!loc) {
        const ch = f.text[off];
        assert.ok(/[\r\n\s﻿]/.test(ch) || isTerminator(m, off), f.name + ': no hover at ' + off + ' (' + JSON.stringify(ch) + ')');
        continue;
      }
      hovers++;
      const lines = hoverLines(loc, {});
      assert.equal(lines[0][1].v, loc.path, f.name);
      assert.ok(lines.some((l) => l[0].v === 'Value: '), f.name);
      assert.ok(lines.some((l) => /^Position: /.test(l[0].v)), f.name);
      assert.ok(lines.some((l) => /^Length: \d+ code points$/.test(l[0].v)), f.name);
      const r = resolvePath(m, loc.path);
      assert.ok(r, f.name + ' hover path does not resolve: ' + loc.path);
      if (isTerminator(m, off)) assert.equal(loc.path, loc.segment.id + '[' + loc.segment.occurrence + ']', f.name + ' a terminator hovers as its segment');
      else assert.ok(r.offset <= off && off <= r.end, f.name + ' hover path range: ' + loc.path + ' at ' + off);
    }
    assert.ok(hovers > m.segments.length, f.name);
  }
});

function isTerminator(m, off) {
  for (const seg of m.segments) {
    const rawEnd = seg.offset + seg.raw.length;
    if (off >= rawEnd && off < seg.end) return true;
  }
  return false;
}

test('corpus: every export is well formed and lists every value; a file compares identical with itself', () => {
  for (const f of ALL) {
    const m = parse(f.text);
    const json = JSON.parse(toJsonText(m, { pretty: true }));
    assert.equal(json.format, f.format);
    assert.equal(json.segments.length, m.segments.length, f.name);
    JSON.parse(toJsonText(m, { unescape: true }));
    const rows = kit.readCsv(toCsv(m));
    assert.deepEqual(rows[0], ['segment', 'occurrence', 'path', 'value']);
    assert.deepEqual(rows.slice(1), kit.expectedCsvRows(m), f.name + ' CSV rows');
    for (const row of rows.slice(1)) assert.ok(resolvePath(m, row[2]), f.name + ' CSV path ' + row[2]);
    const safe = kit.readCsv(toCsv(m, { neutraliseFormulas: true }));
    assert.equal(safe.length, rows.length);
    for (let i = 1; i < rows.length; i++) {
      const v = rows[i][3];
      assert.equal(safe[i][3], /^[=+\-@\t\r]/.test(v) ? "'" + v : v, f.name + ' neutralised row ' + i);
    }
    const root = kit.readXml(toXml(m));
    assert.equal(root.name, 'message');
    assert.equal(root.children.length, m.segments.length, f.name);
    const same = compare(m, m);
    assert.ok(same.identical, f.name);
    assert.ok(compare(m, parse(pretty(m))).identical, f.name + ' differs from its own pretty print');
    assert.ok(compare(m, parse(minify(m))).identical, f.name + ' differs from its own minified text');
    const html = toHtml(same, { labelA: f.name, labelB: f.name + ' (copy)', title: 'Comparison' });
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /identical/i);
    toText(same);
  }
});

test('corpus: a one-value change is found by the comparison with the right path, for every file', () => {
  const rand = kit.rng(2026);
  for (const f of ALL) {
    const a = parse(f.text);
    const candidates = [];
    a.segments.forEach((seg, i) => {
      if (i === 0 && f.format !== 'edifact') return; // ISA and MSH carry the delimiters
      if (seg.id === 'UNA') return;
      seg.elements.forEach((el) => el.repetitions.forEach((rep) => rep.components.forEach((comp) => {
        if (comp.subcomponents.length === 1 && comp.raw !== '' && !/[?\\!]/.test(comp.raw)) candidates.push(comp);
      })));
    });
    const target = kit.pick(rand, candidates);
    const b = parse(f.text.slice(0, target.end) + 'Z' + f.text.slice(target.end));
    const r = compare(a, b);
    assert.equal(r.summary.changed, 1, f.name);
    assert.equal(r.summary.added + r.summary.removed, 0, f.name);
    const entry = r.segments.find((e) => e.status === 'changed');
    assert.equal(entry.differences.length, 1, f.name);
    const d = entry.differences[0];
    assert.equal(d.b, d.a + 'Z', f.name);
    assert.ok(compare(a, b, { ignorePaths: [d.path] }).identical, f.name + ' ignore ' + d.path);
    assert.ok(resolvePath(b, d.path), f.name + ' difference path resolves in b: ' + d.path);
  }
});

test('corpus: the status bar text and the problem counts for clean files are "0 issues"', () => {
  for (const f of ALL) {
    const m = parse(f.text);
    const issues = mergeIssues(m.issues, validate(m), 500);
    const summary = { skipped: null, format: m.format, segments: m.segments.length, counts: countIssues(issues) };
    const s = statusContent(f.format, summary);
    assert.match(s.text, /^\$\(check\) (UN\/EDIFACT|ANSI X12|HL7 v2) · \d+ segments · 0 issues$/, f.name);
    assert.match(s.tooltip, /0 errors, 0 warnings, 0 notes/);
  }
});

test('corpus: parsing is linear in time and lazy in memory (every file in a few milliseconds)', () => {
  const started = Date.now();
  let segments = 0;
  for (const f of ALL) {
    const m = parse(f.text);
    validate(m);
    segments += m.segments.length;
    const built = m.segments.filter((s) => !(Object.getOwnPropertyDescriptor(s, 'elements') && typeof Object.getOwnPropertyDescriptor(s, 'elements').get === 'function'));
    assert.ok(built.length <= 12, f.name + ' validation built ' + built.length + ' segments eagerly');
  }
  assert.ok(segments > 2000, String(segments));
  assert.ok(Date.now() - started < 5000);
});
