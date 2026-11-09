'use strict';

/*
 * Adversarial correctness tests for the core modules (detect, parse,
 * serialize, path) and the validator: awkward delimiters, escape handling,
 * odd line endings, damaged headers, hostile paths and regression cases for
 * defects found while attacking the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/core/parse.js');
const { detectFormat } = require('../src/core/detect.js');
const { pretty, minify, toJSON, unescapeValue } = require('../src/core/serialize.js');
const { resolvePath, locate, formatPath } = require('../src/core/path.js');
const { validate } = require('../src/core/validate.js');
const { checkInvariants, fixture, fixtureNames } = require('./core.helpers.js');
const kit = require('./helpers/attack-kit.js');

const ISA_BASE = ['ISA', '00', ''.padEnd(10), '00', ''.padEnd(10), 'ZZ', 'SENDER'.padEnd(15), 'ZZ', 'RECEIVER'.padEnd(15), '210101', '1200'];

/** Builds a 105 character ISA plus its terminator (106 characters in total). */
function isa(opts) {
  const o = Object.assign({ el: '*', comp: ':', term: '~', rep: 'U', ctl: '000000001' }, opts);
  return ISA_BASE.concat([o.rep, '00501', o.ctl, '0', 'P', o.comp]).join(o.el) + o.term;
}

/** Returns the raw text of every element of a segment. */
function raws(seg) {
  return seg.elements.map((e) => e.raw);
}

/** Returns the codes of the parse issues. */
function codes(message) {
  return message.issues.map((i) => i.code);
}

/** Parses and checks the structural invariants every message must satisfy. */
function parsed(text, opts) {
  const m = parse(text, opts);
  checkInvariants(m);
  return m;
}

// ---------------------------------------------------------------------------
// UN/EDIFACT
// ---------------------------------------------------------------------------

test('edifact: a release character before each kind of delimiter keeps the value in one piece', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'FTX+AAI+x?+y+a?:b:c?'d+e??f?? g'UNZ+0+1'");
  const ftx = m.segments[1];
  assert.deepEqual(raws(ftx), ['AAI', 'x?+y', "a?:b:c?'d", 'e??f?? g']);
  assert.deepEqual(ftx.elements[2].repetitions[0].components.map((c) => c.raw), ['a?:b', "c?'d"]);
  assert.deepEqual(codes(m), []);
});

test('edifact: a double release before the terminator does not escape it', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'FTX+AAI+x??'UNZ+0+1'");
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[1].raw, 'FTX+AAI+x??');
  assert.deepEqual(codes(m), []);
});

test('edifact: three releases before the terminator escape it and the segment runs on', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'FTX+AAI+x???'UNZ+1+1'");
  assert.equal(m.segments.length, 2);
  assert.equal(m.segments[1].raw, "FTX+AAI+x???'UNZ+1+1");
});

test('edifact: UNA with unusual separators is honoured for every level', () => {
  const m = parsed('UNA;,.\\ ~UNB,UNOA;1,A,B,200101;1200,7~UNH,1,X\\,Y;Z~FTX,AAI~UNT,3,1~UNZ,1,7~');
  assert.deepEqual(m.delimiters, { component: ';', element: ',', decimal: '.', release: '\\', repetition: '', segment: '~' });
  assert.deepEqual(m.segments.map((s) => s.id), ['UNA', 'UNB', 'UNH', 'FTX', 'UNT', 'UNZ']);
  assert.deepEqual(raws(m.segments[2]), ['1', 'X\\,Y;Z']);
  assert.deepEqual(m.segments[2].elements[1].repetitions[0].components.map((c) => c.raw), ['X\\,Y', 'Z']);
  assert.deepEqual(codes(m), []);
  assert.deepEqual(validate(m), []);
});

test('edifact: UNA with a segment terminator that is a line feed', () => {
  const m = parsed("UNA:+.? \nUNB+UNOA:1+A+B+1\nUNH+1+X\nUNT+2+1\nUNZ+1+1\n".replace("? \n", "? \n"));
  assert.equal(m.delimiters.segment, '\n');
  assert.deepEqual(m.segments.map((s) => s.id), ['UNA', 'UNB', 'UNH', 'UNT', 'UNZ']);
});

test('edifact: a UNA that declares no release character makes the question mark ordinary text', () => {
  const m = parsed("UNA:+.  'UNB+UNOA:1+S+R+200101:1200+1'UNH+1+ORDERS'FTX+AAI+++Is it ok?'UNT+3+1'UNZ+1+1'");
  assert.equal(m.delimiters.release, '');
  assert.equal(m.segments.length, 6);
  assert.equal(m.segments[3].raw, 'FTX+AAI+++Is it ok?');
  assert.deepEqual(validate(m), []);
});

test('edifact: a UNA repetition separator splits repetitions inside an element', () => {
  const m = parsed("UNA:+.?*'UNB+UNOA:1+A+B+1'LOC+7+a:b*c*d?*e'UNZ+0+1'");
  const el = m.segments[2].elements[1];
  assert.equal(el.repetitions.length, 3);
  assert.deepEqual(el.repetitions.map((r) => r.components.map((c) => c.raw)), [['a', 'b'], ['c'], ['d?*e']]);
});

test('edifact: invalid UNA strings fall back to the defaults and report bad-una', () => {
  const variants = [
    "UNA:+.X 'UNB+UNOA:1+A+B+1'UNZ+0+1'", // letter as release character
    "UNA:+.+ 'UNB+UNOA:1+A+B+1'UNZ+0+1'", // release equal to the element separator
    "UNA:+.?:'UNB+UNOA:1+A+B+1'UNZ+0+1'", // repetition equal to the component separator
    "UNA:+.? ?UNB+UNOA:1+A+B+1?UNZ+0+1?", // fine except: terminator equals release
    'UNA:+.?', // truncated
    'UNA',
  ];
  for (const text of variants) {
    const m = parsed(text);
    assert.ok(codes(m).includes('bad-una'), JSON.stringify(text));
    assert.equal(m.delimiters.element, '+');
    assert.equal(m.delimiters.segment, "'");
  }
});

