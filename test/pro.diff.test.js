'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/core/parse.js');
const { compare, toText, toHtml, escapeHtml } = require('../src/pro/diff.js');
const { EDIFACT_ORDER, HL7_ADT, buildMessage } = require('./fixtures/pro/samples.js');

const A = parse(EDIFACT_ORDER);

/** Parses the sample after replacing text in it. */
function variant(from, to) {
  assert.ok(EDIFACT_ORDER.includes(from), 'sample does not contain ' + from);
  return parse(EDIFACT_ORDER.split(from).join(to));
}

test('diff: the same text compared with itself is identical', () => {
  const r = compare(A, parse(EDIFACT_ORDER));
  assert.equal(r.identical, true);
  assert.deepEqual(r.summary, { added: 0, removed: 0, changed: 0, unchanged: 13 });
  assert.equal(r.segments.length, 13);
  assert.ok(r.segments.every((e) => e.status === 'unchanged'));
});

test('diff: two empty messages are identical', () => {
  const r = compare(parse(''), parse(''));
  assert.equal(r.identical, true);
  assert.deepEqual(r.summary, { added: 0, removed: 0, changed: 0, unchanged: 0 });
});

test('diff: one changed value is reported with its path and both values', () => {
  const r = compare(A, variant('PO-100', 'PO-200'));
  assert.equal(r.identical, false);
  assert.deepEqual(r.summary, { added: 0, removed: 0, changed: 1, unchanged: 12 });
  const entry = r.segments.find((e) => e.status === 'changed');
  assert.equal(entry.id, 'BGM');
  assert.deepEqual(entry.differences, [
    { path: 'BGM[1]-2.1', pathB: 'BGM[1]-2.1', kind: 'changed', a: 'PO-100', b: 'PO-200' },
  ]);
});

test('diff: an inserted segment is reported as added and nothing else changes', () => {
  const b = variant("BGM+220+PO-100+9'", "BGM+220+PO-100+9'FTX+AAI+++Note text'");
  const r = compare(A, b);
  assert.deepEqual(r.summary, { added: 1, removed: 0, changed: 0, unchanged: 13 });
  const added = r.segments.find((e) => e.status === 'added');
  assert.equal(added.id, 'FTX');
  assert.equal(added.a, null);
  assert.equal(added.b.path, 'FTX[1]');
});

test('diff: a deleted segment is reported as removed', () => {
  const r = compare(A, variant("DTM+137:20240101:102'", ''));
  assert.deepEqual(r.summary, { added: 0, removed: 1, changed: 0, unchanged: 12 });
  const removed = r.segments.find((e) => e.status === 'removed');
  assert.equal(removed.id, 'DTM');
  assert.equal(removed.b, null);
  assert.equal(removed.a.raw, 'DTM+137:20240101:102');
});

test('diff: repeated ids pair up so the right occurrence is removed', () => {
  const r = compare(A, variant("NAD+BY+BUYER01::9'", ''));
  assert.deepEqual(r.summary, { added: 0, removed: 1, changed: 0, unchanged: 12 });
  const removed = r.segments.find((e) => e.status === 'removed');
  assert.match(removed.a.raw, /BUYER01/);
  const supplier = r.segments.find((e) => e.a && /SELLER01/.test(e.a.raw));
  assert.equal(supplier.status, 'unchanged');
  assert.equal(supplier.a.occurrence, 2);
  assert.equal(supplier.b.occurrence, 1);
});

test('diff: a new repeated group in the middle is added without disturbing the others', () => {
  const b = variant("QTY+21:10'LIN+2", "QTY+21:10'LIN+3++ITEM-C:EN'QTY+21:1'LIN+2");
  const r = compare(A, b);
  assert.deepEqual(r.summary, { added: 2, removed: 0, changed: 0, unchanged: 13 });
  const addedRaw = r.segments.filter((e) => e.status === 'added').map((e) => e.b.raw);
  assert.deepEqual(addedRaw, ['LIN+3++ITEM-C:EN', 'QTY+21:1']);
});

test('diff: a moved segment shows as one removal and one addition marked moved', () => {
  const b = variant("BGM+220+PO-100+9'DTM+137:20240101:102'", "DTM+137:20240101:102'BGM+220+PO-100+9'");
  const r = compare(A, b);
  assert.equal(r.summary.added, 1);
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.changed, 0);
  const moved = r.segments.filter((e) => e.moved);
  assert.equal(moved.length, 2);
  assert.deepEqual(moved.map((e) => e.status).sort(), ['added', 'removed']);
  assert.equal(moved[0].id, moved[1].id);
});

test('diff: a difference in a repeated segment uses that occurrence in the path', () => {
  const r = compare(A, variant('SELLER01', 'SELLER02'));
  const entry = r.segments.find((e) => e.status === 'changed');
  assert.equal(entry.differences[0].path, 'NAD[2]-2.1');
});

