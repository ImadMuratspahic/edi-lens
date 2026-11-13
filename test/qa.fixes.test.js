'use strict';
// Regression tests for the defects found by the release review of 0.2.0: exact comparison of long
// numbers, envelope identifiers and unchanged files in Anonymise, date ranges, acknowledgements of
// damaged envelopes, the pattern time budget, HL7 merge and the diagnostics block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shared = require('../src/pro/shared');
const query = require('../src/pro/query');
const rules = require('../src/pro/rules');
const anon = require('../src/pro/anonymise');
const env = require('../src/pro/envelope');
const support = require('../src/support');
const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const { SAMPLES } = require('../src/samples');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const corpus = (rel) => fs.readFileSync(path.join(CORPUS, rel), 'utf8');
const ALL = ['edifact', 'x12', 'hl7'].reduce((acc, f) => acc.concat(fs.readdirSync(path.join(CORPUS, f)).sort().map((name) => ({ format: f, name, text: fs.readFileSync(path.join(CORPUS, f, name), 'utf8') }))), []);
const issues = (text) => validate(parse(text), { includeParseIssues: true }).map((i) => i.code);
const NOW = new Date(2024, 2, 11, 10, 15, 30);
const units = (text, q, o) => query.scanText(text, query.compile(q, o), o).matches.map((m) => m.unit);

// ---- exact numbers -------------------------------------------------------------------------------

const SSCC = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+DESADV:D:96A:UN'GIN+BJ+340123456789012346'RFF+ZZ:340123456789012345'RFF+ON:0012345'QTY+12:1.50'MOA+9:99999999999999999.01'MOA+9:0.02'UNT+7+1'UNZ+1+R1'";

test('exact numbers: decimals are compared digit by digit, whatever their length', () => {
  const c = shared.compareDecimal;
  assert.equal(c('340123456789012346', '340123456789012345'), 1, 'eighteen digits, last digit differs');
  assert.equal(c('340123456789012345', '340123456789012345'), 0);
  assert.equal(c('9007199254740993', '9007199254740992'), 1, 'just above what a binary number can hold');
  assert.equal(c('0012345', '12345'), 0, 'leading zeros do not count');
  assert.equal(c('1.50', '1.5'), 0, 'zeros at the end of a fraction do not count');
  assert.equal(c('1,5', '1.50'), 0, 'a decimal comma is understood');
  assert.equal(c('-0', '0'), 0);
  assert.equal(c('-2', '1'), -1);
  assert.equal(c('0.1', '0.10000000000000000001'), -1);
  assert.equal(c('123456789012345678901234567890.5', '123456789012345678901234567890.4'), 1);
  assert.equal(c('.5', '0.5'), 0);
  assert.equal(c('5.', '5'), 0);
  for (const bad of ['', ' ', 'abc', '1e5', '0x10', '1.2.3', '--1', '+', '.', '1 000', 'NaN', 'Infinity', null, undefined, {}, '9'.repeat(401)]) assert.equal(c(bad, '1'), null, String(bad));
  assert.equal(shared.formatDecimal(shared.addDecimal(shared.parseDecimal('99999999999999999.01'), shared.parseDecimal('0.02'))), '99999999999999999.03');
  assert.equal(shared.formatDecimal(shared.parseDecimal('-0.50')), '-0.5');
  assert.equal(shared.formatDecimal(shared.parseDecimal('007')), '7');
  assert.equal(shared.withinDecimal(shared.parseDecimal('1.00'), shared.parseDecimal('1.01'), shared.parseDecimal('0.01')), true);
  assert.equal(shared.withinDecimal(shared.parseDecimal('1.00'), shared.parseDecimal('1.02'), shared.parseDecimal('0.01')), false);
});

test('query: an 18-digit identifier matches only itself, as text and as a number', () => {
  assert.deepEqual(units(SSCC, 'GIN-2.1 == "340123456789012346"'), [1]);
  assert.deepEqual(units(SSCC, 'GIN-2.1 == "340123456789012345"'), [], 'the neighbour (last digit differs) does not match');
  assert.deepEqual(units(SSCC, 'GIN-2.1 == 340123456789012345'), [], 'nor as a number');
  assert.deepEqual(units(SSCC, 'GIN-2.1 == 340123456789012346'), [1]);
  assert.deepEqual(units(SSCC, 'GIN-2.1 != 340123456789012345'), [1]);
  assert.deepEqual(units(SSCC, 'GIN-2.1 > 340123456789012345'), [1]);
  assert.deepEqual(units(SSCC, 'GIN-2.1 > 340123456789012346'), []);
  assert.deepEqual(units(SSCC, 'GIN-2.1 >= 340123456789012346 AND GIN-2.1 <= 340123456789012346'), [1]);
  assert.deepEqual(units(SSCC, 'GIN-2.1 == RFF[ZZ]-1.2'), [], 'two paths: off by one in the last digit is not equal');
  assert.deepEqual(units(SSCC, 'GIN-2.1 > RFF[ZZ]-1.2'), [1]);
  assert.deepEqual(units(SSCC, 'sum(MOA[9]-1.2) == 99999999999999999.03'), [1], 'sums are exact');
  assert.deepEqual(units(SSCC, 'sum(MOA[9]-1.2) == 99999999999999999.02'), []);
});

