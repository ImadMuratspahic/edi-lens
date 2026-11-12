'use strict';
// Partner rules: every rule type, scoping, rule creation from a message, reports, the whole
// corpus (rules created from a file always pass on that file) and adversarial and fuzz tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../src/pro/rules');
const { SAMPLES } = require('../src/samples');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const FORMATS = ['edifact', 'x12', 'hl7'];
const ALL = FORMATS.reduce((acc, f) => acc.concat(fs.readdirSync(path.join(CORPUS, f)).sort().map((name) => ({ format: f, name, text: fs.readFileSync(path.join(CORPUS, f, name), 'utf8') }))), []);
const corpus = (rel) => fs.readFileSync(path.join(CORPUS, rel), 'utf8');

function guide(format, list, extra) {
  const loaded = rules.loadRules(JSON.stringify(Object.assign({ format, rules: list }, extra || {})));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  return loaded.guide;
}
function check(text, format, list, extra) {
  const r = rules.validateText(text, guide(format, list, extra));
  assert.equal(r.ok, true);
  return r;
}
const brief = (r) => r.violations.map((v) => v.ruleId + '@' + (v.line + 1) + ':' + (v.column + 1) + ' ' + v.code);
const E = SAMPLES.edifact.text;

test('rules: every rule type reports its violations at the right place with the right code', () => {
  const r = check(E, 'edifact', [
    { id: 'A', type: 'segment-required', segment: 'NAD[DP]', message: 'Delivery party missing' },
    { id: 'B', type: 'value-in', path: 'BGM-1.1', values: ['221', 224] },
    { id: 'C', type: 'pattern', path: 'BGM-2', pattern: '^PO-\\d{2}-\\d{6}$' },
    { id: 'D', type: 'segment-required', segment: 'PRI[AAB]', within: 'LIN' },
    { id: 'E', type: 'equal', left: 'count(LIN)', right: 3 },
    { id: 'F', type: 'condition', if: { path: 'BGM-1.1', equals: '220' }, then: { type: 'segment-required', segment: 'FTX[AAI]' } },
    { id: 'G', type: 'range', path: 'QTY[21]-1.2', min: 1, max: 20 },
    { id: 'H', type: 'date', path: 'DTM[137]-1.2', format: 'CCYYMMDD' },
    { id: 'I', type: 'length', path: 'FTX-4', max: 10 },
    { id: 'J', type: 'occurrences', segment: 'NAD', min: 3 },
    { id: 'K', type: 'segment-forbidden', segment: 'CUX', severity: 'warning' },
    { id: 'L', type: 'element-required', path: 'NAD-4' },
  ]);
  assert.deepEqual(brief(r), [
    'A@3:1 RULES-SEGMENT-REQUIRED', 'E@3:1 RULES-EQUAL', 'F@3:1 RULES-CONDITION', 'J@3:1 RULES-OCCURRENCES',
    'B@4:5 RULES-VALUE-NOT-IN-LIST', 'C@4:9 RULES-PATTERN', 'I@7:11 RULES-LENGTH', 'L@8:1 RULES-ELEMENT-REQUIRED', 'L@9:1 RULES-ELEMENT-REQUIRED',
    'K@10:1 RULES-SEGMENT-FORBIDDEN', 'D@11:1 RULES-SEGMENT-REQUIRED', 'G@12:8 RULES-RANGE', 'D@14:1 RULES-SEGMENT-REQUIRED',
  ]);
  const by = Object.fromEntries(r.violations.map((v) => [v.ruleId + v.line, v]));
  assert.equal(by.A2.message, '[A] Delivery party missing', 'the message of the rule file is shown with the rule id');
  assert.equal(by.A2.severity, 'error');
  assert.equal(by.K9.severity, 'warning');
  assert.match(by.B3.message, /^\[B\] BGM-1\.1 has the value "220", which is not in the list of allowed values \(221, 224\)\.$/);
  assert.match(by.G11.message, /"48"; a number between 1 and 20 is expected/);
  assert.match(by.I6.message, /is 32 characters long; a length at most 10 is expected/);
  assert.match(by.F2.message, /When BGM-1\.1 is "220": Segment FTX\[AAI\] is required but is missing/);
  assert.match(by.D10.message, /required in every LIN group/);
  assert.match(by.J2.message, /must occur at least 3 times; found 2/);
  // Ranges cover exactly the value.
  assert.equal(E.split('\n')[3].slice(by.B3.column, by.B3.endColumn), '220');
  assert.equal(E.split('\n')[3].slice(by.C3.column, by.C3.endColumn), 'PO-24-00318');
  assert.equal(by.C3.endLine, 3);
  assert.deepEqual([r.units, r.unitsChecked, r.applicable, r.truncated], [1, 1, true, false]);
  for (const v of r.violations) assert.ok(v.unit === 1 && v.unitType === 'ORDERS' && v.endLine >= v.line);
});

