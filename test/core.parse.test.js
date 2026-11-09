'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/parse');
const { fixture, fixtureNames, toLf, checkInvariants } = require('./core.helpers');

/** Returns the raw text of element n (1-based) of the first segment with the given id. */
function el(message, id, n, occurrence) {
  const segs = message.segments.filter((s) => s.id === id);
  const seg = segs[(occurrence || 1) - 1];
  return seg.elements[n - 1];
}

// ---------------------------------------------------------------- general

test('parse: every fixture parses without issues and satisfies the structure invariants', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    assert.deepEqual(message.issues, [], name);
    assert.ok(message.segments.length >= 5, name);
    checkInvariants(message);
  }
});

test('parse: offsets are exact, slice(offset, end) equals raw plus terminator', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    for (const seg of message.segments) {
      const slice = message.text.slice(seg.offset, seg.end);
      assert.ok(slice.startsWith(seg.raw), name);
      const terminator = slice.slice(seg.raw.length);
      if (message.format === 'hl7') {
        assert.ok(['', '\n', '\r', '\r\n'].includes(terminator), name);
      } else if (name !== 'x12-214-newline.x12') {
        assert.ok(terminator === message.delimiters.segment || terminator === '', name);
      }
    }
  }
});

test('parse: text is kept untouched and the segment index, occurrence and line are set', () => {
  const text = fixture('orders-d96a.edi');
  const message = parse(text);
  assert.equal(message.text, text);
  assert.equal(message.segments[0].id, 'UNA');
  assert.equal(message.segments[1].id, 'UNB');
  assert.equal(message.segments[1].line, 1);
  const nads = message.segments.filter((s) => s.id === 'NAD');
  assert.deepEqual(nads.map((s) => s.occurrence), [1, 2]);
  assert.deepEqual(message.segments.map((s) => s.index), message.segments.map((_, i) => i));
  const last = message.segments[message.segments.length - 1];
  assert.equal(last.id, 'UNZ');
  assert.equal(last.line, text.split('\n').length - 2);
});

test('parse: a format can be forced with opts.format', () => {
  const message = parse("BGM+220+1'", { format: 'edifact' });
  assert.equal(message.format, 'edifact');
  assert.equal(message.segments.length, 1);
  const hl7 = parse('PID|1||X', { format: 'hl7' });
  assert.equal(hl7.format, 'hl7');
  assert.equal(hl7.segments[0].id, 'PID');
  assert.ok(hl7.issues.some((i) => i.code === 'bad-msh'));
});

// ---------------------------------------------------------------- EDIFACT

test('edifact: UNA defines the delimiters and the UNA line is a segment', () => {
  const message = parse(fixture('orders-d96a.edi'));
  assert.equal(message.format, 'edifact');
  assert.deepEqual(message.delimiters, {
    component: ':',
    element: '+',
    decimal: '.',
    release: '?',
    repetition: '',
    segment: "'",
  });
  const una = message.segments[0];
  assert.equal(una.id, 'UNA');
  assert.equal(una.raw, "UNA:+.? ");
  assert.equal(una.end, 9);
});

test('edifact: a comma decimal mark in the UNA is honoured', () => {
  const message = parse(fixture('desadv-d96a.edi'));
  assert.equal(message.delimiters.decimal, ',');
  assert.equal(message.issues.length, 0);
});

test('edifact: without UNA the standard delimiters apply', () => {
  const message = parse(fixture('invoic-d01b-single-line.edi'));
  assert.equal(message.delimiters.element, '+');
  assert.equal(message.delimiters.component, ':');
  assert.equal(message.delimiters.release, '?');
  assert.equal(message.delimiters.segment, "'");
  assert.equal(message.segments.length, 19);
  assert.equal(message.segments[0].id, 'UNB');
});

test('edifact: a custom UNA changes element, component and terminator characters', () => {
  const text = "UNA;|,\\ !UNB|UNOA;2|A|B!UNH|1|X;Y!";
  const message = parse(text);
  assert.equal(message.delimiters.component, ';');
  assert.equal(message.delimiters.element, '|');
  assert.equal(message.delimiters.segment, '!');
  assert.equal(message.delimiters.release, '\\');
  assert.equal(message.segments.length, 3);
  assert.equal(message.segments[2].elements[1].repetitions[0].components[1].raw, 'Y');
});

