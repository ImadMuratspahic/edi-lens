'use strict';

/*
 * Child process for the large input tests of the Pro tools. Usage:
 *   node protools-stress-child.js <edifact|x12|hl7> <megabytes>
 * It builds a message of the given size with many small messages or one very large one, runs
 * anonymise, partner rules, query, split, renumber and acknowledge over it and prints one JSON
 * line with what it measured. It runs in its own process so that the heap limit given on the
 * command line is the real limit.
 */

const anon = require('../../src/pro/anonymise.js');
const rules = require('../../src/pro/rules.js');
const query = require('../../src/pro/query.js');
const env = require('../../src/pro/envelope.js');

const format = process.argv[2];
const target = Number(process.argv[3]) * 1024 * 1024;
// The test runner also loads this file on its own, without arguments: then there is nothing to do.
if (['edifact', 'x12', 'hl7'].indexOf(format) === -1 || !(target > 0)) process.exit(0);

function build() {
  const parts = [];
  let size = 0;
  let segments = 0;
  const push = (s) => { parts.push(s); size += s.length; segments++; };
  let messages = 0;
  if (format === 'edifact') {
    // One very large message: the case in which nothing may be kept per segment.
    push("UNB+UNOC:3+5412345000176:14+5498765000134:14+240311:1015+IC1'");
    push("UNH+1+ORDERS:D:96A:UN'");
    push("BGM+220+PO-1+9'");
    let i = 0;
    while (size < target) {
      i++;
      push('NAD+BY+54123' + String(i % 100000).padStart(8, '0') + "::9++Fjordline Trading AB+Hamngatan 14+Malmo++21122+SE'");
      push('LIN+' + i + '++5410000100012:EN\'');
      push("QTY+21:48'");
    }
    push('UNT+' + (segments - 1 + 1) + "+1'");
    push("UNZ+1+IC1'");
    messages = 1;
  } else if (format === 'x12') {
    // Very many small messages.
    push('ISA*00*          *00*          *ZZ*NORTHBAYRETAIL *ZZ*HARBORSUPPLY   *240311*1015*U*00401*000000001*0*P*>~');
    push('GS*HC*NORTHBAYRETAIL*HARBORSUPPLY*20240311*1015*1*X*004010~');
    let i = 0;
    while (size < target) {
      i++;
      const st = String(i).padStart(9, '0');
      push('ST*837*' + st + '~');
      push('NM1*IL*1*HARTWELL*MIRA*J***MI*NHP' + String(i).padStart(8, '0') + '~');
      push('N3*18 LINDEN WALK~');
      push('DMG*D8*19840712*F~');
      push('CLM*RS' + i + '*185.00~');
      push('SE*6*' + st + '~');
    }
    messages = i;
    push('GE*' + i + '*1~');
    push('IEA*1*000000001~');
  } else {
    let i = 0;
    while (size < target) {
      i++;
      push('MSH|^~\\&|ADMITSYS|RIVERSIDE|LABPORTAL|CITYLAB|20240305101500||ORU^R01|RS' + String(i).padStart(9, '0') + '|P|2.5.1\r');
      push('PID|1||RS-' + String(i).padStart(7, '0') + '^^^RIVERSIDE^MR||Hartwell^Mira^J||19840712|F|||18 Linden Walk^^Millford^NY^12901\r');
      for (let k = 1; k <= 6; k++) push('OBX|' + k + '|NM|2345-7^Glucose^LN||5.' + k + '|mmol/L|3.9-5.8|N|||F\r');
    }
    messages = i;
  }
  return { text: parts.join(''), segments: segments, messages: messages };
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value: value, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6) };
}
let peak = 0;
function sample() { peak = Math.max(peak, process.memoryUsage().heapUsed); }

const built = build();
const text = built.text;
sample();

