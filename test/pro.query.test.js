'use strict';
// Query: the language, results checked against expectations worked out by hand from the corpus
// files, the whole corpus, CSV export and adversarial and fuzz tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const query = require('../src/pro/query');
const { parse } = require('../src/core/parse');
const { resolvePath } = require('../src/core/path');
const { SAMPLES } = require('../src/samples');
const kit = require('./helpers/attack-kit');

const CORPUS = path.join(__dirname, 'fixtures', 'corpus');
const FORMATS = ['edifact', 'x12', 'hl7'];
const ALL = FORMATS.reduce((acc, f) => acc.concat(fs.readdirSync(path.join(CORPUS, f)).sort().map((name) => ({ format: f, name, text: fs.readFileSync(path.join(CORPUS, f, name), 'utf8') }))), []);
const corpus = (rel) => fs.readFileSync(path.join(CORPUS, rel), 'utf8');

function run(text, q, options) {
  const c = query.compile(q, options);
  assert.equal(c.ok, true, q + ': ' + c.message);
  const r = query.scanText(text, c, options);
  assert.equal(r.ok, true);
  return r;
}
const units = (text, q, options) => run(text, q, options).matches.map((m) => m.unit);
const hits = (text, q) => run(text, q).matches.map((m) => m.hits.map((h) => h.path + '=' + h.value + '@' + (h.line + 1) + ':' + (h.column + 1)));
const E = SAMPLES.edifact.text;

test('query: comparisons, functions and combinations on the EDIFACT sample', () => {
  const yes = ['NAD[BY]-2.1 == "5412345000176"', 'NAD[BY]-2.1 == "5412*"', 'NAD[BY]-2.1 = "*176"', "BGM-2 == 'PO-24-00318'", 'BGM-1.1 == 220', 'BGM-1.1 != 221', 'BGM-1.1 <> "221"',
    'count(LIN) == 2', 'count(LIN) > 1', 'count(LIN) >= 2', 'count(LIN) < 3', 'count(LIN) <= 2', 'count(NAD[BY|SU]) == 2', 'count(QTY-1.2) == 2', 'exists(CUX)', 'exists(NAD[SU])',
    'exists(FTX-4)', 'NOT exists(CTA)', '!exists(CTA)', 'not exists(NAD[DP])', 'MOA[86]-1.2 > 400', 'MOA[86]-1.2 == 454.8', 'MOA[1.1=86]-1.2 >= 454.80', 'sum(QTY[21]-1.2) == 60',
    'sum(PRI-1.2) > 23.6 AND sum(PRI-1.2) < 23.7', 'count(LIN) > 1 AND exists(CUX)', 'count(LIN) > 5 OR exists(CUX)', 'exists(ZZZ) or exists(BGM) and exists(CUX)', '(exists(ZZZ) OR exists(BGM)) AND exists(CUX)',
    'NOT (exists(ZZZ) OR exists(YYY))', 'count(LIN) > 1 && !exists(CTA) || exists(ZZZ)', 'LIN#2-3.1 == "5410000100029"', 'NAD-2.1 == NAD[SU]-2.1', 'count(LIN) == count(QTY)',
    '2 == count(LIN)', '"5412345000176" == NAD[BY]-2.1', '400 < MOA[86]-1.2', 'DTM[137]-1.2 < DTM[2]-1.2', 'QTY[21]-1.2 >= 48', 'FTX-4 == "*gate 4*"', 'CUX-1.2 > "EUA"', 'NAD[BY]-2.1 != NAD[SU]-2.1',
    'count(ZZZ) == 0', 'UNH-2.1 == "ORDERS"', 'exists(UNT)'];
  const no = ['NAD[BY]-2.1 == "5498765000134"', 'NAD[BY]-2.1 == "5412"', 'BGM-1.1 == 221', 'count(LIN) > 2', 'count(LIN) == 0', 'exists(CTA)', 'exists(NAD[DP])', 'NOT exists(BGM)',
    'MOA[86]-1.2 > 500', 'sum(QTY[21]-1.2) == 61', 'sum(ZZZ-1) == 0', 'count(LIN) > 1 AND exists(CTA)', 'exists(ZZZ) OR exists(YYY)', 'LIN#3-3.1 == "5410000100029"', 'LIN#1-3.1 == "5410000100029"',
    'NAD[BY]-2.1 == NAD[SU]-2.1', 'ZZZ-1 == ZZZ-2', 'ZZZ-1 != "x"', 'FTX-4 == "*GATE 4*"', 'exists(UNB)', 'exists(UNZ)', 'NAD[2]-2.1 == "5498765000134"'];
  for (const q of yes) assert.deepEqual(units(E, q), [1], q);
  for (const q of no) assert.deepEqual(units(E, q), [], q);
  assert.deepEqual(units(E, 'FTX-4 == "*GATE 4*"', { ignoreCase: true }), [1]);
  assert.deepEqual(units(E, 'cux-1.2 == "eur"', { ignoreCase: true }), [], 'segment ids are never folded');
  assert.deepEqual(units(E, 'CUX-1.2 == "eur"', { ignoreCase: true }), [1]);
});