test('rules: a message that follows the guide has no violations', () => {
  const r = check(E, 'edifact', [
    { type: 'segment-required', segment: 'BGM' }, { type: 'segment-required', segment: 'NAD[BY]' }, { type: 'segment-forbidden', segment: 'FTX[AAI]' },
    { type: 'occurrences', segment: 'LIN', min: 1, max: 2 }, { type: 'element-required', path: 'NAD[SU]-2.1' }, { type: 'value-in', path: 'CUX-1.2', values: ['EUR', 'USD'] },
    { type: 'pattern', path: 'BGM-2', pattern: '^PO-\\d{2}-\\d{5}$' }, { type: 'range', path: 'PRI-1.2', min: 0.01, max: 1000 }, { type: 'date', path: 'DTM-1.2', format: 'CCYYMMDD' },
    { type: 'length', path: 'NAD-2.1', min: 13, max: 13 }, { type: 'equal', left: 'count(LIN)', right: 'count(QTY[21])' }, { type: 'equal', left: 'MOA[86]-1.2', right: 454.8 },
    { type: 'condition', if: { segment: 'CUX' }, then: { type: 'value-in', path: 'CUX-1.1', values: ['2'] } },
    { type: 'condition', if: { path: 'BGM-1.1', in: ['380', '381'] }, then: { type: 'segment-required', segment: 'TAX' } },
    { type: 'condition', if: { path: 'BGM-1.1', equals: '380', not: true }, then: { type: 'segment-forbidden', segment: 'TAX' } },
    { type: 'segment-required', segment: 'QTY[21]', within: 'LIN' }, { type: 'occurrences', segment: 'PRI', min: 1, max: 1, within: 'LIN', until: ['UNS'] },
    { type: 'element-required', path: 'LIN#2-3.1' },
  ]);
  assert.deepEqual(brief(r), []);
  assert.equal(r.rulesApplied, 18);
});

test('rules: totals with sum(), tolerance and text equality', () => {
  const inv = corpus('edifact/two-interchanges-orders-invoic.edi');
  // The invoice: line amounts 2280.00 + 1814.40 = 4094.40 = MOA 79 = MOA 125.
  const ok = check(inv, 'edifact', [
    { id: 'T1', type: 'equal', left: 'sum(MOA[203]-1.2)', right: 'MOA[79]-1.2' },
    { id: 'T2', type: 'equal', left: 'MOA[79]-1.2', right: 'MOA[125]-1.2' },
    { id: 'T3', type: 'equal', left: 'NAD[BY]-2.1', right: 'NAD[IV]-2.1' },
  ], { messageTypes: ['INVOIC'] });
  assert.deepEqual(brief(ok), []);
  assert.deepEqual([ok.units, ok.unitsChecked], [2, 1], 'the order in the first interchange is not checked');
  const bad = check(inv, 'edifact', [
    { id: 'T4', type: 'equal', left: 'sum(MOA[203]-1.2)', right: 'MOA[86]-1.2' },
    { id: 'T5', type: 'equal', left: 'sum(MOA[203]-1.2)', right: 'MOA[86]-1.2', tolerance: 1023.6 },
    { id: 'T6', type: 'equal', left: 'NAD[BY]-2.1', right: 'NAD[SU]-2.1' },
    { id: 'T7', type: 'equal', left: 'RFF[ZZ]-1.2', right: 'BGM-2' },
  ], { messageTypes: ['INVOIC'] });
  assert.deepEqual(bad.violations.map((v) => v.ruleId).sort(), ['T4', 'T6'], 'a side without a value is not compared');
  assert.match(bad.violations.find((v) => v.ruleId === 'T4').message, /sum\(MOA\[203\]-1\.2\) is "4094\.4" but MOA\[86\]-1\.2 is "5118\.00"/);
});