test('edifact: a second interchange may bring its own UNA while the message keeps the first delimiters', () => {
  const m = parsed("UNA:+.? 'UNB+UNOA:1+A+B+1'UNZ+0+1'UNA;,.! ~UNB,UNOA;1,C,D,2~FTX,AAI,x!,y;z~UNZ,0,2~");
  assert.equal(m.delimiters.element, '+');
  assert.deepEqual(m.segments.map((s) => s.id), ['UNA', 'UNB', 'UNZ', 'UNA', 'UNB', 'FTX', 'UNZ']);
  assert.deepEqual(raws(m.segments[5]), ['AAI', 'x!,y;z']);
  assert.deepEqual(m.segments[5].elements[1].repetitions[0].components.map((c) => c.raw), ['x!,y', 'z']);
  assert.deepEqual(codes(m), []);
});

test('edifact: trailing text after UNZ becomes an unterminated segment and is reported', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'UNH+1+X'UNT+2+1'UNZ+1+1'garbage here");
  assert.equal(m.segments.length, 5);
  assert.equal(m.segments[4].raw, 'garbage here');
  assert.ok(codes(m).includes('unterminated-segment'));
});

test('edifact: trailing NUL, line breaks and spaces after UNZ are not segments', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'UNZ+0+1'\r\n" + kit.NUL + kit.NUL + '  \n');
  assert.equal(m.segments.length, 2);
  assert.deepEqual(codes(m), []);
});

test('edifact: segments separated by a lone carriage return, a line feed or both', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'\rUNH+1+X'\nUNT+2+1'\r\nUNZ+1+1'\r");
  assert.deepEqual(m.segments.map((s) => s.id), ['UNB', 'UNH', 'UNT', 'UNZ']);
  assert.deepEqual(m.segments.map((s) => s.line), [0, 1, 2, 3]);
});

test('edifact: empty elements and components keep their positions', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'NAD+++::::'UNZ+0+1'");
  const nad = m.segments[1];
  assert.deepEqual(raws(nad), ['', '', '::::']);
  assert.equal(nad.elements[2].repetitions[0].components.length, 5);
  assert.ok(nad.elements[2].repetitions[0].components.every((c) => c.raw === '' && c.offset === c.end));
});

test('edifact: a segment id without elements and an id followed by an empty element differ', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'UNZ'UNZ+'");
  assert.equal(m.segments[1].elements.length, 0);
  assert.equal(m.segments[2].elements.length, 1);
  assert.equal(m.segments[2].elements[0].raw, '');
});

test('edifact: a line break inside a segment stays inside the segment', () => {
  const m = parsed("UNB+UNOA:1+A+B+1'FTX+AAI+++first line\r\nsecond line'UNZ+0+1'");
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[1].elements[3].raw, 'first line\r\nsecond line');
});

test('edifact: a byte order mark, a no-break space and whitespace before the first segment are skipped', () => {
  for (const prefix of [kit.BOM, kit.NBSP, '  \r\n', kit.BOM + kit.BOM, '\t' + kit.BOM]) {
    const m = parsed(prefix + "UNA:+.? 'UNB+UNOA:1+A+B+1'UNZ+0+1'");
    assert.deepEqual(m.segments.map((s) => s.id), ['UNA', 'UNB', 'UNZ'], JSON.stringify(prefix));
    assert.equal(m.segments[0].offset, prefix.length);
    assert.deepEqual(codes(m), []);
  }
});

test('edifact: NUL bytes inside a value are kept and do not move any offset', () => {
  const text = "UNB+UNOA:1+A" + kit.NUL + "B+1'UNZ+0+1'";
  const m = parsed(text);
  assert.equal(m.segments[0].elements[1].raw, 'A' + kit.NUL + 'B');
  assert.equal(text.slice(m.segments[1].offset, m.segments[1].end), "UNZ+0+1'");
});

test('edifact: astral characters and a release character in front of one', () => {
  const smile = String.fromCodePoint(0x1f600);
  const text = "UNB+UNOA:1+A+B+1'FTX+AAI+?" + smile + '+' + smile + smile + "'UNZ+0+1'";
  const m = parsed(text);
  const ftx = m.segments[1];
  assert.deepEqual(raws(ftx), ['AAI', '?' + smile, smile + smile]);
  assert.equal(ftx.elements[2].end - ftx.elements[2].offset, 4, 'two astral characters are four UTF-16 units');
  assert.equal(text.slice(ftx.elements[2].offset, ftx.elements[2].end), smile + smile);
});

test('edifact: lone surrogates and other broken text never throw', () => {
  const junk = ["UNB+UNOA:1+" + String.fromCharCode(0xd800) + "+B+1'", String.fromCharCode(0xdc00) + "UNB+", "UNH+1+" + String.fromCharCode(0xd83d) + "'UNZ"];
  for (const text of junk) {
    const m = parsed(text);
    assert.equal(typeof m.format, 'string');
    pretty(m);
    minify(m);
    validate(m);
  }
});

test('edifact: a very long segment with 300,000 elements keeps every element', () => {
  const text = "UNB+UNOA:1+A+B+1'NAD" + '+x'.repeat(300000) + "'UNZ+0+1'";
  const started = Date.now();
  const m = parsed(text);
  assert.equal(m.segments[1].elements.length, 300000);
  assert.equal(m.segments[1].elements[299999].index, 300000);
  assert.equal(m.segments[1].elements[299999].raw, 'x');
  assert.ok(Date.now() - started < 5000);
});

test('edifact: a segment of 300,000 release characters is read in linear time', () => {
  const text = "UNB+UNOA:1+A+B+1'NAD+" + '?+'.repeat(150000) + "'UNZ+0+1'";
  const started = Date.now();
  const m = parsed(text);
  assert.equal(m.segments[1].elements.length, 1, 'every plus sign is escaped, so there is a single element');
  assert.equal(m.segments[1].elements[0].raw.length, 300000);
  assert.ok(Array.isArray(validate(m)));
  assert.ok(Date.now() - started < 3000);
});

test('edifact: input that starts like no known format gives no segments and one issue', () => {
  for (const text of ['hello', 'NAD+BY+1\'', '   x', '{"json": true}', '<xml/>']) {
    const m = parsed(text);
    assert.equal(m.segments.length, 0, text);
    assert.deepEqual(codes(m), ['unknown-format']);
  }
  assert.deepEqual(codes(parsed('')), ['empty-input']);
  assert.deepEqual(codes(parsed(' \r\n\t' + kit.BOM)), ['empty-input']);
});