test('query: the matched values are reported with the hover path, line and column', () => {
  assert.deepEqual(hits(E, 'NAD[SU]-2.1 == "5498*"'), [['NAD[2]-2.1=5498765000134@9:8']]);
  assert.deepEqual(hits(E, 'QTY[21]-1.2 >= 12'), [['QTY[1]-1.2=48@12:8', 'QTY[2]-1.2=12@15:8']]);
  assert.deepEqual(hits(E, 'exists(CUX)'), [["CUX[1]=CUX+2:EUR:9@10:1"]]);
  assert.deepEqual(hits(E, 'NOT exists(CTA)'), [[]], 'a message can match without a value');
  assert.deepEqual(hits(E, 'MOA[86]-1.2 > 400 AND MOA[86]-1.2 < 500'), [['MOA[1]-1.2=454.80@18:8']], 'the same value is listed once');
  assert.deepEqual(hits(E, 'exists(ZZZ) OR BGM-2 == "PO*"'), [['BGM[1]-2=PO-24-00318@4:9']], 'only the true parts contribute');
  const r = run(E, 'BGM-2 == "PO*"');
  const hit = r.matches[0].hits[0];
  assert.equal(E.split('\n')[hit.line].slice(hit.column, hit.column + hit.length), 'PO-24-00318');
  assert.equal(resolvePath(parse(E), hit.path).value, 'PO-24-00318', 'the path is the one the hover shows');
  assert.deepEqual([r.matches[0].type, r.matches[0].ref, r.matches[0].line, r.matches[0].column, r.units, r.format], ['ORDERS', '1', 2, 0, 1, 'edifact']);
  assert.deepEqual(hits(SAMPLES.hl7.text, 'PID-5.1 == "Hartwell" AND PID-13(2).1 == "555-0143"'), [['PID[1]-5.1=Hartwell@3:35', 'PID[1]-13(2).1=555-0143@3:116']]);
  assert.deepEqual(hits(SAMPLES.x12.text, 'N1[ST]-2 == "North*" AND PO1-2 >= 48'), [['N1[1]-2=North Bay Retail Store 17@7:7', 'PO1[1]-2=48@10:7']]);
});