test('edifact: a repetition character in the UNA splits repetitions', () => {
  const message = parse("UNA:+.?*'BGM+A*B:C*D'");
  assert.equal(message.delimiters.repetition, '*');
  const element = el(message, 'BGM', 1);
  assert.equal(element.repetitions.length, 3);
  assert.equal(element.repetitions[1].components.length, 2);
  assert.equal(element.repetitions[1].components[1].raw, 'C');
});

test('edifact: composite elements are split into components', () => {
  const message = parse(fixture('orders-d96a.edi'));
  const dtm = el(message, 'DTM', 1);
  assert.equal(dtm.repetitions[0].components.map((c) => c.raw).join('|'), '137|20240115|102');
  assert.equal(dtm.index, 1);
});

test('edifact: release characters protect delimiters', () => {
  const message = parse(fixture('release-chars.edi'));
  assert.equal(message.issues.length, 0);
  assert.equal(message.segments.length, 9);
  const bgm = el(message, 'BGM', 2);
  assert.equal(bgm.raw, "PO-?'77");
  const ftx = message.segments.find((s) => s.id === 'FTX');
  assert.equal(ftx.elements[3].raw, 'Contains plus?+sign, colon?: and question mark??');
  assert.equal(ftx.elements[3].repetitions[0].components.length, 1);
  const quote = message.segments.filter((s) => s.id === 'FTX')[1];
  assert.equal(quote.elements[3].raw, "Quote?' inside text");
  const imd = el(message, 'IMD', 3);
  assert.equal(imd.repetitions[0].components.length, 4);
  assert.equal(imd.repetitions[0].components[3].raw, 'Widget 12?+4 ?(large?)');
  const unb = el(message, 'UNB', 2);
  assert.equal(unb.raw, 'SENDER?+A:ZZ');
  assert.equal(unb.repetitions[0].components.length, 2);
});

test('edifact: empty elements and trailing delimiters are kept', () => {
  const message = parse("UNB+UNOA:2+A++B+'BGM+'LIN+1++4000:EN'");
  const unb = message.segments[0];
  assert.deepEqual(unb.elements.map((e) => e.raw), ['UNOA:2', 'A', '', 'B', '']);
  assert.deepEqual(unb.elements.map((e) => e.index), [1, 2, 3, 4, 5]);
  const empty = unb.elements[2];
  assert.equal(empty.repetitions.length, 1);
  assert.equal(empty.repetitions[0].components.length, 1);
  assert.equal(empty.offset, empty.end);
  const bgm = message.segments[1];
  assert.equal(bgm.elements.length, 1);
  assert.equal(bgm.elements[0].raw, '');
  const lin = message.segments[2];
  assert.deepEqual(lin.elements.map((e) => e.raw), ['1', '', '4000:EN']);
});

test('edifact: a segment without elements has none, a segment with only an id is valid', () => {
  const message = parse("UNB+A'UNS'UNZ+1'");
  assert.equal(message.segments[1].id, 'UNS');
  assert.equal(message.segments[1].elements.length, 0);
});

test('edifact: LF, CRLF and single-line files give the same segments', () => {
  const lf = parse(toLf(fixture('desadv-d96a.edi')));
  const crlf = parse(fixture('desadv-d96a-crlf.edi'));
  assert.ok(fixture('desadv-d96a-crlf.edi').includes('\r\n'));
  assert.deepEqual(crlf.segments.map((s) => s.raw), lf.segments.map((s) => s.raw));
  const single = parse(lf.segments.map((s) => s.raw + "'").join(''));
  assert.deepEqual(single.segments.map((s) => s.raw), lf.segments.map((s) => s.raw));
  assert.equal(crlf.segments[2].line, 2);
});

test('edifact: a byte order mark shifts all offsets by one and is kept in the text', () => {
  const plain = parse(fixture('orders-d96a.edi'));
  const bom = parse('﻿' + fixture('orders-d96a.edi'));
  assert.equal(bom.text.charCodeAt(0), 0xfeff);
  assert.equal(bom.segments.length, plain.segments.length);
  assert.equal(bom.segments[0].offset, 1);
  assert.equal(bom.segments[0].id, 'UNA');
  assert.equal(bom.segments[3].offset, plain.segments[3].offset + 1);
  assert.deepEqual(bom.issues, []);
  checkInvariants(bom);
});

