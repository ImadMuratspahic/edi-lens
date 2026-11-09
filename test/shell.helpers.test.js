'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMock, install } = require('./shell.vscode-mock');

// The shell modules require 'vscode' only inside functions that need it, but commands.js and
// friends are loaded here with a stand-in to be safe.
const uninstall = install(createMock().vscode);
const { getCore } = require('../src/format');
const commands = require('../src/commands');
const tree = require('../src/tree');
const { hoverLines, inlineCode } = require('../src/hover');
const { statusContent } = require('../src/status');
const { issueSpan } = require('../src/diagnostics');
uninstall();

const core = getCore();

const ORDERS = [
  "UNA:+.? '",
  "UNB+UNOC:3+4012345000009:14+4098765000008:14+240117:1200+MUL3'",
  "UNH+1+ORDERS:D:96A:UN'",
  "BGM+220+PO-1001+9'",
  "NAD+BY+4012345000009::9'",
  "NAD+SU+4098765000008::9'",
  "UNT+5+1'",
  "UNH+2+ORDERS:D:96A:UN'",
  "BGM+220+PO-1002+9'",
  "UNT+3+2'",
  "UNZ+2+MUL3'"
].join('\n');

const X12 = [
  'ISA*00*          *00*          *ZZ*ACMEBUYER      *ZZ*GLOBALSUPPLY   *240115*0930*U*00401*000000101*0*P*>~',
  'GS*PO*ACMEBUYER*GLOBALSUPPLY*20240115*0930*101*X*004010~',
  'ST*850*0001~',
  'BEG*00*SA*PO-1**20240115~',
  'SE*3*0001~',
  'GE*1*101~',
  'IEA*1*000000101~'
].join('\n');

const HL7 = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|MSG1|P|2.5\rPID|1||123^^^H^MR||Doe^Jane~Roe^Rita||19800214\rNK1|1|a^b&c\r';

function ids(message) { return message.segments.map((s) => s.id + '[' + s.occurrence + ']'); }