test('query corpus: results agree with what the files hold (worked out by hand)', () => {
  // x12/850-three-sets.x12: three purchase orders 0001..0003 (PO-24-01177..79), each with three PO1 lines.
  const three = corpus('x12/850-three-sets.x12');
  assert.deepEqual(run(three, 'count(PO1) == 3').matches.map((m) => [m.unit, m.type, m.ref, m.line + 1]), [[1, '850', '0001', 3], [2, '850', '0002', 25], [3, '850', '0003', 47]]);
  assert.deepEqual(units(three, 'BEG-3 == "PO-24-01178"'), [2]);
  assert.deepEqual(hits(three, 'BEG-3 == "PO-24-01178"'), [['BEG[2]-3=PO-24-01178@26:11']]);
  assert.deepEqual(units(three, 'BEG-3 >= "PO-24-01178"'), [2, 3]);
  assert.deepEqual(units(three, 'PO1-2 > 400'), [1, 2, 3]);
  assert.deepEqual(units(three, 'sum(PO1-2) == 660 AND CTT-2 == 660'), [1, 2, 3]);
  assert.deepEqual(units(three, 'ST-2 == "0003" OR ST-2 == "0001"'), [1, 3]);
  assert.deepEqual(units(three, 'N1[BT]-4 == "AP01" AND NOT BEG-3 == "PO-24-01177"'), [2, 3]);
  assert.deepEqual(units(three, 'count(N1) > 2'), []);
  assert.equal(run(three, 'exists(ST)').units, 3);

  // edifact/two-interchanges-orders-invoic.edi: message 1 ORDERS (3 lines, MOA 86 5112.00), message 2 INVOIC (2 lines, MOA 86 5118.00).
  const two = corpus('edifact/two-interchanges-orders-invoic.edi');
  assert.deepEqual(run(two, 'exists(BGM)').matches.map((m) => m.type), ['ORDERS', 'INVOIC']);
  assert.deepEqual(units(two, 'count(LIN) > 2'), [1]);
  assert.deepEqual(units(two, 'MOA[86]-1.2 > 5115'), [2]);
  assert.deepEqual(units(two, 'exists(NAD[IV])'), [2]);
  assert.deepEqual(units(two, 'exists(NAD[DP])'), [1]);
  assert.deepEqual(units(two, 'BGM-1.1 == 380 AND sum(MOA[203]-1.2) == 4094.4'), [2]);
  assert.deepEqual(units(two, 'NAD[BY]-4 == "Fjordline*"'), [1, 2]);
  assert.deepEqual(units(two, 'MOA[79]-1.2 == MOA[125]-1.2'), [2]);
  assert.deepEqual(units(two, 'count(MOA[124]) == 2'), [2]);

  // edifact/orders-group-altdelim.edi: other delimiters (, ; ~), two orders in one group.
  const alt = corpus('edifact/orders-group-altdelim.edi');
  assert.deepEqual(run(alt, 'BGM-2 == "PO-24-0117*"').matches.map((m) => [m.unit, m.ref]), [[1, '1'], [2, '2']]);
  assert.deepEqual(units(alt, 'BGM-2 == "PO-24-01179"'), [2]);
  assert.deepEqual(units(alt, 'count(LIN) == 3 AND MOA[86]-1.2 == 5112 AND CNT[2]-1.2 == 3'), [1, 2]);
  assert.deepEqual(units(alt, 'COM-1.1 == "*@example.invalid" AND COM-1.2 == "EM"'), [1, 2]);

  // hl7/file-fhs-two-batches.hl7: five messages ORU, ORM, SIU, MDM, DFT; the DFT has three FT1 with 1850.00, 840.00 and 96.50.
  const file = corpus('hl7/file-fhs-two-batches.hl7');
  assert.deepEqual(run(file, 'exists(MSH)').matches.map((m) => m.type), ['ORU^R01', 'ORM^O01', 'SIU^S12', 'MDM^T02', 'DFT^P03']);
  assert.deepEqual(run(file, 'exists(MSH)').matches.map((m) => m.ref), ['RS2403-0142', 'RS2403-0143', 'RS2403-0144', 'RS2403-0145', 'RS2403-0146']);
  assert.deepEqual(units(file, 'count(OBX) == 7'), [1]);
  assert.deepEqual(units(file, 'count(OBX) >= 2'), [1, 4]);
  assert.deepEqual(units(file, 'OBX[3.1=2823-3]-5 < 3.5'), [1]);
  assert.deepEqual(units(file, 'sum(FT1-12) == 2786.5'), [5]);
  assert.deepEqual(units(file, 'count(FT1) == 3 AND FT1-12 > 1000'), [5]);
  assert.deepEqual(units(file, 'MSH-9.1 == "ORM" OR MSH-9.2 == "S12"'), [2, 3]);
  assert.deepEqual(units(file, 'PID-5.1 == "Hartwell"'), [1, 2, 3, 4, 5]);
  assert.deepEqual(units(file, 'PID-11.3 == "Millford"'), [3]);
  assert.deepEqual(units(file, 'exists(IN1) AND NOT exists(OBX)'), [5]);
  assert.deepEqual(units(file, 'exists(BHS) OR exists(FTS)'), [], 'batch segments belong to no message');

  // hl7/log-four-messages-crlf.hl7: ACK, ADT, ACK, ORU; the ADT has a second identifier 0912345 in PID-3.
  const log = corpus('hl7/log-four-messages-crlf.hl7');
  assert.deepEqual(run(log, 'exists(MSH)').matches.map((m) => [m.unit, m.type, m.line + 1]), [[1, 'ACK^A01', 1], [2, 'ADT^A01', 4], [3, 'ACK^A01', 15], [4, 'ORU^R01', 18]]);
  assert.deepEqual(units(log, 'PID-3(2).1 == "0912345"'), [2]);
  assert.deepEqual(units(log, 'PID-3.1 == "0912345"'), [2], 'without a repetition number every repetition is looked at');
  assert.deepEqual(units(log, 'PID-3(1).1 == "0912345"'), []);
  assert.deepEqual(units(log, 'MSH-9.1 == "ACK"'), [1, 3]);
});