test('rules: the guide applies only to its format and message types; rules can be limited further', () => {
  const g = guide('edifact', [{ id: 'R', type: 'segment-required', segment: 'ZZZ' }, { id: 'S', type: 'segment-required', segment: 'YYY', messageTypes: ['INVOIC'] }], { messageTypes: ['ORDERS', 'INVOIC'] });
  const both = rules.validateText(corpus('edifact/two-interchanges-orders-invoic.edi'), g);
  assert.deepEqual(both.violations.map((v) => v.ruleId + v.unit + v.unitType), ['R1ORDERS', 'R2INVOIC', 'S2INVOIC']);
  const other = rules.validateText(SAMPLES.x12.text, g);
  assert.deepEqual([other.ok, other.applicable, other.unitsChecked, other.violations.length, other.format], [true, false, 0, 0, 'x12']);
  const wrongType = rules.validateText(E, guide('edifact', [{ type: 'segment-required', segment: 'ZZZ' }], { messageTypes: ['DESADV'] }));
  assert.deepEqual([wrongType.applicable, wrongType.units], [false, 1]);
  // HL7 types match with or without the trigger event.
  for (const [types, hits] of [[['ADT^A01'], 1], [['ADT'], 1], [['ADT^A08'], 0], [['A*'], 1], [['*'], 1], [[], 1]]) {
    const r = rules.validateText(SAMPLES.hl7.text, guide('hl7', [{ type: 'segment-required', segment: 'ZZZ' }], { messageTypes: types }));
    assert.equal(r.violations.length, hits, JSON.stringify(types));
  }
  assert.equal(rules.validateText('hello', g).code, 'RULES-NOT-EDI');
});

test('rules: X12 and HL7 messages, qualifiers on other elements, repetitions and groups', () => {
  const x = check(corpus('x12/837p-std-lf.x12'), 'x12', [
    { id: 'X1', type: 'segment-required', segment: 'NM1[85]' }, { id: 'X2', type: 'element-required', path: 'NM1[IL]-9' },
    { id: 'X3', type: 'value-in', path: 'NM1[85]-8', values: ['XX'] }, { id: 'X4', type: 'pattern', path: 'NM1[85]-9', pattern: '^\\d{10}$' },
    { id: 'X5', type: 'segment-required', segment: 'SBR', within: 'HL[3=22]' }, { id: 'X6', type: 'segment-required', segment: 'SBR', within: 'HL' },
    { id: 'X7', type: 'date', path: 'DTP[472]-3', format: 'CCYYMMDD' }, { id: 'X8', type: 'equal', left: 'count(LX)', right: 'count(SV1)' },
    { id: 'X9', type: 'equal', left: 'sum(SV1-2)', right: 'CLM-2' }, { id: 'X10', type: 'range', path: 'SV1-2', max: 100 },
    { id: 'X11', type: 'value-in', path: 'CLM-5.1', values: ['11'] }, { id: 'X12', type: 'value-in', path: 'CLM-5.2', values: ['A'] },
  ]);
  assert.deepEqual(brief(x), ['X6@8:1 RULES-SEGMENT-REQUIRED', 'X12@20:31 RULES-VALUE-NOT-IN-LIST', 'X10@25:14 RULES-RANGE']);
  const h = check(corpus('hl7/log-four-messages-crlf.hl7'), 'hl7', [
    { id: 'H1', type: 'segment-required', segment: 'PID' }, { id: 'H2', type: 'value-in', path: 'PID-3(2).5', values: ['MB'] },
    { id: 'H3', type: 'pattern', path: 'PID-3.1', pattern: '^RS-\\d+$' }, { id: 'H4', type: 'range', path: 'OBX[3.1=2823-3]-5', min: 3.5, max: 5.1 },
    { id: 'H5', type: 'date', path: 'PID-7', format: 'CCYYMMDD' }, { id: 'H6', type: 'value-in', path: 'MSH-12', values: ['2.5.1'] },
  ], { messageTypes: ['ADT', 'ORU'] });
  assert.deepEqual(h.violations.map((v) => v.ruleId + '#' + v.unit), ['H3#2', 'H4#4'], 'the second identifier 0912345 does not match; potassium 3.4 is out of range');
  assert.deepEqual([h.units, h.unitsChecked], [4, 2]);
});

