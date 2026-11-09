'use strict';

/*
 * Shared helpers for the validator tests: parser selection, fixture loading
 * and issue assertions. The real parser (src/core/parse.js) is used when it
 * exists; set EDI_LENS_TEST_PARSER=mini to force the small private tokenizer
 * in test/helpers/mini-parse.js instead.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const mini = require('./mini-parse.js');
const { validate } = require('../../src/core/validate.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'validate');

function loadParser() {
  if (process.env.EDI_LENS_TEST_PARSER !== 'mini') {
    const file = path.join(__dirname, '..', '..', 'src', 'core', 'parse.js');
    if (fs.existsSync(file)) {
      try {
        const core = require(file);
        if (core && typeof core.parse === 'function') return { name: 'core', parse: core.parse };
      } catch (err) {
        // fall through to the private tokenizer
      }
    }
  }
  return { name: 'mini', parse: mini.parse };
}

const parser = loadParser();

/** Parses text; when the parser does not report the wanted format, falls back to the private tokenizer. */
function parseAs(text, format) {
  let m = null;
  try {
    m = parser.parse(text, { format: format });
  } catch (err) {
    m = null;
  }
  if (!m || m.format !== format) m = mini.parse(text, { format: format });
  return m;
}

/** Validates text parsed by the private tokenizer with explicit X12 delimiters (for wrong-width ISA tests). */
function runMini(text, format, delimiters, opts) {
  return validate(mini.parse(text, { format: format, delimiters: delimiters }), opts);
}

/** Reads a fixture file as text. */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Parses and validates text in the given format. */
function run(text, format, opts) {
  return validate(parseAs(text, format), opts);
}

function codes(issues) {
  return issues.map(function (i) {
    return i.code;
  });
}

function find(issues, code) {
  return issues.filter(function (i) {
    return i.code === code;
  });
}

/** Asserts that exactly the listed codes (in any order, no extras) were reported. */
function assertCodes(issues, expected) {
  assert.deepEqual(codes(issues).sort(), expected.slice().sort(), JSON.stringify(issues.map(function (i) { return i.code + '@' + i.offset; })));
}

/** Asserts that the issue with the code covers exactly the given substring of the text. */
function assertCovers(issues, code, text, substring, nth) {
  const hits = find(issues, code);
  assert.ok(hits.length > (nth || 0), 'issue ' + code + ' not found in ' + JSON.stringify(codes(issues)));
  const hit = hits[nth || 0];
  assert.equal(text.slice(hit.offset, hit.end), substring);
}

/** Asserts the structural invariants every issue must satisfy. */
function assertShape(issues, text, prefixes) {
  for (const i of issues) {
    assert.ok(['error', 'warning', 'info'].indexOf(i.severity) >= 0, 'severity ' + i.severity);
    assert.equal(typeof i.code, 'string');
    assert.ok(prefixes.some(function (p) { return i.code.indexOf(p) === 0; }), 'code prefix ' + i.code);
    assert.ok(typeof i.message === 'string' && i.message.length > 0);
    assert.ok(Number.isInteger(i.offset) && Number.isInteger(i.end));
    assert.ok(i.offset >= 0 && i.offset <= i.end && i.end <= text.length, 'range ' + i.offset + '-' + i.end + ' of ' + text.length);
    assert.ok(Number.isInteger(i.segmentIndex) && i.segmentIndex >= -1);
  }
}

module.exports = {
  parser: parser,
  parseAs: parseAs,
  fixture: fixture,
  run: run,
  runMini: runMini,
  mini: mini,
  codes: codes,
  find: find,
  assertCodes: assertCodes,
  assertCovers: assertCovers,
  assertShape: assertShape,
  validate: validate,
};