test('edifact: the segment offsets reach the terminator and the next segment starts after any gap', () => {
  const text = "UNB+UNOA:1+A+B+1'  \r\n  UNZ+0+1'";
  const m = parsed(text);
  assert.equal(m.segments[0].end, 17);
  assert.equal(m.segments[1].offset, 23);
  assert.equal(text.slice(m.segments[1].offset, m.segments[1].end), "UNZ+0+1'");
  assert.equal(m.segments[1].line, 1);
});

// ---------------------------------------------------------------------------
// X12
// ---------------------------------------------------------------------------

test('x12: an ISA of 106 characters is read, one of 105 or 107 characters is reported', () => {
  const good = isa();
  assert.equal(good.length, 106);
  const ok = parsed(good + 'GS*PO*A*B*20210101*1200*1*X*005010~GE*0*1~IEA*1*000000001~');
  assert.deepEqual(codes(ok), []);
  assert.equal(ok.segments[0].raw.length, 105);

  const short = parsed(good.slice(0, 105));
  assert.equal(short.format, 'x12');
  assert.ok(codes(short).includes('bad-isa'));

  const long = parsed(good.replace('SENDER ', 'SENDER  ') + 'GS*PO~');
  assert.equal(long.format, 'x12');
  assert.ok(codes(long).includes('bad-isa'));
  assert.equal(long.segments.length, 2);
});

test('x12: a repetition separator in ISA11 equal to the terminator still leaves a 106 character ISA', () => {
  const header = isa({ rep: '`', term: '`' });
  const m = parsed(header + 'REF*AB*1`SE*2*1`');
  assert.equal(m.segments[0].raw.length, 105);
  assert.deepEqual(m.segments.map((s) => s.id), ['ISA', 'REF', 'SE']);
  assert.equal(m.delimiters.repetition, '');
  assert.deepEqual(codes(m), []);
});

test('x12: ISA11 is a repetition separator unless it is U or clashes with another delimiter', () => {
  const split = parsed(isa({ rep: '^' }) + 'REF*AB*a^b:c^d~');
  assert.equal(split.delimiters.repetition, '^');
  const el = split.segments[1].elements[1];
  assert.deepEqual(el.repetitions.map((r) => r.components.map((c) => c.raw)), [['a'], ['b', 'c'], ['d']]);

  const plain = parsed(isa({ rep: 'U' }) + 'REF*AB*a^b~');
  assert.equal(plain.segments[1].elements[1].repetitions.length, 1);

  const clash = parsed(isa({ rep: '*' }) + 'REF*AB*a*b~');
  assert.equal(clash.delimiters.repetition, '');
  assert.equal(clash.segments[1].elements.length, 3);
});

test('x12: the ISA itself is never split into repetitions or components', () => {
  const m = parsed(isa({ rep: '^', comp: '>' }));
  const seg = m.segments[0];
  assert.equal(seg.elements.length, 16);
  assert.ok(seg.elements.every((e) => e.repetitions.length === 1 && e.repetitions[0].components.length === 1));
  assert.equal(seg.elements[10].raw, '^');
  assert.equal(seg.elements[15].raw, '>');
});

test('x12: every kind of segment terminator is read, with and without line breaks after it', () => {
  const terms = ['~', '\n', '\r', '!', '`', String.fromCharCode(0x1c)];
  const gaps = ['', '\n', '\r\n', ' '];
  for (const term of terms) {
    for (const gap of gaps) {
      if (term === '\n' && gap !== '' && gap !== '\n') continue;
      const text = isa({ term }) + gap + ['GS*PO*A*B', 'ST*850*0001', 'SE*2*0001', 'GE*1*1', 'IEA*1*000000001'].map((s) => s + term).join(gap);
      const m = parsed(text);
      assert.deepEqual(m.segments.map((s) => s.id), ['ISA', 'GS', 'ST', 'SE', 'GE', 'IEA'], JSON.stringify([term, gap]));
      assert.equal(m.delimiters.segment, term);
      assert.deepEqual(codes(m), []);
    }
  }
});

test('x12: a CRLF file with a carriage return terminator reads cleanly', () => {
  const text = isa({ term: '\r' }) + '\nGS*PO*A*B\r\nST*850*0001\r\nSE*2*0001\r\n';
  const m = parsed(text);
  assert.deepEqual(m.segments.map((s) => s.id), ['ISA', 'GS', 'ST', 'SE']);
  assert.deepEqual(m.segments.map((s) => s.line), [0, 1, 2, 3]);
});

test('x12: two interchanges with different delimiters are each read with their own', () => {
  const text = isa({ el: '*', comp: ':', term: '~' }) + 'REF*AB*1:2~IEA*0*000000001~' + isa({ el: '|', comp: '>', term: '!', ctl: '000000002' }) + 'REF|AB|3>4!IEA|0|000000002!';
  const m = parsed(text);
  assert.equal(m.delimiters.element, '*');
  assert.deepEqual(m.segments.map((s) => s.id), ['ISA', 'REF', 'IEA', 'ISA', 'REF', 'IEA']);
  assert.deepEqual(m.segments[1].elements[1].repetitions[0].components.map((c) => c.raw), ['1', '2']);
  assert.deepEqual(m.segments[4].elements[1].repetitions[0].components.map((c) => c.raw), ['3', '4']);
  assert.deepEqual(codes(m), []);
  assert.deepEqual(validate(m), []);
});

test('x12: indentation, blank lines and a trailing newline are not part of any segment', () => {
  const m = parsed(isa() + '\n\n   GS*PO*A~\n\t\nGE*0*1~\n\n');
  assert.deepEqual(m.segments.map((s) => s.id), ['ISA', 'GS', 'GE']);
  assert.equal(m.segments[1].raw, 'GS*PO*A');
});

test('x12: text after the last terminator is an unterminated segment', () => {
  const m = parsed(isa() + 'IEA*0*000000001~trailing');
  assert.equal(m.segments[2].raw, 'trailing');
  assert.ok(codes(m).includes('unterminated-segment'));
});