test('query corpus: every file answers simple questions consistently', () => {
  let total = 0;
  for (const f of ALL) {
    const every = run(f.text, f.format === 'edifact' ? 'exists(UNH)' : f.format === 'x12' ? 'exists(ST)' : 'exists(MSH)');
    const m = parse(f.text);
    const headers = m.segments.filter((s) => s.id === (f.format === 'edifact' ? 'UNH' : f.format === 'x12' ? 'ST' : 'MSH'));
    assert.equal(every.units, headers.length, f.name);
    assert.deepEqual(every.matches.map((x) => x.line), headers.map((s) => s.line), f.name);
    assert.equal(run(f.text, 'exists(ZZQ)').matches.length, 0);
    assert.equal(run(f.text, 'NOT exists(ZZQ)').matches.length, headers.length);
    // Every reported path resolves to the reported value at the reported place.
    const lines = f.text.split(/\r\n|\r|\n/);
    for (const q of ['count(NAD) >= 1 AND NAD-2.1 >= "0"', 'N1-2 >= " "', 'PID-5.1 >= "A"', 'exists(LIN)', 'OBX-5 > 0']) {
      for (const match of run(f.text, q).matches) {
        for (const hit of match.hits) {
          total++;
          const resolved = resolvePath(m, hit.path);
          assert.ok(resolved, f.name + ' ' + hit.path);
          if (hit.path.includes('-')) {
            assert.equal(resolved.value.trim(), hit.value, f.name + ' ' + hit.path);
            assert.equal(lines[hit.line].slice(hit.column, hit.column + hit.length), resolved.value, f.name + ' ' + hit.path);
          }
        }
      }
    }
  }
  assert.ok(total > 300, String(total));
});

