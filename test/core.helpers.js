'use strict';

/*
 * Shared helpers for the core tests: fixture loading and a structural
 * invariant checker that every parsed message must satisfy.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'core');

/** Reads a fixture file as UTF-8 text without changing its line endings. */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** Returns the names of all fixture files. */
function fixtureNames() {
  return fs.readdirSync(FIXTURE_DIR).sort();
}

/** Converts every line ending to LF. */
function toLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Checks the invariants of the parsed structure: segments are ordered and do not
 * overlap, all ranges are inside the text and nested correctly, raw values
 * equal the text they cover, and indexes count up from 1.
 */
function checkInvariants(message) {
  const text = message.text;
  let previousEnd = 0;
  const counts = new Map();
  message.segments.forEach((seg, i) => {
    assert.equal(seg.index, i, 'segment index');
    counts.set(seg.id, (counts.get(seg.id) || 0) + 1);
    assert.equal(seg.occurrence, counts.get(seg.id), 'segment occurrence');
    assert.ok(seg.offset >= previousEnd, 'segments overlap at ' + seg.offset);
    assert.ok(seg.offset + seg.raw.length <= seg.end, 'raw longer than segment');
    assert.ok(seg.end <= text.length, 'segment beyond text');
    assert.equal(text.slice(seg.offset, seg.offset + seg.raw.length), seg.raw, 'segment raw');
    const terminator = text.slice(seg.offset + seg.raw.length, seg.end);
    if (message.format === 'hl7') {
      assert.ok(['', '\r', '\n', '\r\n'].includes(terminator), 'hl7 terminator');
    } else {
      assert.ok(terminator.length <= 1, 'terminator length');
    }
    previousEnd = seg.end;
    let lastElementEnd = seg.offset;
    seg.elements.forEach((el, k) => {
      assert.ok(el.offset >= lastElementEnd, 'elements out of order');
      assert.ok(el.end >= el.offset && el.end <= seg.offset + seg.raw.length, 'element range');
      assert.equal(text.slice(el.offset, el.end), el.raw, 'element raw');
      assert.ok(el.index >= 1);
      if (k > 0) {
        assert.equal(el.index, seg.elements[k - 1].index + 1, 'element index sequence');
      }
      assert.ok(el.repetitions.length >= 1, 'at least one repetition');
      lastElementEnd = el.end;
      el.repetitions.forEach((rep) => {
        assert.ok(rep.components.length >= 1, 'at least one component');
        rep.components.forEach((comp, c) => {
          assert.equal(comp.index, c + 1, 'component index');
          assert.ok(comp.offset >= el.offset && comp.end <= el.end && comp.end >= comp.offset, 'component range');
          assert.equal(text.slice(comp.offset, comp.end), comp.raw, 'component raw');
          assert.ok(comp.subcomponents.length >= 1, 'at least one subcomponent');
          comp.subcomponents.forEach((sub, s) => {
            assert.equal(sub.index, s + 1, 'subcomponent index');
            assert.ok(sub.offset >= comp.offset && sub.end <= comp.end && sub.end >= sub.offset, 'sub range');
            assert.equal(text.slice(sub.offset, sub.end), sub.raw, 'subcomponent raw');
          });
          if (message.format !== 'hl7') {
            assert.equal(comp.subcomponents.length, 1);
            assert.equal(comp.subcomponents[0].raw, comp.raw);
          }
        });
      });
    });
  });
  message.issues.forEach((issue) => {
    assert.ok(issue.offset >= 0 && issue.end >= issue.offset && issue.end <= text.length, 'issue range');
    assert.ok(['error', 'warning', 'info'].includes(issue.severity));
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.message, 'string');
    assert.ok(issue.segmentIndex >= -1 && issue.segmentIndex <= message.segments.length);
  });
}

module.exports = { fixture, fixtureNames, toLf, checkInvariants, FIXTURE_DIR };