test('query: a text in quotes is text, a number is a number; leading and trailing zeros', () => {
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 == "12345"'), [], 'a quoted text does not match 0012345');
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 == "0012345"'), [1]);
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 == 12345'), [1], 'as a number the leading zeros do not count');
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 == 0012345'), [1]);
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 != "12345"'), [1]);
  assert.deepEqual(units(SSCC, 'QTY[12]-1.2 == 1.5'), [1], '1.50 is 1.5');
  assert.deepEqual(units(SSCC, 'QTY[12]-1.2 == "1.5"'), []);
  assert.deepEqual(units(SSCC, 'QTY[12]-1.2 == "1.50"'), [1]);
  assert.deepEqual(units(SSCC, 'QTY[12]-1.2 == "1.*"'), [1], 'wildcards work on text');
  assert.deepEqual(units(SSCC, '"12345" == RFF[ON]-1.2'), [], 'also with the text on the left');
  assert.deepEqual(units(SSCC, '12345 == RFF[ON]-1.2'), [1]);
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 < "9"'), [1], 'text order: "0012345" comes before "9"');
  assert.deepEqual(units(SSCC, 'RFF[ON]-1.2 < 9'), [], 'number order: 12345 is not below 9');
  assert.deepEqual(units(SSCC, 'count(RFF) == 2 AND count(RFF) == "2"'), [1], 'a count compared with a text is compared as text');
  // A literal star cannot be searched for; the documentation says so.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'docs', 'query.md'), 'utf8'), /a literal `\*` cannot be searched for/);
});

test('query: a part under NOT lists no values, the other parts do', () => {
  const E = SAMPLES.edifact.text;
  const r = query.scanText(E, query.compile('!exists(CTA) && count(LIN) > 5 || count(NAD) >= 2 AND NOT exists(ZZZ) AND BGM-2 == "PO*"'));
  assert.deepEqual(r.matches[0].hits.map((h) => h.path), ['BGM[1]-2']);
  const n = query.scanText(E, query.compile('NOT (exists(LIN) AND exists(ZZZ))'));
  assert.equal(n.matches.length, 1);
  assert.deepEqual(n.matches[0].hits, [], 'the LIN segments under the NOT are not listed as findings');
  const d = query.scanText(E, query.compile('NOT NOT exists(CUX)'));
  assert.deepEqual(d.matches[0].hits.map((h) => h.path), ['CUX[1]'], 'two NOTs are no NOT');
});

test('rules: the equal rule compares long identifiers exactly and totals without rounding', () => {
  const load = (list) => { const r = rules.loadRules(JSON.stringify({ format: 'edifact', rules: list })); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.guide; };
  const run = (list) => rules.validateText(SSCC, load(list)).violations.map((v) => v.ruleId);
  assert.deepEqual(run([{ id: 'A', type: 'equal', left: 'GIN-2.1', right: 'RFF[ZZ]-1.2' }]), ['A'], 'off by one in the last of eighteen digits is a violation');
  assert.deepEqual(run([{ id: 'B', type: 'equal', left: 'GIN-2.1', right: '340123456789012346' }]), []);
  assert.deepEqual(run([{ id: 'C', type: 'equal', left: 'GIN-2.1', right: '340123456789012345' }]), ['C']);
  assert.deepEqual(run([{ id: 'D', type: 'equal', left: 'RFF[ON]-1.2', right: 12345 }]), [], 'leading zeros do not count for numbers');
  assert.deepEqual(run([{ id: 'E', type: 'equal', left: 'sum(MOA[9]-1.2)', right: '99999999999999999.03' }]), []);
  assert.deepEqual(run([{ id: 'F', type: 'equal', left: 'sum(MOA[9]-1.2)', right: '99999999999999999.02' }]), ['F']);
  assert.deepEqual(run([{ id: 'G', type: 'equal', left: 'sum(MOA[9]-1.2)', right: '99999999999999999.02', tolerance: 0.01 }]), [], 'the tolerance is applied exactly');
  assert.deepEqual(run([{ id: 'H', type: 'equal', left: 'sum(MOA[9]-1.2)', right: '99999999999999999.01', tolerance: 0.01 }]), ['H']);
  assert.deepEqual(run([{ id: 'I', type: 'equal', left: 'QTY[12]-1.2', right: 1.5 }]), []);
  const v = rules.validateText(SSCC, load([{ id: 'A', type: 'equal', left: 'GIN-2.1', right: 'RFF[ZZ]-1.2' }])).violations[0];
  assert.match(v.message, /GIN-2\.1 is "340123456789012346" but RFF\[ZZ\]-1\.2 is "340123456789012345"/, 'both values are shown in full');
  assert.equal(rules.loadRules(JSON.stringify({ format: 'edifact', rules: [{ type: 'equal', left: 'GIN-2.1', right: 1, tolerance: 1e-9 }] })).ok, false, 'a tolerance that needs an exponent is refused');
});

