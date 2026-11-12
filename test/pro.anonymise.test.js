'use strict';
// Anonymise: unit tests, the whole corpus (every file anonymised and validated again), and
// adversarial and seeded fuzz tests. The property that matters most: the copy is structurally the
// same as the original and validates exactly like it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const anon = require('../src/pro/anonymise');
const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const { minify } = require('../src/core/serialize');
const { SAMPLES } = require('../src/samples');
const { checkInvariants } = require('./core.helpers');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const FORMATS = ['edifact', 'x12', 'hl7'];
const ALL = FORMATS.reduce((acc, f) => acc.concat(fs.readdirSync(path.join(CORPUS, f)).sort().map((name) => ({ format: f, name, text: fs.readFileSync(path.join(CORPUS, f, name), 'utf8') }))), []);
const PROFILES = Object.keys(anon.PROFILES);
const BUILT_IN = anon.compile(null, PROFILES);

function issuesOf(text) {
  return validate(parse(text), { includeParseIssues: true, maxIssues: 5000 }).map((i) => [i.severity, i.code, i.message, i.offset, i.end, i.segmentIndex]);
}

// The shape of a message: every delimiter and the length of every value, nothing of the values.
function skeleton(text) {
  const m = parse(text);
  return m.segments.map((s) => s.id + '@' + s.offset + ':' + s.elements.map((e) => e.repetitions.map((r) => r.components.map((c) => c.subcomponents.map((x) => x.raw.length).join('&')).join('^')).join('~')).join('|'));
}

function rulesOf(list) {
  const loaded = anon.loadRules(JSON.stringify({ profiles: [], rules: list }));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  // These tests look at single rules, so the envelope ids are left alone unless a test asks.
  return anon.compile(loaded.config, [], { envelopeIds: 'keep' });
}

test('anonymise: the four built-in profiles exist, each for one format, with valid paths', () => {
  assert.deepEqual(PROFILES.sort(), ['edifact-party', 'hl7-patient', 'x12-healthcare', 'x12-party']);
  assert.equal(anon.PROFILES['x12-party'].format, 'x12');
  assert.equal(anon.PROFILES['hl7-patient'].format, 'hl7');
  assert.equal(anon.PROFILES['x12-healthcare'].format, 'x12');
  assert.equal(anon.PROFILES['edifact-party'].format, 'edifact');
  for (const name of PROFILES) {
    const p = anon.PROFILES[name];
    assert.ok(p.title.length > 10);
    assert.ok(p.rules.length >= 10, name);
    for (const r of p.rules) assert.ok(anon.ACTIONS.includes(r.action), r.path);
    assert.equal(anon.compile({ profiles: [name], rules: [] }, [], { envelopeIds: 'keep' }).list.length, p.rules.length, 'every rule of ' + name + ' compiles');
  }
  const ids = (name) => new Set(anon.PROFILES[name].rules.map((r) => r.path.slice(0, 3)));
  assert.deepEqual([...ids('hl7-patient')].sort(), ['GT1', 'IN1', 'NK1', 'PID']);
  assert.deepEqual([...ids('edifact-party')].sort(), ['COM', 'CTA', 'FII', 'NAD']);
});