test('edifact: several messages in one interchange are all read', () => {
  const message = parse(fixture('multi-orders.edi'));
  assert.equal(message.segments.filter((s) => s.id === 'UNH').length, 2);
  assert.equal(message.segments.filter((s) => s.id === 'UNT').length, 2);
  assert.equal(message.segments.filter((s) => s.id === 'LIN').length, 3);
  assert.equal(message.segments.filter((s) => s.id === 'LIN')[2].occurrence, 3);
});

test('edifact: an unterminated last segment is reported and still parsed', () => {
  const text = "UNB+UNOA:2+A+B+240101:1200+1'UNZ+1+1";
  const message = parse(text);
  const issue = message.issues.find((i) => i.code === 'unterminated-segment');
  assert.ok(issue);
  assert.equal(issue.segmentIndex, 1);
  assert.equal(message.segments[1].raw, 'UNZ+1+1');
  assert.equal(message.segments[1].end, text.length);
});

test('edifact: a trailing release character is reported', () => {
  const message = parse("UNB+A'FTX+AAI+text?");
  assert.ok(message.issues.some((i) => i.code === 'unclosed-release'));
  assert.ok(message.issues.some((i) => i.code === 'unterminated-segment'));
});

test('edifact: an invalid UNA is reported and defaults are used', () => {
  const short = parse('UNA:+.');
  assert.ok(short.issues.some((i) => i.code === 'bad-una'));
  const letters = parse("UNAabc? 'UNB+A'");
  assert.ok(letters.issues.some((i) => i.code === 'bad-una'));
  assert.equal(letters.delimiters.element, '+');
});

test('edifact: an empty segment id is reported', () => {
  const message = parse("UNB+A'+X'UNZ+1'");
  const issue = message.issues.find((i) => i.code === 'empty-segment-id');
  assert.ok(issue);
  assert.equal(issue.segmentIndex, 1);
  assert.equal(message.segments[1].id, '');
});

// ---------------------------------------------------------------- X12

test('x12: delimiters come from the fixed-width ISA header', () => {
  const po = parse(fixture('x12-850-po.x12'));
  assert.deepEqual(po.delimiters, { element: '*', component: '>', repetition: '', segment: '~' });
  const invoice = parse(fixture('x12-810-invoice.x12'));
  assert.deepEqual(invoice.delimiters, { element: '*', component: ':', repetition: '^', segment: '~' });
});

test('x12: the ISA segment is exactly 106 characters and its elements are not split further', () => {
  const message = parse(fixture('x12-810-invoice.x12'));
  const isa = message.segments[0];
  assert.equal(isa.id, 'ISA');
  assert.equal(isa.end, 106);
  assert.equal(isa.elements.length, 16);
  assert.equal(isa.elements[10].raw, '^');
  assert.equal(isa.elements[10].repetitions.length, 1);
  assert.equal(isa.elements[15].raw, ':');
  assert.equal(isa.elements[15].repetitions[0].components.length, 1);
  assert.equal(isa.elements[5].raw, 'GLOBALSUPPLY   ');
});

test('x12: repetitions and components are split with the declared characters', () => {
  const message = parse(fixture('x12-810-invoice.x12'));
  const n9 = el(message, 'N9', 2);
  assert.equal(n9.repetitions.length, 2);
  assert.equal(n9.repetitions[1].components[0].raw, 'REF2');
  const ref = el(message, 'REF', 2);
  assert.equal(ref.repetitions.length, 1);
  assert.deepEqual(ref.repetitions[0].components.map((c) => c.raw), ['BOX1', 'BOX2']);
});

test('x12: ISA11 equal to U means no repetition separator', () => {
  const message = parse(fixture('x12-850-po.x12'));
  assert.equal(message.delimiters.repetition, '');
  const n1 = el(message, 'N1', 2);
  assert.equal(n1.raw, 'Acme Distribution Centre');
});

test('x12: a newline can be the segment terminator', () => {
  const message = parse(fixture('x12-214-newline.x12'));
  assert.equal(message.delimiters.segment, '\n');
  assert.equal(message.segments.length, 9);
  assert.equal(message.segments[0].end, 106);
  assert.equal(message.segments[3].id, 'B10');
  assert.deepEqual(message.issues, []);
});

test('x12: empty elements keep their position', () => {
  const message = parse(fixture('x12-850-po.x12'));
  const beg = message.segments.find((s) => s.id === 'BEG');
  assert.deepEqual(beg.elements.map((e) => e.raw), ['00', 'SA', 'PO-100234', '', '20240115']);
  const po1 = message.segments.find((s) => s.id === 'PO1');
  assert.equal(po1.elements[4].raw, '');
  assert.equal(po1.elements[5].raw, 'UP');
});

