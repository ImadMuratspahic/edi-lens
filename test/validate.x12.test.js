'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/validate-env.js');

const VALID = env.fixture('x12-valid.x12');
const MULTI = env.fixture('x12-multi.x12');
const FIXED = { element: '*', component: '>', segment: '~' };

function run(text) {
  return env.run(text, 'x12');
}

function mustReplace(text, from, to) {
  assert.ok(text.indexOf(from) >= 0, 'fixture does not contain ' + JSON.stringify(from));
  return text.replace(from, to);
}

test('x12: valid single transaction has no issues', () => {
  assert.deepEqual(run(VALID), []);
});

test('x12: valid interchange with two groups and three transaction sets has no issues', () => {
  assert.deepEqual(run(MULTI), []);
});

test('x12: valid file with CRLF line breaks, without line breaks and with a BOM', () => {
  assert.deepEqual(run(VALID.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(run(VALID.replace(/\n/g, '')), []);
  assert.deepEqual(run('﻿' + VALID), []);
});

test('x12: ISA that is one character too long', () => {
  const text = mustReplace(VALID, 'SENDERID       *', 'SENDERID        *');
  const issues = env.runMini(text, 'x12', FIXED);
  env.assertCodes(issues, ['X12-ISA-LENGTH']);
  assert.equal(text.slice(issues[0].offset, issues[0].end), text.split('\n')[0].slice(0, -1));
});

test('x12: ISA that is one character too short', () => {
  const text = mustReplace(VALID, 'SENDERID       *', 'SENDERID      *');
  env.assertCodes(env.runMini(text, 'x12', FIXED), ['X12-ISA-LENGTH']);
});

test('x12: ISA of exactly 106 characters is accepted', () => {
  assert.equal(VALID.split('\n')[0].length, 106);
  assert.deepEqual(env.runMini(VALID, 'x12', FIXED), []);
});

test('x12: ISA16 missing', () => {
  const text = mustReplace(VALID, '*0*P*>~', '*0*P*~');
  const issues = env.runMini(text, 'x12', { element: '*', component: '>', segment: '~' });
  env.assertCodes(issues, ['X12-ISA-LENGTH', 'X12-ISA16-MISSING']);
});

test('x12: ISA13 missing', () => {
  const text = mustReplace(VALID, '*00401*000000001*0*', '*00401**0*');
  const issues = env.runMini(text, 'x12', FIXED);
  env.assertCodes(issues, ['X12-ISA-LENGTH', 'X12-ISA-CONTROL-MISSING', 'X12-IEA-CONTROL']);
});

test('x12: first segment is not ISA', () => {
  const text = VALID.split('\n').slice(1).join('\n');
  const issues = run(text);
  env.assertCodes(issues, ['X12-ISA-MISSING']);
  env.assertCovers(issues, 'X12-ISA-MISSING', text, 'GS');
});

test('x12: IEA missing', () => {
  const text = mustReplace(VALID, 'IEA*1*000000001~\n', '');
  const issues = run(text);
  env.assertCodes(issues, ['X12-IEA-MISSING']);
  assert.equal(issues[0].offset, 0);
  env.assertCovers(issues, 'X12-IEA-MISSING', text, 'ISA');
});

test('x12: GE missing', () => {
  const text = mustReplace(VALID, 'GE*1*1~\n', '');
  const issues = run(text);
  env.assertCodes(issues, ['X12-GE-MISSING']);
  env.assertCovers(issues, 'X12-GE-MISSING', text, 'GS');
});

test('x12: SE missing', () => {
  const text = mustReplace(VALID, 'SE*6*0001~\n', '');
  const issues = run(text);
  env.assertCodes(issues, ['X12-SE-MISSING']);
  env.assertCovers(issues, 'X12-SE-MISSING', text, 'ST');
});

test('x12: SE segment count wrong', () => {
  const text = mustReplace(VALID, 'SE*6*0001', 'SE*7*0001');
  const issues = run(text);
  env.assertCodes(issues, ['X12-SE-COUNT']);
  env.assertCovers(issues, 'X12-SE-COUNT', text, '7');
  assert.match(issues[0].message, /declares 7/);
});

test('x12: SE count empty or not a number', () => {
  env.assertCodes(run(mustReplace(VALID, 'SE*6*0001', 'SE**0001')), ['X12-SE-COUNT']);
  const issues = run(mustReplace(VALID, 'SE*6*0001', 'SE*six*0001'));
  env.assertCodes(issues, ['X12-SE-COUNT']);
  assert.match(issues[0].message, /not a number/);
});

test('x12: SE control number differs from ST02', () => {
  const text = mustReplace(VALID, 'SE*6*0001', 'SE*6*0002');
  const issues = run(text);
  env.assertCodes(issues, ['X12-SE-CONTROL']);
  env.assertCovers(issues, 'X12-SE-CONTROL', text, '0002');
});

test('x12: GE count and control number wrong', () => {
  const countText = mustReplace(MULTI, 'GE*2*1', 'GE*3*1');
  env.assertCodes(run(countText), ['X12-GE-COUNT']);
  const controlText = mustReplace(VALID, 'GE*1*1', 'GE*1*9');
  const issues = run(controlText);
  env.assertCodes(issues, ['X12-GE-CONTROL']);
  env.assertCovers(issues, 'X12-GE-CONTROL', controlText, '9');
});

test('x12: IEA count and control number wrong', () => {
  const countText = mustReplace(MULTI, 'IEA*2*000000002', 'IEA*3*000000002');
  const countIssues = run(countText);
  env.assertCodes(countIssues, ['X12-IEA-COUNT']);
  env.assertCovers(countIssues, 'X12-IEA-COUNT', countText, '3');
  const controlText = mustReplace(VALID, 'IEA*1*000000001', 'IEA*1*000000009');
  const issues = run(controlText);
  env.assertCodes(issues, ['X12-IEA-CONTROL']);
  env.assertCovers(issues, 'X12-IEA-CONTROL', controlText, '000000009');
});

test('x12: SE, GE and IEA without an opening segment', () => {
  env.assertCodes(run(mustReplace(VALID, 'SE*6*0001~\n', 'SE*6*0001~\nSE*1*0001~\n')), ['X12-SE-UNEXPECTED']);
  env.assertCodes(run(mustReplace(VALID, 'GE*1*1~\n', 'GE*1*1~\nGE*1*1~\n')), ['X12-GE-UNEXPECTED']);
  env.assertCodes(run(VALID + 'IEA*1*000000001~\n'), ['X12-IEA-UNEXPECTED']);
});

test('x12: ST outside a functional group', () => {
  const text = mustReplace(mustReplace(VALID, 'GE*1*1~\n', ''), /GS\*[^\n]*\n/.exec(VALID)[0], '');
  env.assertCodes(run(text), ['X12-ST-OUTSIDE-GS', 'X12-IEA-COUNT']);
});

test('x12: GS outside an interchange', () => {
  const text = VALID + 'GS*PO*S*R*20240115*1030*9*X*004010~\nGE*0*9~\n';
  env.assertCodes(run(text), ['X12-GS-OUTSIDE-ISA']);
});

test('x12: control numbers missing in ST and GS', () => {
  env.assertCodes(run(mustReplace(VALID, 'ST*850*0001', 'ST*850')), ['X12-ST-CONTROL-MISSING', 'X12-SE-CONTROL']);
  env.assertCodes(run(mustReplace(VALID, '*20240115*1030*1*X*', '*20240115*1030**X*')), ['X12-GS-CONTROL-MISSING', 'X12-GE-CONTROL']);
});

test('x12: duplicate ST02 inside a group is a warning', () => {
  const text = mustReplace(mustReplace(MULTI, 'ST*810*0002', 'ST*810*0001'), 'SE*4*0002', 'SE*4*0001');
  const issues = run(text);
  env.assertCodes(issues, ['X12-DUPLICATE-CONTROL']);
  assert.equal(issues[0].severity, 'warning');
});

test('x12: duplicate GS06 inside an interchange is a warning', () => {
  const text = mustReplace(mustReplace(MULTI, '*0900*2*X*', '*0900*1*X*'), 'GE*1*2', 'GE*1*1');
  env.assertCodes(run(text), ['X12-DUPLICATE-CONTROL']);
});

test('x12: duplicate ISA13 across interchanges is a warning', () => {
  const issues = run(VALID + VALID);
  env.assertCodes(issues, ['X12-DUPLICATE-CONTROL']);
  assert.equal(issues[0].severity, 'warning');
});

test('x12: two interchanges with different control numbers are fine', () => {
  const second = VALID.replace(/000000001/g, '000000002');
  assert.deepEqual(run(VALID + second), []);
});

test('x12: same ST02 in different groups is allowed', () => {
  assert.equal((MULTI.match(/ST\*\d+\*0001/g) || []).length, 2);
  assert.deepEqual(run(MULTI), []);
});

test('x12: empty transaction set is a warning', () => {
  const text = mustReplace(mustReplace(VALID, /BEG[^\n]*\nN1[^\n]*\nPO1[^\n]*\nCTT[^\n]*\n/.exec(VALID)[0], ''), 'SE*6*0001', 'SE*2*0001');
  const issues = run(text);
  env.assertCodes(issues, ['X12-TRANSACTION-EMPTY']);
  assert.equal(issues[0].severity, 'warning');
});

test('x12: truncated input reports every open level', () => {
  const text = VALID.slice(0, VALID.indexOf('N1*BY') + 5);
  const issues = run(text);
  env.assertCodes(issues, ['X12-SE-MISSING', 'X12-GE-MISSING', 'X12-IEA-MISSING']);
  env.assertShape(issues, text, ['X12-']);
});

test('x12: empty segment id', () => {
  const text = mustReplace(VALID, 'BEG*00*SA*PO12345**20240115~\n', 'BEG*00*SA*PO12345**20240115~\n~\n');
  const issues = run(text);
  assert.ok(env.codes(issues).indexOf('X12-SEGMENT-ID-EMPTY') >= 0, JSON.stringify(env.codes(issues)));
  env.assertShape(issues, text, ['X12-']);
});

test('x12: lower-case segment id is a warning', () => {
  const issues = run(mustReplace(VALID, 'BEG*00', 'beg*00'));
  env.assertCodes(issues, ['X12-SEGMENT-ID-INVALID']);
  assert.equal(issues[0].severity, 'warning');
});

test('x12: empty input', () => {
  env.assertCodes(run(''), ['X12-NO-SEGMENTS']);
});

test('x12: all issue ranges stay inside the text', () => {
  const broken = [
    mustReplace(VALID, 'SE*6*0001', 'SE*9*0002'),
    VALID.slice(0, 50),
    VALID.slice(0, 106),
    MULTI.slice(0, MULTI.indexOf('GE*2*1')),
    'ISA*',
  ];
  for (const text of broken) {
    env.assertShape(run(text), text, ['X12-']);
  }
});