test('anonymise: the HL7 sample loses the patient and keeps its structure, codes and validity', () => {
  const r = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: 'unit' });
  assert.equal(r.ok, true);
  assert.equal(r.text.length, SAMPLES.hl7.text.length);
  for (const gone of ['Hartwell', 'Mira', 'RS-4471902', '19840712', '18 Linden Walk', 'Millford', '12901', '555-0142', '555-0143', 'Tomas', '555-0144', 'ADMITSYS', 'RIVERSIDE', 'LABPORTAL']) assert.ok(!r.text.includes(gone), gone + ' is still there');
  for (const kept of ['ADT^A01^ADT_A01', 'RS240305-0042', '^MR|', '^NY^', '^PRN^PH', '^ORN^CP', '2201^Okafor^Lena', 'Penicillin', '|SPO|', '|P|2.5.1']) assert.ok(r.text.includes(kept), kept + ' was changed');
  assert.deepEqual(skeleton(r.text), skeleton(SAMPLES.hl7.text));
  assert.deepEqual(issuesOf(r.text), []);
  assert.match(r.text, /PID\|1\|\|[A-Z]{2}-\d{7}\^\^\^[A-Z]{9}\^MR\|\|[A-Z][a-z]{7}\^[A-Z][a-z]{3}\^[A-Z]\|\|\d{8}\|F/);
  // The facility in MSH-4, MSH-6 and in the assigning authority of PID-3 is one value and stays one value.
  const facility = /^MSH\|\^~\\&\|[A-Z]+\|([A-Z]+)\|[A-Z]+\|([A-Z]+)\|/.exec(r.text);
  assert.ok(facility && facility[1] === facility[2] && r.text.includes('^^^' + facility[1] + '^MR'), r.text.slice(0, 200));
  // The same surname in PID and NK1 stays the same surname.
  const pid = /PID\|1\|\|[^|]*\|\|([A-Za-z]+)\^/.exec(r.text)[1];
  const nk1 = /NK1\|1\|([A-Za-z]+)\^/.exec(r.text)[1];
  assert.equal(pid, nk1, 'cross references stay consistent');
});

test('anonymise: the same seed gives the same result, another seed or no seed gives another', () => {
  const a = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: 'alpha' }).text;
  const b = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: 'alpha' }).text;
  const c = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: 'beta' }).text;
  const d = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, {}).text;
  const e = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: '' }).text;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.notEqual(d, e, 'without a seed every run draws its own');
  // One rewriter shared by two files keeps the replacements the same across them.
  const shared = anon.createRewriter('alpha');
  const one = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { rewriter: shared }).text;
  const two = anon.anonymiseText(SAMPLES.hl7.text.replace('EVN|A01', 'EVN|A04'), BUILT_IN, { rewriter: shared }).text;
  assert.equal(one, a);
  assert.equal(two, a.replace('EVN|A01', 'EVN|A04'));
});