test('rules: rule files are checked and every problem is named', () => {
  const bad = [
    ['{', /not valid JSON/], ['[]', /one JSON object/], ['{"rules":[]}', /"format" must be/], ['{"format":"edifact"}', /"rules" must be a list/],
    ['{"format":"edifact","name":3,"rules":[]}', /"name" must be a text/], ['{"format":"edifact","messageTypes":"ORDERS","rules":[]}', /"messageTypes" must be a list/],
    [{ type: 'nope' }, /"type" must be one of/], [{ type: 'segment-required' }, /"segment" is not a selector/], [{ type: 'segment-required', segment: 'NAD-2' }, /must name a segment only/],
    [{ type: 'value-in', path: 'NAD' }, /must name an element/], [{ type: 'value-in', path: 'NAD-2' }, /"values" must be a list/], [{ type: 'value-in', path: 'NAD-2', values: [] }, /"values" must be a list/],
    [{ type: 'pattern', path: 'NAD-2' }, /pattern is empty/], [{ type: 'pattern', path: 'NAD-2', pattern: '(' }, /not a valid regular expression/],
    [{ type: 'pattern', path: 'NAD-2', pattern: '^(a+)+$' }, /repeated group must not contain a repetition, an optional part or an alternative/], [{ type: 'pattern', path: 'NAD-2', pattern: '(a)\\1' }, /backreferences/],
    [{ type: 'pattern', path: 'NAD-2', pattern: 'a(?=b)' }, /lookarounds/], [{ type: 'pattern', path: 'NAD-2', pattern: 'a'.repeat(301) }, /longer than 300/],
    [{ type: 'range', path: 'NAD-2' }, /needs "min", "max" or both/], [{ type: 'range', path: 'NAD-2', min: 5, max: 1 }, /"min" is larger than "max"/], [{ type: 'range', path: 'NAD-2', min: '1' }, /"min" must be a number/],
    [{ type: 'date', path: 'DTM-1.2', format: 'banana' }, /"format" must be built from/], [{ type: 'date', path: 'DTM-1.2' }, /"format" must be built from/],
    [{ type: 'occurrences', segment: 'LIN' }, /needs "min", "max" or both/], [{ type: 'condition', then: { type: 'segment-required', segment: 'A1' } }, /"if" must be an object/],
    [{ type: 'condition', if: { path: 'BGM' }, then: { type: 'segment-required', segment: 'A1' } }, /"if.path" must be a path/],
    [{ type: 'condition', if: { segment: 'BGM' }, then: { type: 'condition' } }, /then: "type" must be one of/], [{ type: 'equal', left: 'count(LIN', right: 1 }, /"left" is not a selector/],
    [{ type: 'equal', left: 'sum(LIN)', right: 1 }, /sum\(\.\.\.\) needs a path/], [{ type: 'equal', left: 'LIN', right: 1 }, /must name an element/], [{ type: 'equal', left: 1, right: 'LIN-1', tolerance: -1 }, /"tolerance"/],
    [{ type: 'segment-required', segment: 'LIN', within: 'LIN-1' }, /"within" must name a segment/], [{ type: 'segment-required', segment: 'LIN', within: 'LIN', until: ['toolong'] }, /"until" must be a list of segment ids/],
    [{ type: 'segment-required', segment: 'LIN', severity: 'fatal' }, /"severity" must be/], [{ type: 'segment-required', segment: 'LIN', id: 'a\nb' }, /"id" must be a short text/],
    [{ type: 'segment-required', segment: 'LIN', message: 7 }, /"message" must be a text/],
  ];
  for (const [input, pattern] of bad) {
    const text = typeof input === 'string' ? input : JSON.stringify({ format: 'edifact', rules: [input] });
    const r = rules.loadRules(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.code, 'RULES-FILE-INVALID');
    assert.match(r.errors.join(' '), pattern, text);
  }
  assert.match(rules.loadRules(JSON.stringify({ format: 'x12', rules: [{ id: 'A', type: 'segment-required', segment: 'N1' }, { id: 'A', type: 'segment-required', segment: 'N2' }] })).errors[0], /used twice/);
  assert.equal(rules.loadRules(JSON.stringify({ format: 'x12', rules: new Array(1001).fill({ type: 'segment-required', segment: 'N1' }) })).ok, false);
  const many = rules.loadRules(JSON.stringify({ format: 'x12', rules: new Array(60).fill({ type: 'nope' }) }));
  assert.ok(many.errors.length <= 20, 'the error list is bounded');
  const fine = rules.loadRules('﻿' + JSON.stringify({ $schema: 'x', format: 'hl7', name: 'G', rules: [{ type: 'segment-required', segment: 'PID' }] }));
  assert.equal(fine.ok, true);
  assert.equal(fine.guide.rules[0].id, 'rule 1', 'a rule without an id is numbered');
});