test('rules: a pattern that is slow on every value is stopped after its time budget, not after the file', () => {
  const value = '1'.repeat(256);
  const text = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'" + ("FTX+AAI+++" + value + "'").repeat(4000) + "BGM+220+X+9'UNT+4003+1'UNZ+1+R1'";
  const guide = rules.loadRules(JSON.stringify({ format: 'edifact', rules: [
    { id: 'SLOW', type: 'pattern', path: 'FTX-4', pattern: '^(\\d+)(\\d+)(\\d+)x$' },
    { id: 'OK', type: 'value-in', path: 'BGM-1.1', values: ['221'] }] })).guide;
  const started = Date.now();
  const r = rules.validateText(text, guide, { maxIssues: 100000 });
  const took = Date.now() - started;
  assert.ok(took < 8000, 'took ' + took + ' ms');
  assert.deepEqual(r.stoppedPatterns, ['SLOW']);
  assert.ok(r.violations.some((v) => v.code === 'RULES-PATTERN-STOPPED'));
  assert.ok(r.violations.some((v) => v.ruleId === 'OK'), 'the other rules still ran');
  // A fast pattern over many values is not stopped.
  const fast = rules.loadRules(JSON.stringify({ format: 'edifact', rules: [{ id: 'FAST', type: 'pattern', path: 'FTX-4', pattern: '^\\d+$' }] })).guide;
  assert.deepEqual(rules.validateText(text, fast).stoppedPatterns, []);
});

// ---- anonymise -------------------------------------------------------------------------------------

const ALL_PROFILES = Object.keys(anon.PROFILES);

test('anonymise: sender and receiver ids of the envelope are replaced and match the same id in the body', () => {
  const compiled = anon.compile(null, ALL_PROFILES);
  // EDIFACT: the GLN of UNB-2 is the GLN of NAD+BY.
  const e = anon.anonymiseText(SAMPLES.edifact.text, compiled, { seed: 'envelope' });
  assert.ok(!e.text.includes('5412345000176') && !e.text.includes('5498765000134'), 'no party id is left anywhere');
  const unb = /UNB\+UNOC:3\+(\d{13}):14\+(\d{13}):14\+/.exec(e.text);
  assert.ok(unb, e.text.slice(0, 120));
  assert.ok(e.text.includes('NAD+BY+' + unb[1] + '::9') && e.text.includes('NAD+SU+' + unb[2] + '::9'), 'envelope and body carry the same replacement');
  assert.deepEqual([e.report.changedEnvelope, e.report.changedBody], [2, 2]);
  // X12: ISA06 is padded to 15 characters, GS02 is not; both get the same replacement.
  const x = anon.anonymiseText(SAMPLES.x12.text, compiled, { seed: 'envelope' });
  assert.ok(!/NORTHBAYRETAIL|HARBORSUPPLY/.test(x.text));
  const isa = /^ISA\*00\* {10}\*00\* {10}\*ZZ\*([A-Z]{14}) \*ZZ\*([A-Z]{12}) {3}\*/.exec(x.text);
  assert.ok(isa, x.text.slice(0, 110));
  assert.ok(x.text.includes('\nGS*PO*' + isa[1] + '*' + isa[2] + '*20240305'), 'GS02 and GS03 match ISA06 and ISA08');
  assert.equal(x.text.split('\n')[0].length, 106);
  // HL7: applications and facilities; the facility is also the assigning authority of PID-3.
  const h = anon.anonymiseText(SAMPLES.hl7.text, compiled, { seed: 'envelope' });
  assert.ok(!/ADMITSYS|LABPORTAL|RIVERSIDE/.test(h.text));
  const msh = /^MSH\|\^~\\&\|([A-Z]{8})\|([A-Z]{9})\|([A-Z]{9})\|([A-Z]{9})\|/.exec(h.text);
  assert.ok(msh && msh[2] === msh[4] && h.text.includes('^^^' + msh[2] + '^MR'));
  for (const r of [e, x, h]) assert.deepEqual(issues(r.text), []);
  assert.equal(e.text.length, SAMPLES.edifact.text.length);
  // Control numbers, dates and versions of the envelope are untouched.
  assert.ok(e.text.includes('+240305:1015+ORD240305001\'') && x.text.includes('*240305*1015*U*00401*000000417*0*P*>~') && h.text.includes('|20240305101500||ADT^A01^ADT_A01|RS240305-0042|P|2.5.1'));
});