test('anonymise: every action does what it says', () => {
  const text = "UNB+UNOC:3+SENDER1+RECEIVER1+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'NAD+BY+Ab12-9x::9+O?'Brien ?+ Co:Dock 4+Mira Hartwell+++21122'DTM+137:20240229:102'DTM+2:240301:101'DTM+3:notadate:ZZZ'FTX+AAI+++Keep me'UNT+7+1'UNZ+1+R1'";
  const run = (rules) => anon.anonymiseText(text, rulesOf(rules), { seed: 's' });
  assert.match(run([{ format: 'edifact', path: 'NAD-2.1', action: 'mask' }]).text, /NAD\+BY\+XX99-9X::9\+/);
  const pseudo = run([{ format: 'edifact', path: 'NAD-2.1', action: 'pseudonym' }]).text;
  assert.match(pseudo, /NAD\+BY\+[A-Z][a-z]\d\d-\d[a-z]::9\+/);
  assert.ok(!pseudo.includes('Ab12-9x'));
  // Release characters and the characters they escape are kept, so the element still has two components.
  const escaped = run([{ format: 'edifact', path: 'NAD-3', action: 'pseudonym' }]);
  assert.match(escaped.text, /NAD\+BY\+Ab12-9x::9\+[A-Z]\?'[A-Z][a-z]{4} \?\+ [A-Z][a-z]:[A-Z][a-z]{3} \d\+Mira/);
  assert.deepEqual(skeleton(escaped.text), skeleton(text));
  const named = run([{ format: 'edifact', path: 'NAD-4', action: 'fake-name' }]).text;
  const fake = /\+([A-Z][a-z]{3}) ([A-Z][a-z]{7})\+\+\+21122/.exec(named);
  assert.ok(fake, named);
  assert.notEqual(fake[1], 'Mira');
  assert.match(fake[2], /^(?:[^aeiou][aeiou]|[aeiou][^aeiou])/i, 'a name-like value alternates consonants and vowels');
  // Dates move by one offset: order and distance are kept; the leap day and the two-digit year work.
  const dated = run([{ format: 'edifact', path: 'DTM-1.2', action: 'fake-date' }]);
  const d1 = /DTM\+137:(\d{8}):102/.exec(dated.text)[1];
  const d2 = /DTM\+2:(\d{6}):101/.exec(dated.text)[1];
  const toDay = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;
  const shift = toDay(Number(d1.slice(0, 4)), Number(d1.slice(4, 6)), Number(d1.slice(6))) - toDay(2024, 2, 29);
  assert.ok(shift <= -1 && shift >= -365, String(shift));
  assert.equal(shift, dated.rewriter.dateShiftDays);
  assert.equal(toDay(2000 + Number(d2.slice(0, 2)), Number(d2.slice(2, 4)), Number(d2.slice(4))) - toDay(2024, 3, 1), shift, 'both dates moved by the same number of days');
  assert.equal(dated.report.datesNotRecognised, 1);
  assert.ok(!dated.text.includes('notadate'), 'a value that is no date is replaced like an identifier');
  assert.match(dated.text, /DTM\+3:[a-z]{8}:ZZZ/);
  // keep switches a later rule off; blank empties the value and nothing else.
  const kept = run([{ format: 'edifact', path: 'NAD-4', action: 'keep' }, { format: 'edifact', path: 'NAD-4', action: 'mask' }]);
  assert.equal(kept.text, text);
  const blank = run([{ format: 'edifact', path: 'FTX-4', action: 'blank' }]);
  assert.equal(blank.text, text.replace('Keep me', ''));
  assert.deepEqual(issuesOf(blank.text).map((i) => i[1]), issuesOf(text).map((i) => i[1]));
});

test('anonymise: date shifting rejects impossible dates and keeps the time part', () => {
  assert.equal(anon.shiftDate('20240301', -1), '20240229');
  assert.equal(anon.shiftDate('20230301', -1), '20230228');
  assert.equal(anon.shiftDate('20240101103000+0100', -1), '20231231103000+0100');
  assert.equal(anon.shiftDate('000101', -1), '991231');
  for (const bad of ['20241301', '20240230', '2024', '2024-03-01', 'abcdefgh', '', '00000000', '09990101', '1234567']) assert.equal(anon.shiftDate(bad, -5), null, bad);
  assert.equal(anon.shiftDate('10000101', -1), null, 'a result before the year 1000 is refused');
});

test('anonymise: envelope values that validation depends on are never changed', () => {
  const attack = [];
  for (const [format, table] of Object.entries(anon.PROTECTED)) {
    for (const id of Object.keys(table)) for (let e = 1; e <= 18; e++) attack.push({ format, path: id + '-' + e, action: 'pseudonym' });
  }
  const compiled = rulesOf(attack);
  let skipped = 0;
  for (const f of ALL) {
    const r = anon.anonymiseText(f.text, compiled, { seed: 'envelope' });
    assert.equal(r.ok, true, f.name);
    assert.deepEqual(issuesOf(r.text), [], f.name + ' no longer validates');
    assert.deepEqual(skeleton(r.text), skeleton(f.text), f.name);
    skipped += r.report.protectedSkipped;
    const before = parse(f.text);
    const after = parse(r.text);
    before.segments.forEach((s, i) => {
      const p = anon.PROTECTED[f.format][s.id];
      if (p === true) assert.equal(after.segments[i].raw, s.raw, f.name + ' ' + s.id);
      else if (p) for (const e of p) assert.equal((after.segments[i].elements[e - 1] || {}).raw, (s.elements[e - 1] || {}).raw, f.name + ' ' + s.id + '-' + e);
    });
  }
  assert.ok(skipped > 1000, 'the protected values were counted: ' + skipped);
  // What is not protected in the envelope may be replaced: sender and receiver ids.
  const x12 = anon.anonymiseText(SAMPLES.x12.text, rulesOf([{ format: 'x12', path: 'ISA-6', action: 'pseudonym' }, { format: 'x12', path: 'ISA-8', action: 'blank' }]), { seed: 'x' });
  assert.equal(x12.text.split('\n')[0].length, 106, 'the ISA keeps its fixed width');
  assert.ok(!x12.text.split('\n')[0].includes('NORTHBAYRETAIL'));
  assert.match(x12.text.split('\n')[0], /\*ZZ\* {15}\*240305/, 'a blanked ISA element is filled with spaces');
  assert.deepEqual(issuesOf(x12.text), []);
});

test('anonymise corpus: every one of the 126 files is anonymised and validates exactly like before', () => {
  assert.equal(ALL.length, 126);
  let changed = 0;
  for (const f of ALL) {
    const r = anon.anonymiseText(f.text, BUILT_IN, { seed: 'corpus' });
    assert.equal(r.ok, true, f.name);
    assert.equal(r.format, f.format);
    assert.equal(r.text.length, f.text.length, f.name + ' changed its length');
    assert.deepEqual(issuesOf(r.text), issuesOf(f.text), f.name + ' validates differently');
    assert.deepEqual(issuesOf(r.text), [], f.name);
    assert.deepEqual(skeleton(r.text), skeleton(f.text), f.name + ' changed its structure');
    checkInvariants(parse(r.text));
    // Only letters and digits were exchanged for letters and digits; everything else is untouched.
    for (let i = 0; i < f.text.length; i++) {
      const a = f.text.charCodeAt(i);
      const b = r.text.charCodeAt(i);
      if (a === b) continue;
      assert.ok(/[A-Za-z0-9]/.test(f.text[i]) && /[A-Za-z0-9]/.test(r.text[i]), f.name + ' at ' + i + ': ' + JSON.stringify(f.text[i]) + ' became ' + JSON.stringify(r.text[i]));
      assert.equal(/[0-9]/.test(f.text[i]), /[0-9]/.test(r.text[i]), f.name + ' at ' + i);
    }
    assert.equal(anon.anonymiseText(f.text, BUILT_IN, { seed: 'corpus' }).text, r.text, f.name + ' is not deterministic');
    assert.equal(r.report.segments, parse(f.text).segments.length);
    changed += r.report.changed;
  }
  assert.ok(changed > 800, 'values were replaced across the corpus: ' + changed);
});

test('anonymise corpus: the identifying values of the corpus are gone from the files they were in', () => {
  const secrets = {
    hl7: ['Hartwell', 'RS-4471902', '19840712', '18 Linden Walk', '555-0142'],
    x12: ['HARTWELL', 'NHP44719020', '18 LINDEN WALK'],
    edifact: ['Fjordline Trading AB', 'Hamngatan 14', 'Valkenburg Components BV', 'purchasing@example.invalid'],
  };
  let checked = 0;
  for (const f of ALL) {
    const r = anon.anonymiseText(f.text, BUILT_IN, { seed: 'gone' });
    const m = parse(f.text);
    for (const secret of secrets[f.format]) {
      // Only where the value sits in a segment the profiles cover.
      const inCovered = m.segments.some((s) => /^(PID|NK1|IN1|GT1|NM1|N3|N4|DMG|NAD|CTA|COM|FII)$/.test(s.id) && s.raw.includes(secret) && !(s.id === 'NM1' && !/^NM1.(IL|QC|03|74)/.test(s.raw)));
      if (!inCovered) continue;
      const after = parse(r.text);
      m.segments.forEach((s, i) => {
        if (/^(PID|NK1|IN1|GT1|N3|NAD|CTA|COM|FII)$/.test(s.id) && s.raw.includes(secret)) {
          assert.ok(!after.segments[i].raw.includes(secret), f.name + ': ' + secret + ' is still in ' + s.id);
          checked++;
        }
      });
    }
  }
  assert.ok(checked > 100, String(checked));
});

test('anonymise: the report lists counts only and never an original or a replacement value', () => {
  const entries = [];
  const rewriter = anon.createRewriter('report');
  const values = new Set();
  for (const f of ALL) {
    const r = anon.anonymiseText(f.text, BUILT_IN, { rewriter });
    entries.push({ label: f.name, report: r.report });
  }
  entries.push({ label: 'notes.txt', skipped: 'Not valid UTF-8 text.' });
  for (const e of rewriter.entries()) { values.add(e.original); values.add(e.replacement); }
  const report = anon.toReport(entries, { seeded: true, mapSize: rewriter.size() });
  assert.match(report, /^# EDI Lens anonymise report/);
  assert.match(report, /Files anonymised \| 126/);
  assert.match(report, /Files left out \| 1/);
  assert.match(report, /contains no value from the files/);
  assert.match(report, /\| PID-5 \| fake-name \| profile hl7-patient \| \d+ \|/);
  let longValues = 0;
  for (const v of values) {
    if (v.length < 5 || /^\d{1,5}$/.test(v)) continue; // short codes and small numbers also occur as counts
    longValues++;
    assert.ok(!report.includes(v), 'the report contains the value ' + JSON.stringify(v));
  }
  assert.ok(longValues > 100, String(longValues));
  assert.ok(!/Hartwell|Fjordline|RS-4471902|19840712/.test(report));
  // The JSON form of a report has no value either.
  assert.ok(!/Hartwell|Fjordline|RS-4471902/.test(JSON.stringify(entries)));
  assert.match(anon.toReport([], { seeded: false }), /random seed was used for this run only/);
});

test('anonymise: the replacement table exists only in the rewriter and its export is explicit', () => {
  const r = anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { seed: 'map' });
  assert.ok(r.rewriter.size() >= 10);
  assert.ok(!('map' in r) && !('entries' in r.report), 'the result object itself carries no table');
  assert.ok(!JSON.stringify(r.report).includes('Hartwell'));
  const csv = anon.mapToCsv(r.rewriter, true);
  assert.match(csv, /^action,original,replacement\r\n/);
  assert.match(csv, /fake-name,Hartwell,[A-Z][a-z]{7}\r\n/);
  assert.match(csv, /fake-date,19840712,\d{8}\r\n/);
  // Formula cells are neutralised in the export.
  const tricky = anon.anonymiseText("UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'NAD+BY+=cmd9::9'UNT+3+1'UNZ+1+R1'", rulesOf([{ format: 'edifact', path: 'NAD-2.1', action: 'pseudonym' }]), { seed: 'm' });
  assert.match(anon.mapToCsv(tricky.rewriter, true), /pseudonym,'=cmd9,'=[a-z]{3}\d\r\n/);
  assert.match(anon.mapToCsv(tricky.rewriter, false), /pseudonym,=cmd9,=[a-z]{3}\d\r\n/);
});

test('anonymise: rule files are checked and every problem is named', () => {
  const ok = anon.loadRules('﻿{"profiles":["hl7-patient"],"rules":[{"format":"hl7","path":"PV1-7","action":"fake-name"}]}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.profiles, ['hl7-patient']);
  assert.equal(anon.loadRules('{}').ok, true, 'an empty object is a valid (empty) rule file');
  const bad = [
    ['{', /not valid JSON/], ['[]', /one JSON object/], ['null', /one JSON object/], ['{"profiles":"hl7-patient"}', /must be a list/],
    ['{"profiles":["nope"]}', /Unknown profile/], ['{"rules":{}}', /must be a list/], ['{"rules":[1]}', /must be an object/],
    ['{"rules":[{"format":"csv","path":"A-1","action":"mask"}]}', /"format" must be/], ['{"rules":[{"format":"hl7","path":"PID-5","action":"delete"}]}', /"action" must be one of/],
    ['{"rules":[{"format":"hl7","path":"PID","action":"mask"}]}', /must name an element/], ['{"rules":[{"format":"hl7","path":"PID-0","action":"mask"}]}', /start at 1/],
    ['{"rules":[{"format":"hl7","path":"PID#2-5","action":"mask"}]}', /must not use #n/], ['{"rules":[{"format":"hl7","path":"../../etc","action":"mask"}]}', /not a selector/],
    ['{"rules":[{"format":"hl7","path":"PID[]-5","action":"mask"}]}', /qualifier in brackets is empty/],
  ];
  for (const [text, pattern] of bad) {
    const r = anon.loadRules(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.code, 'ANON-RULES-INVALID');
    assert.match(r.errors.join(' '), pattern, text);
  }
  assert.equal(anon.loadRules(JSON.stringify({ rules: new Array(2001).fill({ format: 'hl7', path: 'PID-5', action: 'mask' }) })).ok, false);
  // A rule file wins over the profiles; a rule file with its own profile list replaces the setting.
  const own = anon.compile({ profiles: null, rules: [{ format: 'hl7', path: 'PID-5', action: 'keep' }] }, ['hl7-patient']);
  const kept = anon.anonymiseText(SAMPLES.hl7.text, own, { seed: 'k' }).text;
  assert.ok(kept.includes('Hartwell^Mira^J'), 'keep in the rule file switches the profile rule off');
  assert.ok(!kept.includes('19840712'));
  assert.equal(anon.compile({ profiles: [], rules: [] }, ['hl7-patient']).list.filter((r) => !r.envelope).length, 0);
});

test('anonymise: texts that are not messages, and formats without rules, are refused with a code', () => {
  for (const text of ['', '   ', 'hello world', '{"a":1}', null, undefined, 42]) {
    const r = anon.anonymiseText(text, BUILT_IN, { seed: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ANON-NOT-EDI');
  }
  const onlyHl7 = anon.compile(null, ['hl7-patient']);
  const r = anon.anonymiseText(SAMPLES.x12.text, onlyHl7, { seed: 'x' });
  assert.equal(r.code, 'ANON-NO-RULES');
  assert.match(r.message, /No anonymise rule applies to x12/);
});

test('anonymise: HL7 escape sequences, repetitions, subcomponents and other alphabets keep their place', () => {
  const text = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|M1|P|2.5\rPID|1||77&x1&y^^^H~88^^^K||Müller-Lüd\\T\\Co^Jürgen\\.br\\Karl^Жанна||19840712\rNK1|1|\\X0D\\Smith^𝐀b\r';
  const rules = rulesOf([{ format: 'hl7', path: 'PID-3', action: 'pseudonym' }, { format: 'hl7', path: 'PID-5', action: 'fake-name' }, { format: 'hl7', path: 'NK1-2', action: 'pseudonym' }]);
  const r = anon.anonymiseText(text, rules, { seed: 'esc' });
  assert.equal(r.text.length, text.length);
  assert.deepEqual(skeleton(r.text), skeleton(text));
  assert.ok(r.text.includes('\\T\\') && r.text.includes('\\.br\\') && r.text.includes('\\X0D\\'), 'escape sequences are untouched');
  assert.ok(!/Müller|Jürgen|Karl|Жанна|Smith/.test(r.text), 'letters of other alphabets are replaced too: ' + r.text);
  assert.match(r.text, /PID\|1\|\|\d\d&[a-z]\d&[a-z]\^\^\^[A-Z]~\d\d\^\^\^[A-Z]\|\|/);
  assert.match(r.text, /NK1\|1\|\\X0D\\[A-Z][a-z]{4}\^[a-z]{3}\r$/, 'a letter outside the basic plane becomes two letters, so the length stays');
  assert.deepEqual(issuesOf(r.text), issuesOf(text));
});

test('anonymise attack: hostile values never break out of their place', () => {
  const nasty = ["?", "??", "?'", "'", '+', ':', '*', '~', '^', '|', '&', '\\', '\\F\\', '\\', '\u0000', ' ', '﻿', '\ud800', '\udfff\ud800', 'A'.repeat(5000), '9'.repeat(400), '<script>alert(1)</script>', '=HYPERLINK("x")', '${7*7}', '%s%s%n', '../../etc/passwd', 'a\r\nb', '\t'];
  for (const value of nasty) {
    for (const [format, make, path] of [
      ['edifact', (v) => "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'NAD+BY+" + v + "::9+x" + v + "'UNT+3+1'UNZ+1+R1'", 'NAD-2'],
      ['x12', (v) => SAMPLES.x12.text.replace('410 Harbour View Road', v), 'N3-1'],
      ['hl7', (v) => SAMPLES.hl7.text.replace('Hartwell^Mira^J', v + '^' + v), 'PID-5'],
    ]) {
      const text = make(value);
      for (const action of anon.ACTIONS) {
        const r = anon.anonymiseText(text, rulesOf([{ format, path, action }, { format, path: path.replace(/-\d+$/, '-3'), action }]), { seed: 'attack' });
        assert.equal(r.ok, true);
        if (action !== 'blank') {
          assert.equal(r.text.length, text.length, format + ' ' + action + ' ' + JSON.stringify(value.slice(0, 20)));
          assert.deepEqual(skeleton(r.text), skeleton(text), format + ' ' + action + ' ' + JSON.stringify(value.slice(0, 20)));
        }
        assert.deepEqual(issuesOf(r.text).map((i) => i[1] + '#' + i[5]), issuesOf(text).map((i) => i[1] + '#' + i[5]), format + ' ' + action + ' ' + JSON.stringify(value.slice(0, 20)));
        assert.equal(parse(r.text).segments.length, parse(text).segments.length);
      }
    }
  }
});

test('anonymise fuzz: every mutation of every corpus file keeps its problems, segment for segment (seed 20240311)', () => {
  const next = kit.rng(20240311);
  let cases = 0;
  const started = Date.now();
  for (const f of ALL) {
    for (let k = 0; k < 6; k++) {
      let text = f.text;
      const at = Math.floor(next() * text.length);
      const len = 1 + Math.floor(next() * 12);
      const kind = Math.floor(next() * 6);
      if (kind === 0) text = text.slice(0, at) + text.slice(at + len);
      else if (kind === 1) text = text.slice(0, at) + text.slice(at, at + len) + text.slice(at);
      else if (kind === 2) text = text.slice(0, at);
      else if (kind === 3) text = text.slice(0, at) + '\u0000\r\n?\\~' + text.slice(at);
      else if (kind === 4) text = text.slice(0, at) + String.fromCharCode(33 + Math.floor(next() * 90)) + text.slice(at + 1);
      else text = text + text.slice(Math.floor(text.length / 2));
      const r = anon.anonymiseText(text, BUILT_IN, { seed: 'fuzz' });
      cases++;
      if (!r.ok) { assert.ok(['ANON-NOT-EDI', 'ANON-NO-RULES'].includes(r.code)); continue; }
      assert.equal(r.text.length, text.length, f.name + ' case ' + k);
      assert.deepEqual(issuesOf(r.text), issuesOf(text), f.name + ' case ' + k + ' kind ' + kind + ' validates differently after anonymising');
      assert.equal(minify(parse(r.text)).length, minify(parse(text)).length);
    }
  }
  assert.equal(cases, 126 * 6);
  assert.ok(Date.now() - started < 120000);
});

test('streaming: a failure inside a tool is never swallowed (no half-finished result that looks complete)', () => {
  const { parseStream, parse: parseAll } = require('../src/core/parse');
  let seen = 0;
  assert.throws(() => parseStream(SAMPLES.edifact.text, null, () => { seen++; if (seen === 5) throw new Error('handler failed'); }), /handler failed/);
  assert.equal(seen, 5, 'reading stopped at the failure');
  // The ordinary parser still never throws, whatever the input.
  for (const text of [null, undefined, 42, {}, '', '\u0000', SAMPLES.x12.text.slice(0, 50)]) assert.ok(Array.isArray(parseAll(text).segments));
  // A rewriter that fails makes the whole call fail instead of returning a partly anonymised text.
  const broken = anon.createRewriter('x');
  let calls = 0;
  broken.rewrite = () => { calls++; if (calls === 3) throw new Error('rewriter failed'); return { value: 'X', note: '' }; };
  assert.throws(() => anon.anonymiseText(SAMPLES.hl7.text, BUILT_IN, { rewriter: broken }), /rewriter failed/);
});