test('x12: a file with the wrong ISA delimiters is still opened with the defaults', () => {
  const bad = isa().slice(0, 104) + '1~';
  const m = parsed(bad + 'GS*PO~');
  assert.ok(codes(m).includes('bad-isa'));
  assert.equal(m.delimiters.element, '*');
});

test('x12: data that looks like another format never changes the format', () => {
  const m = parsed(isa() + "REF*AB*UNB+UNOA'MSH|^\\&~");
  assert.equal(m.format, 'x12');
  assert.equal(m.segments.length, 2);
});

// ---------------------------------------------------------------------------
// HL7 v2
// ---------------------------------------------------------------------------

test('hl7: escape sequences stay as written and unescapeValue turns them back into characters', () => {
  const m = parsed('MSH|^~\\&|A|B\rPID|1||a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f||x\\.br\\y\\X0D\\z');
  const pid = m.segments[1];
  assert.equal(pid.elements[2].raw, 'a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f');
  assert.equal(pid.elements[2].repetitions.length, 1);
  assert.equal(unescapeValue(m, pid.elements[2].raw), 'a|b^c&d~e\\f');
  assert.equal(unescapeValue(m, pid.elements[4].raw), 'x\\.br\\y\\X0D\\z');
});

test('hl7: unescapeValue handles back to back, unterminated and doubled escape characters', () => {
  const m = parse('MSH|^~\\&|A');
  assert.equal(unescapeValue(m, '\\F\\\\F\\'), '||');
  assert.equal(unescapeValue(m, 'abc\\F'), 'abc\\F');
  assert.equal(unescapeValue(m, '\\\\'), '\\\\');
  assert.equal(unescapeValue(m, '\\E\\F\\'), '\\F\\');
  assert.equal(unescapeValue(m, ''), '');
});

test('hl7: custom encoding characters and a custom field separator', () => {
  const m = parsed('MSH#*+!&#A#B\rPID#1*2+3&4#x!F!y');
  assert.deepEqual(m.delimiters, { field: '#', component: '*', repetition: '+', escape: '!', subcomponent: '&', segment: '\r' });
  const pid = m.segments[1];
  assert.equal(pid.elements.length, 2);
  assert.deepEqual(pid.elements[0].repetitions.map((r) => r.components.map((c) => c.raw)), [['1', '2'], ['3&4']]);
  assert.deepEqual(pid.elements[0].repetitions[1].components[0].subcomponents.map((s) => s.raw), ['3', '4']);
  assert.equal(unescapeValue(m, pid.elements[1].raw), 'x#y');
});

test('hl7: a fifth encoding character (truncation character) does not shift the fields', () => {
  const m = parsed('MSH|^~\\&#|APP|FAC|||20200101||ADT^A01|C1|P|2.7\rPID|1');
  assert.equal(m.segments[0].elements[1].raw, '^~\\&#');
  assert.equal(m.segments[0].elements[2].raw, 'APP');
  assert.equal(m.segments[0].elements[8].raw, 'ADT^A01');
  assert.deepEqual(codes(m), []);
});

test('hl7: MSH-1 is the separator and MSH-2 the encoding characters, so MSH-9 is the ninth field', () => {
  const m = parsed('MSH|^~\\&|APP|FAC|RAPP|RFAC|20200101||ADT^A01^ADT_A01|C1|P|2.5\r');
  assert.equal(resolvePath(m, 'MSH[1]-1').value, '|');
  assert.equal(resolvePath(m, 'MSH[1]-2').value, '^~\\&');
  assert.equal(resolvePath(m, 'MSH[1]-3').value, 'APP');
  assert.equal(resolvePath(m, 'MSH[1]-9.3').value, 'ADT_A01');
  assert.equal(resolvePath(m, 'MSH[1]-12').value, '2.5');
});

test('hl7: Z segments with repetitions, components and subcomponents', () => {
  const m = parsed('MSH|^~\\&|A\rZPI|1|a&b^c~d^e&f&g|');
  const f = m.segments[1].elements[1];
  assert.equal(f.repetitions.length, 2);
  assert.deepEqual(f.repetitions[0].components.map((c) => c.subcomponents.map((s) => s.raw)), [['a', 'b'], ['c']]);
  assert.deepEqual(f.repetitions[1].components.map((c) => c.subcomponents.map((s) => s.raw)), [['d'], ['e', 'f', 'g']]);
  assert.equal(resolvePath(m, 'ZPI[1]-2(2).2.3').value, 'g');
  assert.equal(m.segments[1].elements[2].raw, '');
});

test('hl7: mixed line endings, blank lines and whitespace-only lines', () => {
  const text = 'MSH|^~\\&|A\r\n\r\n  \t \rPID|1\n\nOBX|1\r';
  const m = parsed(text);
  assert.deepEqual(m.segments.map((s) => s.id), ['MSH', 'PID', 'OBX']);
  assert.deepEqual(m.segments.map((s) => s.line), [0, 3, 5]);
});

test('hl7: MLLP framing characters around a message are not part of any segment', () => {
  const VT = String.fromCharCode(0x0b);
  const FS = String.fromCharCode(0x1c);
  const m = parsed(VT + 'MSH|^~\\&|A|B\rPID|1\r' + FS + '\r');
  assert.deepEqual(m.segments.map((s) => s.id), ['MSH', 'PID']);
  assert.deepEqual(codes(m), []);
});

test('hl7: a no-break space or byte order mark before MSH is skipped like any other blank', () => {
  for (const prefix of [kit.NBSP, kit.BOM, kit.BOM + kit.NBSP + ' ']) {
    const m = parsed(prefix + 'MSH|^~\\&|A|B\rPID|1');
    assert.deepEqual(m.segments.map((s) => s.id), ['MSH', 'PID'], JSON.stringify(prefix));
    assert.deepEqual(codes(m), []);
  }
});

test('hl7: a batch whose messages use different delimiters switches at each MSH', () => {
  const m = parsed('FHS|^~\\&|A\rBHS|^~\\&|B\rMSH#*+!&#X\rPID#1*2\rMSH|^~\\&|Y\rPID|3^4\rBTS|2\rFTS|1');
  assert.equal(m.delimiters.field, '|');
  assert.deepEqual(m.segments.map((s) => s.id), ['FHS', 'BHS', 'MSH', 'PID', 'MSH', 'PID', 'BTS', 'FTS']);
  assert.deepEqual(m.segments[3].elements[0].repetitions[0].components.map((c) => c.raw), ['1', '2']);
  assert.deepEqual(m.segments[5].elements[0].repetitions[0].components.map((c) => c.raw), ['3', '4']);
  assert.deepEqual(raws(m.segments[6]), ['2']);
});

