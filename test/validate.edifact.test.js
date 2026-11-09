'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/validate-env.js');

const VALID = env.fixture('edifact-valid.edi');
const MULTI = env.fixture('edifact-multi.edi');
const GROUPS = env.fixture('edifact-groups.edi');
const TRUNCATED = env.fixture('edifact-truncated.edi');

function run(text) {
  return env.run(text, 'edifact');
}

function mustReplace(text, from, to) {
  assert.ok(text.indexOf(from) >= 0, 'fixture does not contain ' + JSON.stringify(from));
  return text.replace(from, to);
}

test('edifact: valid single message has no issues', () => {
  assert.deepEqual(run(VALID), []);
});

test('edifact: valid interchange with two messages has no issues', () => {
  assert.deepEqual(run(MULTI), []);
});

test('edifact: valid interchange with two functional groups has no issues', () => {
  assert.deepEqual(run(GROUPS), []);
});

test('edifact: valid file without UNA, with CRLF line breaks and with a BOM', () => {
  const noUna = VALID.split('\n').slice(1).join('\n');
  assert.deepEqual(run(noUna), []);
  assert.deepEqual(run(VALID.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(run('﻿' + VALID), []);
});

test('edifact: result is the same when the parser does not list UNA as a segment', () => {
  const m = env.parseAs(VALID, 'edifact');
  m.segments = m.segments.filter((s) => s.id !== 'UNA');
  assert.deepEqual(env.validate(m), []);
});

test('edifact: UNB missing', () => {
  const text = mustReplace(VALID, "UNB+UNOC:3+SENDER01:ZZ+RECEIVER01:ZZ+240115:1030+REF0001'\n", '');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNB-MISSING']);
  env.assertCovers(issues, 'EDIFACT-UNB-MISSING', text, 'UNH');
});

test('edifact: UNB present but not first', () => {
  const noUna = VALID.split('\n').slice(1).join('\n');
  const text = "BGM+220+X'\n" + noUna;
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNB-NOT-FIRST']);
  env.assertCovers(issues, 'EDIFACT-UNB-NOT-FIRST', text, 'BGM');
});

test('edifact: UNB syntax identifier missing', () => {
  const text = mustReplace(VALID, 'UNB+UNOC:3+', 'UNB++');
  env.assertCodes(run(text), ['EDIFACT-UNB-SYNTAX-ID-MISSING']);
});

test('edifact: UNB control reference missing also breaks the UNZ match', () => {
  const text = mustReplace(VALID, "+240115:1030+REF0001'", "+240115:1030'");
  env.assertCodes(run(text), ['EDIFACT-UNB-REF-MISSING', 'EDIFACT-UNZ-REF']);
});

test('edifact: UNZ missing', () => {
  const text = mustReplace(VALID, "UNZ+1+REF0001'\n", '');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNZ-MISSING']);
  env.assertCovers(issues, 'EDIFACT-UNZ-MISSING', text, 'UNB');
});

test('edifact: truncated input reports the open message and interchange', () => {
  const issues = run(TRUNCATED);
  env.assertCodes(issues, ['EDIFACT-UNT-MISSING', 'EDIFACT-UNZ-MISSING']);
  env.assertCovers(issues, 'EDIFACT-UNT-MISSING', TRUNCATED, 'UNH');
  env.assertShape(issues, TRUNCATED, ['EDIFACT-']);
});

test('edifact: UNT missing before the next UNH', () => {
  const text = mustReplace(MULTI, "UNT+4+1'\n", '');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNT-MISSING']);
  assert.equal(issues[0].offset, text.indexOf('UNH+1'));
});

test('edifact: UNT without UNH', () => {
  const text = mustReplace(VALID, "UNT+9+M0001'\n", "UNT+9+M0001'\nUNT+1+X'\n");
  env.assertCodes(run(text), ['EDIFACT-UNT-UNEXPECTED']);
});

test('edifact: UNT segment count wrong', () => {
  const text = mustReplace(VALID, 'UNT+9+M0001', 'UNT+8+M0001');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNT-COUNT']);
  env.assertCovers(issues, 'EDIFACT-UNT-COUNT', text, '8');
  assert.match(issues[0].message, /declares 8/);
  assert.match(issues[0].message, /contains 9/);
});

test('edifact: UNT count empty or not a number', () => {
  env.assertCodes(run(mustReplace(VALID, 'UNT+9+M0001', 'UNT++M0001')), ['EDIFACT-UNT-COUNT']);
  const issues = run(mustReplace(VALID, 'UNT+9+M0001', 'UNT+XX+M0001'));
  env.assertCodes(issues, ['EDIFACT-UNT-COUNT']);
  assert.match(issues[0].message, /not a number/);
});

test('edifact: UNT message reference differs from UNH', () => {
  const text = mustReplace(VALID, 'UNT+9+M0001', 'UNT+9+M0002');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNT-REF']);
  env.assertCovers(issues, 'EDIFACT-UNT-REF', text, 'M0002');
});

test('edifact: UNH message reference missing', () => {
  const text = mustReplace(VALID, 'UNH+M0001+', 'UNH++');
  env.assertCodes(run(text), ['EDIFACT-UNH-REF-MISSING', 'EDIFACT-UNT-REF']);
});

test('edifact: wrong count in the second message points at the second UNT', () => {
  const text = mustReplace(MULTI, 'UNT+5+2', 'UNT+6+2');
  const m = env.parseAs(text, 'edifact');
  const issues = env.validate(m);
  env.assertCodes(issues, ['EDIFACT-UNT-COUNT']);
  const second = m.segments.filter((s) => s.id === 'UNT')[1];
  assert.equal(issues[0].segmentIndex, second.index);
  env.assertCovers(issues, 'EDIFACT-UNT-COUNT', text, '6');
});

test('edifact: UNZ message count wrong', () => {
  const text = mustReplace(MULTI, 'UNZ+2+REF0002', 'UNZ+3+REF0002');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNZ-COUNT']);
  env.assertCovers(issues, 'EDIFACT-UNZ-COUNT', text, '3');
});

test('edifact: UNZ control reference differs from UNB', () => {
  const text = mustReplace(MULTI, 'UNZ+2+REF0002', 'UNZ+2+REF0009');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNZ-REF']);
  env.assertCovers(issues, 'EDIFACT-UNZ-REF', text, 'REF0009');
});

test('edifact: UNE message count wrong', () => {
  const text = mustReplace(GROUPS, 'UNE+1+G1', 'UNE+2+G1');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNE-COUNT']);
  env.assertCovers(issues, 'EDIFACT-UNE-COUNT', text, '2');
});

test('edifact: UNE group reference differs from UNG', () => {
  const text = mustReplace(GROUPS, 'UNE+2+G2', 'UNE+2+G9');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNE-REF']);
  env.assertCovers(issues, 'EDIFACT-UNE-REF', text, 'G9');
});

test('edifact: UNG without UNE (first group never closed)', () => {
  const text = mustReplace(GROUPS, "UNE+1+G1'\n", '');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNE-MISSING']);
  assert.equal(issues[0].offset, text.indexOf('UNG+INVOIC'));
});

test('edifact: UNE without UNG', () => {
  const text = mustReplace(MULTI, 'UNZ+2+REF0002', "UNE+1+G3'\nUNZ+2+REF0002");
  env.assertCodes(run(text), ['EDIFACT-UNE-UNEXPECTED']);
});

test('edifact: UNZ counts groups, and tolerates the message total when groups are present', () => {
  assert.deepEqual(run(mustReplace(GROUPS, 'UNZ+2+REF0003', 'UNZ+3+REF0003')), []);
  const text = mustReplace(GROUPS, 'UNZ+2+REF0003', 'UNZ+5+REF0003');
  env.assertCodes(run(text), ['EDIFACT-UNZ-COUNT']);
});

test('edifact: message with no body segments is a warning', () => {
  const text = "UNB+UNOC:3+A:ZZ+B:ZZ+240115:1030+R1'\nUNH+1+ORDERS:D:96A:UN'\nUNT+2+1'\nUNZ+1+R1'\n";
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-MESSAGE-EMPTY']);
  assert.equal(issues[0].severity, 'warning');
  env.assertCovers(issues, 'EDIFACT-MESSAGE-EMPTY', text, 'UNH');
});

test('edifact: empty segment id', () => {
  const text = mustReplace(VALID, "BGM+220+PO12345+9'\n", "BGM+220+PO12345+9'\n'\n");
  const issues = run(text);
  assert.ok(env.codes(issues).indexOf('EDIFACT-SEGMENT-ID-EMPTY') >= 0, JSON.stringify(env.codes(issues)));
  env.assertShape(issues, text, ['EDIFACT-']);
});

test('edifact: lower-case segment id is a warning', () => {
  const text = mustReplace(VALID, 'BGM+220', 'bgm+220');
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-SEGMENT-ID-INVALID']);
  assert.equal(issues[0].severity, 'warning');
});

test('edifact: an escaped terminator inside a segment is not an error', () => {
  const text = mustReplace(mustReplace(VALID, "QTY+21:5'", "QTY+21:5'\nFTX+AAI+++Don?'t panic'"), 'UNT+9', 'UNT+10');
  assert.deepEqual(run(text), []);
});

test('edifact: unclosed release character at the end of the input', () => {
  const text = mustReplace(VALID, "UNZ+1+REF0001'\n", 'UNZ+1+REF0001?');
  const issues = run(text);
  assert.ok(env.codes(issues).indexOf('EDIFACT-RELEASE-UNCLOSED') >= 0, JSON.stringify(env.codes(issues)));
  const hit = env.find(issues, 'EDIFACT-RELEASE-UNCLOSED')[0];
  assert.equal(text.slice(hit.offset, hit.end), '?');
});

test('edifact: escaped terminator that swallows the end of the file is reported', () => {
  const text = "UNB+UNOC:3+A:ZZ+B:ZZ+240115:1030+R1'\nUNH+1+ORDERS:D:96A:UN'\nFTX+AAI+++text?'";
  const issues = run(text);
  assert.ok(env.codes(issues).indexOf('EDIFACT-RELEASE-UNCLOSED') >= 0, JSON.stringify(env.codes(issues)));
});

test('edifact: doubled release character is a literal release, not an escape', () => {
  const text = mustReplace(mustReplace(VALID, "QTY+21:5'", "QTY+21:5'\nFTX+AAI+++path??'"), 'UNT+9', 'UNT+10');
  assert.deepEqual(run(text), []);
});

test('edifact: segments after UNZ', () => {
  const text = VALID + "BGM+1'\n";
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNZ-NOT-LAST']);
  env.assertCovers(issues, 'EDIFACT-UNZ-NOT-LAST', text, 'BGM');
});

test('edifact: two complete interchanges in one file', () => {
  const second = MULTI.split('\n').slice(1).join('\n');
  assert.deepEqual(run(VALID + second), []);
});

test('edifact: second interchange missing its UNZ is reported at its own UNB', () => {
  const second = MULTI.split('\n').slice(1).join('\n').replace("UNZ+2+REF0002'\n", '');
  const text = VALID + second;
  const issues = run(text);
  env.assertCodes(issues, ['EDIFACT-UNZ-MISSING']);
  assert.equal(issues[0].offset, text.lastIndexOf('UNB+'));
});

test('edifact: empty input and UNA-only input', () => {
  env.assertCodes(run(''), ['EDIFACT-NO-SEGMENTS']);
  env.assertCodes(run("UNA:+.? '"), ['EDIFACT-NO-SEGMENTS']);
});

test('edifact: all issue ranges stay inside the text', () => {
  const broken = [
    mustReplace(VALID, 'UNT+9+M0001', 'UNT+8+M0002'),
    mustReplace(MULTI, "UNZ+2+REF0002'\n", ''),
    TRUNCATED,
    VALID.slice(0, 77),
    "UNB'",
  ];
  for (const text of broken) {
    env.assertShape(run(text), text, ['EDIFACT-']);
  }
});