test('anonymise: envelopeIds "keep" leaves the envelope ids, a single keep rule switches one off', () => {
  const kept = anon.compile(null, ALL_PROFILES, { envelopeIds: 'keep' });
  const x = anon.anonymiseText(SAMPLES.x12.text, kept, { seed: 'k' });
  assert.ok(x.text.startsWith('ISA*00*          *00*          *ZZ*NORTHBAYRETAIL *ZZ*HARBORSUPPLY   *'));
  assert.ok(x.text.includes('\nGS*PO*NORTHBAYRETAIL*HARBORSUPPLY*'));
  assert.equal(x.report.changedEnvelope, 0);
  assert.ok(x.report.changedBody > 0 && !x.text.includes('410 Harbour View Road'));
  assert.ok(anon.anonymiseText(SAMPLES.hl7.text, kept, { seed: 'k' }).text.startsWith('MSH|^~\\&|ADMITSYS|RIVERSIDE|LABPORTAL|RIVERSIDE|'));
  const one = anon.compile({ profiles: null, rules: [{ format: 'x12', path: 'ISA-8', action: 'keep' }, { format: 'x12', path: 'GS-3', action: 'keep' }] }, ALL_PROFILES);
  const y = anon.anonymiseText(SAMPLES.x12.text, one, { seed: 'k' });
  assert.match(y.text, /^ISA\*00\* {10}\*00\* {10}\*ZZ\*[A-Z]{14} \*ZZ\*HARBORSUPPLY {3}\*/);
  assert.equal(anon.compile(null, [], { envelopeIds: 'something else' }).list.filter((r) => r.envelope).length, anon.compile(null, []).list.length, 'any other value means the default');
  assert.deepEqual(Object.keys(anon.ENVELOPE_IDS).sort(), ['edifact', 'hl7', 'x12']);
  for (const format of Object.keys(anon.ENVELOPE_IDS)) for (const p of anon.ENVELOPE_IDS[format]) {
    const [id, element] = p.split('-');
    const prot = anon.PROTECTED[format][id];
    assert.ok(prot !== true && !(prot || []).includes(Number(element.split('.')[0])), p + ' is not a protected value');
  }
});

test('anonymise corpus: with the envelope ids replaced every file still validates exactly as before', () => {
  const compiled = anon.compile(null, ALL_PROFILES);
  let envelope = 0;
  for (const f of ALL) {
    const r = anon.anonymiseText(f.text, compiled, { seed: 'corpus-envelope' });
    assert.equal(r.ok, true, f.name);
    assert.equal(r.text.length, f.text.length, f.name);
    assert.deepEqual(issues(r.text), issues(f.text), f.name);
    assert.deepEqual(issues(r.text), [], f.name);
    assert.equal(parse(r.text).segments.length, parse(f.text).segments.length);
    envelope += r.report.changedEnvelope;
    assert.equal(r.report.changed, r.report.changedBody + r.report.changedEnvelope);
  }
  assert.ok(envelope >= 250, String(envelope));
});

