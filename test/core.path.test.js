'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/parse');
const { formatPath, resolvePath, locate } = require('../src/core/path');
const { fixture, fixtureNames } = require('./core.helpers');

test('path: formatPath builds the documented syntax', () => {
  const message = parse(fixture('orders-d96a.edi'));
  const nad2 = message.segments.filter((s) => s.id === 'NAD')[1];
  assert.equal(formatPath(nad2), 'NAD[2]');
  assert.equal(formatPath(nad2, 3), 'NAD[2]-3');
  assert.equal(formatPath(nad2, 3, 1), 'NAD[2]-3.1');
  assert.equal(formatPath(nad2, 3, 1, 2), 'NAD[2]-3.1.2');
  assert.equal(formatPath(nad2, 5, 1, undefined, 2), 'NAD[2]-5(2).1');
  assert.equal(formatPath(nad2, 5, undefined, undefined, 2), 'NAD[2]-5(2)');
  assert.equal(formatPath(nad2, 5, undefined, 3), 'NAD[2]-5.1.3');
  assert.equal(formatPath('MSH', 9, 2), 'MSH[1]-9.2');
  assert.equal(formatPath('PID', 5, 1, undefined, 2), 'PID[1]-5(2).1');
});

test('path: resolvePath finds segments, elements, components and subcomponents', () => {
  const edifact = parse(fixture('orders-d96a.edi'));
  assert.equal(resolvePath(edifact, 'NAD[2]').value, "NAD+SU+4098765000008::9");
  assert.equal(resolvePath(edifact, 'NAD[2]-1').value, 'SU');
  assert.equal(resolvePath(edifact, 'NAD[2]-2.1').value, '4098765000008');
  assert.equal(resolvePath(edifact, 'NAD[2]-2.3').value, '9');
  assert.equal(resolvePath(edifact, 'NAD[2]-2.2').value, '');
  assert.equal(resolvePath(edifact, 'BGM[1]-2').value, 'PO-100234');
  assert.equal(resolvePath(edifact, 'LIN[2]-3.1.1').value, '4000000000022');

  const hl7 = parse(fixture('hl7-oru-r01.hl7'));
  assert.equal(resolvePath(hl7, 'MSH[1]-9.2').value, 'R01');
  assert.equal(resolvePath(hl7, 'MSH[1]-1').value, '|');
  assert.equal(resolvePath(hl7, 'MSH[1]-2').value, '^~\\&');
  assert.equal(resolvePath(hl7, 'OBX[3]-5.2.2').value, 'Strong');
  assert.equal(resolvePath(hl7, 'OBX[3]-5.2').value, 'Positive&Strong&Marked');

  const x12 = parse(fixture('x12-850-po.x12'));
  assert.equal(resolvePath(x12, 'N1[1]-2').value, 'Acme Distribution Centre');
  assert.equal(resolvePath(x12, 'PO1[2]-7').value, '040000000022');
  assert.equal(resolvePath(x12, 'ISA[1]-13').value, '000000101');
});

test('path: repetitions default to 1 and can be addressed explicitly', () => {
  const hl7 = parse(fixture('hl7-oru-r01.hl7'));
  const whole = resolvePath(hl7, 'PID[1]-3');
  assert.equal(whole.value, '100200300^^^GENHOSP^MR~900800700^^^NATID^NI');
  assert.equal(resolvePath(hl7, 'PID[1]-3.1').value, '100200300');
  assert.equal(resolvePath(hl7, 'PID[1]-3(1).1').value, '100200300');
  assert.equal(resolvePath(hl7, 'PID[1]-3(2).1').value, '900800700');
  assert.equal(resolvePath(hl7, 'PID[1]-3(2)').value, '900800700^^^NATID^NI');
  assert.equal(resolvePath(hl7, 'PID[1]-3(2).5').value, 'NI');
  assert.equal(resolvePath(hl7, 'PID[1]-3(3).1'), null);
  assert.equal(resolvePath(hl7, 'PID[1]-3(2).1').repetition, whole.element.repetitions[1]);
});