test('rules: patterns are examined before use; the dangerous shapes are refused', () => {
  for (const p of ['^(a+)+$', '(a|aa)+', '(a*)*', '(a?a?)*b', '(ab?)+', '(a{0,1}b)*', '((a)?)+', '([a-z]+)*', '(x+x+)+y', '(a|b)*c', '((a)+)+', '(.*a){20}', '\\1', '(?<n>a)\\k<n>', '(?=a)', '(?!a)', '(?<=a)b', '(?<!a)b', '', '(']) {
    assert.equal(rules.checkPattern(p).ok, false, p);
  }
  for (const p of ['^\\d+$', '^[A-Z]{2}\\d{6}$', '^(?:AB|CD)-\\d{3}$', '^PO-\\d{2}-\\d{5}$', '^[^+:]+$', '^(\\d\\d)+$', '^[\\]\\[)(]+$', '^a{2,5}b?$', '^\\(x\\)+$', '^(?<year>\\d{4})-\\d\\d$', '^(\\d\\d)?$', '^(AB|CD)?\\d+$', '^(?:\\+|-)?\\d+$']) {
    assert.deepEqual(rules.checkPattern(p), { ok: true, guarded: false }, p);
  }
  assert.deepEqual(rules.checkPattern('a*b*c*d*e*'), { ok: true, guarded: true }, 'many open-ended repetitions run with a time limit');
  assert.equal(rules.checkPattern(42).ok, false);
});

test('rules: a slow pattern is stopped, reported once and does not block the rest', () => {
  const value = 'a'.repeat(3000) + '!';
  const text = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'FTX+AAI+++" + value + "'FTX+AAI+++" + value + "'BGM+220+X+9'UNT+5+1'UNZ+1+R1'";
  const started = Date.now();
  const r = check(text, 'edifact', [
    { id: 'SLOW', type: 'pattern', path: 'FTX-4', pattern: '^a*a*a*a*a*a*a*a*$' },
    { id: 'FAST', type: 'value-in', path: 'BGM-1.1', values: ['221'] },
  ]);
  assert.ok(Date.now() - started < 15000, 'took ' + (Date.now() - started) + ' ms');
  assert.deepEqual(r.stoppedPatterns, ['SLOW']);
  assert.deepEqual(r.violations.map((v) => v.ruleId + ' ' + v.code).sort(), ['FAST RULES-VALUE-NOT-IN-LIST', 'SLOW RULES-PATTERN-STOPPED']);
  assert.match(r.violations.find((v) => v.ruleId === 'SLOW').message, /took too long/);
});