test('anonymise: when no rule matches a value in the body the result says so (changedBody is 0)', () => {
  // An X12 purchase order checked with the healthcare profile only: nothing in the body is named.
  const onlyHealth = anon.compile(null, ['x12-healthcare'], { envelopeIds: 'keep' });
  const order = "ISA*00*          *00*          *ZZ*SENDERQ1       *ZZ*RECEIVERQ2     *240305*1015*U*00401*000000001*0*P*>~GS*PO*SENDERQ1*RECEIVERQ2*20240305*1015*1*X*004010~ST*850*0001~BEG*00*SA*PO1**20240305~N1*BY*Lakeshore Outfitters*92*LO01~PO1*1*1*EA*1.00~SE*5*0001~GE*1*1~IEA*1*000000001~";
  const r = anon.anonymiseText(order, onlyHealth, { seed: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.report.changedBody, 0);
  assert.equal(r.text, order);
  // The envelope ids alone never make a file count as anonymised.
  const withEnvelope = anon.anonymiseText(order, anon.compile(null, ['x12-healthcare']), { seed: 's' });
  assert.deepEqual([withEnvelope.report.changedBody, withEnvelope.report.changedEnvelope], [0, 4]);
  // With the party profile the same order is anonymised.
  const party = anon.anonymiseText(order, anon.compile(null, ['x12-party']), { seed: 's' });
  assert.ok(party.report.changedBody >= 2 && !/Lakeshore|LO01|SENDERQ1|RECEIVERQ2/.test(party.text), party.text);
  assert.deepEqual(issues(party.text), []);
  // No body rule at all for the format: refused with the code, also when envelope ids are on.
  assert.equal(anon.anonymiseText(order, anon.compile(null, ['hl7-patient']), { seed: 's' }).code, 'ANON-NO-RULES');
  // The report names unchanged files apart from anonymised ones and never calls them anonymised.
  const report = anon.toReport([{ label: 'a.x12', report: party.report }, { label: 'b.x12', report: r.report, unchanged: true, copied: false }, { label: 'c.x12', report: r.report, unchanged: true, copied: true }], { seeded: true });
  assert.match(report, /Files anonymised \| 1 \|/);
  assert.match(report, /Files unchanged: no rule matched \| 2 \|/);
  assert.match(report, /## Unchanged: no rule matched\n\nNo rule matched a value in the body of these files\. They are NOT anonymised\./);
  assert.match(report, /- b\.x12 \(ANSI X12\): nothing was written/);
  assert.match(report, /- c\.x12 \(ANSI X12\): copied unchanged because the setting ediLens\.anonymise\.copyUnchanged is on/);
});

test('anonymise: both dates of a range move by the same number of days', () => {
  assert.equal(anon.shiftDate('20240101-20240131', -10), '20231222-20240121');
  assert.equal(anon.shiftDate('20240229-20240301', -366), '20230228-20230301');
  assert.equal(anon.shiftDate('20240101-20241340', -10), null, 'a range with an impossible second date is no date');
  assert.equal(anon.shiftDate('20240101-2024013', -10), null, 'a hyphen and seven digits start a range; a truncated second date is no date');
  assert.equal(anon.shiftDate('20240101-0500', -10), '20231222-0500', 'a time zone offset is not a range');
  const text = SAMPLES.x12.text.replace('DTM*002*20240312~', 'DTP*472*RD8*20240101-20240131~');
  const rules12 = anon.compile({ profiles: [], rules: [{ format: 'x12', path: 'DTP-3', action: 'fake-date' }] }, [], { envelopeIds: 'keep' });
  const r = anon.anonymiseText(text, rules12, { seed: 'range' });
  const m = /DTP\*472\*RD8\*(\d{8})-(\d{8})~/.exec(r.text);
  assert.ok(m, r.text);
  assert.ok(m[1] !== '20240101' && m[2] !== '20240131', 'neither date is left in clear text');
  const day = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6))) / 86400000;
  assert.equal(day(m[2]) - day(m[1]), 30, 'the distance is kept');
  assert.equal(day(m[1]) - day('20240101'), r.rewriter.dateShiftDays);
  assert.equal(r.report.datesNotRecognised, 0);
});

test('anonymise: padding around a value is kept and is not part of the value', () => {
  const rw = anon.createRewriter('pad');
  const ctx = { format: 'x12', release: '', escape: '', fixedWidth: true };
  const padded = rw.rewrite('pseudonym', 'NORTHBAY       ', ctx).value;
  const plain = rw.rewrite('pseudonym', 'NORTHBAY', ctx).value;
  assert.equal(padded, plain + '       ');
  assert.equal(rw.rewrite('pseudonym', '  AB12  ', ctx).value.length, 8);
  assert.match(rw.rewrite('pseudonym', '  AB12  ', ctx).value, /^ {2}[A-Z]{2}\d{2} {2}$/);
  assert.equal(rw.rewrite('pseudonym', '     ', ctx).value, '     ', 'a value of spaces stays');
  assert.equal(rw.rewrite('mask', ' A1 ', ctx).value, ' X9 ');
  assert.equal(rw.rewrite('fake-date', '20240101  ', ctx).value.length, 10);
  assert.ok(rw.entries().every((e) => e.original === e.original.trim()), 'the table holds the values without padding');
});

// ---- acknowledgements --------------------------------------------------------------------------------