test('path: the occurrence defaults to 1 and the spelling may be loose', () => {
  const message = parse(fixture('orders-d96a.edi'));
  assert.equal(resolvePath(message, 'NAD-1').value, 'BY');
  assert.equal(resolvePath(message, '  NAD[1]-1  ').value, 'BY');
});

test('path: paths that do not exist or are malformed give null', () => {
  const message = parse(fixture('orders-d96a.edi'));
  for (const bad of ['', 'NAD[3]', 'NAD[0]', 'XXX[1]', 'NAD[1]-99', 'NAD[1]-0', 'NAD[1]-2.9', 'NAD[1]-2.1.2',
    'NAD[1]-', 'NAD[1]-a', '[1]-2', 'NAD[1]-2..1', 'NAD[1]-2.1.1.1', 'NAD [1]']) {
    assert.equal(resolvePath(message, bad), null, JSON.stringify(bad));
  }
  assert.equal(resolvePath(message, null), null);
  assert.equal(resolvePath(message, 7), null);
  assert.equal(resolvePath(null, 'NAD[1]'), null);
});

test('path: resolved offset and end always delimit the value', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    for (const seg of message.segments) {
      const bySegment = resolvePath(message, formatPath(seg));
      assert.equal(bySegment.segment, seg, name);
      assert.equal(message.text.slice(bySegment.offset, bySegment.end), seg.raw);
      for (const el of seg.elements) {
        for (let r = 0; r < el.repetitions.length; r++) {
          for (const comp of el.repetitions[r].components) {
            for (const sub of comp.subcomponents) {
              const path = formatPath(seg, el.index, comp.index, sub.index, r + 1);
              const found = resolvePath(message, path);
              assert.ok(found, name + ' ' + path);
              assert.equal(found.value, sub.raw, name + ' ' + path);
              assert.equal(found.offset, sub.offset);
              assert.equal(found.end, sub.end);
              assert.equal(message.text.slice(found.offset, found.end), found.value);
              assert.equal(found.element, el);
              assert.equal(found.component, comp);
            }
          }
        }
      }
    }
  }
});

test('path: locate returns the piece under an offset and a path that resolves back', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    for (const seg of message.segments) {
      for (const el of seg.elements) {
        for (const rep of el.repetitions) {
          for (const comp of rep.components) {
            if (comp.end === comp.offset) {
              continue;
            }
            for (const offset of [comp.offset, comp.end - 1]) {
              const hit = locate(message, offset);
              assert.ok(hit, name + ' @' + offset);
              assert.equal(hit.segment, seg);
              assert.equal(hit.element, el);
              assert.equal(hit.component, comp);
              const back = resolvePath(message, hit.path);
              assert.ok(back, name + ' ' + hit.path);
              assert.equal(back.segment, seg);
              assert.equal(back.element, el);
              assert.ok(back.offset <= offset && offset < back.end, name + ' ' + hit.path);
            }
          }
        }
      }
    }
  }
});

test('path: locate gives short paths and covers repetitions and subcomponents', () => {
  const hl7 = parse(fixture('hl7-oru-r01.hl7'));
  const second = hl7.text.indexOf('900800700');
  const hit = locate(hl7, second);
  assert.equal(hit.path, 'PID[1]-3(2).1');
  assert.equal(hit.repetition, hit.element.repetitions[1]);
  assert.equal(hit.component.raw, '900800700');
  const strong = locate(hl7, hl7.text.indexOf('Strong'));
  assert.equal(strong.path, 'OBX[3]-5.2.2');
  assert.equal(strong.subcomponent.raw, 'Strong');
  const mshType = locate(hl7, hl7.text.indexOf('R01'));
  assert.equal(mshType.path, 'MSH[1]-9.2');

  const edifact = parse(fixture('orders-d96a.edi'));
  const qualifier = locate(edifact, edifact.text.indexOf('BGM+220') + 4);
  assert.equal(qualifier.path, 'BGM[1]-1');
  const plain = locate(edifact, edifact.text.indexOf('PO-100234'));
  assert.equal(plain.path, 'BGM[1]-2');
  const ean = locate(edifact, edifact.text.indexOf('EN\'', edifact.text.indexOf('LIN+2')));
  assert.equal(ean.path, 'LIN[2]-3.2');
});

