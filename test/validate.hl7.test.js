'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/validate-env.js');

const VALID = env.fixture('hl7-valid.hl7');
const BATCH = env.fixture('hl7-batch.hl7');
const MSH_LINE = VALID.split('\n')[0];

function run(text) {
  return env.run(text, 'hl7');
}

function mustReplace(text, from, to) {
  assert.ok(text.indexOf(from) >= 0, 'fixture does not contain ' + JSON.stringify(from));
  return text.replace(from, to);
}

test('hl7: valid message has no issues', () => {
  assert.deepEqual(run(VALID), []);
});

test('hl7: valid batch file has no issues', () => {
  assert.deepEqual(run(BATCH), []);
});

test('hl7: valid with LF, CRLF and CR separators and a BOM', () => {
  assert.deepEqual(run(VALID.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(run(VALID.replace(/\n/g, '\r')), []);
  assert.deepEqual(run('﻿' + VALID), []);
});

test('hl7: two messages in one file are both valid', () => {
  assert.deepEqual(run(VALID + VALID.replace('MSG00001', 'MSG00002')), []);
});

test('hl7: first segment is not MSH', () => {
  const text = VALID.split('\n').slice(1).join('\n');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-MISSING']);
  env.assertCovers(issues, 'HL7-MSH-MISSING', text, 'EVN');
});

test('hl7: empty input', () => {
  env.assertCodes(run(''), ['HL7-MSH-MISSING']);
});

test('hl7: encoding characters too short', () => {
  const text = mustReplace(VALID, 'MSH|^~\\&|', 'MSH|^~&|');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-ENCODING']);
  env.assertCovers(issues, 'HL7-MSH-ENCODING', text, '^~&');
});

test('hl7: encoding characters not distinct', () => {
  const text = mustReplace(VALID, 'MSH|^~\\&|', 'MSH|^^\\&|');
  env.assertCodes(run(text), ['HL7-MSH-ENCODING']);
});

test('hl7: encoding character is a letter', () => {
  const text = mustReplace(VALID, 'MSH|^~\\&|', 'MSH|^~a&|');
  env.assertCodes(run(text), ['HL7-MSH-ENCODING']);
});

test('hl7: five encoding characters (truncation character) are accepted', () => {
  const text = mustReplace(VALID, 'MSH|^~\\&|', 'MSH|^~\\&#|');
  assert.deepEqual(run(text), []);
});

test('hl7: a different but valid set of delimiters is accepted', () => {
  const text = VALID.replace(/\|/g, ',');
  assert.deepEqual(run(text), []);
});

test('hl7: field separator is a letter or digit', () => {
  const text = mustReplace(VALID, 'MSH|^~\\&|', 'MSH1^~\\&1');
  const issues = run(text);
  assert.ok(env.codes(issues).indexOf('HL7-MSH-FIELD-SEPARATOR') >= 0, JSON.stringify(env.codes(issues)));
});

test('hl7: MSH without a field separator', () => {
  const issues = run('MSH');
  env.assertCodes(issues, ['HL7-MSH-FIELD-SEPARATOR']);
});

test('hl7: MSH-9 message type missing', () => {
  const text = mustReplace(VALID, '||ADT^A01|MSG00001|', '|||MSG00001|');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-TYPE-MISSING']);
  assert.equal(issues[0].severity, 'error');
});

test('hl7: MSH-9 holding only separators counts as missing', () => {
  const text = mustReplace(VALID, '||ADT^A01|MSG00001|', '||^|MSG00001|');
  env.assertCodes(run(text), ['HL7-MSH-TYPE-MISSING']);
});

test('hl7: MSH-10 control id missing', () => {
  const text = mustReplace(VALID, '|ADT^A01|MSG00001|', '|ADT^A01||');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-CONTROL-ID-MISSING']);
  assert.equal(issues[0].severity, 'error');
});

test('hl7: MSH-12 version missing is a warning', () => {
  const text = mustReplace(VALID, '|MSG00001|P|2.5', '|MSG00001|P|');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-VERSION-MISSING']);
  assert.equal(issues[0].severity, 'warning');
});

test('hl7: MSH ending before MSH-12 reports the version as missing', () => {
  const text = mustReplace(VALID, '|P|2.5', '');
  env.assertCodes(run(text), ['HL7-MSH-VERSION-MISSING']);
});

test('hl7: truncated MSH reports each missing field', () => {
  const text = 'MSH|^~\\&|SENDAPP|SENDFAC';
  const issues = run(text);
  env.assertCodes(issues, ['HL7-MSH-TYPE-MISSING', 'HL7-MSH-CONTROL-ID-MISSING', 'HL7-MSH-VERSION-MISSING']);
  env.assertShape(issues, text, ['HL7-']);
});

test('hl7: segment identifiers must be three characters starting with a letter', () => {
  const bad = ['pid|1', 'PI|1', 'PIDX|1', '1ID|1', 'P-D|1'];
  for (const line of bad) {
    const text = MSH_LINE + '\n' + line + '\n';
    const issues = run(text);
    env.assertCodes(issues, ['HL7-SEGMENT-ID-INVALID']);
    env.assertCovers(issues, 'HL7-SEGMENT-ID-INVALID', text, line.split('|')[0].slice(0, 4));
  }
});

test('hl7: Z segments and identifiers with digits are accepted', () => {
  assert.deepEqual(run(VALID + 'ZXY|1|custom\nIN1|1\nOBX|1|ST|A\n'), []);
});

test('hl7: blank line between segments is reported as information', () => {
  const text = mustReplace(VALID, 'EVN|', '\nEVN|');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-BLANK-LINE']);
  assert.equal(issues[0].severity, 'info');
  assert.equal(issues[0].segmentIndex, -1);
  assert.equal(text.slice(issues[0].offset, issues[0].end), '\n');
});

test('hl7: several consecutive blank lines are one issue', () => {
  const text = mustReplace(VALID, 'EVN|', '\n\n  \nEVN|');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-BLANK-LINE']);
});

test('hl7: blank lines before the first segment are reported, trailing ones are not', () => {
  env.assertCodes(run('\n' + VALID), ['HL7-BLANK-LINE']);
  assert.deepEqual(run(VALID + '\n\n\n'), []);
});

test('hl7: batch count in BTS is wrong', () => {
  const text = mustReplace(BATCH, 'BTS|2', 'BTS|3');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-BTS-COUNT']);
  env.assertCovers(issues, 'HL7-BTS-COUNT', text, '3');
});

test('hl7: BTS without a count is not checked', () => {
  assert.deepEqual(run(mustReplace(BATCH, 'BTS|2', 'BTS|')), []);
});

test('hl7: BHS without BTS', () => {
  const text = mustReplace(BATCH, 'BTS|2\n', '');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-BTS-MISSING']);
  assert.equal(issues[0].offset, text.indexOf('BHS'));
});

test('hl7: BTS without BHS', () => {
  env.assertCodes(run(VALID + 'BTS|1\n'), ['HL7-BTS-UNEXPECTED']);
});

test('hl7: file count in FTS is wrong', () => {
  const text = mustReplace(BATCH, 'FTS|2', 'FTS|5');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-FTS-COUNT']);
  env.assertCovers(issues, 'HL7-FTS-COUNT', text, '5');
});

test('hl7: FHS without FTS', () => {
  const text = mustReplace(BATCH, 'FTS|2\n', '');
  const issues = run(text);
  env.assertCodes(issues, ['HL7-FTS-MISSING']);
  env.assertCovers(issues, 'HL7-FTS-MISSING', text, 'FHS');
});

test('hl7: FTS without FHS', () => {
  const text = mustReplace(BATCH, /FHS[^\n]*\n/.exec(BATCH)[0], '');
  env.assertCodes(run(text), ['HL7-FTS-UNEXPECTED']);
});

test('hl7: file of loose messages counts messages in FTS', () => {
  const header = 'FHS|^~\\&|A|B|C|D|20240115\n';
  const bodyOne = mustReplace(VALID, 'MSG00001', 'M1');
  const bodyTwo = mustReplace(VALID, 'MSG00001', 'M2');
  assert.deepEqual(run(header + bodyOne + bodyTwo + 'FTS|2\n'), []);
  env.assertCodes(run(header + bodyOne + bodyTwo + 'FTS|3\n'), ['HL7-FTS-COUNT']);
});

test('hl7: every message in a multi-message file is checked', () => {
  const text = VALID + mustReplace(VALID, 'MSG00001', '');
  const m = env.parseAs(text, 'hl7');
  const issues = env.validate(m);
  env.assertCodes(issues, ['HL7-MSH-CONTROL-ID-MISSING']);
  const secondMsh = m.segments.filter((s) => s.id === 'MSH')[1];
  assert.equal(issues[0].segmentIndex, secondMsh.index);
});

test('hl7: all issue ranges stay inside the text', () => {
  const broken = [
    BATCH.slice(0, 120),
    VALID.slice(0, 5),
    'MSH|',
    'MSH|^~\\&|\n\n\nPID',
    mustReplace(BATCH, 'BTS|2', 'BTS|9'),
  ];
  for (const text of broken) {
    env.assertShape(run(text), text, ['HL7-']);
  }
});