const compiled = anon.compile(null, Object.keys(anon.PROFILES));
const a = timed(() => anon.anonymiseText(text, compiled, { seed: 'stress' }));
sample();
const anonOut = { ok: a.value.ok, sameLength: a.value.ok && a.value.text.length === text.length, changed: a.value.ok ? a.value.report.changed : 0, segments: a.value.ok ? a.value.report.segments : 0, mapSize: a.value.ok ? a.value.rewriter.size() : 0 };
a.value = null;

const guideText = {
  edifact: { format: 'edifact', rules: [{ id: 'R1', type: 'element-required', path: 'NAD-4' }, { id: 'R2', type: 'value-in', path: 'QTY-1.1', values: ['21'] }, { id: 'R3', type: 'segment-required', segment: 'QTY[21]', within: 'LIN' }, { id: 'R4', type: 'pattern', path: 'LIN-3.1', pattern: '^\\d{13}$' }, { id: 'R5', type: 'equal', left: 'count(LIN)', right: 'count(QTY)' }] },
  x12: { format: 'x12', rules: [{ id: 'R1', type: 'segment-required', segment: 'NM1[IL]' }, { id: 'R2', type: 'date', path: 'DMG-2', format: 'CCYYMMDD' }, { id: 'R3', type: 'range', path: 'CLM-2', min: 1, max: 1000 }] },
  hl7: { format: 'hl7', rules: [{ id: 'R1', type: 'segment-required', segment: 'PID' }, { id: 'R2', type: 'range', path: 'OBX[3.1=2345-7]-5', min: 3.9, max: 5.8 }, { id: 'R3', type: 'occurrences', segment: 'OBX', min: 6, max: 6 }] },
}[format];
const guide = rules.loadRules(JSON.stringify(guideText)).guide;
const r = timed(() => rules.validateText(text, guide, { maxIssues: 500 }));
sample();
const rulesOut = { ok: r.value.ok, units: r.value.units, unitsChecked: r.value.unitsChecked, violations: r.value.violations.length, truncated: r.value.truncated };
r.value = null;

const queryText = { edifact: 'count(LIN) > 1000 AND NAD[BY]-4 == "Fjord*"', x12: 'NM1[IL]-9 == "NHP00000042" OR CLM-1 == "RS77"', hl7: 'PID-3.1 == "RS-0000042" OR sum(OBX-5) > 1000' }[format];
const q = timed(() => query.scanText(text, query.compile(queryText), { maxResults: 1000 }));
sample();
const queryOut = { ok: q.value.ok, units: q.value.units, matches: q.value.matches.length, firstUnit: q.value.matches.length ? q.value.matches[0].unit : 0 };
q.value = null;

const n = timed(() => env.renumber(text, { start: 5 }));
sample();
const renumberOut = { ok: n.value.ok, changed: n.value.changed, sameLength: n.value.ok && n.value.text.length === text.length };
n.value = null;

const k = timed(() => env.acknowledge(text, { now: new Date(2024, 2, 11, 10, 15, 30) }));
sample();
const ackOut = { ok: k.value.ok, acknowledged: k.value.acknowledged, rejected: k.value.rejected, length: k.value.ok ? k.value.text.length : 0 };
k.value = null;

// Splitting writes one text per message; for the file with one huge message that is one text.
const s = timed(() => env.split(text, { start: 1 }));
sample();
const splitOut = { ok: s.value.ok, parts: s.value.ok ? s.value.parts.length : 0, code: s.value.code || '' };
s.value = null;

process.stdout.write(JSON.stringify({
  format: format, chars: text.length, segments: built.segments, messages: built.messages,
  anonymise: anonOut, anonymiseMs: a.ms, rules: rulesOut, rulesMs: r.ms, query: queryOut, queryMs: q.ms,
  renumber: renumberOut, renumberMs: n.ms, acknowledge: ackOut, acknowledgeMs: k.ms, split: splitOut, splitMs: s.ms,
  heapPeakMB: Math.round(peak / 1048576), rssMB: Math.round(process.memoryUsage().rss / 1048576),
}) + '\n');