test('diff: differences come in file order', () => {
  const c = parse(EDIFACT_ORDER.replace('PO-100', 'PO-300').replace('SELLER01', 'SELLER09'));
  const r = compare(A, c);
  const changed = r.segments.filter((e) => e.status === 'changed').map((e) => e.id);
  assert.deepEqual(changed, ['BGM', 'NAD']);
});

test('diff: a component present on one side only is added or removed', () => {
  const shorter = variant('BUYER01::9', 'BUYER01');
  const forward = compare(A, shorter).segments.find((e) => e.status === 'changed');
  assert.deepEqual(forward.differences, [
    { path: 'NAD[1]-2.3', pathB: 'NAD[1]-2.3', kind: 'removed', a: '9', b: null },
  ]);
  const backward = compare(shorter, A).segments.find((e) => e.status === 'changed');
  assert.equal(backward.differences[0].kind, 'added');
  assert.equal(backward.differences[0].a, null);
  assert.equal(backward.differences[0].b, '9');
});

test('diff: a trailing empty element does not count as a difference', () => {
  const r = compare(parse("UNH+1+X'QTY+21:10+'"), parse("UNH+1+X'QTY+21:10'"));
  assert.equal(r.identical, true);
});

test('diff: HL7 subcomponent differences use a three-part path', () => {
  const a = parse(HL7_ADT);
  const b = parse(HL7_ADT.replace('Jane&Q', 'Jane&R'));
  const entry = compare(a, b).segments.find((e) => e.status === 'changed');
  assert.deepEqual(entry.differences.map((d) => [d.path, d.a, d.b]), [['PID[1]-5.2.2', 'Q', 'R']]);
});

test('diff: HL7 field repetitions are compared one by one', () => {
  const a = parse(HL7_ADT);
  const b = parse(HL7_ADT.replace('1002^^^ALT', '1003^^^ALT'));
  const entry = compare(a, b).segments.find((e) => e.status === 'changed');
  assert.equal(entry.differences.length, 1);
  assert.equal(entry.differences[0].path, 'PID[1]-3(2).1');
});

test('diff: ignorePaths with an exact path hides that difference', () => {
  const r = compare(A, variant('PO-100', 'PO-200'), { ignorePaths: ['BGM[1]-2.1'] });
  assert.equal(r.identical, true);
  assert.equal(r.summary.unchanged, 13);
});

test('diff: ignorePaths without a wildcard still shows other differences', () => {
  const r = compare(A, variant('PO-100', 'PO-200'), { ignorePaths: ['BGM[2]-2.1', 'BGM[1]-3'] });
  assert.equal(r.summary.changed, 1);
});

test('diff: ignorePaths wildcard in the occurrence', () => {
  const b = variant('REF001', 'REF999');
  assert.equal(compare(A, b).summary.changed, 2);
  const r = compare(A, b, { ignorePaths: ['UNB[*]-5.1', 'UNZ[*]-2.1'] });
  assert.equal(r.identical, true);
});

test('diff: ignorePaths wildcard over a whole element number', () => {
  const b = variant('20240101:102', '20240215:102');
  assert.equal(compare(A, b).summary.changed, 1);
  assert.equal(compare(A, b, { ignorePaths: ['DTM[*]-1.2'] }).identical, true);
  assert.equal(compare(A, b, { ignorePaths: ['*-1.2'] }).identical, true);
  assert.equal(compare(A, b, { ignorePaths: ['DTM*'] }).identical, true);
});

test('diff: an element-level pattern covers its components', () => {
  const r = compare(A, variant('PO-100', 'PO-200'), { ignorePaths: ['BGM[1]-2'] });
  assert.equal(r.identical, true);
});

test('diff: a segment-level pattern covers everything below it', () => {
  const r = compare(A, variant('PO-100', 'PO-200'), { ignorePaths: ['BGM[1]'] });
  assert.equal(r.identical, true);
});

test('diff: patterns without an occurrence match every occurrence', () => {
  const r = compare(A, variant('PO-100', 'PO-200'), { ignorePaths: ['BGM-2.1'] });
  assert.equal(r.identical, true);
});

test('diff: patterns are not case sensitive and tolerate special characters', () => {
  const b = variant('PO-100', 'PO-200');
  assert.equal(compare(A, b, { ignorePaths: ['bgm[1]-2.1'] }).identical, true);
  assert.doesNotThrow(() => compare(A, b, { ignorePaths: ['[(', '\\', '+?', ''] }));
  assert.equal(compare(A, b, { ignorePaths: ['[('] }).summary.changed, 1);
});

