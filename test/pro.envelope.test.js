'use strict';
// Envelope tools: split, merge, renumber and acknowledge. Unit tests, the whole corpus (split then
// merge keeps every message; every acknowledgement validates and quotes the right control numbers)
// and adversarial and fuzz tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const env = require('../src/pro/envelope');
const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const { SAMPLES } = require('../src/samples');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const FORMATS = ['edifact', 'x12', 'hl7'];
const ALL = FORMATS.reduce((acc, f) => acc.concat(fs.readdirSync(path.join(CORPUS, f)).sort().map((name) => ({ format: f, name, text: fs.readFileSync(path.join(CORPUS, f, name), 'utf8') }))), []);
const corpus = (rel) => fs.readFileSync(path.join(CORPUS, rel), 'utf8');
const NOW = new Date(2024, 2, 11, 10, 15, 30);

const issues = (text) => validate(parse(text), { includeParseIssues: true }).map((i) => i.code + ': ' + i.message);
const HEAD = { edifact: 'UNH', x12: 'ST', hl7: 'MSH' };
const TAIL = { edifact: 'UNT', x12: 'SE', hl7: '' };
const REF = { edifact: [1, 2], x12: [2, 2], hl7: [10, 0] };

// The messages of a text with their control references blanked: what split and merge must keep.
function bodies(text, blankHl7) {
  const m = parse(text);
  const out = [];
  let cur = null;
  for (const s of m.segments) {
    if (s.id === HEAD[m.format]) { cur = []; out.push(cur); }
    else if (cur && m.format === 'hl7' && ['BHS', 'BTS', 'FHS', 'FTS'].includes(s.id)) cur = null;
    if (!cur) continue;
    const blank = s.id === HEAD[m.format] ? REF[m.format][0] : s.id === TAIL[m.format] ? REF[m.format][1] : 0;
    cur.push(s.id + '|' + s.elements.map((e) => (e.index === blank && (m.format !== 'hl7' || blankHl7) ? '#' : e.raw)).join('|'));
    if (s.id === TAIL[m.format]) cur = null;
  }
  return out.map((b) => b.join('\n'));
}
const ids = (text) => parse(text).segments.map((s) => s.id).join(' ');
const el = (text, id, n, occurrence) => parse(text).segments.filter((s) => s.id === id)[(occurrence || 1) - 1].elements[n - 1].raw;

