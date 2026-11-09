'use strict';

/*
 * Child process for the large input tests. Usage: node attack-stress-child.js
 * <edifact|x12|hl7> <megabytes>. It builds a realistic message of the given
 * size, runs the core functions over it and prints one JSON line with the
 * measurements. It runs in its own process so that the memory it needs does
 * not depend on what the test runner has already loaded.
 */

const { parse } = require('../../src/core/parse.js');
const { pretty, minify } = require('../../src/core/serialize.js');
const { validate } = require('../../src/core/validate.js');
const { resolvePath, locate } = require('../../src/core/path.js');
const { toCsv } = require('../../src/pro/export.js');

const format = process.argv[2];
const megabytes = Number(process.argv[3]);
const target = megabytes * 1024 * 1024;

/** Builds a message of about target characters; returns { text, segments }. */
function build() {
  const parts = [];
  let size = 0;
  let count = 0;
  const push = (s) => {
    parts.push(s);
    size += s.length;
    count++;
  };
  if (format === 'edifact') {
    push("UNB+UNOA:1+SENDER+RECEIVER+200101:1200+1'");
    push("UNH+1+ORDERS:D:96A:UN'");
    let i = 0;
    while (size < target) {
      i++;
      push('LIN+' + i + '++4012345' + String(i).padStart(6, '0') + ":EN'");
      push('QTY+21:' + (i % 100) + ":PCE'");
    }
    push('UNT+' + count + "+1'");
    push("UNZ+1+1'");
  } else if (format === 'x12') {
    const header = ['ISA', '00', ''.padEnd(10), '00', ''.padEnd(10), 'ZZ', 'SENDER'.padEnd(15), 'ZZ', 'RECEIVER'.padEnd(15), '210101', '1200', '^', '00501', '000000001', '0', 'P', ':'].join('*');
    push(header + '~');
    push('GS*PO*SENDER*RECEIVER*20210101*1200*1*X*005010~');
    push('ST*850*0001~');
    const first = count;
    let i = 0;
    while (size < target) {
      i++;
      push('N1*ST*ACME WIDGETS ' + i + '*92*' + String(i).padStart(8, '0') + '~');
    }
    push('SE*' + (count - first + 2) + '*0001~');
    push('GE*1*1~');
    push('IEA*1*000000001~');
  } else {
    push('MSH|^~\\&|APP|FAC|||20200101||ORU^R01|C1|P|2.5\r');
    push('PID|1||12345^^^HOSP^MR||Doe^John^Q||19800101|M\r');
    let i = 0;
    while (size < target) {
      i++;
      push('OBX|' + i + '|NM|718-7^Hemoglobin^LN||' + (i % 20) + '|g/dL|12-16|N|||F\r');
    }
  }
  return { text: parts.join(''), segments: count };
}

/** Runs fn and returns its result together with the time it took in milliseconds. */
function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

const built = build();
const text = built.text;
const parseRun = timed(() => parse(text));
const message = parseRun.value;
const heapAfterParse = process.memoryUsage().heapUsed / 1048576;
const validateRun = timed(() => validate(message));
const minifyRun = timed(() => minify(message));
const prettyRun = timed(() => pretty(message));
const mid = Math.floor(message.segments.length / 2);
const middle = message.segments[mid];
const pathRun = timed(() => resolvePath(message, middle.id + '[' + middle.occurrence + ']-1'));
const locateRun = timed(() => locate(message, middle.offset + 2));
const csvRun = format === 'edifact' ? timed(() => toCsv(message).length) : { value: 0, ms: 0 };

process.stdout.write(JSON.stringify({
  format,
  chars: text.length,
  segments: message.segments.length,
  expectedSegments: built.segments,
  issues: message.issues.length,
  validateIssues: validateRun.value.length,
  parseMs: Math.round(parseRun.ms),
  validateMs: Math.round(validateRun.ms),
  minifyMs: Math.round(minifyRun.ms),
  prettyMs: Math.round(prettyRun.ms),
  pathMs: Math.round(pathRun.ms),
  locateMs: Math.round(locateRun.ms),
  csvMs: Math.round(csvRun.ms),
  pathFound: pathRun.value !== null,
  locatePath: locateRun.value ? locateRun.value.path : null,
  minifyEqualsLength: minifyRun.value.length >= text.length - message.segments.length * 2,
  prettyLength: prettyRun.value.length,
  heapAfterParseMB: Math.round(heapAfterParse),
  heapPeakMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  rssMB: Math.round(process.memoryUsage().rss / 1048576),
}) + '\n');