test('findMatchingSegment pairs envelope segments in both directions (EDIFACT)', () => {
  const m = core.parse(ORDERS);
  const at = (label) => ids(m).indexOf(label);
  assert.equal(commands.findMatchingSegment(m.segments, at('UNH[1]')), at('UNT[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('UNT[1]')), at('UNH[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('UNH[2]')), at('UNT[2]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('UNT[2]')), at('UNH[2]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('UNB[1]')), at('UNZ[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('UNZ[1]')), at('UNB[1]'));
});

test('findMatchingSegment pairs X12 envelopes', () => {
  const m = core.parse(X12);
  const at = (label) => ids(m).indexOf(label);
  assert.equal(commands.findMatchingSegment(m.segments, at('ISA[1]')), at('IEA[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('GS[1]')), at('GE[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('ST[1]')), at('SE[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('SE[1]')), at('ST[1]'));
  assert.equal(commands.findMatchingSegment(m.segments, at('IEA[1]')), at('ISA[1]'));
});

test('findMatchingSegment returns null for body segments and -1 for a missing partner', () => {
  const m = core.parse(ORDERS);
  assert.equal(commands.findMatchingSegment(m.segments, ids(m).indexOf('BGM[1]')), null);
  const broken = core.parse("UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+X'");
  assert.equal(commands.findMatchingSegment(broken.segments, 1), -1, 'UNH without UNT');
  assert.equal(commands.findMatchingSegment(broken.segments, 0), -1, 'UNB without UNZ');
  const orphan = core.parse("UNB+UNOC:3+A+B+240117:1200+R1'UNT+1+1'UNZ+1+R1'");
  assert.equal(commands.findMatchingSegment(orphan.segments, 1), -1, 'UNT without UNH');
});

test('findMatchingSegment respects nesting of identical openers', () => {
  const segs = ['GS', 'GS', 'GE', 'GE'].map((id, i) => ({ id, index: i }));
  assert.equal(commands.findMatchingSegment(segs, 0), 3);
  assert.equal(commands.findMatchingSegment(segs, 1), 2);
  assert.equal(commands.findMatchingSegment(segs, 2), 1);
  assert.equal(commands.findMatchingSegment(segs, 3), 0);
});

test('findMatchingSegment pairs HL7 batch envelopes', () => {
  const m = core.parse('FHS|^~\\&|A\rBHS|^~\\&|A\rMSH|^~\\&|A|B\rBTS|1\rFTS|1\r');
  assert.equal(commands.findMatchingSegment(m.segments, 0), 4);
  assert.equal(commands.findMatchingSegment(m.segments, 1), 3);
  assert.equal(commands.findMatchingSegment(m.segments, 4), 0);
});

test('segmentIndexAt finds the segment containing or preceding an offset', () => {
  const m = core.parse(ORDERS);
  const segs = m.segments;
  assert.equal(commands.segmentIndexAt(segs, 0), 0);
  for (let i = 0; i < segs.length; i++) {
    assert.equal(commands.segmentIndexAt(segs, segs[i].offset), i);
    assert.equal(commands.segmentIndexAt(segs, segs[i].offset + 2), i);
    assert.equal(commands.segmentIndexAt(segs, segs[i].end - 1), i);
  }
  assert.equal(commands.segmentIndexAt(segs, ORDERS.length + 50), segs.length - 1);
  assert.equal(commands.segmentIndexAt([], 5), -1);
  assert.equal(commands.segmentIndexAt([{ offset: 10 }], 3), -1);
});

test('segmentPickItems lists segments with occurrence, line and a preview', () => {
  const m = core.parse(ORDERS);
  const items = commands.segmentPickItems(m);
  assert.equal(items.length, m.segments.length);
  const nad2 = items.find((i) => i.label === 'NAD[2]');
  assert.ok(nad2);
  assert.equal(nad2.description, 'line 6');
  assert.equal(nad2.detail, "NAD+SU+4098765000008::9");
  assert.equal(items[0].index, 0);
  assert.equal(nad2.index, ids(m).indexOf('NAD[2]'));
  assert.equal(commands.segmentPickItems(m, 3).length, 3);
});

test('licence status text covers every state', () => {
  const base = { mode: 'live', keyHint: '...abcd', lastGoodAt: Date.UTC(2026, 0, 2), graceEndsAt: Date.UTC(2026, 0, 16) };
  assert.match(commands.licenceStatusText(Object.assign({}, base, { pro: true, via: 'server', hasKey: true })), /Pro is active on this machine \(key \.\.\.abcd\)/);
  assert.match(commands.licenceStatusText(Object.assign({}, base, { pro: true, via: 'grace', hasKey: true })), /offline mode/);
  assert.match(commands.licenceStatusText(Object.assign({}, base, { pro: false, via: 'rejected', hasKey: true })), /no longer valid/);
  assert.match(commands.licenceStatusText(Object.assign({}, base, { pro: false, via: 'expired', hasKey: true })), /more than 14 days/);
  assert.match(commands.licenceStatusText(Object.assign({}, base, { pro: false, via: 'none', hasKey: false })), /EDI Lens Free/);
  assert.match(commands.licenceStatusText(Object.assign({}, base, { mode: 'test', pro: false, via: 'none', hasKey: false })), /test environment/);
});

test('activation failure texts are specific and never mention internals', () => {
  assert.match(commands.activationFailureText({ reason: 'limit' }), /maximum number of machines/);
  assert.match(commands.activationFailureText({ reason: 'invalid' }), /not recognised/);
  assert.match(commands.activationFailureText({ reason: 'network' }), /could not be reached/);
  assert.match(commands.activationFailureText({ reason: 'error', status: 500 }), /HTTP 500/);
  assert.match(commands.activationFailureText({ reason: 'error' }), /try again later/);
});

test('tree: segment descriptors carry label, preview and range', () => {
  const m = core.parse(ORDERS);
  const d = tree.segmentDescriptors(m, { formatPath: core.formatPath });
  assert.equal(d.length, m.segments.length);
  const nad = d.filter((x) => x.label.startsWith('NAD'));
  assert.deepEqual(nad.map((x) => x.label), ['NAD[1]', 'NAD[2]']);
  assert.equal(nad[0].description, 'BY+4012345000009::9');
  assert.equal(nad[0].path, 'NAD[1]');
  assert.equal(nad[0].kind, 'segment');
  assert.equal(nad[0].collapsible, true);
  const seg = m.segments[ids(m).indexOf('NAD[1]')];
  assert.equal(nad[0].start, seg.offset);
  assert.equal(ORDERS.slice(nad[0].start, nad[0].end), "NAD+BY+4012345000009::9");
});

test('tree: segment list is capped and reports how many are hidden', () => {
  const m = core.parse(ORDERS);
  const d = tree.segmentDescriptors(m, { maxSegments: 4 });
  assert.equal(d.length, 5);
  assert.equal(d[4].kind, 'more');
  assert.match(d[4].label, /7 more segments/);
  assert.equal(d[4].start, -1);
});

test('tree: elements and components of an EDIFACT segment', () => {
  const m = core.parse(ORDERS);
  const nad = tree.segmentDescriptors(m, { formatPath: core.formatPath }).find((x) => x.label === 'NAD[1]');
  const elements = tree.childDescriptors(nad, { formatPath: core.formatPath });
  assert.deepEqual(elements.map((e) => e.label), ['NAD-1', 'NAD-2']);
  assert.equal(elements[0].collapsible, false);
  assert.equal(elements[1].collapsible, true);
  assert.equal(elements[1].path, 'NAD[1]-2');
  const comps = tree.childDescriptors(elements[1], { formatPath: core.formatPath });
  assert.deepEqual(comps.map((c) => c.label), ['NAD-2.1', 'NAD-2.3'], 'the empty component 2 is left out');
  assert.deepEqual(comps.map((c) => c.description), ['4012345000009', '9']);
  assert.equal(comps[1].path, 'NAD[1]-2.3');
  assert.equal(ORDERS.slice(comps[0].start, comps[0].end), '4012345000009');
});

test('tree: HL7 repetitions, components and subcomponents', () => {
  const m = core.parse(HL7);
  const pid = tree.segmentDescriptors(m, { formatPath: core.formatPath }).find((x) => x.label === 'PID[1]');
  const els = tree.childDescriptors(pid, { formatPath: core.formatPath });
  assert.deepEqual(els.map((e) => e.label), ['PID-1', 'PID-3', 'PID-5', 'PID-7']);
  const name = els.find((e) => e.label === 'PID-5');
  assert.equal(name.collapsible, true);
  const reps = tree.childDescriptors(name, { formatPath: core.formatPath });
  assert.deepEqual(reps.map((r) => r.label), ['PID-5(1)', 'PID-5(2)']);
  assert.equal(reps[1].path, 'PID[1]-5(2)');
  const comps = tree.childDescriptors(reps[1], { formatPath: core.formatPath });
  assert.deepEqual(comps.map((c) => c.label), ['PID-5(2).1', 'PID-5(2).2']);
  assert.equal(comps[0].path, 'PID[1]-5(2).1');
  assert.equal(comps[0].description, 'Roe');

  const nk1 = tree.segmentDescriptors(m, { formatPath: core.formatPath }).find((x) => x.label === 'NK1[1]');
  const nkEls = tree.childDescriptors(nk1, { formatPath: core.formatPath });
  const e2 = nkEls.find((e) => e.label === 'NK1-2');
  const c = tree.childDescriptors(e2, { formatPath: core.formatPath });
  assert.deepEqual(c.map((x) => x.label), ['NK1-2.1', 'NK1-2.2']);
  assert.equal(c[1].collapsible, true, 'component b&c has subcomponents');
  const subs = tree.childDescriptors(c[1], { formatPath: core.formatPath });
  assert.deepEqual(subs.map((s) => s.label), ['NK1-2.2.1', 'NK1-2.2.2']);
  assert.deepEqual(subs.map((s) => s.description), ['b', 'c']);
  assert.equal(subs[1].path, 'NK1[1]-2.2.2');
  assert.deepEqual(tree.childDescriptors(subs[0], {}), []);
});

test('tree: descriptions use dictionary names when provided', () => {
  const m = core.parse(ORDERS);
  const describe = (segId, e, c, value) => {
    if (segId === 'BGM' && e === undefined) return { segmentName: 'Beginning of message' };
    if (segId === 'BGM' && e === 1) return { elementName: 'Document name' };
    if (segId === 'BGM' && e === 2 && c === 1) return { componentName: 'Document number', valueName: value === 'PO-1001' ? 'first order' : undefined };
    return {};
  };
  const bgm = tree.segmentDescriptors(m, { describe }).find((x) => x.label === 'BGM[1]');
  assert.equal(bgm.description, 'Beginning of message · 220+PO-1001+9');
  const els = tree.childDescriptors(bgm, { describe });
  assert.equal(els[0].description, 'Document name · 220');
});

test('tree: works without a path function and on messages without segments', () => {
  const m = core.parse(ORDERS);
  const d = tree.segmentDescriptors(m, {});
  assert.equal(d[3].path, 'BGM[1]');
  assert.deepEqual(tree.segmentDescriptors(core.parse('nothing here'), {}), []);
  assert.deepEqual(tree.segmentDescriptors(null, {}), []);
  assert.deepEqual(tree.childDescriptors({ kind: 'segment', ref: {} }, {}), []);
});

test('hover: lines for an element with a dictionary name', () => {
  const m = core.parse(ORDERS);
  const text = ORDERS;
  const loc = core.locate(m, text.indexOf('PO-1001') + 2);
  const lines = hoverLines(loc, { segmentName: 'Beginning of message', elementName: 'Document number' });
  const flat = lines.map((l) => l.map((p) => p.v).join(''));
  assert.equal(flat[0], '**' + loc.path + '**');
  assert.ok(flat.includes('Segment: Beginning of message'));
  assert.ok(flat.includes('Element: Document number'));
  assert.ok(flat.some((l) => l === 'Value: PO-1001'));
  assert.ok(flat.some((l) => /^Position: element 2/.test(l)));
  assert.ok(flat.some((l) => l === 'Length: 7 code points'));
});

test('hover: lines for a repetition, component and subcomponent', () => {
  const m = core.parse(HL7);
  const offset = HL7.indexOf('Roe') + 1;
  const loc = core.locate(m, offset);
  const flat = hoverLines(loc, {}).map((l) => l.map((p) => p.v).join(''));
  assert.ok(flat.some((l) => /Position: element 5, repetition 2 of 2, component 1/.test(l)), flat.join('|'));
  const subLoc = core.locate(m, HL7.indexOf('c\r') );
  const subFlat = hoverLines(subLoc, {}).map((l) => l.map((p) => p.v).join(''));
  assert.ok(subFlat.some((l) => /subcomponent 2/.test(l)), subFlat.join('|'));
});

test('hover: code point length is not the UTF-16 length', () => {
  const m = core.parse("UNB+UNOC:3+A+B+240117:1200+R1'FTX+AAI+++\u{1F600}\u{1F600}'UNZ+0+R1'");
  const loc = core.locate(m, m.text.indexOf('\u{1F600}') + 1);
  const flat = hoverLines(loc, {}).map((l) => l.map((p) => p.v).join(''));
  assert.ok(flat.includes('Length: 2 code points'), flat.join('|'));
});

test('hover: inlineCode copes with backticks and line breaks', () => {
  assert.equal(inlineCode('abc'), '`abc`');
  assert.equal(inlineCode('a`b'), '``a`b``');
  assert.equal(inlineCode('`'), '`` ` ``');
  assert.equal(inlineCode('a\r\nb'), '`a b`');
  assert.equal(inlineCode('a``b'), '```a``b```');
});

test('hover: dictionary text is plain text parts, never markdown', () => {
  const m = core.parse(ORDERS);
  const loc = core.locate(m, ORDERS.indexOf('PO-1001'));
  const lines = hoverLines(loc, { elementName: '[x](command:evil) **bold**' });
  const named = lines.find((l) => l[0].v.startsWith('Element:'));
  assert.equal(named[0].t, 'text');
});

test('status: content for a clean file, a file with problems and an oversized file', () => {
  const clean = statusContent('x12', { skipped: null, format: 'x12', segments: 18, counts: { error: 0, warning: 0, info: 0 } });
  assert.equal(clean.text, '$(check) ANSI X12 · 18 segments · 0 issues');
  const bad = statusContent('edifact', { skipped: null, format: 'edifact', segments: 1, counts: { error: 1, warning: 2, info: 0 } });
  assert.equal(bad.text, '$(error) UN/EDIFACT · 1 segment · 3 issues');
  assert.match(bad.tooltip, /1 error, 2 warnings, 0 notes/);
  const warn = statusContent('hl7', { skipped: null, format: 'hl7', segments: 4, counts: { error: 0, warning: 1, info: 1 } });
  assert.ok(warn.text.startsWith('$(warning) HL7 v2'));
  const big = statusContent('x12', { skipped: 'size', limitMB: 10, segments: 0, counts: { error: 0, warning: 0, info: 0 } });
  assert.match(big.text, /over limit/);
  assert.match(big.tooltip, /10 MB/);
  const none = statusContent('hl7', null);
  assert.equal(none.text, '$(file-code) HL7 v2');
});

test('diagnostics: issueSpan widens empty ranges and clamps to the text', () => {
  assert.deepEqual(issueSpan({ offset: 5, end: 9 }, 100), { start: 5, end: 9 });
  assert.deepEqual(issueSpan({ offset: 5, end: 5 }, 100), { start: 5, end: 6 });
  assert.deepEqual(issueSpan({ offset: 100, end: 100 }, 100), { start: 100, end: 100 });
  assert.deepEqual(issueSpan({ offset: 98, end: 200 }, 100), { start: 98, end: 100 });
  assert.deepEqual(issueSpan({ offset: -4, end: 2 }, 100), { start: 0, end: 2 });
  assert.deepEqual(issueSpan({ offset: 7 }, 100), { start: 7, end: 8 });
});