test('query: syntax errors are explained with a position', () => {
  const bad = [['', 1, /empty/], ['   ', 1, /empty/], ['exists(', 8, /segment or a path is expected/], ['BGM == 3', 1, /needs an element/], ['"a" == "b"', 5, /at least one side/],
    ['NAD[BY]-2.1 === 3', 15, /is expected here/], ['count(LIN) > 1 or', 18, /is expected here/], ['(exists(BGM)', 13, /"\)" expected/], ['exists(BGM))', 12, /AND, OR or the end/],
    ['BGM-1 == "open', 10, /no closing quote/], ['BGM-1 @ 3', 7, /unexpected character/], ['BGM-1 3', 7, /comparison operator/], ['sum(LIN) > 1', 5, /sum\(\.\.\.\) needs a path/],
    ['count() > 1', 7, /a path is expected inside count/], ['exists(BGM) exists(CUX)', 13, /AND, OR or the end/], ['TOOLONG-1 == 1', 1, /not a path, a function or a keyword/],
    ['NAD[BY-2 == 1', 1, /not a path/], ['BGM-0 == 1', 1, /not a path/], ['1 == 2', 3, /at least one side/], ['AND', 1, /is expected here/], ['exists(BGM) AND', 16, /is expected here/],
    ['NOT', 4, /is expected here/], ['exists BGM', 1, /not a path, a function or a keyword/]];
  for (const [text, position, pattern] of bad) {
    const c = query.compile(text);
    assert.equal(c.ok, false, text);
    assert.equal(c.code, 'QUERY-SYNTAX', text);
    assert.equal(c.position + 1, position, text + ' -> ' + c.message);
    assert.match(c.message, pattern, text);
    if (text.trim()) assert.match(c.message, /^The query is not valid at position \d+: /);
  }
  assert.equal(query.compile('exists(BGM) AND '.repeat(80) + 'exists(BGM)').code, 'QUERY-TOO-LONG');
  assert.match(query.compile(new Array(60).fill('!exists(A1)').join(' or ')).message, /too many parts/);
  assert.equal(query.compile(null).ok, false);
  assert.equal(query.compile(42).ok, false);
});

test('query: keywords, quotes, numbers and segment ids that look like keywords', () => {
  const text = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'AND+x+y'NOT+1'OR+say \"hi\"+it?'s'QTY+21:-5'QTY+47:1,5'UNT+7+1'UNZ+1+R1'";
  for (const q of ['AND-1 == "x"', 'exists(AND)', 'NOT-1 == 1', 'exists(NOT) AND exists(OR)', 'OR-1 == "say \\"hi\\""', "OR-1 == 'say \"hi\"'", "OR-2 == \"it?'s\"", 'QTY[21]-1.2 == -5', 'QTY[21]-1.2 < 0',
    'QTY[47]-1.2 == 1.5', 'QTY[47]-1.2 == 1,5', 'sum(QTY-1.2) == -3.5', 'AND-1 == "x" and not exists(ZZZ)','exists(AND)AND exists(NOT)', 'count(QTY)==2', 'count(QTY)>=2&&count(QTY)<=2']) {
    assert.deepEqual(units(text, q), [1], q);
  }
  assert.deepEqual(units(text, 'QTY[21]-1.2 > 0'), []);
  assert.deepEqual([...query.compile('exists(AND) AND NAD[BY]-2.1 == LIN-1 OR count(QTY) > sum(MOA-1.2)').ids].sort(), ['AND', 'LIN', 'MOA', 'NAD', 'QTY']);
});

