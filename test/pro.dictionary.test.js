'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BOM = String.fromCharCode(0xfeff);

const { loadDictionary, describe, limits } = require('../src/pro/dictionary.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'pro', name), 'utf8');

/** Builds dictionary text from an object, with sensible defaults. */
function dict(overrides) {
  return JSON.stringify(Object.assign({ format: 'edifact', name: 'Test', segments: {} }, overrides));
}

function errorsOf(text) {
  const r = loadDictionary(text);
  assert.equal(r.ok, false, 'expected the dictionary to be rejected');
  return r.errors;
}

test('dictionary: the sample file loads', () => {
  const r = loadDictionary(fixture('dictionary-edifact.json'));
  assert.equal(r.ok, true);
  assert.equal(r.dictionary.format, 'edifact');
  assert.equal(r.dictionary.name, 'Sample order dictionary');
  assert.deepEqual(Object.keys(r.dictionary.segments), ['BGM', 'NAD']);
  assert.deepEqual(r.warnings, []);
});

test('dictionary: the invalid sample reports several problems at once', () => {
  const errors = errorsOf(fixture('dictionary-invalid.json'));
  const all = errors.join('\n');
  assert.match(all, /"format" must be one of: edifact, x12, hl7/);
  assert.match(all, /"name"/);
  assert.match(all, /"one"/);
  assert.match(all, /Segment BGM\.elements\["2"\]\.components\["1"\]/);
  assert.match(all, /values must be an object/);
  assert.match(all, /LONGID/);
  assert.ok(errors.length >= 5);
});

test('dictionary: segment ids are stored in upper case', () => {
  const r = loadDictionary(fixture('dictionary-edifact.json'));
  assert.ok(r.dictionary.segments.NAD);
  assert.equal(r.dictionary.segments.nad, undefined);
});

test('dictionary: a byte order mark is accepted', () => {
  assert.equal(loadDictionary(BOM + dict()).ok, true);
});

test('dictionary: invalid JSON gives a readable message', () => {
  const errors = errorsOf('{ "format": ');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
});

test('dictionary: empty text and non-text input are rejected', () => {
  assert.match(errorsOf('')[0], /not valid JSON/);
  assert.deepEqual(loadDictionary(undefined), { ok: false, errors: ['The dictionary must be given as text.'] });
  assert.equal(loadDictionary(42).ok, false);
  assert.equal(loadDictionary(null).ok, false);
});

test('dictionary: the top level must be an object', () => {
  assert.match(errorsOf('[]')[0], /top level/);
  assert.match(errorsOf('"text"')[0], /top level/);
  assert.match(errorsOf('null')[0], /top level/);
  assert.match(errorsOf('12')[0], /top level/);
});

test('dictionary: format is required and must be known', () => {
  assert.match(errorsOf(JSON.stringify({ name: 'x', segments: {} })).join(' '), /"format"/);
  assert.match(errorsOf(dict({ format: 'edi' })).join(' '), /"format"/);
  assert.match(errorsOf(dict({ format: 5 })).join(' '), /"format"/);
  ['edifact', 'x12', 'hl7'].forEach((f) => assert.equal(loadDictionary(dict({ format: f })).ok, true));
});

test('dictionary: name is required, text and not empty', () => {
  assert.match(errorsOf(JSON.stringify({ format: 'hl7', segments: {} })).join(' '), /"name"/);
  assert.match(errorsOf(dict({ name: '   ' })).join(' '), /"name" must not be empty/);
  assert.match(errorsOf(dict({ name: 5 })).join(' '), /"name" must be a text value/);
});

test('dictionary: segments must be an object', () => {
  assert.match(errorsOf(dict({ segments: [] })).join(' '), /"segments" must be an object/);
  assert.match(errorsOf(dict({ segments: 'x' })).join(' '), /"segments" must be an object/);
  assert.match(errorsOf(JSON.stringify({ format: 'hl7', name: 'x' })).join(' '), /"segments"/);
});

test('dictionary: segment ids must be 2 or 3 letters or digits starting with a letter', () => {
  ['B', 'ABCD', '1AB', 'A-B', 'A B', ''].forEach((id) => {
    const text = JSON.stringify({ format: 'x12', name: 'x', segments: { [id]: {} } });
    assert.match(errorsOf(text).join(' '), /not valid/, 'id ' + JSON.stringify(id));
  });
  ['ST', 'N1', 'G61', 'ZZ9'].forEach((id) => {
    const text = JSON.stringify({ format: 'x12', name: 'x', segments: { [id]: {} } });
    assert.equal(loadDictionary(text).ok, true, 'id ' + id);
  });
});

test('dictionary: the same segment in two cases is a duplicate', () => {
  const text = dict({ segments: { BGM: {}, bgm: {} } });
  assert.match(errorsOf(text).join(' '), /defined more than once/);
});

test('dictionary: a segment must be an object', () => {
  assert.match(errorsOf(dict({ segments: { BGM: 'x' } })).join(' '), /Segment BGM must be an object/);
  assert.match(errorsOf(dict({ segments: { BGM: [] } })).join(' '), /Segment BGM must be an object/);
  assert.match(errorsOf(dict({ segments: { BGM: null } })).join(' '), /Segment BGM must be an object/);
});

test('dictionary: element keys must be positive whole numbers', () => {
  ['0', '-1', 'a', '1.5', '01', '', '12345'].forEach((key) => {
    const text = dict({ segments: { BGM: { elements: { [key]: { name: 'x' } } } } });
    assert.match(errorsOf(text).join(' '), /not an element number/, 'key ' + JSON.stringify(key));
  });
  const ok = dict({ segments: { BGM: { elements: { 1: { name: 'x' }, 10: { name: 'y' } } } } });
  assert.equal(loadDictionary(ok).ok, true);
});

test('dictionary: elements must be an object and each element too', () => {
  assert.match(errorsOf(dict({ segments: { BGM: { elements: [] } } })).join(' '), /elements must be an object/);
  assert.match(errorsOf(dict({ segments: { BGM: { elements: { 1: 'x' } } } })).join(' '), /must be an object/);
});

test('dictionary: component keys must be numbers and names must be text', () => {
  const badKey = dict({ segments: { BGM: { elements: { 1: { components: { x: 'a' } } } } } });
  assert.match(errorsOf(badKey).join(' '), /not a component number/);
  const badName = dict({ segments: { BGM: { elements: { 1: { components: { 1: 7 } } } } } });
  assert.match(errorsOf(badName).join(' '), /must be a text value/);
  const emptyName = dict({ segments: { BGM: { elements: { 1: { components: { 1: '' } } } } } });
  assert.match(errorsOf(emptyName).join(' '), /must not be empty/);
  const notObject = dict({ segments: { BGM: { elements: { 1: { components: ['a'] } } } } });
  assert.match(errorsOf(notObject).join(' '), /components must be an object/);
});

test('dictionary: values must be an object of text', () => {
  const notObject = dict({ segments: { BGM: { elements: { 1: { values: 'x' } } } } });
  assert.match(errorsOf(notObject).join(' '), /values must be an object/);
  const badValue = dict({ segments: { BGM: { elements: { 1: { values: { 220: { a: 1 } } } } } } });
  assert.match(errorsOf(badValue).join(' '), /must be a text value/);
});

test('dictionary: a code value key called __proto__ is rejected', () => {
  const text = '{"format":"hl7","name":"x","segments":{"PID":{"elements":{"1":{"values":{"__proto__":"x"}}}}}}';
  assert.match(errorsOf(text).join(' '), /unusable code value key/);
  assert.equal(Object.prototype.polluted, undefined);
});

test('dictionary: names longer than the limit are rejected', () => {
  const long = 'x'.repeat(limits.maxNameLength + 1);
  assert.match(errorsOf(dict({ name: long })).join(' '), /longer than/);
  const ok = 'x'.repeat(limits.maxNameLength);
  assert.equal(loadDictionary(dict({ name: ok })).ok, true);
});

test('dictionary: unknown keys are reported as warnings, not errors', () => {
  const text = dict({ extra: 1, segments: { BGM: { nmae: 'typo', elements: { 1: { name: 'x', comment: 'y' } } } } });
  const r = loadDictionary(text);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 3);
  assert.match(r.warnings.join('\n'), /"nmae"/);
  assert.ok(!('nmae' in r.dictionary.segments.BGM));
});