test('x12: CRLF and single-line files give the same segments as the LF file', () => {
  const lf = parse(toLf(fixture('x12-856-asn.x12')));
  const crlf = parse(fixture('x12-856-asn-crlf.x12'));
  assert.deepEqual(crlf.segments.map((s) => s.raw), lf.segments.map((s) => s.raw));
  const single = parse(lf.segments.map((s) => s.raw + '~').join(''));
  assert.deepEqual(single.segments.map((s) => s.raw), lf.segments.map((s) => s.raw));
  assert.equal(single.segments[0].end, 106);
});

test('x12: several transaction sets and groups are all read', () => {
  const message = parse(fixture('x12-multi-sets.x12'));
  assert.equal(message.segments.filter((s) => s.id === 'ST').length, 3);
  assert.equal(message.segments.filter((s) => s.id === 'GS').length, 2);
  assert.equal(message.segments.filter((s) => s.id === 'PO1')[2].occurrence, 3);
});

test('x12: a short or missing ISA header is reported', () => {
  const cut = parse(fixture('x12-850-po.x12').slice(0, 60));
  assert.equal(cut.format, 'x12');
  assert.ok(cut.issues.some((i) => i.code === 'bad-isa'));
  const noIsa = parse('ST*850*0001~SE*2*0001~', { format: 'x12' });
  assert.ok(noIsa.issues.some((i) => i.code === 'bad-isa'));
  assert.equal(noIsa.segments.length, 2);
});

test('x12: a second interchange with other delimiters is read with its own delimiters', () => {
  const first = fixture('x12-850-po.x12').replace(/\n/g, '');
  const second = fixture('x12-810-invoice.x12');
  const message = parse(first + second);
  assert.equal(message.delimiters.component, '>');
  const n9 = message.segments.find((s) => s.id === 'N9');
  assert.equal(n9.elements[1].repetitions.length, 2);
  assert.equal(message.issues.length, 0);
});

// ---------------------------------------------------------------- HL7

test('hl7: delimiters come from MSH', () => {
  const message = parse(fixture('hl7-adt-a01.hl7'));
  assert.equal(message.format, 'hl7');
  assert.equal(message.delimiters.field, '|');
  assert.equal(message.delimiters.component, '^');
  assert.equal(message.delimiters.repetition, '~');
  assert.equal(message.delimiters.escape, '\\');
  assert.equal(message.delimiters.subcomponent, '&');
});

test('hl7: custom delimiters in MSH are used', () => {
  const text = 'MSH#$*\\!#APP#FAC#X#Y#20240101##ADT$A01#7#P#2.5\rPID#1##A$B*C$D!E\r';
  const message = parse(text);
  assert.equal(message.delimiters.field, '#');
  assert.equal(message.delimiters.component, '$');
  assert.equal(message.delimiters.repetition, '*');
  assert.equal(message.delimiters.subcomponent, '!');
  const pid3 = el(message, 'PID', 3);
  assert.equal(pid3.repetitions.length, 2);
  assert.equal(pid3.repetitions[1].components[1].subcomponents.length, 2);
  assert.equal(el(message, 'MSH', 9).repetitions[0].components[1].raw, 'A01');
});

test('hl7: MSH field numbering starts with the field separator as field 1', () => {
  const message = parse(fixture('hl7-adt-a01.hl7'));
  const msh = message.segments[0];
  assert.equal(msh.elements[0].index, 1);
  assert.equal(msh.elements[0].raw, '|');
  assert.equal(msh.elements[0].offset, 3);
  assert.equal(msh.elements[1].index, 2);
  assert.equal(msh.elements[1].raw, '^~\\&');
  assert.equal(msh.elements[2].raw, 'REGADT');
  assert.equal(msh.elements[7].raw, '');
  const type = msh.elements[8];
  assert.equal(type.index, 9);
  assert.deepEqual(type.repetitions[0].components.map((c) => c.raw), ['ADT', 'A01', 'ADT_A01']);
  assert.equal(msh.elements[9].raw, 'MSG00001');
  assert.equal(msh.elements[11].raw, '2.5.1');
});