test('query: the result list is capped, a cancelled search stops, other texts are refused', () => {
  const many = 'ISA*00*          *00*          *ZZ*A              *ZZ*B              *240305*1015*U*00401*000000001*0*P*>~GS*PO*A*B*20240305*1015*1*X*004010~' +
    Array.from({ length: 300 }, (_, i) => 'ST*850*' + String(i + 1).padStart(4, '0') + '~BEG*00*SA*PO' + i + '**20240305~SE*3*' + String(i + 1).padStart(4, '0') + '~').join('') + 'GE*300*1~IEA*1*000000001~';
  const all = run(many, 'exists(BEG)');
  assert.deepEqual([all.matches.length, all.truncated, all.units], [300, false, 300]);
  const capped = run(many, 'exists(BEG)', { maxResults: 25 });
  assert.deepEqual([capped.matches.length, capped.truncated], [25, true]);
  assert.equal(run(many, 'exists(BEG)', { maxResults: 99999999 }).matches.length, 300);
  assert.equal(run(many, 'exists(BEG)', { maxResults: -3 }).matches.length, 300, 'a senseless limit falls back to the default');
  let asked = 0;
  const big = many.replace(/BEG\*00\*SA\*PO(\d+)\*\*20240305~/g, (m) => m + 'N1*ST*X~'.repeat(60));
  const cancelled = query.scanText(big, query.compile('exists(BEG)'), { isCancelled: () => { asked++; return asked > 1; } });
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.matches.length < 300 && asked >= 2);
  for (const text of ['', 'hello', null, undefined, 7]) assert.equal(query.scanText(text, query.compile('exists(BEG)')).code, 'QUERY-NOT-EDI');
  // More than twenty values in one message: the list of values is cut, the message still matches.
  const wide = run("UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'" + "LIN+1++X:EN'".repeat(100) + "UNT+102+1'UNZ+1+R1'", 'LIN-1 == 1');
  assert.equal(wide.matches[0].hits.length, 20);
});

test('query: CSV export has one row per value and neutralises formula cells', () => {
  const text = E.replace('PO-24-00318', '=1-1').replace('Deliver to gate 4 in the morning', 'say "hi", twice');
  const files = [
    { label: 'in/a,b.edi', result: run(text, 'BGM-2 == "=*" OR FTX-4 == "say*"') },
    { label: 'none.edi', result: run(E, 'exists(ZZZ)') },
    { label: 'no-value.edi', result: run(E, 'NOT exists(ZZZ)') },
    { label: 'skipped.bin', result: null },
  ];
  const rows = query.toCsv(files, true).split('\r\n');
  assert.deepEqual(rows, [
    'file,message_number,message_type,reference,line,column,path,value',
    '"in/a,b.edi",1,ORDERS,1,4,9,BGM[1]-2,\'=1-1',
    '"in/a,b.edi",1,ORDERS,1,7,11,FTX[1]-4,"say ""hi"", twice"',
    'no-value.edi,1,ORDERS,1,3,1,,',
    '',
  ]);
  assert.match(query.toCsv(files, false), /BGM\[1\]-2,=1-1\r\n/);
});

test('query attack: hostile query texts and hostile values are handled', () => {
  const nasty = ['(((((((((((((((((((((((((((((((((((((((((((((((((((', ')'.repeat(200), 'NOT '.repeat(250) + 'exists(A1)', '"' + 'a'.repeat(990), 'exists(' + 'A'.repeat(300) + ')',
    'A1[' + ']'.repeat(50), 'A1[' + '*'.repeat(400) + 'x]-1 == 1', '\u0000\u0001', 'exists(A1)   AND exists(B1)', 'A1-99999999999 == 1', 'A1#0-1 == 1', 'A1[=]-1 == 1', '__proto__ == 1',
    'constructor-1 == 1', 'count(count(A1)) > 1', 'exists(exists(A1))', '== 1', 'A1-1 == == 1', '1 2 3', '"\\', "'\\'", 'A1-1 == "' + '*a'.repeat(400) + '"'];
  for (const q of nasty) {
    const started = Date.now();
    const c = query.compile(q);
    if (c.ok) {
      const r = query.scanText(E, c);
      assert.equal(r.ok, true, q.slice(0, 40));
    } else {
      assert.match(c.code, /^QUERY-(SYNTAX|TOO-LONG)$/);
      assert.ok(c.position >= 0 && c.position <= Math.max(q.length, 1000), q.slice(0, 40));
    }
    assert.ok(Date.now() - started < 2000, 'slow on ' + q.slice(0, 40));
  }
  // A wildcard pattern with many stars against a long value stays fast.
  const long = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'FTX+AAI+++" + 'ab'.repeat(20000) + "'UNT+3+1'UNZ+1+R1'";
  const started = Date.now();
  assert.deepEqual(units(long, 'FTX-4 == "' + '*a'.repeat(30) + '*c"'), []);
  assert.deepEqual(units(long, 'FTX-4 == "' + '*a'.repeat(30) + '*b"'), [1]);
  assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
});