test('rules: dates are real calendar dates in the given format', () => {
  const f = (format) => rules.compileDateFormat(format);
  const ok = (format, value) => rules.matchesDate(f(format), value);
  assert.ok(ok('CCYYMMDD', '20240229') && !ok('CCYYMMDD', '20230229') && !ok('CCYYMMDD', '20241301') && !ok('CCYYMMDD', '2024022') && !ok('CCYYMMDD', '202402290'));
  assert.ok(ok('YYMMDD', '240229') && !ok('YYMMDD', '240230') && ok('CCYYMMDDhhmm', '202403111015') && !ok('CCYYMMDDhhmm', '202403112515') && !ok('CCYYMMDDhhmmss', '20240311101561'));
  assert.ok(ok('CCYY-MM-DD', '2024-03-11') && !ok('CCYY-MM-DD', '2024/03/11') && ok('hhmm', '2359') && !ok('hhmm', '2360') && ok('YYYYMMDD', '20240311') && ok('MMDD', '0229'));
  for (const bad of ['', 'banana', 'CCYYxMMDD', 'A', 'CCYYMMDD'.repeat(6), 42, null, '---']) assert.equal(f(bad), null, String(bad));
});

test('rules: Create Rules From This Message writes rules the message itself passes', () => {
  const made = rules.inferRules(E, { label: 'orders.edi' });
  assert.equal(made.ok, true);
  assert.equal(made.guide.format, 'edifact');
  assert.deepEqual(made.guide.messageTypes, ['ORDERS']);
  assert.equal(made.guide.name, 'Rules created from orders.edi');
  const byId = (type, key) => made.guide.rules.filter((r) => r.type === type).map((r) => r[key]);
  assert.deepEqual(byId('segment-required', 'segment'), ['BGM', 'DTM', 'FTX', 'NAD', 'CUX', 'LIN', 'QTY', 'PRI', 'UNS', 'MOA']);
  assert.ok(byId('element-required', 'path').includes('NAD-2') && !byId('element-required', 'path').includes('NAD-3'));
  const lists = Object.fromEntries(made.guide.rules.filter((r) => r.type === 'value-in').map((r) => [r.path, r.values]));
  assert.deepEqual(lists['NAD-1.1'], ['BY', 'SU']);
  assert.deepEqual(lists['BGM-1.1'], ['220']);
  assert.deepEqual(lists['CUX-1.2'], ['EUR']);
  assert.equal(lists['LIN-1.1'], undefined, 'line numbers are no code list');
  assert.equal(lists['QTY-1.2'], undefined, 'quantities are no code list');
  assert.ok(made.guide.rules.every((r) => /^R\d{3}$/.test(r.id) && r.message.length > 5));
  const loaded = rules.loadRules(JSON.stringify(made.guide));
  assert.equal(loaded.ok, true);
  assert.deepEqual(rules.validateText(E, loaded.guide).violations, []);
  // A changed message is caught by the created rules.
  const changed = E.replace('NAD+SU+', 'NAD+ZZ+').replace("BGM+220+", "BGM+999+").replace("CUX+2:EUR:9'\n", '');
  assert.deepEqual(rules.validateText(changed, loaded.guide).violations.map((v) => v.code).sort(), ['RULES-SEGMENT-REQUIRED', 'RULES-VALUE-NOT-IN-LIST', 'RULES-VALUE-NOT-IN-LIST']);
  assert.equal(rules.inferRules('nothing here').code, 'RULES-NOT-EDI');
  assert.equal(rules.inferRules("UNB+UNOC:3+A+B+240117:1200+R1'UNZ+0+R1'").code, 'RULES-NOT-EDI');
});

