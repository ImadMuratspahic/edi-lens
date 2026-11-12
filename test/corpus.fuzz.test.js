'use strict';
// Mutation tests over the sample corpus with a fixed seed: every corpus file is damaged in
// several ways (characters and segments deleted, segments duplicated and swapped, the text
// truncated, delimiters swapped, control characters injected) and every feature must still
// finish without throwing, with every reported range inside the text, and quickly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const { pretty, minify, toJSON } = require('../src/core/serialize');
const { locate, resolvePath, formatPath } = require('../src/core/path');
const { compare, toHtml, toText } = require('../src/pro/diff');
const { toJsonText, toCsv, toXml } = require('../src/pro/export');
const tree = require('../src/tree');
const { hoverLines } = require('../src/hover');
const { statusContent } = require('../src/status');
const { formatMessage, mergeIssues, countIssues, getCore, shorten } = require('../src/format');
const { segmentPickItems, findMatchingSegment, segmentIndexAt } = require('../src/commands');
const { checkInvariants } = require('./core.helpers');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const SEED = 20261111;
const MUTATIONS_PER_FILE = 7;

const ALL = ['edifact', 'x12', 'hl7'].reduce(function (acc, format) {
  return acc.concat(fs.readdirSync(path.join(CORPUS, format)).sort().map(function (name) {
    return { format: format, name: name, text: fs.readFileSync(path.join(CORPUS, format, name), 'utf8') };
  }));
}, []);

const CONTROL = [kit.NUL, '\u0001', '\u001c', '\u001b', '\u0007', '\u007f', kit.BOM, ' ', '\u0085', '\ud800', '\udc00', '￾', '\t'];

/** Splits a text into its segments (by the parser) so that mutations can work on whole segments. */
function segmentsOf(text) {
  const m = parse(text);
  return m.segments.map((s) => text.slice(s.offset, s.end));
}

const MUTATORS = {
  deleteChar(text, rand) {
    const at = Math.floor(rand() * text.length);
    return text.slice(0, at) + text.slice(at + 1);
  },
  deleteRun(text, rand) {
    const at = Math.floor(rand() * text.length);
    const n = 1 + Math.floor(rand() * 40);
    return text.slice(0, at) + text.slice(at + n);
  },
  deleteSegment(text, rand) {
    const segs = segmentsOf(text);
    if (segs.length < 2) return text.slice(1);
    segs.splice(Math.floor(rand() * segs.length), 1);
    return segs.join('');
  },
  duplicateSegment(text, rand) {
    const segs = segmentsOf(text);
    const i = Math.floor(rand() * segs.length);
    segs.splice(i, 0, segs[i]);
    return segs.join('');
  },
  swapSegments(text, rand) {
    const segs = segmentsOf(text);
    if (segs.length < 2) return text;
    const i = Math.floor(rand() * segs.length);
    const j = Math.floor(rand() * segs.length);
    const t = segs[i]; segs[i] = segs[j]; segs[j] = t;
    return segs.join('');
  },
  truncate(text, rand) {
    return text.slice(0, Math.floor(rand() * text.length));
  },
  truncateHeader(text, rand) {
    return text.slice(0, Math.floor(rand() * Math.min(text.length, 120)));
  },
  swapDelimiters(text, rand) {
    const d = parse(text).delimiters;
    const chars = Object.keys(d).map((k) => d[k]).filter((c) => typeof c === 'string' && c.length === 1 && !/[\r\n]/.test(c));
    if (chars.length < 2) return text;
    const a = kit.pick(rand, chars);
    const b = kit.pick(rand, chars.filter((c) => c !== a));
    let out = '';
    for (const ch of text) out += ch === a ? b : ch === b ? a : ch;
    return out;
  },
  replaceDelimiter(text, rand) {
    const d = parse(text).delimiters;
    const chars = Object.keys(d).map((k) => d[k]).filter((c) => typeof c === 'string' && c.length === 1 && !/[\r\n]/.test(c));
    if (chars.length === 0) return text;
    const from = kit.pick(rand, chars);
    const to = kit.pick(rand, ['!', '%', '$', ';', '`', ' ', 'A', '7', '\n']);
    return text.split(from).join(to);
  },
  injectControl(text, rand) {
    let out = text;
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const at = Math.floor(rand() * (out.length + 1));
      out = out.slice(0, at) + kit.pick(rand, CONTROL) + out.slice(at);
    }
    return out;
  },
  injectLineBreaks(text, rand) {
    let out = text;
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const at = Math.floor(rand() * (out.length + 1));
      out = out.slice(0, at) + kit.pick(rand, ['\r\n', '\n', '\r', '\n\n\n']) + out.slice(at);
    }
    return out;
  },
  insertDelimiterRun(text, rand) {
    const d = parse(text).delimiters;
    const chars = Object.keys(d).map((k) => d[k]).filter((c) => typeof c === 'string' && c.length === 1);
    const at = Math.floor(rand() * (text.length + 1));
    const run = kit.pick(rand, chars.length ? chars : ['+']).repeat(1 + Math.floor(rand() * 12));
    return text.slice(0, at) + run + text.slice(at);
  },
  prependGarbage(text, rand) {
    return kit.pick(rand, ['﻿', '  \n', 'x', 'UNA', 'ISA', 'MSH', '\u0000', 'ISA*00*', "UNB+UNOC:3+'"]) + text;
  },
  doubleFile(text) {
    return text + text;
  }
};
const MUTATOR_NAMES = Object.keys(MUTATORS);