test('query fuzz: random queries over mutated files never crash and are reproducible (seed 99)', () => {
  const rand = kit.rng(99);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const sels = ['NAD', 'NAD[BY]', 'LIN', 'PID', 'OBX[3.1=2345-7]', 'N1[ST]', 'PO1', 'QTY[21]', 'MOA[86]', 'MSH', 'ST', 'UNH', 'DTM[137]', 'NM1[IL|QC]', 'LIN#2'];
  const paths = ['NAD-2.1', 'NAD[BY]-4', 'LIN-3.1', 'PID-5.1', 'PID-3(2).1', 'OBX-5', 'N1-2', 'PO1-2', 'QTY[21]-1.2', 'MOA[86]-1.2', 'MSH-9.1', 'BGM-2', 'BEG-3', 'CLM-2', 'NM1[IL]-3'];
  function leaf() {
    const k = Math.floor(rand() * 5);
    if (k === 0) return 'exists(' + pick(sels.concat(paths)) + ')';
    if (k === 1) return 'count(' + pick(sels.concat(paths)) + ') ' + pick(['>', '>=', '==', '<', '!=']) + ' ' + Math.floor(rand() * 4);
    if (k === 2) return 'sum(' + pick(paths) + ') ' + pick(['>', '<']) + ' ' + Math.floor(rand() * 500);
    if (k === 3) return pick(paths) + ' ' + pick(['==', '!=', '<', '>']) + ' ' + pick(['"5*"', '"*a*"', '100', '"Hartwell"', pick(paths)]);
    return pick(paths) + ' == "*"';
  }
  function expr(depth) {
    if (depth > 2 || rand() < 0.4) return leaf();
    const k = Math.floor(rand() * 4);
    if (k === 0) return 'NOT ' + expr(depth + 1);
    if (k === 1) return '(' + expr(depth + 1) + ')';
    return expr(depth + 1) + pick([' AND ', ' OR ', ' && ', ' || ']) + expr(depth + 1);
  }
  let cases = 0;
  let matched = 0;
  for (const f of ALL) {
    for (let k = 0; k < 4; k++) {
      const q = expr(0);
      const c = query.compile(q);
      assert.equal(c.ok, true, q + ' -> ' + c.message);
      let text = f.text;
      const at = Math.floor(rand() * text.length);
      const kind = Math.floor(rand() * 4);
      if (kind === 1) text = text.slice(0, at) + text.slice(at + 7);
      else if (kind === 2) text = text.slice(0, at);
      else if (kind === 3) text = text.slice(0, at) + "'~\r\n\u0000|+" + text.slice(at);
      const r = query.scanText(text, c);
      cases++;
      if (!r.ok) { assert.equal(r.code, 'QUERY-NOT-EDI'); continue; }
      matched += r.matches.length;
      const lines = text.split(/\r\n|\r|\n/);
      for (const m of r.matches) {
        assert.ok(m.unit >= 1 && m.unit <= r.units && m.line < lines.length, f.name + ' ' + q);
        for (const h of m.hits) assert.ok(h.line < lines.length && h.column <= lines[h.line].length && h.value.length <= 200, f.name + ' ' + q);
      }
      // NOT of a query matches exactly the other messages.
      const inverse = query.scanText(text, query.compile('NOT (' + q + ')'));
      assert.equal(inverse.matches.length + r.matches.length, r.units, f.name + ' ' + q);
      assert.deepEqual(query.scanText(text, query.compile(q)), r, 'the same result every time');
    }
  }
  assert.equal(cases, 504);
  assert.ok(matched > 100, String(matched));
});

test('query: every problem code is documented in docs/query.md', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'query.md'), 'utf8');
  for (const code of Object.values(query.CODES)) assert.ok(doc.includes('`' + code + '`'), code + ' is not documented');
});