test('hl7: repetitions, components and subcomponents are split', () => {
  const oru = parse(fixture('hl7-oru-r01.hl7'));
  const pid3 = el(oru, 'PID', 3);
  assert.equal(pid3.repetitions.length, 2);
  assert.equal(pid3.repetitions[0].components[0].raw, '100200300');
  assert.equal(pid3.repetitions[1].components[0].raw, '900800700');
  assert.equal(pid3.repetitions[1].components[4].raw, 'NI');
  const obx = oru.segments.filter((s) => s.id === 'OBX')[2];
  const comp = obx.elements[4].repetitions[0].components[1];
  assert.deepEqual(comp.subcomponents.map((s) => s.raw), ['Positive', 'Strong', 'Marked']);
  assert.equal(comp.subcomponents[2].index, 3);
  const adt = parse(fixture('hl7-adt-a01.hl7'));
  assert.equal(el(adt, 'NK1', 5).repetitions.length, 2);
});

test('hl7: empty fields and trailing delimiters are kept', () => {
  const message = parse(fixture('hl7-adt-a01.hl7'));
  const pv1 = message.segments.find((s) => s.id === 'PV1');
  assert.equal(pv1.elements[3].raw, '');
  assert.equal(pv1.elements[6].repetitions[0].components[1].raw, 'Smith');
  assert.equal(pv1.elements[pv1.elements.length - 1].raw, '');
  assert.ok(pv1.elements.length > 30);
  assert.deepEqual(pv1.elements.map((e) => e.index), pv1.elements.map((_, i) => i + 1));
});

test('hl7: escape sequences stay raw and do not split fields', () => {
  const message = parse(fixture('hl7-oru-r01.hl7'));
  const obx = message.segments.filter((s) => s.id === 'OBX')[1];
  assert.equal(obx.elements[4].raw, 'Sample haemolysed\\.br\\recheck advised \\F\\ pipe');
});

test('hl7: CR, LF and CRLF segment terminators are all accepted', () => {
  const lf = parse(fixture('hl7-adt-a01.hl7'));
  const cr = parse(fixture('hl7-adt-a01-cr.hl7'));
  const crlf = parse(fixture('hl7-oru-r01-crlf.hl7'));
  assert.deepEqual(cr.segments.map((s) => s.raw), lf.segments.map((s) => s.raw));
  assert.equal(cr.delimiters.segment, '\r');
  assert.equal(lf.delimiters.segment, '\n');
  assert.equal(crlf.delimiters.segment, '\r\n');
  assert.equal(crlf.segments.length, 7);
  assert.equal(crlf.segments[1].end - crlf.segments[1].offset, crlf.segments[1].raw.length + 2);
  assert.deepEqual(cr.issues, []);
  assert.equal(cr.segments[3].line, 3);
  assert.equal(crlf.segments[3].line, 3);
});

test('hl7: blank lines, indentation and transport framing characters are skipped', () => {
  const text = '\u000bMSH|^~\\&|A|B|C|D|20240101||ADT^A01|9|P|2.5\r\r  PID|1||77\r\n\n\u001c\r';
  const message = parse(text);
  assert.deepEqual(message.segments.map((s) => s.id), ['MSH', 'PID']);
  assert.equal(message.segments[1].raw, 'PID|1||77');
  assert.equal(message.segments[1].offset, text.indexOf('PID'));
  checkInvariants(message);
});

test('hl7: batch headers FHS and BHS use the same field numbering as MSH', () => {
  const message = parse(fixture('hl7-batch.hl7'));
  assert.deepEqual(
    message.segments.map((s) => s.id),
    ['FHS', 'BHS', 'MSH', 'EVN', 'PID', 'MSH', 'EVN', 'PID', 'BTS', 'FTS']
  );
  assert.equal(message.segments[0].elements[0].raw, '|');
  assert.equal(message.segments[0].elements[2].raw, 'REGADT');
  assert.equal(message.segments.filter((s) => s.id === 'MSH')[1].occurrence, 2);
});

test('hl7: a missing MSH or short encoding characters are reported', () => {
  const noMsh = parse('PID|1||77\r', { format: 'hl7' });
  assert.ok(noMsh.issues.some((i) => i.code === 'bad-msh'));
  assert.equal(noMsh.delimiters.field, '|');
  const short = parse('MSH|^~|A|B\r');
  assert.ok(short.issues.some((i) => i.code === 'short-encoding'));
  assert.equal(short.delimiters.escape, '\\');
});