test('hl7: missing or short encoding characters are reported and defaulted', () => {
  const m = parsed('MSH|^~|A\rPID|1^2');
  assert.deepEqual(codes(m), ['short-encoding']);
  assert.equal(m.delimiters.escape, '\\');
  const bare = parsed('MSH|');
  assert.deepEqual(codes(bare), ['short-encoding']);
  const none = parsed('MSH');
  assert.equal(none.segments.length, 1);
  assert.ok(codes(none).includes('bad-msh'));
});

test('hl7: text that is not a message but contains MSH later is not detected as one', () => {
  const m = parsed('Dear team,\rMSH|^~\\&|A\r');
  assert.equal(m.segments.length, 0);
  assert.deepEqual(codes(m), ['unknown-format']);
});

test('hl7: no final line break, only a final line break and only CR or only LF', () => {
  for (const eol of ['\r', '\n', '\r\n']) {
    for (const tail of ['', eol]) {
      const m = parsed('MSH|^~\\&|A' + eol + 'PID|1' + tail);
      assert.deepEqual(m.segments.map((s) => s.id), ['MSH', 'PID']);
      assert.equal(m.segments[1].end, ('MSH|^~\\&|A' + eol + 'PID|1' + tail).length);
    }
  }
});

test('hl7: a line with only a field separator is an empty-id segment, not a crash', () => {
  const m = parsed('MSH|^~\\&|A\r|x\rPID|1');
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[1].id, '');
  assert.ok(codes(m).includes('empty-segment-id'));
});

// ---------------------------------------------------------------------------
// Line numbers and offsets
// ---------------------------------------------------------------------------

test('lines: every segment line equals the number of line breaks before it', () => {
  const texts = [
    "UNB+UNOA:1+A+B+1'\rUNH+1+X'\r\n\r\nUNT+2+1'\n\rUNZ+1+1'",
    isa({ term: '\r' }) + '\nGS*A\r\r\nST*B\r',
    'MSH|^~\\&|A\r\r\nPID|1\n\n\nOBX|1\r',
    kit.BOM + "UNB+UNOA:1+A+B+1'\n\n\nUNZ+0+1'",
  ];
  for (const text of texts) {
    const m = parsed(text);
    for (const seg of m.segments) {
      const before = text.slice(0, seg.offset);
      const expected = before.split(/\r\n|\r|\n/).length - 1;
      assert.equal(seg.line, expected, JSON.stringify(text) + ' segment ' + seg.index);
    }
  }
});

test('lines: U+2028 and U+0085 are not line breaks', () => {
  const m = parsed("UNB+UNOA:1+A" + String.fromCharCode(0x2028) + "B+1'" + String.fromCharCode(0x85) + "UNZ+0+1'");
  assert.equal(m.segments[1].line, 0);
});

// ---------------------------------------------------------------------------
// Options and input types
// ---------------------------------------------------------------------------

test('parse: non-string input never throws', () => {
  for (const input of [undefined, null, 42, true, {}, [], Buffer.from("UNB+UNOA:1+A+B+1'"), Symbol.iterator.description]) {
    const m = parse(input);
    assert.ok(Array.isArray(m.segments));
    assert.ok(Array.isArray(m.issues));
  }
  assert.equal(parse(Buffer.from("UNB+UNOA:1+A+B+1'UNZ+0+1'")).segments.length, 2);
});

test('parse: the format option forces a reader even when the text looks different', () => {
  const asHl7 = parsed("UNB+UNOA:1+A+B+1'", { format: 'hl7' });
  assert.equal(asHl7.format, 'hl7');
  assert.ok(codes(asHl7).includes('bad-msh'));
  const asX12 = parsed("UNB+UNOA:1+A+B+1'", { format: 'x12' });
  assert.equal(asX12.format, 'x12');
  assert.ok(codes(asX12).includes('bad-isa'));
  assert.equal(parsed('MSH|^~\\&|A', { format: 'nonsense' }).format, 'hl7');
});

test('parse: maxIssues limits the list and adds one summary note', () => {
  const text = "UNB+UNOA:1+A+B+1'" + "'".repeat(50);
  const m = parsed(text, { maxIssues: 5 });
  assert.equal(m.issues.length, 6);
  assert.equal(m.issues[5].code, 'too-many-issues');
  assert.equal(parsed(text, { maxIssues: 0 }).issues.length, 50, 'a zero limit falls back to the default');
  assert.equal(parsed(text, { maxIssues: NaN }).issues.length, 50);
  assert.equal(parsed(text, { maxIssues: -3 }).issues.length, 50);
});

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

test('detect: tricky starts', () => {
  const ok = (text) => (detectFormat(text) || {}).format || null;
  assert.equal(ok("UNA:+.? 'UNB"), 'edifact');
  assert.equal(ok(kit.BOM + "  \r\n UNB+UNOA'"), 'edifact');
  assert.equal(ok("UNH+1+X'"), 'edifact');
  assert.equal(ok(isa()), 'x12');
  assert.equal(ok('ISA*' + 'x'.repeat(50)), null, 'a short ISA is not detected strictly');
  assert.equal(ok('MSH|^~\\&|'), 'hl7');
  assert.equal(ok('FHS|^~\\&|'), 'hl7');
  assert.equal(ok('BHS|^~\\&|'), 'hl7');
  assert.equal(ok('MSHX|'), null);
  assert.equal(ok('UNBX'), null);
  assert.equal(ok('unb+unoa'), null);
  assert.equal(ok(''), null);
  assert.equal(ok('   '), null);
  assert.equal(ok(null), null);
  assert.equal(ok(undefined), null);
  assert.equal(ok(42), null);
  assert.equal(ok('\u0000MSH|'), 'hl7');
});

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