test('path: locate on the segment id, delimiters and outside segments', () => {
  const message = parse(fixture('orders-d96a.edi'));
  const bgm = message.segments.find((s) => s.id === 'BGM');
  const onId = locate(message, bgm.offset + 1);
  assert.equal(onId.path, 'BGM[1]');
  assert.equal(onId.element, undefined);
  const onPlus = locate(message, bgm.offset + 3);
  assert.equal(onPlus.path, 'BGM[1]');
  const onTerminator = locate(message, bgm.end - 1);
  assert.equal(onTerminator.segment, bgm);
  assert.equal(onTerminator.element, undefined);
  const onColon = locate(message, message.text.indexOf('137:') + 3);
  assert.equal(onColon.path, 'DTM[1]-1');
  assert.equal(locate(message, -1), null);
  assert.equal(locate(message, message.text.length + 10), null);
  assert.equal(locate(message, 'x'), null);
  assert.equal(locate(parse(''), 0), null);
});

test('path: locate ignores a byte order mark and the white space between segments', () => {
  const message = parse('﻿' + fixture('x12-850-po.x12'));
  assert.equal(locate(message, 0), null);
  assert.equal(locate(message, 1).path, 'ISA[1]');
  const gap = message.segments[0].end;
  assert.equal(message.text[gap], '\n');
  assert.equal(locate(message, gap), null);
});

test('path: locate with inclusiveEnd treats the position after a value as inside it', () => {
  const message = parse(fixture('orders-d96a.edi'));
  const bgm = message.segments.find((s) => s.id === 'BGM');
  const afterValue = bgm.elements[1].end;
  assert.equal(locate(message, afterValue).path, 'BGM[1]');
  assert.equal(locate(message, afterValue, { inclusiveEnd: true }).path, 'BGM[1]-2');
});

test('path: resolve after locate is stable for empty elements', () => {
  const message = parse(fixture('orders-d96a.edi'));
  const lin = message.segments.find((s) => s.id === 'LIN');
  const empty = resolvePath(message, 'LIN[1]-2');
  assert.equal(empty.value, '');
  assert.equal(empty.offset, empty.end);
  assert.equal(empty.offset, lin.elements[1].offset);
});

test('locate on the separator between two subcomponents reports the enclosing component, not the first subcomponent', () => {
  const m = parse('MSH|^~\&|A|B|C|D|20240101||ORU^R01|1|P|2.5\rOBX|1|CE|X||BLDV&Blood venous&HL70070^^^&Left arm||||||F\r');
  const text = m.text;
  const amp = text.indexOf('&Blood');
  assert.equal(locate(m, amp + 1).path, 'OBX[1]-5.1.2');
  assert.equal(locate(m, amp).path, 'OBX[1]-5.1', 'the separator belongs to the component');
  assert.equal(locate(m, amp).subcomponent, null);
  assert.equal(locate(m, amp).component.raw, 'BLDV&Blood venous&HL70070');
  const r = resolvePath(m, locate(m, amp).path);
  assert.ok(r.offset <= amp && amp <= r.end);
  // A component with a single subcomponent still reports that subcomponent (unchanged behaviour).
  const plain = locate(m, text.indexOf('BLDV') + 1);
  assert.equal(plain.path, 'OBX[1]-5.1.1');
  assert.ok(plain.subcomponent);
  const edi = parse("UNB+UNOC:3+A+B+240101:1200+1'NAD+BY+123::9'UNZ+1+1'");
  const nad = locate(edi, edi.text.indexOf('123') + 1);
  assert.equal(nad.path, 'NAD[1]-2.1');
  assert.ok(nad.subcomponent && nad.subcomponent.raw === '123');
});
