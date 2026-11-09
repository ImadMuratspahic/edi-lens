'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFormat, guessFormat } = require('../src/core/detect');
const { fixture, fixtureNames } = require('./core.helpers');

test('detect: UNA, UNB and UNH starts are EDIFACT', () => {
  assert.equal(detectFormat("UNA:+.? 'UNB+UNOC:3+A+B+240101:1200+1'").format, 'edifact');
  assert.equal(detectFormat("UNB+UNOA:2+A+B+240101:1200+1'").format, 'edifact');
  assert.equal(detectFormat("UNH+1+ORDERS:D:96A:UN'").format, 'edifact');
});

test('detect: ISA with at least 106 characters is X12, a shorter one is not', () => {
  const isa = fixture('x12-850-po.x12');
  assert.equal(detectFormat(isa).format, 'x12');
  assert.equal(detectFormat(isa.slice(0, 106)).format, 'x12');
  assert.equal(detectFormat(isa.slice(0, 105)), null);
});

test('detect: MSH, FHS and BHS starts are HL7', () => {
  assert.equal(detectFormat('MSH|^~\\&|A|B|C|D|20240101||ADT^A01|1|P|2.5').format, 'hl7');
  assert.equal(detectFormat('FHS|^~\\&|A|B').format, 'hl7');
  assert.equal(detectFormat('BHS|^~\\&|A|B').format, 'hl7');
});

test('detect: leading byte order mark and white space are ignored', () => {
  assert.equal(detectFormat("﻿\r\n  UNB+UNOA:2+A+B+240101:1200+1'").format, 'edifact');
  assert.equal(detectFormat('﻿' + fixture('x12-850-po.x12')).format, 'x12');
  assert.equal(detectFormat('\n\n  MSH|^~\\&|A').format, 'hl7');
});

test('detect: unknown text, empty text and non-strings give null', () => {
  assert.equal(detectFormat(''), null);
  assert.equal(detectFormat('   \n  '), null);
  assert.equal(detectFormat('Hello world'), null);
  assert.equal(detectFormat('{"json": true}'), null);
  assert.equal(detectFormat(null), null);
  assert.equal(detectFormat(undefined), null);
  assert.equal(detectFormat(42), null);
});

test('detect: a word that merely starts with a tag is not a match', () => {
  assert.equal(detectFormat('UNBOUND values everywhere'), null);
  assert.equal(detectFormat('MSHIP|1'), null);
  assert.equal(detectFormat('ISAAC' + ' '.repeat(120)), null);
});

test('detect: the result carries a human readable reason', () => {
  const result = detectFormat(fixture('hl7-adt-a01.hl7'));
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 5);
});

test('detect: guessFormat accepts a truncated ISA header, detectFormat does not', () => {
  const cut = fixture('x12-850-po.x12').slice(0, 40);
  assert.equal(detectFormat(cut), null);
  assert.equal(guessFormat(cut).format, 'x12');
  assert.equal(guessFormat('plain text'), null);
});

test('detect: every fixture is recognised as the format its name says', () => {
  for (const name of fixtureNames()) {
    const expected = /\.edi$/.test(name) ? 'edifact' : /\.x12$/.test(name) ? 'x12' : 'hl7';
    const result = detectFormat(fixture(name));
    assert.ok(result, name + ' not detected');
    assert.equal(result.format, expected, name);
  }
});