test('acknowledgement: a group or interchange whose trailer is wrong is never reported as accepted (X12)', () => {
  const X = SAMPLES.x12.text;
  const cases = [
    [X.replace('GE*1*417~', 'GE*5*417~'), /AK9\*E\*5\*1\*1\*5~/, 'a wrong count of transaction sets'],
    [X.replace('GE*1*417~', 'GE*1*8~'), /AK9\*E\*1\*1\*1\*4~/, 'a control number that differs from GS06'],
    [X.replace('GE*1*417~\n', ''), /AK9\*E\*1\*1\*1\*3~/, 'a missing GE'],
    [X.replace('GE*1*417~', 'GE*1*8~').replace('SE*13*0001~', 'SE*12*0001~'), /AK5\*R\*4~\nAK9\*R\*1\*1\*0\*4~/, 'nothing accepted and a wrong group trailer'],
  ];
  for (const [text, pattern, what] of cases) {
    const r = env.acknowledge(text, { now: NOW });
    assert.equal(r.ok, true, what + ': ' + r.message);
    assert.match(r.text, pattern, what);
    assert.ok(!/AK9\*A/.test(r.text), what + ' must not be accepted');
    assert.equal(r.envelopeFaults, 1);
    assert.deepEqual(issues(r.text), [], 'the acknowledgement itself is valid');
  }
  for (const text of [X.replace('IEA*1*000000417~\n', ''), X.replace('IEA*1*000000417~', 'IEA*4*000000417~'), X.replace('IEA*1*000000417~', 'IEA*1*000000999~')]) {
    const r = env.acknowledge(text, { now: NOW });
    assert.equal(r.code, 'ENV-BAD-ENVELOPE');
    assert.match(r.message, /is not closed correctly: IEA is (missing|there, but its group count is wrong|there, but its control number differs from ISA13)/);
  }
  assert.equal(env.acknowledge(X, { now: NOW }).envelopeFaults, 0);
  assert.match(env.acknowledge(X, { now: NOW }).text, /AK9\*A\*1\*1\*1~/);
});

test('acknowledgement: the rejection code names what was wrong with the transaction set', () => {
  const three = corpus('x12/850-three-sets.x12');
  const r = env.acknowledge(three.replace('SE*22*0002~', 'SE*9*0002~').replace('SE*22*0003~', 'SE*22*0009~'), { now: NOW });
  assert.match(r.text, /AK2\*850\*0002~\nAK5\*R\*4~/, 'a wrong segment count is code 4');
  assert.match(r.text, /AK2\*850\*0003~\nAK5\*R\*3~/, 'a control number that differs is code 3');
  const r999 = env.acknowledge(three.replace('SE*22*0002~', 'SE*9*0002~'), { now: NOW, x12Type: '999' });
  assert.match(r999.text, /IK5\*R\*4~/);
  // A missing SE: the next ST closes the set; code 2. The file is damaged, so the group is not accepted either.
  const noSe = env.acknowledge(three.replace('SE*22*0002~\n', ''), { now: NOW });
  assert.match(noSe.text, /AK2\*850\*0002~\nAK5\*R\*2~/);
  assert.ok(!/AK5\*R\*5/.test(r.text + noSe.text), 'code 5 is for segment errors, which are not examined');
});

test('acknowledgement: EDIFACT rejects an interchange or group with a wrong trailer and writes the date in the width of the source', () => {
  const E = SAMPLES.edifact.text;
  for (const [text, what] of [[E.replace("UNZ+1+ORD240305001'", "UNZ+5+ORD240305001'"), 'count'], [E.replace("UNZ+1+ORD240305001'", "UNZ+1+OTHER'"), 'reference'], [E.replace("UNZ+1+ORD240305001'\n", ''), 'missing']]) {
    const r = env.acknowledge(text, { now: NOW });
    assert.equal(r.ok, true, what);
    assert.match(r.text, /UCI\+ORD240305001\+5412345000176:14\+5498765000134:14\+4'\nUNT\+3\+1'/, what + ': rejected as a whole, no UCM');
    assert.deepEqual([r.accepted, r.rejected, r.envelopeFaults], [0, 1, 1]);
    assert.deepEqual(issues(r.text), []);
  }
  const grouped = corpus('edifact/orders-group-altdelim.edi');
  const g = env.acknowledge(grouped.replace('UNE,2,G1~', 'UNE,7,G1~'), { now: NOW });
  assert.match(g.text, /UCF,G1,5412345000176;14,5498765000134;14,4~\r?\nUNT,4,1~/, 'the group is rejected and its messages are not listed');
  assert.deepEqual([g.accepted, g.rejected], [0, 2]);
  assert.match(env.acknowledge(grouped, { now: NOW }).text, /UCF,G1,[^~]*,7~/);
  // Syntax version 4 uses an eight-digit date in UNB; the acknowledgement follows the source.
  const v4 = "UNB+UNOC:4+S:14+R:14+20240115:0930+REF1'UNH+1+ORDERS:D:96A:UN'BGM+220+P+9'UNT+3+1'UNZ+1+REF1'";
  const a4 = env.acknowledge(v4, { now: NOW });
  assert.match(a4.text, /^UNB\+UNOC:4\+R:14\+S:14\+20240311:1015\+REF1\+\+\+\+\+\+1'UNH\+1\+CONTRL:D:3:UN'/);
  assert.match(env.acknowledge(v4.replace('20240115', '240115'), { now: NOW }).text, /^UNB\+UNOC:4\+R:14\+S:14\+240311:1015\+/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'docs', 'envelope-tools.md'), 'utf8'), /always written as `CONTRL:D:3:UN`, also for a version 4 source/);
});