test('diff: an explicit first repetition in a pattern matches too', () => {
  const b = variant('PO-100', 'PO-200');
  assert.equal(compare(A, b, { ignorePaths: ['BGM[1]-2(1).1'] }).identical, true);
});

test('diff: ignoreSegments leaves whole segments out', () => {
  const b = variant('REF001', 'REF999');
  const r = compare(A, b, { ignoreSegments: ['UNB', 'UNZ'] });
  assert.equal(r.identical, true);
  assert.equal(r.segments.length, 11);
  assert.equal(compare(A, b, { ignoreSegments: ['unb'] }).summary.changed, 1);
});

test('diff: ignoring a repeated segment id leaves out every occurrence of it', () => {
  const r = compare(A, variant('SELLER01', 'SELLER02'), { ignoreSegments: ['NAD'] });
  assert.equal(r.identical, true);
  assert.equal(r.segments.length, 11);
});

test('diff: ignoreCase makes values equal that differ only in letter case', () => {
  const b = variant('PO-100', 'po-100');
  assert.equal(compare(A, b).summary.changed, 1);
  assert.equal(compare(A, b, { ignoreCase: true }).identical, true);
});

test('diff: trimValues makes values equal that differ only in surrounding spaces', () => {
  const b = variant('PO-100', ' PO-100 ');
  assert.equal(compare(A, b).summary.changed, 1);
  assert.equal(compare(A, b, { trimValues: true }).identical, true);
});

test('diff: the original values are reported even when the comparison ignores case', () => {
  const b = variant('PO-100', 'po-101');
  const entry = compare(A, b, { ignoreCase: true }).segments.find((e) => e.status === 'changed');
  assert.equal(entry.differences[0].a, 'PO-100');
  assert.equal(entry.differences[0].b, 'po-101');
});

test('diff: inputs are not modified', () => {
  const b = variant('PO-100', 'PO-200');
  const copyA = structuredClone(A);
  const copyB = structuredClone(b);
  compare(A, b, { ignorePaths: ['BGM*'] });
  assert.deepEqual(A, copyA);
  assert.deepEqual(b, copyB);
});

test('diff: messages of different formats compare without error', () => {
  const r = compare(A, parse(HL7_ADT));
  assert.equal(r.identical, false);
  assert.equal(r.summary.added, 4);
  assert.equal(r.summary.removed, 13);
});

test('diff: missing or odd input does not throw', () => {
  assert.doesNotThrow(() => compare(null, undefined));
  assert.equal(compare(null, undefined).identical, true);
  assert.doesNotThrow(() => compare({ segments: [{ id: 'ABC' }] }, { segments: [{ id: 'ABC', elements: [] }] }));
});

test('diff: hand-built messages work too', () => {
  const a = buildMessage('hl7', [['ZZ1', ['x', ['a', 'b']]]]);
  const b = buildMessage('hl7', [['ZZ1', ['x', ['a', 'c']]]]);
  const r = compare(a, b);
  assert.equal(r.summary.changed, 1);
  assert.equal(r.segments[0].differences[0].path, 'ZZ1[1]-2.2');
});

test('diff: a long run of segments is aligned exactly', () => {
  const ids = ['AAA', 'BBB', 'CCC'];
  const make = (first, last, skip) => {
    const list = [['HDR', [first]]];
    for (let i = 0; i < 2000; i += 1) {
      if (i !== skip) {
        list.push([ids[i % 3], ['v' + i]]);
      }
    }
    list.push(['TRL', [last]]);
    return buildMessage('hl7', list);
  };
  const r = compare(make('one', 'end1', -1), make('two', 'end2', 1000));
  assert.notEqual(r.approximate, true);
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.added, 0);
  assert.equal(r.summary.changed, 2);
});

test('diff: very large inputs fall back to a quick alignment and say so', () => {
  const ids = ['AAA', 'BBB', 'CCC'];
  const make = (first, last, skip) => {
    const list = [['HDR', [first]]];
    for (let i = 0; i < 5000; i += 1) {
      if (i !== skip) {
        list.push([ids[i % 3], ['v' + i]]);
      }
    }
    list.push(['TRL', [last]]);
    return buildMessage('hl7', list);
  };
  const started = Date.now();
  const r = compare(make('one', 'end1', -1), make('two', 'end2', 2500));
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.approximate, true);
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.added, 0);
  assert.match(toText(r), /approximate/);
});

test('diff text: an identical result says so', () => {
  const text = toText(compare(A, A));
  assert.match(text, /Summary: 0 added, 0 removed, 0 changed, 13 unchanged/);
  assert.match(text, /The messages are identical\./);
});