test('rules corpus: rules created from each of the 126 files load and pass on that file', () => {
  let total = 0;
  for (const f of ALL) {
    const made = rules.inferRules(f.text, { label: f.name });
    assert.equal(made.ok, true, f.name);
    assert.equal(made.guide.format, f.format);
    assert.ok(made.guide.rules.length >= 3, f.name + ' gave only ' + made.guide.rules.length + ' rules');
    const loaded = rules.loadRules(JSON.stringify(made.guide));
    assert.equal(loaded.ok, true, f.name + ': ' + JSON.stringify(loaded.errors));
    const r = rules.validateText(f.text, loaded.guide);
    assert.equal(r.applicable, true, f.name);
    assert.equal(r.unitsChecked, r.units, f.name);
    assert.deepEqual(r.violations, [], f.name + ' does not pass its own rules');
    total += made.guide.rules.length;
    // The same rules are created every time.
    assert.deepEqual(rules.inferRules(f.text, { label: f.name }).guide, made.guide);
  }
  assert.ok(total > 3000, String(total));
});

test('rules corpus: a file checked against the rules of another message type is not checked at all', () => {
  const orders = rules.loadRules(JSON.stringify(rules.inferRules(corpus('edifact/orders-una-lf.edi')).guide)).guide;
  const r = rules.validateText(corpus('edifact/invoic-una-lf.edi'), orders);
  assert.deepEqual([r.applicable, r.violations.length], [false, 0]);
  const same = rules.validateText(corpus('edifact/orders-nouna-crlf.edi'), orders);
  assert.equal(same.applicable, true);
});

test('rules: the number of violations is capped and the cap is reported', () => {
  const body = "LIN+1++X:EN'".repeat(3000);
  const text = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'" + body + "UNT+3002+1'UNZ+1+R1'";
  const g = guide('edifact', [{ id: 'N', type: 'pattern', path: 'LIN-3.1', pattern: '^\\d+$' }]);
  const r = rules.validateText(text, g, { maxIssues: 50 });
  assert.equal(r.violations.length, 50);
  assert.equal(r.truncated, true);
  assert.equal(rules.validateText(text, g).violations.length, 500, 'the default cap');
});

test('rules: CSV and HTML reports escape everything that comes from files and rule files', () => {
  const g = guide('edifact', [{ id: '=cmd', type: 'value-in', path: 'BGM-2', values: ['x'], message: '<img src=x onerror=alert(1)> "quoted", & more' }], { name: '<script>alert(1)</script>' });
  const text = E.replace('PO-24-00318', '=1+1');
  const files = [
    { label: 'in/<b>orders</b>,a.edi', result: rules.validateText(text, g) },
    { label: 'other.x12', result: rules.validateText(SAMPLES.x12.text, g) },
    { label: 'broken.bin', skipped: 'Not valid UTF-8 text.' },
  ];
  const csv = rules.toCsv(files, true);
  assert.equal(csv.split('\r\n')[0], 'file,line,column,severity,code,rule,message_number,message_type,message');
  assert.equal(csv.split('\r\n')[1], '"in/<b>orders</b>,a.edi",4,9,error,RULES-VALUE-NOT-IN-LIST,\'=cmd,1,ORDERS,"[=cmd] <img src=x onerror=alert(1)> ""quoted"", & more"');
  assert.equal(csv.split('\r\n').length, 3, 'one row and the final line break');
  assert.match(rules.toCsv(files, false), /,=cmd,1,ORDERS/);
  const html = rules.toHtml(files, { guideName: g.name, reportDate: '2024-03-11 10:15 UTC', cancelled: true });
  assert.ok(!/<script|<img|<b>/.test(html), 'no markup from data');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /in\/&lt;b&gt;orders&lt;\/b&gt;,a\.edi/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /1 files checked, 1 rule violations, 2 files not checked\. The run was cancelled/);
  assert.match(html, /other\.x12: the rule file is for another format or message type/);
  assert.match(html, /broken\.bin: Not valid UTF-8 text\./);
});