test('acknowledgement: no acknowledgement is written from a damaged header or without an interchange', () => {
  const X = SAMPLES.x12.text;
  const cases = [
    [X.replace('*U*00401*', '*U*004*'), 'a short ISA'],
    [SAMPLES.hl7.text.replace('MSH|^~\\&|', 'MSH|^^^^|'), 'encoding characters that repeat'],
    ["UNH+1+ORDERS:D:96A:UN'BGM+220+P+9'UNT+3+1'", 'a message without UNB'],
    ["UNB+UNOC:3'UNH+1+ORDERS:D:96A:UN'BGM+220+P+9'UNT+3+1'UNZ+1+X'", 'a UNB without a control reference'],
  ];
  for (const [text, what] of cases) {
    const r = env.acknowledge(text, { now: NOW });
    assert.equal(r.ok, false, what + ': ' + (r.text || '').slice(0, 80));
    assert.equal(r.code, 'ENV-BAD-ENVELOPE', what);
    assert.ok(!/only CONTRL messages|only acknowledgements/.test(r.message), what + ' gets the right reason: ' + r.message);
  }
  assert.match(env.acknowledge("UNH+1+ORDERS:D:96A:UN'BGM+220+P+9'UNT+3+1'", { now: NOW }).message, /no interchange header \(UNB\)/);
});

test('acknowledgement fuzz: whatever the damage, a result that is handed out validates (seed 31337)', () => {
  let s = 31337;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let made = 0;
  let refused = 0;
  for (const f of ALL) {
    for (let k = 0; k < 8; k++) {
      let text = f.text;
      const at = Math.floor(rand() * Math.min(text.length, 220));
      const kind = Math.floor(rand() * 3);
      if (kind === 0) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 6));
      else if (kind === 1) text = text.slice(0, at) + String.fromCharCode(33 + Math.floor(rand() * 90)) + text.slice(at + 1);
      else text = text.slice(0, at) + "'~|\r\n" + text.slice(at);
      const r = env.acknowledge(text, { now: NOW });
      if (!r.ok) { refused++; assert.match(r.code, /^ENV-/); continue; }
      made++;
      const errors = validate(parse(r.text), { includeParseIssues: true }).filter((i) => i.severity === 'error');
      assert.deepEqual(errors, [], f.name + ' case ' + k + ': an invalid acknowledgement was handed out');
    }
  }
  assert.ok(made > 200 && refused > 100, made + ' made, ' + refused + ' refused');
});

// ---- merge, renumber ---------------------------------------------------------------------------------

test('merge: HL7 messages keep their control ids and the batch has one line-end style', () => {
  const a = SAMPLES.hl7.text;
  const b = SAMPLES.hl7.text.replace(/\r/g, '\n');
  const c = SAMPLES.hl7.text.replace(/\r/g, '\r\n');
  const r = env.merge([a, b, c]);
  assert.equal(r.ok, true);
  assert.ok(!/\n/.test(r.text), 'the line ends of the first file (CR) are used for every message');
  assert.equal(r.text.split('\r').filter((l) => l.startsWith('MSH|')).length, 3);
  assert.equal((r.text.match(/\|RS240305-0042\|/g) || []).length, 3, 'the control ids are kept, not renumbered');
  assert.deepEqual(issues(r.text), []);
  assert.match(env.merge([b, a]).text, /^BHS\|[^\r\n]*\nMSH\|/, 'a first file with LF gives LF');
  assert.ok(!/\r/.test(env.merge([b, a]).text));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /every X12 and EDIFACT message renumbered[\s\S]{0,160}keep their own control ids/);
});

test('renumber: the message for a number that is too large names the right field for the format', () => {
  const two = SAMPLES.edifact.text + SAMPLES.edifact.text.replace("UNA:+.? '\n", '');
  const e = env.renumber(two, { start: 999999999 });
  assert.equal(e.code, 'ENV-NUMBER-TOO-LARGE');
  assert.ok(!/ISA13/.test(e.message), e.message);
  const x = env.renumber(SAMPLES.x12.text + SAMPLES.x12.text, { start: 999999999 });
  assert.equal(x.code, 'ENV-NUMBER-TOO-LARGE');
  assert.match(x.message, /ISA13 holds nine digits/);
});