test('diff text: a changed value is shown as old -> new with its path', () => {
  const text = toText(compare(A, variant('PO-100', 'PO-200')), { labelA: 'old.edi', labelB: 'new.edi' });
  assert.match(text, /Compared old\.edi with new\.edi/);
  assert.match(text, /~ BGM\[1\] \(old\.edi line 1, new\.edi line 1\)/);
  assert.match(text, /BGM\[1\]-2\.1: "PO-100" -> "PO-200"/);
});

test('diff text: added and removed segments are marked and show their content', () => {
  const added = toText(compare(A, variant("BGM+220+PO-100+9'", "BGM+220+PO-100+9'FTX+AAI+++Note'")));
  assert.match(added, /^\+ FTX\[1\]/m);
  assert.match(added, /FTX\+AAI\+\+\+Note/);
  const removed = toText(compare(A, variant("DTM+137:20240101:102'", '')));
  assert.match(removed, /^- DTM\[1\]/m);
});

test('diff text: moved segments are labelled', () => {
  const b = variant("BGM+220+PO-100+9'DTM+137:20240101:102'", "DTM+137:20240101:102'BGM+220+PO-100+9'");
  assert.match(toText(compare(A, b)), /\[moved\]/);
});

test('diff text: line numbers start at 1 and follow the file', () => {
  const pretty = EDIFACT_ORDER.replace(/'/g, "'\n");
  const a = parse(pretty);
  const b = parse(pretty.replace('PO-100', 'PO-200'));
  assert.match(toText(compare(a, b)), /~ BGM\[1\] \(A line 4, B line 4\)/);
});

test('diff text: unchanged segments are listed only on request', () => {
  const result = compare(A, A);
  assert.ok(!/^= /m.test(toText(result)));
  assert.match(toText(result, { showUnchanged: true }), /^= UNB\[1\]/m);
});

test('diff text: a missing value is shown as (none)', () => {
  const text = toText(compare(variant('BUYER01::9', 'BUYER01'), A));
  assert.match(text, /NAD\[1\]-2\.3: \(none\) -> "9"/);
});

test('diff html: output is a complete page without scripts', () => {
  const html = toHtml(compare(A, variant('PO-100', 'PO-200')));
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>$/);
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /1 changed/);
  assert.match(html, /BGM\[1\]-2\.1/);
});

test('diff html: values taken from the messages are escaped', () => {
  const a = buildMessage('hl7', [['NTE', ['<img src=x onerror=alert(1)>', 'a & b "q" \'s\'']]]);
  const b = buildMessage('hl7', [['NTE', ['</td><script>alert(2)</script>', 'a & b']]]);
  const html = toHtml(compare(a, b));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/onerror=alert\(1\)>/.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;\/td&gt;&lt;script&gt;/);
  assert.match(html, /a &amp; b &quot;q&quot; &#39;s&#39;/);
});

test('diff html: labels and title are escaped', () => {
  const html = toHtml(compare(A, A), {
    title: '<b>Report</b>',
    labelA: '"><svg onload=alert(1)>',
    labelB: "x' onmouseover='y",
  });
  assert.ok(!/<svg/i.test(html));
  assert.ok(!/<b>Report/.test(html));
  assert.match(html, /<title>&lt;b&gt;Report&lt;\/b&gt;<\/title>/);
  assert.match(html, /&quot;&gt;&lt;svg onload=alert\(1\)&gt;/);
});

test('diff html: added and removed rows carry their status class', () => {
  const html = toHtml(compare(A, variant("DTM+137:20240101:102'", '')));
  assert.match(html, /<tr class="removed">/);
  assert.ok(!/<tr class="added">/.test(html));
});

test('diff html: unchanged rows can be hidden', () => {
  const result = compare(A, variant('PO-100', 'PO-200'));
  assert.match(toHtml(result), /<tr class="unchanged">/);
  assert.ok(!/<tr class="unchanged">/.test(toHtml(result, { showUnchanged: false })));
});

test('diff html: escapeHtml covers all five characters and odd input', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('diff html: a very large comparison hides unchanged rows and caps the table', () => {
  const result = compare(A, variant('PO-100', 'PO-200'));
  const html = toHtml(result, { maxRows: 5 });
  assert.match(html, /unchanged segments are not listed/);
  assert.ok(!/<tr class="unchanged">/.test(html));
  assert.match(html, /<tr class="changed">/);
  const many = compare(A, parse(EDIFACT_ORDER.split("'").map((s, i) => (i > 1 && s ? s + 'X' : s)).join("'")));
  const capped = toHtml(many, { maxRows: 3 });
  assert.match(capped, /The first 3 rows are shown; \d+ more are left out/);
  assert.equal((capped.match(/<tr class="(added|removed|changed|unchanged)">/g) || []).length, 3);
});

test('diff html: a normal comparison shows no size notes', () => {
  const html = toHtml(compare(A, variant('PO-100', 'PO-200')));
  assert.ok(!/are not listed|rows are shown/.test(html));
});