test('envelope: split wraps each message in its own valid envelope with fresh numbers', () => {
  const three = corpus('x12/850-three-sets.x12');
  const r = env.split(three, { start: 500 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.parts.map((p) => [p.number, p.type, p.ref]), [[1, '850', '0001'], [2, '850', '0002'], [3, '850', '0003']]);
  r.parts.forEach((p, i) => {
    assert.deepEqual(issues(p.text), [], 'part ' + (i + 1));
    assert.equal(ids(p.text).replace(/ST .* SE/, 'ST..SE'), 'ISA GS ST..SE GE IEA');
    assert.equal(el(p.text, 'ISA', 13), String(500 + i).padStart(9, '0'));
    assert.equal(el(p.text, 'IEA', 2), String(500 + i).padStart(9, '0'));
    assert.equal(el(p.text, 'GS', 6), String(500 + i));
    assert.equal(el(p.text, 'GE', 2), String(500 + i));
    assert.equal(el(p.text, 'GE', 1), '1');
    assert.equal(el(p.text, 'IEA', 1), '1');
    assert.equal(el(p.text, 'ST', 2), '000' + (i + 1), 'the message keeps its own reference');
    assert.equal(p.text.split('\n')[0].length, 106);
    assert.ok(p.text.endsWith('~\n'), 'the line style of the source is kept');
    assert.deepEqual(bodies(p.text), [bodies(three)[i]]);
  });
  // EDIFACT with UNA, other delimiters and a functional group.
  const alt = corpus('edifact/orders-group-altdelim.edi');
  const g = env.split(alt, { start: 7 });
  assert.equal(g.parts.length, 2);
  assert.match(g.parts[0].text, /^UNA;,\.\\ ~\r?\nUNB,UNOC;3,5412345000176;14,5498765000134;14,240311;1015,IC00007~\r?\nUNG,ORDERS,[^~]*,G7,UN,D;96A~\r?\nUNH,1,/);
  assert.match(g.parts[1].text, /UNT,31,2~\r?\nUNE,1,G8~\r?\nUNZ,1,IC00008~\r?\n$/);
  for (const p of g.parts) assert.deepEqual(issues(p.text), []);
  // HL7: every message on its own, batch segments left out.
  const file = corpus('hl7/file-fhs-two-batches.hl7');
  const h = env.split(file);
  assert.deepEqual(h.parts.map((p) => p.type), ['ORU^R01', 'ORM^O01', 'SIU^S12', 'MDM^T02', 'DFT^P03']);
  for (const p of h.parts) {
    assert.deepEqual(issues(p.text), []);
    assert.ok(p.text.startsWith('MSH|') && !/\n(BHS|BTS|FHS|FTS)\|/.test(p.text));
  }
  assert.deepEqual(h.parts.map((p) => bodies(p.text)[0]), bodies(file));
});

test('envelope: merge builds one valid interchange and renumbers the messages', () => {
  const a = SAMPLES.x12.text;
  const b = SAMPLES.x12.text.replace('PO-24-00318', 'PO-24-00319').replace('000000417', '000000418');
  const r = env.merge([a, b, a], { start: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.messages, 3);
  assert.deepEqual(issues(r.text), []);
  assert.equal(ids(r.text).replace(/ST .*? SE(?= GE)/g, 'ST..SE'), 'ISA GS ST..SE GE GS ST..SE GE GS ST..SE GE IEA');
  assert.equal(el(r.text, 'ISA', 13), '000000030');
  assert.equal(el(r.text, 'IEA', 1), '3');
  assert.deepEqual([1, 2, 3].map((n) => el(r.text, 'GS', 6, n)), ['030', '031', '032']);
  assert.deepEqual(bodies(r.text), bodies(a).concat(bodies(b), bodies(a)));
  // EDIFACT without groups: one UNB, messages 1..n, UNZ with the count.
  const e = env.merge([SAMPLES.edifact.text, SAMPLES.edifact.text.replace('PO-24-00318', 'PO-24-00400')], { start: 5 });
  assert.deepEqual(issues(e.text), []);
  assert.match(e.text, /^UNA:\+\.\? '\nUNB\+UNOC:3\+5412345000176:14\+5498765000134:14\+240305:1015\+ORD000000005'\nUNH\+1\+ORDERS/);
  assert.match(e.text, /UNT\+17\+1'\nUNH\+2\+ORDERS[\s\S]*UNT\+17\+2'\nUNZ\+2\+ORD000000005'\n$/);
  // HL7: a batch around the messages.
  const h = env.merge([SAMPLES.hl7.text, SAMPLES.hl7.text.replace('RS240305-0042', 'RS240305-0043')]);
  assert.deepEqual(issues(h.text), []);
  assert.match(h.text, /^BHS\|\^~\\&\|ADMITSYS\|RIVERSIDE\|LABPORTAL\|RIVERSIDE\|20240305101500\rMSH\|/);
  assert.match(h.text, /\rBTS\|2\r$/);
  assert.equal(h.messages, 2);
});

test('envelope: merge refuses what cannot be one interchange and says why', () => {
  const cases = [
    [[SAMPLES.x12.text, SAMPLES.edifact.text], 'ENV-MIXED-FORMATS', /File 2 is in another format/],
    [[SAMPLES.edifact.text, corpus('edifact/orders-group-altdelim.edi')], 'ENV-DELIMITER-MISMATCH', /File 2 uses other delimiters/],
    [[SAMPLES.edifact.text, corpus('edifact/orders-group-altdelim.edi').replace(/,/g, '+').replace(/;/g, ':').replace(/~/g, "'").replace("UNA:+.\\ '", "UNA:+.? '")], 'ENV-MIXED-GROUPS', /File 2 mixes messages inside functional groups/],
    [[SAMPLES.x12.text, 'hello'], 'ENV-NOT-EDI', /File 2: /],
    [[SAMPLES.x12.text, SAMPLES.x12.text.replace('SE*13*0001~\n', '')], 'ENV-BAD-ENVELOPE', /File 2: The envelope of the file is damaged/],
    [[SAMPLES.x12.text, "ISA*00*          *00*          *ZZ*A              *ZZ*B              *240305*1015*U*00401*000000001*0*P*>~IEA*0*000000001~"], 'ENV-NO-MESSAGES', /File 2: No message/],
    [[], 'ENV-NO-MESSAGES', /No files were given/],
    [[SAMPLES.x12.text.replace(/~\n/g, '|').replace(/\*/g, '^')], null, null],
  ];
  for (const [texts, code, pattern] of cases) {
    const r = env.merge(texts);
    if (code === null) { assert.equal(r.ok, true); assert.deepEqual(issues(r.text), []); continue; }
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code);
    assert.match(r.message, pattern);
  }
  assert.equal(env.merge([SAMPLES.x12.text], { start: 0 }).code, 'ENV-BAD-START');
  assert.equal(env.merge([SAMPLES.x12.text], { start: 1e12 }).code, 'ENV-BAD-START');
  assert.equal(env.merge('not a list').code, 'ENV-NO-MESSAGES');
});

test('envelope: renumber changes headers and trailers together and nothing else', () => {
  const two = corpus('x12/850-860-two-groups.x12');
  const r = env.renumber(two, { start: 41 });
  assert.equal(r.ok, true);
  assert.deepEqual(issues(r.text), []);
  assert.deepEqual(['ISA-13', 'IEA-2', 'GS-6', 'GE-2', 'ST-2', 'SE-2'].map((k) => el(r.text, k.split('-')[0], Number(k.split('-')[1]))), ['000000041', '000000041', '041', '041', '0041', '0041']);
  assert.deepEqual([el(r.text, 'GS', 6, 2), el(r.text, 'GE', 2, 2), el(r.text, 'ST', 2, 2), el(r.text, 'SE', 2, 2)], ['042', '042', '0041', '0041'], 'groups count on, messages restart in each group');
  assert.equal(r.changed, 10);
  assert.equal(r.text.length, two.length);
  assert.deepEqual(bodies(r.text), bodies(two));
  // Counts are not touched.
  assert.deepEqual([el(r.text, 'SE', 1), el(r.text, 'GE', 1), el(r.text, 'IEA', 1)], [el(two, 'SE', 1), el(two, 'GE', 1), el(two, 'IEA', 1)]);
  // EDIFACT keeps the text in front of the digits; HL7 control ids count through the file.
  const e = env.renumber(corpus('edifact/two-interchanges-orders-invoic.edi'), { start: 9 });
  assert.deepEqual(issues(e.text), []);
  assert.deepEqual([el(e.text, 'UNB', 5), el(e.text, 'UNZ', 2), el(e.text, 'UNB', 5, 2), el(e.text, 'UNZ', 2, 2), el(e.text, 'UNH', 1), el(e.text, 'UNH', 1, 2)], ['IC00009', 'IC00009', 'IC00010', 'IC00010', '9', '9']);
  const h = env.renumber(corpus('hl7/log-four-messages-crlf.hl7'), { start: 1 });
  assert.deepEqual([1, 2, 3, 4].map((n) => el(h.text, 'MSH', 10, n)), ['RS2403-0001', 'RS2403-0002', 'RS2403-0003', 'RS2403-0004']);
  assert.deepEqual(issues(h.text), []);
  // Renumbering to the numbers a file already has changes nothing.
  const same = env.renumber(SAMPLES.x12.text.replace(/000000417/g, '000000001').replace('*417*X', '*1*X').replace('GE*1*417', 'GE*1*1'), { start: 1 });
  assert.equal(same.changed, 0);
});

test('envelope: renumber keeps or updates the references of acknowledgements, as asked', () => {
  // An order and its 997 in one file: AK1 quotes group 417, AK2 quotes ST 0001.
  const file = corpus('x12/810-997-two-interchanges.x12');
  const before = parse(file);
  const ak1 = before.segments.find((s) => s.id === 'AK1').elements[1].raw;
  const keep = env.renumber(file, { start: 700 });
  assert.equal(el(keep.text, 'AK1', 2), ak1, 'references stay by default');
  assert.deepEqual(issues(keep.text), []);
  const hl7 = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|M-0042|P|2.5\rPID|1||1\rMSH|^~\\&|C|D|A|B|20240115||ACK^A01|K-0007|P|2.5\rMSA|AA|M-0042\rMSH|^~\\&|C|D|A|B|20240115||ACK^A01|K-0008|P|2.5\rMSA|AA|ELSEWHERE-9\r';
  const kept = env.renumber(hl7, { start: 100 });
  assert.match(kept.text, /ADT\^A01\|M-0100\|[\s\S]*ACK\^A01\|K-0101\|P\|2\.5\rMSA\|AA\|M-0042\r[\s\S]*MSA\|AA\|ELSEWHERE-9\r$/);
  const updated = env.renumber(hl7, { start: 100, keepReferences: false });
  assert.match(updated.text, /ADT\^A01\|M-0100\|[\s\S]*MSA\|AA\|M-0100\r[\s\S]*MSA\|AA\|ELSEWHERE-9\r$/, 'a reference to a message of this file follows; a reference to another file stays');
  const x = 'ISA*00*          *00*          *ZZ*A              *ZZ*B              *240305*1015*U*00401*000000417*0*P*>~GS*PO*A*B*20240305*1015*417*X*004010~ST*850*0007~BEG*00*SA*P**20240305~SE*3*0007~GE*1*417~' +
    'GS*FA*B*A*20240305*1015*900*X*004010~ST*997*0001~AK1*PO*417~AK2*850*0007~AK5*A~AK9*A*1*1*1~SE*6*0001~GE*1*900~IEA*2*000000417~';
  const ux = env.renumber(x, { start: 50, keepReferences: false });
  assert.deepEqual(issues(ux.text), []);
  assert.match(ux.text, /GS\*PO\*A\*B\*20240305\*1015\*050\*X[\s\S]*ST\*850\*0050~[\s\S]*AK1\*PO\*050~AK2\*850\*0050~/);
  assert.match(env.renumber(x, { start: 50 }).text, /AK1\*PO\*417~AK2\*850\*0007~/);
});

test('envelope: renumber checks the start value and the nine digits of ISA13', () => {
  for (const bad of [0, -1, 1.5, 'x', 1e10, NaN, Infinity, '0', '12a']) assert.equal(env.renumber(SAMPLES.x12.text, { start: bad }).code, 'ENV-BAD-START', String(bad));
  assert.equal(env.renumber(SAMPLES.x12.text, { start: 999999999 }).ok, true);
  const two = SAMPLES.x12.text + SAMPLES.x12.text;
  assert.equal(env.renumber(two, { start: 999999999 }).code, 'ENV-NUMBER-TOO-LARGE');
  assert.equal(env.renumber('hello').code, 'ENV-NOT-EDI');
  assert.equal(env.renumber("FTX+AAI+++x'").code, 'ENV-NOT-EDI');
  assert.equal(env.renumber("UNA:+.? 'BGM+220+X'").code, 'ENV-NO-MESSAGES');
  assert.equal(env.numberLike('ORD240305001', 7), 'ORD000000007');
  assert.equal(env.numberLike('0001', 12345), '12345');
  assert.equal(env.numberLike('REF', 3), '3');
  assert.equal(env.numberLike('', 3, 9), '000000003');
  assert.equal(env.numberLike('', 1e9, 9), null);
});

test('envelope: acknowledgements are marked as tests, swap the parties and quote the control numbers', () => {
  const x = env.acknowledge(SAMPLES.x12.text, { now: NOW, start: 77 });
  assert.equal(x.text, [
    'ISA*00*          *00*          *ZZ*HARBORSUPPLY   *ZZ*NORTHBAYRETAIL *240311*1015*U*00401*000000077*0*T*>~',
    'GS*FA*HARBORSUPPLY*NORTHBAYRETAIL*20240311*1015*77*X*004010~', 'ST*997*0001~', 'AK1*PO*417~', 'AK2*850*0001~', 'AK5*A~', 'AK9*A*1*1*1~', 'SE*6*0001~', 'GE*1*77~', 'IEA*1*000000077~', ''].join('\n'));
  assert.deepEqual([x.kind, x.acknowledged, x.accepted, x.rejected], ['997', 1, 1, 0]);
  assert.deepEqual(issues(x.text), []);
  const x999 = env.acknowledge(SAMPLES.x12.text, { now: NOW, x12Type: '999' });
  assert.match(x999.text, /GS\*FA\*HARBORSUPPLY\*NORTHBAYRETAIL\*20240311\*1015\*1\*X\*005010X231A1~\nST\*999\*0001\*005010X231A1~\nAK1\*PO\*417\*004010~\nAK2\*850\*0001~\nIK5\*A~\nAK9\*A\*1\*1\*1~\nSE\*6\*0001~/);
  assert.equal(x999.kind, '999');
  assert.deepEqual(issues(x999.text), []);
  const e = env.acknowledge(SAMPLES.edifact.text, { now: NOW, start: 3 });
  assert.equal(e.text, ["UNA:+.? '", "UNB+UNOC:3+5498765000134:14+5412345000176:14+240311:1015+ORD000000003++++++1'", "UNH+1+CONTRL:D:3:UN'",
    "UCI+ORD240305001+5412345000176:14+5498765000134:14+7'", "UCM+1+ORDERS:D:96A:UN:EAN008+7'", "UNT+4+1'", "UNZ+1+ORD000000003'", ''].join('\n'));
  assert.deepEqual(issues(e.text), []);
  const h = env.acknowledge(SAMPLES.hl7.text, { now: NOW, start: 5 });
  assert.equal(h.text, 'MSH|^~\\&|LABPORTAL|RIVERSIDE|ADMITSYS|RIVERSIDE|20240311101530||ACK^A01^ACK|ACK000000005|T|2.5.1\rMSA|AA|RS240305-0042|TEST ACKNOWLEDGEMENT\r');
  assert.deepEqual(issues(h.text), []);
});

test('envelope: a message with a wrong count or reference is rejected in the acknowledgement', () => {
  const broken = corpus('x12/850-three-sets.x12').replace('SE*22*0002~', 'SE*21*0002~').replace('SE*22*0003~', 'SE*22*0009~');
  const x = env.acknowledge(broken, { now: NOW });
  assert.deepEqual([x.acknowledged, x.accepted, x.rejected], [3, 1, 2]);
  assert.match(x.text, /AK2\*850\*0001~\nAK5\*A~\nAK2\*850\*0002~\nAK5\*R\*4~\nAK2\*850\*0003~\nAK5\*R\*3~\nAK9\*P\*3\*3\*1~\nSE\*10\*0001~/);
  assert.deepEqual(issues(x.text), [], 'the acknowledgement itself is valid');
  const e = env.acknowledge(SAMPLES.edifact.text.replace('UNT+17+1', 'UNT+16+1'), { now: NOW });
  assert.match(e.text, /UCM\+1\+ORDERS:D:96A:UN:EAN008\+4'/);
  assert.equal(e.rejected, 1);
  const open = env.acknowledge(SAMPLES.edifact.text.replace("UNZ+1+ORD240305001'\n", ''), { now: NOW });
  assert.match(open.text, /UCI\+ORD240305001\+5412345000176:14\+5498765000134:14\+4'\nUNT\+3\+1'/, 'an interchange that is not closed is rejected as a whole');
  assert.deepEqual(issues(open.text), []);
  const h = env.acknowledge('MSH|^~\\&|A|B|C|D|20240115||ADT^A01||P|2.5\rPID|1\r', { now: NOW });
  assert.match(h.text, /MSA\|AE\|\|TEST ACKNOWLEDGEMENT/);
  assert.equal(h.rejected, 1);
});

test('envelope: acknowledgements are not acknowledged again', () => {
  for (const rel of ['x12/997-std-lf.x12', 'edifact/contrl-una-lf.edi', 'hl7/ack-cr.hl7']) {
    const r = env.acknowledge(corpus(rel), { now: NOW });
    assert.equal(r.code, 'ENV-NOTHING-TO-ACK', rel);
    assert.match(r.message, /not acknowledged again/);
  }
  // A file with an invoice and a 997: only the invoice is acknowledged.
  const mixed = env.acknowledge(corpus('x12/810-997-two-interchanges.x12'), { now: NOW });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.acknowledged, 1);
  assert.match(mixed.text, /AK2\*810\*/);
  assert.ok(!/AK2\*997/.test(mixed.text));
  const log = env.acknowledge(corpus('hl7/log-four-messages-crlf.hl7'), { now: NOW });
  assert.equal(log.acknowledged, 2, 'the two ACK messages in the log are skipped');
  assert.equal(env.acknowledge('hello').code, 'ENV-NOT-EDI');
  assert.equal(env.acknowledge("UNA:+.? 'UNB+UNOC:3+A+B+240117:1200+R1'UNZ+0+R1'").code, 'ENV-NO-MESSAGES');
});

test('envelope corpus: split then merge keeps every message of all 126 files', () => {
  let parts = 0;
  let merged = 0;
  for (const f of ALL) {
    const sp = env.split(f.text, { start: 500 });
    assert.equal(sp.ok, true, f.name + ': ' + sp.message);
    const original = bodies(f.text);
    assert.equal(sp.parts.length, original.length, f.name);
    sp.parts.forEach((p, i) => {
      assert.deepEqual(issues(p.text), [], f.name + ' part ' + (i + 1) + ' does not validate');
      assert.deepEqual(bodies(p.text), [original[i]], f.name + ' part ' + (i + 1));
      assert.equal(parse(p.text).format, f.format);
    });
    parts += sp.parts.length;
    const mg = env.merge(sp.parts.map((p) => p.text), { start: 7 });
    if (f.name === '810-997-two-interchanges.x12') {
      assert.equal(mg.code, 'ENV-DELIMITER-MISMATCH', 'its two interchanges use different delimiters');
      continue;
    }
    assert.equal(mg.ok, true, f.name + ': ' + mg.message);
    assert.deepEqual(issues(mg.text), [], f.name + ' merged does not validate');
    assert.deepEqual(bodies(mg.text), original, f.name + ': split then merge changed a message');
    assert.equal(mg.messages, original.length);
    merged++;
    // Splitting the merged file again gives the same messages once more.
    assert.deepEqual(env.split(mg.text).parts.map((p) => bodies(p.text)[0]), original, f.name);
  }
  assert.equal(parts, 152);
  assert.equal(merged, 125);
});

test('envelope corpus: renumbering keeps every file valid and every body unchanged', () => {
  for (const f of ALL) {
    for (const keepReferences of [true, false]) {
      const r = env.renumber(f.text, { start: 100, keepReferences });
      assert.equal(r.ok, true, f.name);
      assert.deepEqual(issues(r.text), [], f.name + ' no longer validates');
      const plain = (text) => bodies(text, true).map((b) => b.replace(/^(AK1|AK2|UCI|UCF|UCM|MSA|TA1)\|.*$/gm, '$1'));
      assert.deepEqual(plain(r.text), plain(f.text), f.name);
      assert.equal(parse(r.text).segments.length, parse(f.text).segments.length);
      assert.equal(env.renumber(r.text, { start: 100, keepReferences }).text, r.text, f.name + ': renumbering twice gives the same text');
    }
  }
});

test('envelope corpus: every acknowledgement validates and refers to the right control numbers', () => {
  let made = 0;
  const skipped = [];
  for (const f of ALL) {
    for (const x12Type of f.format === 'x12' ? ['997', '999'] : ['997']) {
      const r = env.acknowledge(f.text, { now: NOW, start: 9, x12Type });
      if (!r.ok) {
        assert.equal(r.code, 'ENV-NOTHING-TO-ACK', f.name + ': ' + r.message);
        assert.match(f.name, /^(997|contrl|ack)-/, f.name);
        if (x12Type === '997') skipped.push(f.name);
        continue;
      }
      made++;
      assert.deepEqual(issues(r.text), [], f.name + ': the acknowledgement does not validate');
      assert.equal(r.rejected, 0, f.name + ': a valid message was rejected');
      const src = parse(f.text);
      const ack = parse(r.text);
      const vals = (m, id, n) => m.segments.filter((s) => s.id === id).map((s) => (s.elements[n - 1] ? s.elements[n - 1].raw.trim() : ''));
      if (f.format === 'x12') {
        const groups = src.segments.filter((s) => s.id === 'GS' && s.elements[0].raw !== 'FA');
        assert.deepEqual(vals(ack, 'AK1', 2), groups.map((s) => s.elements[5].raw), f.name + ' AK1');
        assert.deepEqual(vals(ack, 'AK1', 1), groups.map((s) => s.elements[0].raw), f.name);
        const sets = src.segments.filter((s) => s.id === 'ST' && s.elements[0].raw !== '997' && s.elements[0].raw !== '999');
        assert.deepEqual(vals(ack, 'AK2', 2), sets.map((s) => s.elements[1].raw), f.name + ' AK2');
        assert.deepEqual(vals(ack, 'AK2', 1), sets.map((s) => s.elements[0].raw), f.name);
        assert.ok(vals(ack, 'ISA', 15).every((v) => v === 'T'), 'marked as test');
        assert.ok(vals(ack, 'GS', 1).every((v) => v === 'FA'));
        assert.ok(vals(ack, 'ST', 1).every((v) => v === x12Type));
        const isa = src.segments.find((s) => s.id === 'ISA' );
        const ackIsa = ack.segments.find((s) => s.id === 'ISA');
        assert.equal(ackIsa.raw.length, 105);
        assert.equal(r.acknowledged, sets.length);
        void isa;
      } else if (f.format === 'edifact') {
        const unb = src.segments.filter((s) => s.id === 'UNB');
        assert.deepEqual(vals(ack, 'UCI', 1), unb.map((s) => s.elements[4].raw), f.name + ' UCI');
        assert.deepEqual(vals(ack, 'UCI', 2), unb.map((s) => s.elements[1].raw), f.name);
        assert.deepEqual(vals(ack, 'UNB', 2), unb.map((s) => s.elements[2].raw), f.name + ': sender and recipient are swapped');
        assert.deepEqual(vals(ack, 'UNB', 3), unb.map((s) => s.elements[1].raw), f.name);
        assert.deepEqual(vals(ack, 'UCM', 1), vals(src, 'UNH', 1), f.name + ' UCM');
        assert.deepEqual(vals(ack, 'UCM', 2), vals(src, 'UNH', 2), f.name);
        assert.deepEqual(vals(ack, 'UCF', 1), vals(src, 'UNG', 5), f.name + ' UCF');
        assert.ok(vals(ack, 'UNB', 11).every((v) => v === '1'), 'marked as test');
        assert.ok(vals(ack, 'UCM', 3).every((v) => v === '7'));
        assert.equal(ack.delimiters.element, src.delimiters.element);
        assert.equal(ack.segments.some((s) => s.id === 'UNA'), src.segments.some((s) => s.id === 'UNA'), f.name);
      } else {
        const msh = src.segments.filter((s) => s.id === 'MSH' && !/^ACK/.test(s.elements[8].raw));
        assert.deepEqual(vals(ack, 'MSA', 2), msh.map((s) => s.elements[9].raw), f.name + ' MSA');
        assert.ok(vals(ack, 'MSA', 1).every((v) => v === 'AA'));
        assert.ok(vals(ack, 'MSH', 11).every((v) => v === 'T'), 'marked as test');
        assert.deepEqual(vals(ack, 'MSH', 3), msh.map((s) => s.elements[4].raw), f.name + ': sending and receiving application are swapped');
        assert.deepEqual(vals(ack, 'MSH', 5), msh.map((s) => s.elements[2].raw), f.name);
        assert.deepEqual(vals(ack, 'MSH', 12), msh.map((s) => s.elements[11].raw), f.name);
        assert.ok(vals(ack, 'MSH', 9).every((v) => /^ACK/.test(v)));
        assert.equal(ack.delimiters.field, src.delimiters.field);
      }
      assert.equal(env.acknowledge(f.text, { now: NOW, start: 9, x12Type }).text, r.text, 'the same result for the same time');
    }
  }
  assert.equal(skipped.length, 11, skipped.join(','));
  assert.equal(made, 115 + 39);
});

test('envelope attack: damaged envelopes are refused by split and merge, never half done', () => {
  const x = SAMPLES.x12.text;
  const damaged = [x.replace('SE*13*0001~\n', ''), x.replace('GE*1*417~\n', ''), x.replace('IEA*1*000000417~\n', ''), x.replace('GS*PO', 'GX*PO'), x.replace(/^ISA[^\n]*\n/, ''),
    x + 'ST*850*0002~\n', x.replace('ST*850*0001~\n', ''), SAMPLES.edifact.text.replace("UNT+17+1'\n", ''), SAMPLES.edifact.text.replace("UNZ+1+ORD240305001'\n", ''),
    SAMPLES.edifact.text.replace(/^UNA[^\n]*\nUNB[^\n]*\n/, '')];
  for (const text of damaged) {
    const sp = env.split(text);
    assert.equal(sp.ok, false, text.slice(0, 40));
    assert.match(sp.code, /^ENV-(BAD-ENVELOPE|NO-MESSAGES|NOT-EDI)$/);
    assert.ok(!('parts' in sp));
    const mg = env.merge([x, text]);
    assert.equal(mg.ok, false);
  }
  for (const bad of ['', '   ', 'hello', null, undefined, 9, {}, 'ISA', 'UNB']) {
    for (const fn of [env.split, env.renumber, env.acknowledge]) {
      const r = fn(bad);
      assert.equal(r.ok, false, String(bad));
      assert.match(r.code, /^ENV-/);
    }
    assert.equal(env.merge([bad]).ok, false);
  }
  // A lone MSH is a (poor) message: it is split off as it is and rejected by the acknowledgement.
  assert.deepEqual(env.split('MSH').parts.map((p) => p.text), ['MSH\r']);
  assert.equal(env.acknowledge('MSH', { now: NOW }).code, 'ENV-BAD-ENVELOPE', 'no acknowledgement is written from a header that cannot be read');
  assert.equal(env.renumber('MSH').code, 'ENV-NO-MESSAGES');
  assert.equal(env.split(x, { start: 'x' }).code, 'ENV-BAD-START');
  assert.equal(env.split(corpus('x12/850-three-sets.x12'), { start: 999999998 }).code, 'ENV-NUMBER-TOO-LARGE');
  assert.equal(env.acknowledge(x, { start: 0 }).code, 'ENV-BAD-START');
  // Values with delimiters in release-escaped form survive every tool.
  const esc = corpus('edifact/orders-release-characters.edi');
  for (const text of [env.split(esc).parts[0].text, env.merge([esc, esc]).text, env.renumber(esc, { start: 5 }).text]) assert.deepEqual(issues(text), []);
  assert.deepEqual(bodies(env.merge([esc]).text), bodies(esc));
});

test('envelope fuzz: mutated files never crash any tool, and what a tool returns is consistent (seed 4242)', () => {
  const rand = kit.rng(4242);
  let cases = 0;
  let refused = 0;
  const started = Date.now();
  for (const f of ALL) {
    for (let k = 0; k < 4; k++) {
      let text = f.text;
      const at = Math.floor(rand() * text.length);
      const kind = Math.floor(rand() * 5);
      if (kind === 0) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 10));
      else if (kind === 1) text = text.slice(0, at);
      else if (kind === 2) text = text.slice(0, at) + "'~\r\n\u0000|+*" + text.slice(at);
      else if (kind === 3) text = text + text;
      else text = text.slice(0, at) + String.fromCharCode(33 + Math.floor(rand() * 90)) + text.slice(at + 1);
      cases++;
      const before = issues(text);
      const sp = env.split(text, { start: 3 });
      if (sp.ok) {
        // A file that split accepts has sound messages; the parts hold exactly them.
        assert.deepEqual(sp.parts.map((p) => bodies(p.text)[0]), bodies(text), f.name + ' kind ' + kind);
      } else {
        refused++;
        assert.match(sp.code, /^ENV-/);
      }
      const rn = env.renumber(text, { start: 3 });
      if (rn.ok) {
        assert.equal(parse(rn.text).segments.length, parse(text).segments.length, f.name);
        // Renumbering never adds a problem of another kind than control numbers and never loses a segment.
        const after = issues(rn.text).filter((i) => !/CONTROL|-REF|DUPLICATE/.test(i));
        const base = before.filter((i) => !/CONTROL|-REF|DUPLICATE/.test(i));
        assert.equal(after.length, base.length, f.name + ' kind ' + kind + '\n' + after.join('\n') + '\n--\n' + base.join('\n'));
      } else assert.match(rn.code, /^ENV-/);
      const ak = env.acknowledge(text, { now: NOW });
      if (ak.ok) {
        assert.equal(ak.acknowledged, ak.accepted + ak.rejected);
        assert.equal(parse(ak.text).format, parse(text).format);
      } else assert.match(ak.code, /^ENV-/);
      const mg = env.merge([text, f.text]);
      if (!mg.ok) assert.match(mg.code, /^ENV-/);
    }
  }
  assert.equal(cases, 504);
  assert.ok(refused > 50 && refused < cases, String(refused));
  assert.ok(Date.now() - started < 120000);
});

test('envelope: every problem code is documented in docs/envelope-tools.md', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'envelope-tools.md'), 'utf8');
  for (const code of Object.values(env.CODES)) assert.ok(doc.includes('`' + code + '`'), code + ' is not documented');
});