/** Runs every public function over a text; throws when anything throws or reports an invalid range. */
function exercise(text, label) {
  const started = Date.now();
  const m = parse(text);
  checkInvariants(m);
  const issues = validate(m, { includeParseIssues: true, maxIssues: 500 });
  for (const issue of issues) {
    assert.ok(issue.offset >= 0 && issue.end >= issue.offset && issue.end <= text.length, label + ' issue range ' + JSON.stringify(issue));
    assert.ok(typeof issue.code === 'string' && issue.code.length > 0 && typeof issue.message === 'string' && issue.message.length > 0, label);
  }
  const merged = mergeIssues(m.issues, issues, 500);
  statusContent(m.format || 'edifact', { skipped: null, format: m.format, segments: m.segments.length, counts: countIssues(merged) });
  const p = pretty(m, { eol: '\r\n' });
  const mini = minify(m);
  if (m.segments.length > 0 && m.issues.length === 0 && issues.length === 0) {
    // When the damaged text still parses cleanly, reformatting must not change a single value.
    assert.equal(JSON.stringify(toJSON(parse(p)).segments), JSON.stringify(toJSON(m).segments), label + ' pretty changes values');
    assert.equal(JSON.stringify(toJSON(parse(mini)).segments), JSON.stringify(toJSON(m).segments), label + ' minify changes values');
  }
  formatMessage(m, 'pretty', getCore(), { eol: '\n' });
  formatMessage(m, 'minify', getCore());
  JSON.parse(toJsonText(m, { pretty: true }));
  kit.readCsv(toCsv(m, { neutraliseFormulas: true }));
  kit.readXml(toXml(m));
  const r = compare(m, parse(p));
  toText(r);
  toHtml(r, { labelA: 'a', labelB: 'b', title: 'Comparison' });
  // Outline: every node, two levels deep at most for speed on big mutated files.
  const deps = { formatPath: formatPath };
  const roots = tree.segmentDescriptors(m, Object.assign({ maxSegments: 300 }, deps));
  for (const root of roots) {
    assert.ok(root.end <= text.length && root.start <= root.end, label + ' outline range');
    if (root.kind === 'more') continue;
    for (const kid of tree.childDescriptors(root, deps)) {
      assert.ok(kid.start >= 0 && kid.end <= text.length && kid.start <= kid.end, label + ' outline child range ' + kid.path);
      tree.childDescriptors(kid, deps).forEach((g) => tree.childDescriptors(g, deps));
    }
  }
  // Hover at a sample of offsets, paths, pick items, trailer matching.
  const step = Math.max(1, Math.floor(text.length / 60));
  for (let off = 0; off <= text.length; off += step) {
    const loc = locate(m, off, { inclusiveEnd: true });
    if (!loc) continue;
    const lines = hoverLines(loc, { segmentName: 'S', elementName: 'E', componentName: 'C', valueName: 'V' });
    assert.ok(lines.length >= 4, label);
    // A damaged file can produce a segment id that is not a path token (for example a whole line
    // when the delimiters are wrong); such a path is shown but cannot be resolved, by design.
    if (/^[A-Za-z0-9]+$/.test(loc.segment.id)) assert.ok(resolvePath(m, loc.path), label + ' hover path ' + loc.path);
    else resolvePath(m, loc.path);
  }
  segmentPickItems(m, 500).forEach((item) => assert.ok(typeof item.label === 'string' && typeof item.detail === 'string'));
  if (m.segments.length) {
    for (let i = 0; i < Math.min(m.segments.length, 40); i++) findMatchingSegment(m.segments, i);
    segmentIndexAt(m.segments, Math.floor(text.length / 2));
    shorten(m.segments[0].raw, 40);
  }
  const took = Date.now() - started;
  assert.ok(took < 4000, label + ' took ' + took + ' ms');
  return m;
}