test('dictionary: text over the size limit is rejected without parsing', () => {
  const big = '{"format":"hl7","name":"x","segments":{},"pad":"' + 'a'.repeat(limits.maxTextLength) + '"}';
  const errors = errorsOf(big);
  assert.match(errors[0], /larger than 2 MB/);
});

test('dictionary: more than the allowed number of segments is rejected', () => {
  const segments = {};
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i <= limits.maxSegments; i += 1) {
    segments[letters[Math.floor(i / 676) % 26] + letters[Math.floor(i / 26) % 26] + letters[i % 26]] = {};
  }
  assert.equal(Object.keys(segments).length, limits.maxSegments + 1);
  assert.match(errorsOf(dict({ segments })).join(' '), /defines 2001 segments; the limit is 2000/);
  delete segments[Object.keys(segments)[0]];
  assert.equal(loadDictionary(dict({ segments })).ok, true);
});

test('dictionary: more than the allowed number of entries is rejected', () => {
  const values = {};
  for (let i = 0; i <= limits.maxEntries; i += 1) {
    values['v' + i] = 'n';
  }
  const text = dict({ segments: { BGM: { elements: { 1: { values } } } } });
  assert.ok(text.length < limits.maxTextLength, 'fixture must stay under the size limit');
  assert.match(errorsOf(text).join(' '), /limit is 100000/);
});