test('serialize: pretty and minify are idempotent and keep every element value for all fixtures', () => {
  for (const name of fixtureNames()) {
    const m = parse(fixture(name));
    const values = JSON.stringify(toJSON(m).segments);
    for (const out of [pretty(m), minify(m)]) {
      const again = parse(out);
      assert.equal(JSON.stringify(toJSON(again).segments), values, name);
    }
    const p = pretty(m);
    assert.equal(pretty(parse(p)), p, name + ' pretty twice');
    const mi = minify(m);
    assert.equal(minify(parse(mi)), mi, name + ' minify twice');
  }
});

test('serialize: minify of EDIFACT and X12 contains no line break unless the terminator is one', () => {
  const e = parse("UNA:+.? '\r\nUNB+UNOA:1+A+B+1'\r\nUNZ+0+1'\r\n");
  assert.equal(minify(e), "UNA:+.? 'UNB+UNOA:1+A+B+1'UNZ+0+1'");
  const x = parse(isa() + '\nGS*PO~\nGE*0*1~\n');
  assert.equal(minify(x), isa() + 'GS*PO~GE*0*1~');
  const h = parse('MSH|^~\\&|A\nPID|1\r\nOBX|1');
  assert.equal(minify(h), 'MSH|^~\\&|A\rPID|1\rOBX|1\r');
});

test('serialize: pretty puts one segment on each line, never changes a value and honours the line break option', () => {
  const m = parse("UNB+UNOA:1+A+B+1'UNH+1+X'UNT+2+1'UNZ+1+1'");
  assert.equal(pretty(m), "UNB+UNOA:1+A+B+1'\nUNH+1+X'\nUNT+2+1'\nUNZ+1+1'");
  assert.equal(pretty(m, { eol: '\r\n' }), "UNB+UNOA:1+A+B+1'\r\nUNH+1+X'\r\nUNT+2+1'\r\nUNZ+1+1'");
  const h = parse('MSH|^~\\&|A\rPID|1\rOBX|1\r');
  assert.equal(pretty(h), 'MSH|^~\\&|A\nPID|1\nOBX|1');
  assert.equal(pretty(h, { eol: '\r' }), 'MSH|^~\\&|A\rPID|1\rOBX|1');
});

test('serialize: pretty keeps a line break terminator as it is', () => {
  const m = parse(isa({ term: '\n' }) + 'GS*PO\nGE*0*1\n');
  assert.equal(pretty(m), isa({ term: '\n' }) + 'GS*PO\nGE*0*1\n');
  const crlf = parse(isa({ term: '\r' }) + 'GS*PO\r\nGE*0*1\r\n');
  assert.equal(pretty(crlf), isa({ term: '\r' }) + '\nGS*PO\r\nGE*0*1\r');
});

test('serialize: a message with no segments gives empty text', () => {
  assert.equal(pretty(parse('hello')), '');
  assert.equal(minify(parse('hello')), '');
});

test('serialize: an unterminated last segment stays unterminated', () => {
  const m = parse("UNB+UNOA:1+A+B+1'UNZ+0+1");
  assert.equal(pretty(m), "UNB+UNOA:1+A+B+1'\nUNZ+0+1");
  assert.equal(minify(m), "UNB+UNOA:1+A+B+1'UNZ+0+1");
});

test('serialize: toJSON with unescape leaves the UNA service string alone', () => {
  const m = parse("UNA:+.? 'UNB+UNOA:1+A+B+1'FTX+AAI+++It?'s 1?+1 ?? ok'UNZ+0+1'");
  const plain = toJSON(m, { unescape: true });
  assert.deepEqual(plain.segments[0].elements, [':+.? ']);
  assert.equal(plain.segments[2].elements[3], "It's 1+1 ? ok");
  assert.equal(toJSON(m).segments[2].elements[3], "It?'s 1?+1 ?? ok");
});

test('serialize: toJSON shapes for repetitions, components and subcomponents', () => {
  const h = parse('MSH|^~\\&|A\rPID|1|a^b|c~d|e&f^g~h|');
  const els = toJSON(h).segments[1].elements;
  assert.deepEqual(els, ['1', ['a', 'b'], { repetitions: ['c', 'd'] }, { repetitions: [[['e', 'f'], 'g'], 'h'] }, '']);
  assert.deepEqual(toJSON(h).segments[0].elements.slice(0, 3), ['|', '^~\\&', 'A']);
});

test('serialize: toJSON output can be stringified and read back for every fixture', () => {
  for (const name of fixtureNames()) {
    const obj = toJSON(parse(fixture(name)), { unescape: true });
    assert.deepEqual(JSON.parse(JSON.stringify(obj)), obj, name);
  }
});

test('serialize: toJSON copies the delimiters so changing the result does not change the message', () => {
  const m = parse("UNB+UNOA:1+A+B+1'");
  const j = toJSON(m);
  j.delimiters.element = 'X';
  assert.equal(m.delimiters.element, '+');
});

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

test('path: malformed or hostile paths return null and never throw', () => {
  const m = parse("UNB+UNOA:1+A+B+1'NAD+BY+123::9'UNZ+0+1'");
  const bad = [
    '', ' ', 'NAD[', 'NAD[]', 'NAD[0]', 'NAD[-1]', 'NAD[1.5]', 'NAD-', 'NAD-0', 'NAD[1]-0', 'NAD[1]-1(0)', 'NAD[1]-1(2)', 'NAD[1]-2.0', 'NAD[1]-2.4',
    'NAD[1]-2.3.2', 'NAD[1]-2.3.0', 'NAD[2]', 'NAD[99999999999999999999]', 'NAD[1]-99999999999999999999', '__proto__', '__proto__[1]', 'constructor[1]',
    'toString', 'NAD[1]-1.1.1.1', 'NAD[1] -1', 'NAD [1]', '[1]', '-1', 'NAD[1]-1-2', 'NAD/1', 'NAD[1]-1;', "NAD[1]-1'", 'NAD[1]-\u0000',
  ];
  for (const p of bad) assert.equal(resolvePath(m, p), null, JSON.stringify(p));
  for (const p of [null, undefined, 5, {}, [], true]) assert.equal(resolvePath(m, p), null);
  assert.equal(resolvePath(null, 'NAD'), null);
  assert.equal(resolvePath(undefined, 'NAD'), null);
  assert.equal(locate(null, 3), null);
  assert.equal(locate(m, -1), null);
  assert.equal(locate(m, NaN), null);
  assert.equal(locate(m, 'x'), null);
  assert.equal(locate(m, 10 ** 9), null);
});