test('rules fuzz: mutated files and hostile rule files never crash and give valid positions (seed 7)', () => {
  const rand = kit.rng(7);
  const selectors = ['NAD', 'NAD[BY]', 'PID', 'N1[ST]', 'OBX[3.1=2345-7]', 'LIN#2', 'QTY[21]', 'ST', 'UNH', 'MSH', 'ZZZ', 'HL[3=22]'];
  const paths = ['NAD-2.1', 'PID-5.1', 'PID-3(2).1', 'N1-2', 'BGM-1.1', 'DTM[137]-1.2', 'OBX-5', 'MSH-9.1', 'SE-1', 'UNT-1', 'ISA-13', 'ZZZ-99.99.99', 'PO1-2'];
  const pick = (list) => list[Math.floor(rand() * list.length)];
  let cases = 0;
  let violations = 0;
  for (const f of ALL) {
    const list = [];
    for (let i = 0; i < 12; i++) {
      const type = pick(['segment-required', 'segment-forbidden', 'occurrences', 'element-required', 'value-in', 'pattern', 'range', 'date', 'length', 'condition', 'equal']);
      const rule = { id: 'F' + i, type };
      if (rand() < 0.3) { rule.within = pick(selectors); if (rand() < 0.5) rule.until = ['UNS', 'CTT']; }
      if (['segment-required', 'segment-forbidden', 'occurrences'].includes(type)) { rule.segment = pick(selectors); rule.min = 0; rule.max = Math.floor(rand() * 3); } else if (type === 'condition') {
        rule.if = rand() < 0.5 ? { segment: pick(selectors) } : { path: pick(paths), equals: '220', not: rand() < 0.3 };
        rule.then = { type: 'element-required', path: pick(paths) };
      } else if (type === 'equal') { rule.left = pick(['count(' + pick(selectors) + ')', 'sum(' + pick(paths) + ')', pick(paths)]); rule.right = pick([pick(paths), 3, 'count(' + pick(selectors) + ')']); } else {
        rule.path = pick(paths);
        rule.values = ['220', 'BY', 'EA'];
        rule.pattern = pick(['^\\d+$', '^[A-Z]+$', '.', '^$']);
        rule.min = 1; rule.max = 5; rule.format = pick(['CCYYMMDD', 'YYMMDD', 'CCYYMMDDhhmm']);
      }
      list.push(rule);
    }
    const loaded = rules.loadRules(JSON.stringify({ format: f.format, rules: list }));
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
    for (let k = 0; k < 3; k++) {
      let text = f.text;
      const at = Math.floor(rand() * text.length);
      const kind = Math.floor(rand() * 4);
      if (kind === 1) text = text.slice(0, at) + text.slice(at + 9);
      else if (kind === 2) text = text.slice(0, at);
      else if (kind === 3) text = text.slice(0, at) + "\r\n\u0000'~|" + text.slice(at);
      const r = rules.validateText(text, loaded.guide, { maxIssues: 200 });
      cases++;
      if (!r.ok) { assert.equal(r.code, 'RULES-NOT-EDI'); continue; }
      violations += r.violations.length;
      const lines = text.split(/\r\n|\r|\n/);
      for (const v of r.violations) {
        assert.ok(v.offset >= 0 && v.end >= v.offset && v.end <= text.length, f.name);
        assert.ok(v.line >= 0 && v.line < lines.length && v.endLine >= v.line && v.endLine < lines.length, f.name);
        assert.ok(v.column >= 0 && v.column <= lines[v.line].length && v.endColumn <= lines[v.endLine].length, f.name + ' ' + JSON.stringify(v));
        assert.match(v.code, /^RULES-[A-Z-]+$/);
        assert.match(v.message, /^\[F\d+\] /);
      }
      assert.deepEqual(rules.validateText(text, loaded.guide, { maxIssues: 200 }).violations, r.violations, 'the same result every time');
    }
  }
  assert.equal(cases, 378);
  assert.ok(violations > 500, String(violations));
});

test('rules: every problem code is documented in docs/partner-rules.md and nothing else is', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'partner-rules.md'), 'utf8');
  for (const code of Object.values(rules.CODES)) assert.ok(doc.includes('`' + code + '`'), code + ' is not documented');
  for (const m of doc.matchAll(/`(RULES-[A-Z-]+)`/g)) assert.ok(Object.values(rules.CODES).includes(m[1]), m[1] + ' is documented but does not exist');
});