test('dictionary: the error list is capped', () => {
  const elements = {};
  for (let i = 0; i < 200; i += 1) {
    elements['bad' + i] = {};
  }
  const errors = errorsOf(dict({ segments: { BGM: { elements } } }));
  assert.equal(errors.length, 51);
  assert.match(errors[50], /and 150 more problems/);
});

test('dictionary: the result is a copy, not the parsed object', () => {
  const text = dict({ segments: { BGM: { name: 'x', junk: true } } });
  const r = loadDictionary(text);
  assert.deepEqual(r.dictionary.segments.BGM, { name: 'x' });
});

/* ------------------------------------------------------------ describe */

const SAMPLE = loadDictionary(fixture('dictionary-edifact.json')).dictionary;

test('describe: segment name only', () => {
  assert.deepEqual(describe(SAMPLE, 'BGM'), { segmentName: 'Beginning of message' });
});

test('describe: element name', () => {
  assert.deepEqual(describe(SAMPLE, 'BGM', 2), {
    segmentName: 'Beginning of message',
    elementName: 'Document number',
  });
});

test('describe: component name and value name', () => {
  assert.deepEqual(describe(SAMPLE, 'BGM', 1, 1, '220'), {
    segmentName: 'Beginning of message',
    elementName: 'Document name',
    componentName: 'Document name code',
    valueName: 'Order',
  });
});

test('describe: value name without a component number', () => {
  assert.equal(describe(SAMPLE, 'NAD', 1, undefined, 'BY').valueName, 'Buyer');
  assert.equal(describe(SAMPLE, 'NAD', 1, null, 'SU').valueName, 'Supplier');
});

test('describe: segment ids are not case sensitive', () => {
  assert.equal(describe(SAMPLE, 'nad').segmentName, 'Name and address');
  assert.equal(describe(SAMPLE, 'Nad', 2, 3).componentName, 'Agency');
});

test('describe: indexes may be given as text', () => {
  assert.equal(describe(SAMPLE, 'NAD', '2', '1').componentName, 'Party id');
});

test('describe: surrounding spaces in a value are ignored when nothing matches exactly', () => {
  assert.equal(describe(SAMPLE, 'BGM', 1, 1, ' 220 ').valueName, 'Order');
});

test('describe: unknown things leave the field out', () => {
  assert.deepEqual(describe(SAMPLE, 'XXX'), {});
  assert.deepEqual(describe(SAMPLE, 'BGM', 9), { segmentName: 'Beginning of message' });
  assert.equal(describe(SAMPLE, 'BGM', 1, 9).componentName, undefined);
  assert.equal(describe(SAMPLE, 'BGM', 1, 1, '999').valueName, undefined);
  assert.equal(describe(SAMPLE, 'BGM', 2, 1, '220').valueName, undefined);
});

test('describe: missing dictionary or odd input gives an empty result', () => {
  assert.deepEqual(describe(null, 'BGM'), {});
  assert.deepEqual(describe(undefined, 'BGM'), {});
  assert.deepEqual(describe({}, 'BGM'), {});
  assert.deepEqual(describe(SAMPLE, undefined), {});
  assert.deepEqual(describe(SAMPLE, 42), {});
  assert.deepEqual(describe(SAMPLE, 'BGM', 'x', 'y'), { segmentName: 'Beginning of message' });
});

test('describe: names of Object.prototype members do not leak', () => {
  assert.deepEqual(describe(SAMPLE, 'constructor'), {});
  assert.deepEqual(describe(SAMPLE, 'BGM', 1, 1, 'constructor'), {
    segmentName: 'Beginning of message',
    elementName: 'Document name',
    componentName: 'Document name code',
  });
  assert.deepEqual(describe(SAMPLE, 'BGM', 1, 1, 'toString').valueName, undefined);
});