// ---- diagnostics block ---------------------------------------------------------------------------------

test('diagnostics block: no folder names, no licence environment, no request for the licence state', () => {
  const settings = {
    validateOnType: true, maxFileSizeMB: 10, maxIssues: 500, hoverEnabled: true, autoDetectLanguage: true, exportNeutraliseFormulas: true,
    workspaceInclude: 'clients/harbor-supply-secret/**/*.edi', workspaceExclude: '**/{node_modules,.git,.hg,.svn}/**',
    compare: { ignoreSegments: ['UNB'], ignorePaths: ['private-folder/NAD[1]-2', 'x'], ignoreCase: false, trimValues: false }
  };
  const block = support.diagnosticsBlock({ extensionVersion: '0.2.0', editorName: 'Editor', editorVersion: '1.0', platform: 'win32', settings: settings, licence: { pro: true, via: 'cache', mode: 'live', hasKey: true, trial: { state: 'unused' } }, active: null });
  assert.ok(!/harbor-supply-secret|private-folder|clients\//.test(block), 'values that can hold folder names are not printed');
  assert.match(block, /workspaceInclude = customised\n {2}workspaceExclude = default\n/);
  assert.match(block, /compare\.ignorePaths = 2 entries\n/);
  assert.match(block, /Licence: Pro \(licence, verified\)\n/);
  assert.ok(!/licenceMode|licence server/.test(block));
  assert.deepEqual(support.SETTING_KEYS.filter((k) => /Mode|Include|Exclude/.test(k)), []);
  assert.match(support.licenceLine({ pro: false, via: 'stale', hasKey: true, trial: { state: 'unused' } }), /last check older than a day \(not asked again for this report\)/);
  assert.match(support.licenceLine({ pro: false, via: 'rejected', hasKey: true, trial: { state: 'active', daysLeft: 3 } }), /rejected by the server\), trial running \(3 days left\)/);
  assert.match(support.licenceLine({ pro: false, via: 'product', hasKey: true, trial: { state: 'unused' } }), /stored key of another product/);
  assert.match(support.licenceLine({ pro: false, via: 'none', mode: 'test', hasKey: false, trial: { state: 'unused' } }), /licence server: test$/, 'a development host says so');
});

// ---- package facts ---------------------------------------------------------------------------------------

test('listing: no keyword or text that reads as a claim about a privacy law', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.keywords.length, 30);
  for (const word of ['de-identify', 'phi', 'hipaa', 'gdpr', 'compliant', 'compliance']) assert.ok(!pkg.keywords.includes(word), word);
  assert.ok(pkg.keywords.includes('pseudonymize') && pkg.keywords.includes('test data') && pkg.keywords.includes('anonymize'));
  const root = path.join(__dirname, '..');
  const texts = ['README.md', 'CHANGELOG.md', 'TERMS.md', 'PRIVACY.md', 'LICENSE.txt', 'package.json', 'docs/anonymise.md', 'media/walkthrough/pro-tools.md', 'media/walkthrough/pro.md'];
  for (const f of texts) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/HIPAA|GDPR|de-identif|\bPHI\b|safe harbor|compliant|compliance|certified/i.test(t), f + ' names a law or claims conformance');
    assert.ok(!/safe to share|safely share|fully anonym|guaranteed anonym/i.test(t), f + ' promises more than the tool does');
  }
  assert.match(fs.readFileSync(path.join(root, 'docs/anonymise.md'), 'utf8'), /EDI Lens makes no statement about any privacy law/);
  for (const g of ['edifact', 'x12', 'hl7']) assert.ok(!/https?:\/\//.test(fs.readFileSync(path.join(root, 'syntaxes', g + '.tmLanguage.json'), 'utf8')), 'the ' + g + ' grammar names no web address');
});

test('listing: what was tested is said as it is', () => {
  const root = path.join(__dirname, '..');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /was run on Windows with Node 24/);
  assert.match(changelog, /it has not run yet, so those platforms are untested for this version/);
  assert.ok(!/runs on Windows, macOS and Linux with Node 20 and 22/.test(changelog));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /The automated tests of this version ran on Windows with a stand-in for the editor; the previous version, 0\.2\.0, was also run in VS Code 1\.146 on Windows\. Other platforms were not tested\./);
  assert.match(readme, /kept by the editor's own storage, which VS Code holds on your local computer/);
  assert.ok(!/so the key and the trial are stored there/.test(readme));
});