test('path: paths are found with the documented defaults', () => {
  const m = parse("UNB+UNOA:1+A+B+1'NAD+BY+123::9+x*y'NAD+SU'UNZ+0+1'");
  assert.equal(resolvePath(m, 'NAD').value, 'NAD+BY+123::9+x*y');
  assert.equal(resolvePath(m, 'NAD[2]').value, 'NAD+SU');
  assert.equal(resolvePath(m, 'NAD[2]-1').value, 'SU');
  assert.equal(resolvePath(m, 'NAD-2').value, '123::9');
  assert.equal(resolvePath(m, 'NAD-2.3').value, '9');
  assert.equal(resolvePath(m, 'NAD-2(1)').value, '123::9');
  assert.equal(resolvePath(m, '  NAD[1]-2.1  ').value, '123');
  assert.equal(resolvePath(m, 'nad-2'), null, 'ids are case sensitive');
});

test('path: locate gives a path that resolves to a range containing the offset, for every offset of every fixture', () => {
  for (const name of fixtureNames()) {
    const m = parse(fixture(name));
    const text = m.text;
    const step = Math.max(1, Math.floor(text.length / 400));
    for (let off = 0; off <= text.length; off += step) {
      const loc = locate(m, off, { inclusiveEnd: true });
      if (!loc || off > loc.segment.offset + loc.segment.raw.length) continue;
      const res = resolvePath(m, loc.path);
      assert.ok(res, name + ' offset ' + off + ' path ' + loc.path);
      assert.ok(res.offset <= off && off <= res.end, name + ' offset ' + off + ' path ' + loc.path);
    }
  }
});

test('path: locate on delimiters and between segments', () => {
  const text = "UNB+UNOA:1+A+B+1'  \nNAD+BY+1:2'";
  const m = parse(text);
  assert.equal(locate(m, text.indexOf('+BY')).path, 'NAD[1]');
  assert.equal(locate(m, text.indexOf('BY')).path, 'NAD[1]-1');
  assert.equal(locate(m, text.indexOf(':2')).path, 'NAD[1]-2');
  assert.equal(locate(m, text.indexOf('2\'')).path, 'NAD[1]-2.2');
  assert.equal(locate(m, 18), null, 'blank space between segments belongs to no segment');
  assert.equal(locate(m, text.indexOf('2\'') + 1, { inclusiveEnd: true }).path, 'NAD[1]-2.2');
});

test('path: formatPath accepts segments and plain ids and ignores levels without a parent', () => {
  assert.equal(formatPath('NAD'), 'NAD[1]');
  assert.equal(formatPath({ id: 'NAD', occurrence: 3 }), 'NAD[3]');
  assert.equal(formatPath('NAD', 2), 'NAD[1]-2');
  assert.equal(formatPath('NAD', 2, 3), 'NAD[1]-2.3');
  assert.equal(formatPath('NAD', 2, 3, 4), 'NAD[1]-2.3.4');
  assert.equal(formatPath('NAD', 2, undefined, 4), 'NAD[1]-2.1.4');
  assert.equal(formatPath('NAD', 2, 3, undefined, 2), 'NAD[1]-2(2).3');
  assert.equal(formatPath('NAD', undefined, 3), 'NAD[1]');
  assert.equal(formatPath('NAD', null, 3), 'NAD[1]');
});