test('corpus fuzz: every mutation of every corpus file is handled without a crash, with valid ranges, in bounded time', () => {
  let cases = 0;
  const perMutator = {};
  for (let i = 0; i < ALL.length; i++) {
    const f = ALL[i];
    const rand = kit.rng(SEED + i);
    for (let k = 0; k < MUTATIONS_PER_FILE; k++) {
      const name = MUTATOR_NAMES[(i * MUTATIONS_PER_FILE + k) % MUTATOR_NAMES.length];
      let text = MUTATORS[name](f.text, rand);
      // Two in seven cases get a second mutation on top.
      if (k % 7 === 6) {
        const second = kit.pick(rand, MUTATOR_NAMES);
        text = MUTATORS[second](text, rand);
      }
      exercise(text, f.name + ' [' + name + ' ' + k + ']');
      perMutator[name] = (perMutator[name] || 0) + 1;
      cases++;
    }
  }
  assert.equal(cases, ALL.length * MUTATIONS_PER_FILE);
  for (const name of MUTATOR_NAMES) assert.ok(perMutator[name] >= 40, name + ' was used ' + perMutator[name] + ' times');
});

test('corpus fuzz: a damaged envelope is reported (deleting a trailer or a count never passes silently)', () => {
  const rand = kit.rng(SEED + 9999);
  let checked = 0;
  for (const f of ALL) {
    const m = parse(f.text);
    const trailers = m.segments.filter((s) => ['UNT', 'UNZ', 'UNE', 'SE', 'GE', 'IEA', 'BTS', 'FTS'].indexOf(s.id) !== -1);
    if (trailers.length === 0) continue;
    const victim = kit.pick(rand, trailers);
    const text = f.text.slice(0, victim.offset) + f.text.slice(victim.end);
    const issues = validate(parse(text), { includeParseIssues: true });
    assert.ok(issues.length > 0, f.name + ': removing ' + victim.id + ' went unnoticed');
    assert.ok(issues.some((i) => i.severity === 'error'), f.name + ': removing ' + victim.id + ' is only a warning');
    checked++;
  }
  // Every EDIFACT and X12 file and the HL7 batch files have trailers; single HL7 messages have none.
  assert.ok(checked >= 84, String(checked));
});

test('corpus fuzz: swapping two body segments keeps the file clean for the structural checks (no false positive on order)', () => {
  const rand = kit.rng(SEED + 4242);
  for (const f of ALL) {
    const m = parse(f.text);
    const envelope = new Set(['UNA', 'UNB', 'UNZ', 'UNG', 'UNE', 'UNH', 'UNT', 'ISA', 'IEA', 'GS', 'GE', 'ST', 'SE', 'MSH', 'FHS', 'FTS', 'BHS', 'BTS']);
    const terminatorOf = (s) => f.text.slice(s.offset + s.raw.length, s.end);
    const body = m.segments.filter((s) => !envelope.has(s.id));
    if (body.length < 2) continue;
    const a = kit.pick(rand, body);
    // The partner must sit in the same interchange (same delimiters) and use the same terminator text.
    const headers = m.segments.filter((s) => ['UNA', 'UNB', 'ISA'].indexOf(s.id) !== -1);
    const sameRegion = (x, y) => !headers.some((h) => (h.offset > Math.min(x.offset, y.offset) && h.offset < Math.max(x.offset, y.offset)));
    const partners = body.filter((s) => s !== a && terminatorOf(s) === terminatorOf(a) && sameRegion(s, a));
    if (partners.length === 0) continue;
    const b = kit.pick(rand, partners);
    const first = a.offset < b.offset ? a : b;
    const second = a.offset < b.offset ? b : a;
    const text = f.text.slice(0, first.offset) + f.text.slice(second.offset, second.end) + f.text.slice(first.end, second.offset) + f.text.slice(first.offset, first.end) + f.text.slice(second.end);
    const issues = validate(parse(text), { includeParseIssues: true });
    assert.deepEqual(issues, [], f.name + ': swapping ' + a.id + ' and ' + b.id + ' raised ' + JSON.stringify(issues.slice(0, 2)));
  }
});

test('corpus fuzz: the whole corpus concatenated per format still parses with lazy segments and no crash', () => {
  for (const format of ['edifact', 'x12', 'hl7']) {
    // EDIFACT files without a UNA would inherit the delimiters of the file before them, so only
    // the files that declare their own delimiters are joined.
    const text = ALL.filter((f) => f.format === format && (format !== 'edifact' || f.text.startsWith('UNA'))).map((f) => f.text).join(format === 'hl7' ? '\r' : '');
    const m = exercise(text, format + ' concatenated');
    assert.equal(m.format, format);
    assert.ok(m.segments.length > 400, format + ' ' + m.segments.length);
    assert.deepEqual(m.issues, [], format);
  }
});