test('path: a message edited after the first lookup is looked up again', () => {
  const m = parse("UNB+UNOA:1+A+B+1'NAD+BY'UNZ+0+1'");
  assert.equal(resolvePath(m, 'NAD[1]-1').value, 'BY');
  const fresh = parse("UNB+UNOA:1+A+B+1'NAD+SU'NAD+BY'UNZ+0+1'");
  assert.equal(resolvePath(fresh, 'NAD[2]-1').value, 'BY');
  assert.equal(resolvePath(m, 'NAD[2]-1'), null);
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/** Returns the sorted list of error and warning codes. */
function problemCodes(text) {
  return validate(parse(text)).filter((i) => i.severity !== 'info').map((i) => i.code);
}

test('validate: nested groups, several messages and several interchanges are clean', () => {
  const text = "UNA:+.? 'UNB+UNOA:1+S+R+200101:1200+100'UNG+ORDERS+S+R+200101:1200+G0'UNH+1+ORDERS'FTX+AAI'UNT+3+1'UNH+2+ORDERS'FTX+AAI'UNT+3+2'UNE+2+G0'UNG+ORDERS+S+R+200101:1200+G1'UNH+1+ORDERS'FTX+AAI'UNT+3+1'UNE+1+G1'UNZ+2+100'" +
    "UNB+UNOA:1+S+R+200101:1200+101'UNH+1+ORDERS'FTX+AAI'UNT+3+1'UNZ+1+101'";
  assert.deepEqual(problemCodes(text), []);
});

test('validate: damaged counters and references each give their own code', () => {
  const base = (patch) => ["UNB+UNOA:1+S+R+200101:1200+100'", "UNG+ORDERS+S+R+200101:1200+G0'", "UNH+1+ORDERS'", "FTX+AAI'", "UNT+3+1'", "UNE+1+G0'", "UNZ+1+100'"].map((s, i) => (patch[i] === undefined ? s : patch[i])).join('');
  assert.deepEqual(problemCodes(base({})), []);
  assert.deepEqual(problemCodes(base({ 4: "UNT+4+1'" })), ['EDIFACT-UNT-COUNT']);
  assert.deepEqual(problemCodes(base({ 4: "UNT+3+9'" })), ['EDIFACT-UNT-REF']);
  assert.deepEqual(problemCodes(base({ 5: "UNE+2+G0'" })), ['EDIFACT-UNE-COUNT']);
  assert.deepEqual(problemCodes(base({ 5: "UNE+1+G9'" })), ['EDIFACT-UNE-REF']);
  assert.deepEqual(problemCodes(base({ 6: "UNZ+2+100'" })), ['EDIFACT-UNZ-COUNT']);
  assert.deepEqual(problemCodes(base({ 6: "UNZ+1+999'" })), ['EDIFACT-UNZ-REF']);
  assert.deepEqual(problemCodes(base({ 6: "UNZ+x+100'" })), ['EDIFACT-UNZ-COUNT']);
});

test('validate: X12 envelopes with several groups and sets, then each broken counter', () => {
  const st = (n, extra) => 'ST*850*' + n + '~' + 'REF*AB*1~'.repeat(extra) + 'SE*' + (extra + 2) + '*' + n + '~';
  const body = (gs, sets, ge, iea, sePatch) => isa() + 'GS*PO*A*B*20210101*1200*' + gs + '*X*004010~' + sets + 'GE*' + ge + '*' + gs + '~IEA*' + iea + '*000000001~';
  assert.deepEqual(problemCodes(body('1', st('0001', 1) + st('0002', 2), 2, 1)), []);
  assert.deepEqual(problemCodes(body('1', st('0001', 1) + st('0002', 2), 3, 1)), ['X12-GE-COUNT']);
  assert.deepEqual(problemCodes(body('1', st('0001', 1) + st('0002', 2), 2, 2)), ['X12-IEA-COUNT']);
  assert.deepEqual(problemCodes(body('1', st('0001', 1).replace('SE*3', 'SE*9'), 1, 1)), ['X12-SE-COUNT']);
  assert.deepEqual(problemCodes(body('1', st('0001', 1).replace('*0001~SE', '*0001~SE').replace('SE*3*0001', 'SE*3*0009'), 1, 1)), ['X12-SE-CONTROL']);
});

test('validate: HL7 batches and files, then each broken counter', () => {
  const msg = (i) => 'MSH|^~\\&|A|B|C|D|20200101||ADT^A01|C' + i + '|P|2.5\rPID|1\r';
  const file = (btsCount, ftsCount) => 'FHS|^~\\&|A\rBHS|^~\\&|B\r' + msg(1) + msg(2) + 'BTS|' + btsCount + '\rFTS|' + ftsCount + '\r';
  assert.deepEqual(problemCodes(file(2, 1)), []);
  assert.deepEqual(problemCodes(file(3, 1)), ['HL7-BTS-COUNT']);
  assert.deepEqual(problemCodes(file(2, 5)), ['HL7-FTS-COUNT']);
  assert.deepEqual(problemCodes('BHS|^~\\&|B\r' + msg(1)), ['HL7-BTS-MISSING']);
  assert.deepEqual(problemCodes(msg(1).replace('ADT^A01', '')), ['HL7-MSH-TYPE-MISSING']);
});

test('validate: a UNA without a release character gives no false release warning', () => {
  const text = "UNA:+.  'UNB+UNOA:1+S+R+200101:1200+1'UNH+1+ORDERS'FTX+AAI+++Really?'UNT+3+1'UNZ+1+1'";
  assert.deepEqual(problemCodes(text), []);
  const withRelease = "UNA:+.? 'UNB+UNOA:1+S+R+200101:1200+1'UNH+1+ORDERS'FTX+AAI+++Really?'UNT+3+1'UNZ+1+1'";
  // With a real release character the question mark escapes the terminator, so UNT is swallowed.
  assert.deepEqual(problemCodes(withRelease), ['EDIFACT-UNT-MISSING']);
});

test('validate: an unmatched release character at the end of the text is reported with an exact range', () => {
  const text = "UNB+UNOA:1+A+B+1'UNH+1+X'UNT+2+1'UNZ+1+1?'";
  const issues = validate(parse(text)).filter((i) => i.code === 'EDIFACT-RELEASE-UNCLOSED');
  assert.equal(issues.length, 1);
  assert.equal(text.slice(issues[0].offset, issues[0].end), "?'");
  const crlf = "UNB+UNOA:1+A+B+1'UNH+1+X'UNT+2+1'UNZ+1+1?'\r\n";
  const again = validate(parse(crlf)).filter((i) => i.code === 'EDIFACT-RELEASE-UNCLOSED');
  assert.equal(again.length, 1);
  assert.equal(crlf.slice(again[0].offset, again[0].end), "?'");
});

test('validate: a segment made of 100,000 line breaks does not take quadratic time', () => {
  const text = "UNB+UNOA:1+A+B+1'UNH+1+X'NAD+" + '\n'.repeat(100000) + "X'UNT+3+1'UNZ+1+1'";
  const m = parse(text);
  const started = Date.now();
  validate(m);
  assert.ok(Date.now() - started < 1500, 'took ' + (Date.now() - started) + ' ms');
});

test('validate: maxIssues of 0, 1, a fraction, a negative and a non-number', () => {
  const m = parse("UNB+UNOA:1+A+B+1'" + "UNT+1+1'".repeat(5));
  assert.equal(validate(m, { maxIssues: 0 }).length, 0);
  assert.equal(validate(m, { maxIssues: 1 }).length, 1);
  assert.equal(validate(m, { maxIssues: 2.9 }).length, 2);
  assert.ok(validate(m, { maxIssues: -4 }).length > 2, 'a negative limit falls back to the default');
  assert.ok(validate(m, { maxIssues: 'x' }).length > 2);
});

test('validate: damaged message objects never throw', () => {
  const m = parse("UNB+UNOA:1+A+B+1'UNZ+0+1'");
  const damaged = [
    null, undefined, 5, 'x', {}, { format: 'edifact' }, { format: 'edifact', segments: null }, { format: 'x12', segments: [null, 5, {}] },
    { format: 'hl7', text: 'x', segments: [{ id: 5, raw: 7, elements: 'x', offset: 'a', end: NaN }] },
    Object.assign({}, m, { segments: [{ id: 'UNB' }, { id: 'UNZ', elements: [null] }] }),
    Object.assign({}, m, { delimiters: null }),
  ];
  for (const d of damaged) {
    assert.ok(Array.isArray(validate(d)));
  }
});

test('validate: every issue range stays inside the text for damaged real files', () => {
  for (const name of fixtureNames()) {
    const text = fixture(name);
    for (const cut of [0, 1, 7, text.length >> 1, text.length - 1, text.length]) {
      const m = parse(text.slice(0, cut));
      for (const issue of validate(m, { includeParseIssues: true })) {
        assert.ok(issue.offset >= 0 && issue.end >= issue.offset && issue.end <= m.text.length, name + ' ' + cut);
      }
    }
  }
});
