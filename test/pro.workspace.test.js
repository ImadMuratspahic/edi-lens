'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_GLOB,
  DEFAULT_EXCLUDE,
  limits,
  normaliseScanOptions,
  scanFiles,
  toMarkdown,
  escapeMarkdown,
  lineStarts,
  positionAt,
  scanWorkspace,
} = require('../src/pro/workspace.js');
const { EDIFACT_ORDER, HL7_ADT, X12_PO } = require('./fixtures/pro/samples.js');

/**
 * An in-memory file system for the scan code. files maps an id to a string
 * (the content) or { text, size, failRead }. Every call is recorded.
 */
function memoryAdapter(files) {
  const calls = { findFiles: [], stat: [], readText: [], readHead: [] };
  const entry = (id) => {
    const f = files[id];
    return typeof f === 'string' ? { text: f } : f;
  };
  const extOk = (id, glob) => {
    if (glob === '**/*') {
      return true;
    }
    return /\.(edi|edifact|edf|x12|x12edi|hl7)$/i.test(id);
  };
  return {
    calls,
    async findFiles(glob, exclude, max) {
      calls.findFiles.push({ glob, exclude, max });
      return Object.keys(files).filter((id) => extOk(id, glob)).slice(0, max);
    },
    async stat(id) {
      calls.stat.push(id);
      const f = entry(id);
      return { size: f.size !== undefined ? f.size : Buffer.byteLength(f.text) };
    },
    async readText(id) {
      calls.readText.push(id);
      const f = entry(id);
      if (f.failRead) {
        throw new Error('disk error');
      }
      return f.text;
    },
    async readHead(id, n) {
      calls.readHead.push(id);
      return entry(id).text.slice(0, n);
    },
    label(id) {
      return id.replace(/^\/ws\//, '');
    },
  };
}

const BOM = String.fromCharCode(0xfeff);
const PRETTY_EDI = EDIFACT_ORDER.replace(/'/g, "'\n");

test('workspace: defaults are the documented glob and limits', () => {
  assert.equal(DEFAULT_GLOB, '**/*.{edi,edifact,edf,x12,x12edi,hl7}');
  assert.match(DEFAULT_EXCLUDE, /node_modules/);
  assert.equal(limits.maxFileBytes, 5 * 1024 * 1024);
  assert.equal(limits.maxFiles, 2000);
});

test('workspace: options cannot raise the hard limits', () => {
  const o = normaliseScanOptions({ maxFileBytes: 50 * 1024 * 1024, maxFiles: 99999, maxSniffCandidates: 1e9 });
  assert.equal(o.maxFileBytes, 5 * 1024 * 1024);
  assert.equal(o.maxFiles, 2000);
  assert.equal(o.maxSniffCandidates, limits.maxSniffCandidates);
});

test('workspace: options can lower the limits and bad values fall back to defaults', () => {
  const low = normaliseScanOptions({ maxFileBytes: 1000, maxFiles: 3 });
  assert.equal(low.maxFileBytes, 1000);
  assert.equal(low.maxFiles, 3);
  ['x', 0, -5, NaN, null, undefined].forEach((bad) => {
    const o = normaliseScanOptions({ maxFileBytes: bad, maxFiles: bad });
    assert.equal(o.maxFileBytes, 5 * 1024 * 1024);
    assert.equal(o.maxFiles, 2000);
  });
  assert.equal(normaliseScanOptions().glob, DEFAULT_GLOB);
  assert.equal(normaliseScanOptions({ glob: '  ' }).glob, DEFAULT_GLOB);
  assert.equal(normaliseScanOptions({ glob: '**/*.txt' }).glob, '**/*.txt');
});

test('workspace: scans the matching files and counts formats', async () => {
  const fs = memoryAdapter({
    '/ws/a/order.edi': EDIFACT_ORDER,
    '/ws/b/po.x12': X12_PO,
    '/ws/b/adt.hl7': HL7_ADT,
  });
  const s = await scanFiles(fs, {});
  assert.equal(s.files.length, 3);
  assert.equal(s.totals.scanned, 3);
  assert.deepEqual(s.byFormat, { edifact: 1, x12: 1, hl7: 1 });
  assert.equal(s.cancelled, false);
  assert.equal(s.truncated, false);
  assert.deepEqual(s.files.map((f) => f.label), ['a/order.edi', 'b/adt.hl7', 'b/po.x12']);
});

test('workspace: the glob and exclude patterns are passed to the file finder', async () => {
  const fs = memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER });
  await scanFiles(fs, { glob: '**/*.edi', exclude: '**/old/**', sniffUnknownFiles: false });
  assert.equal(fs.calls.findFiles[0].glob, '**/*.edi');
  assert.equal(fs.calls.findFiles[0].exclude, '**/old/**');
  assert.equal(fs.calls.findFiles[0].max, 2001);
});

test('workspace: a clean file has no issues', async () => {
  const fs = memoryAdapter({ '/ws/ok.edi': EDIFACT_ORDER });
  const s = await scanFiles(fs, {});
  const f = s.files[0];
  assert.equal(f.status, 'ok');
  assert.equal(f.format, 'edifact');
  assert.equal(f.segmentCount, 13);
  assert.deepEqual(f.counts, { error: 0, warning: 0, info: 0 });
  assert.deepEqual(f.issues, []);
  assert.equal(s.totals.filesWithErrors, 0);
});

test('workspace: a structural error is reported with code, line and column', async () => {
  const broken = PRETTY_EDI.replace("UNT+10+1'", "UNT+9+1'");
  const fs = memoryAdapter({ '/ws/bad.edi': broken });
  const s = await scanFiles(fs, {});
  const f = s.files[0];
  assert.ok(f.counts.error >= 1);
  assert.equal(s.totals.filesWithErrors, 1);
  assert.equal(s.totals.errors, f.counts.error);
  const issue = f.issues.find((i) => i.severity === 'error');
  assert.equal(typeof issue.code, 'string');
  assert.ok(issue.message.length > 0);
  assert.ok(issue.line > 1, 'the UNT segment is far down the file');
  assert.ok(issue.column >= 1);
  const lines = broken.split('\n');
  assert.ok(lines[issue.line - 1].length > 0);
  assert.equal(issue.range.startLine, issue.line - 1);
  assert.equal(issue.range.startCharacter, issue.column - 1);
  assert.ok(issue.end >= issue.offset);
});

test('workspace: a file that is not EDI is skipped with a reason', async () => {
  const fs = memoryAdapter({ '/ws/notes.edi': 'Just some notes\nabout the project.' });
  const s = await scanFiles(fs, {});
  assert.equal(s.files[0].status, 'skipped');
  assert.match(s.files[0].reason, /not a recognised/);
  assert.equal(s.totals.skipped, 1);
  assert.equal(s.totals.scanned, 0);
});

test('workspace: an empty file is skipped', async () => {
  const fs = memoryAdapter({ '/ws/empty.edi': '  \n ' });
  const s = await scanFiles(fs, {});
  assert.equal(s.files[0].status, 'skipped');
  assert.match(s.files[0].reason, /empty/);
});

test('workspace: a file over the size cap is skipped and never read', async () => {
  const fs = memoryAdapter({
    '/ws/huge.edi': { text: EDIFACT_ORDER, size: 6 * 1024 * 1024 },
    '/ws/small.edi': EDIFACT_ORDER,
  });
  const s = await scanFiles(fs, {});
  const huge = s.files.find((f) => f.label === 'huge.edi');
  assert.equal(huge.status, 'skipped');
  assert.match(huge.reason, /Larger than 5\.0 MB \(6\.0 MB\)/);
  assert.ok(!fs.calls.readText.includes('/ws/huge.edi'));
  assert.equal(s.totals.scanned, 1);
});

test('workspace: a file exactly at the size cap is scanned', async () => {
  const fs = memoryAdapter({ '/ws/edge.edi': { text: EDIFACT_ORDER, size: 5 * 1024 * 1024 } });
  const s = await scanFiles(fs, {});
  assert.equal(s.files[0].status, 'ok');
});

test('workspace: a lower size cap from the options is honoured', async () => {
  const fs = memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER });
  const s = await scanFiles(fs, { maxFileBytes: 100 });
  assert.equal(s.files[0].status, 'skipped');
});

test('workspace: at most 2,000 files are scanned and the result says so', async () => {
  const files = {};
  for (let i = 0; i < 2005; i += 1) {
    files['/ws/f' + String(i).padStart(4, '0') + '.hl7'] = HL7_ADT;
  }
  const fs = memoryAdapter(files);
  const s = await scanFiles(fs, { sniffUnknownFiles: false });
  assert.equal(s.files.length, 2000);
  assert.equal(s.truncated, true);
  assert.equal(s.totals.scanned, 2000);
  assert.match(toMarkdown(s), /More than 2000 files matched/);
});

test('workspace: exactly 2,000 files is not reported as truncated', async () => {
  const files = {};
  for (let i = 0; i < 2000; i += 1) {
    files['/ws/f' + i + '.hl7'] = HL7_ADT;
  }
  const s = await scanFiles(memoryAdapter(files), { sniffUnknownFiles: false });
  assert.equal(s.files.length, 2000);
  assert.equal(s.truncated, false);
});

test('workspace: a lower file count from the options is honoured', async () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) {
    files['/ws/f' + i + '.hl7'] = HL7_ADT;
  }
  const s = await scanFiles(memoryAdapter(files), { maxFiles: 3, sniffUnknownFiles: false });
  assert.equal(s.files.length, 3);
  assert.equal(s.truncated, true);
});

test('workspace: files without a known extension are found by their first bytes', async () => {
  const fs = memoryAdapter({
    '/ws/data.txt': EDIFACT_ORDER,
    '/ws/readme.txt': 'Nothing to see here.',
    '/ws/photo.png': 'UNB+binary',
    '/ws/known.edi': EDIFACT_ORDER,
  });
  const s = await scanFiles(fs, {});
  assert.deepEqual(s.files.map((f) => f.label), ['data.txt', 'known.edi']);
  assert.ok(!fs.calls.readHead.includes('/ws/photo.png'), 'binary extensions are never read');
  assert.ok(!fs.calls.readHead.includes('/ws/known.edi'), 'matched files are not looked at twice');
  assert.ok(fs.calls.readHead.includes('/ws/readme.txt'));
});

test('workspace: looking at unknown files can be switched off', async () => {
  const fs = memoryAdapter({ '/ws/data.txt': EDIFACT_ORDER, '/ws/known.edi': EDIFACT_ORDER });
  const s = await scanFiles(fs, { sniffUnknownFiles: false });
  assert.deepEqual(s.files.map((f) => f.label), ['known.edi']);
  assert.equal(fs.calls.readHead.length, 0);
});

test('workspace: huge unknown files are not read at all', async () => {
  const fs = memoryAdapter({ '/ws/big.dat': { text: EDIFACT_ORDER, size: 9 * 1024 * 1024 } });
  const s = await scanFiles(fs, {});
  assert.equal(s.files.length, 0);
  assert.equal(fs.calls.readHead.length, 0);
});

test('workspace: the number of unknown files examined is capped', async () => {
  const files = {};
  for (let i = 0; i < 30; i += 1) {
    files['/ws/x' + String(i).padStart(2, '0') + '.dat'] = 'plain text';
  }
  const fs = memoryAdapter(files);
  const s = await scanFiles(fs, { maxSniffCandidates: 10 });
  assert.equal(s.sniffTruncated, true);
  assert.equal(fs.calls.readHead.length, 10);
  assert.match(toMarkdown(s), /Only some of them were checked/);
});

test('workspace: unknown files found by content count against the file limit', async () => {
  const fs = memoryAdapter({
    '/ws/a.hl7': HL7_ADT,
    '/ws/b.dat': HL7_ADT,
    '/ws/c.dat': HL7_ADT,
  });
  const s = await scanFiles(fs, { maxFiles: 2 });
  assert.equal(s.files.length, 2);
  assert.equal(s.truncated, true);
});

test('workspace: cancelling stops the scan and keeps the partial result', async () => {
  const files = {};
  for (let i = 0; i < 6; i += 1) {
    files['/ws/f' + i + '.hl7'] = HL7_ADT;
  }
  const fs = memoryAdapter(files);
  const s = await scanFiles(fs, { sniffUnknownFiles: false }, {
    isCancelled: () => fs.calls.readText.length >= 2,
  });
  assert.equal(s.cancelled, true);
  assert.equal(s.files.length, 2);
  assert.equal(s.totals.scanned, 2);
  assert.match(toMarkdown(s), /cancelled/);
});

test('workspace: cancelling before the first file scans nothing', async () => {
  const fs = memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER });
  const s = await scanFiles(fs, {}, { isCancelled: () => true });
  assert.equal(s.cancelled, true);
  assert.equal(s.files.length, 0);
  assert.equal(fs.calls.readText.length, 0);
});

test('workspace: progress is reported file by file and ends with a done message', async () => {
  const fs = memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER, '/ws/b.hl7': HL7_ADT });
  const events = [];
  await scanFiles(fs, { sniffUnknownFiles: false }, { onProgress: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.phase, e.done, e.total]), [
    ['scanning', 0, 2],
    ['scanning', 1, 2],
    ['done', 2, 2],
  ]);
  assert.equal(events[0].label, 'a.edi');
});

test('workspace: a file that cannot be read is reported and the scan continues', async () => {
  const fs = memoryAdapter({
    '/ws/a.edi': { text: EDIFACT_ORDER, failRead: true },
    '/ws/b.edi': EDIFACT_ORDER,
  });
  const s = await scanFiles(fs, {});
  assert.equal(s.files[0].status, 'failed');
  assert.match(s.files[0].reason, /disk error/);
  assert.equal(s.files[1].status, 'ok');
  assert.equal(s.totals.failed, 1);
  assert.equal(s.totals.scanned, 1);
});

test('workspace: a crash inside parse or validate is contained', async () => {
  const core = {
    detectFormat: () => ({ format: 'edifact', reason: 'test' }),
    parse: () => {
      throw new Error('boom');
    },
    validate: () => [],
  };
  const s = await scanFiles(memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER }), { core });
  assert.equal(s.files[0].status, 'failed');
  assert.match(s.files[0].reason, /boom/);
});

test('workspace: a leading byte order mark does not matter', async () => {
  const fs = memoryAdapter({ '/ws/bom.edi': BOM + EDIFACT_ORDER });
  const s = await scanFiles(fs, {});
  assert.equal(s.files[0].status, 'ok');
  assert.equal(s.files[0].format, 'edifact');
  assert.equal(s.files[0].counts.error, 0);
});

test('workspace: issues are limited per file but all are counted', async () => {
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push({ severity: 'warning', code: 'T' + i, message: 'issue ' + i, offset: i, end: i + 1, segmentIndex: 0 });
  }
  const core = {
    detectFormat: () => ({ format: 'hl7', reason: 'test' }),
    parse: () => ({ format: 'hl7', segments: [{ id: 'MSH', occurrence: 1 }], issues: [] }),
    validate: () => many,
  };
  const s = await scanFiles(memoryAdapter({ '/ws/a.hl7': HL7_ADT }), { core, maxIssuesPerFile: 5 });
  const f = s.files[0];
  assert.equal(f.issues.length, 5);
  assert.equal(f.counts.warning, 20);
  assert.equal(f.issuesTruncated, 15);
  assert.equal(f.issues[0].segment, 'MSH[1]');
  assert.equal(s.totals.warnings, 20);
  assert.equal(s.totals.filesWithWarnings, 1);
});

test('workspace: the same issue from parse and validate is listed once', async () => {
  const issue = { severity: 'error', code: 'DUP', message: 'same', offset: 3, end: 5, segmentIndex: -1 };
  const core = {
    detectFormat: () => ({ format: 'edifact', reason: 'test' }),
    parse: () => ({ format: 'edifact', segments: [], issues: [issue] }),
    validate: () => [Object.assign({}, issue), { severity: 'info', code: 'OTHER', message: 'x', offset: 1, end: 2, segmentIndex: -1 }],
  };
  const s = await scanFiles(memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER }), { core });
  const f = s.files[0];
  assert.deepEqual(f.issues.map((i) => i.code), ['OTHER', 'DUP']);
  assert.deepEqual(f.counts, { error: 1, warning: 0, info: 1 });
  assert.equal(f.issues[0].segment, '');
});

test('workspace: issue offsets beyond the text are clamped', async () => {
  const core = {
    detectFormat: () => ({ format: 'edifact', reason: 'test' }),
    parse: () => ({ format: 'edifact', segments: [], issues: [] }),
    validate: () => [{ severity: 'error', code: 'FAR', message: 'far', offset: 99999, end: 100000, segmentIndex: -1 }],
  };
  const s = await scanFiles(memoryAdapter({ '/ws/a.edi': 'UNB+x\nUNZ' }), { core });
  const issue = s.files[0].issues[0];
  assert.equal(issue.offset, 9);
  assert.equal(issue.end, 9);
  assert.deepEqual(issue.range, { startLine: 1, startCharacter: 3, endLine: 1, endCharacter: 3 });
});

test('workspace: the results do not depend on the order files are listed in', async () => {
  const a = await scanFiles(memoryAdapter({ '/ws/b.edi': EDIFACT_ORDER, '/ws/a.hl7': HL7_ADT }), {});
  const b = await scanFiles(memoryAdapter({ '/ws/a.hl7': HL7_ADT, '/ws/b.edi': EDIFACT_ORDER }), {});
  assert.deepEqual(a, b);
});

/* ---------------------------------------------------------- line maths */

test('lines: LF, CRLF and lone CR each end one line', () => {
  assert.deepEqual(lineStarts('a\nb\r\nc\rd'), [0, 2, 5, 7]);
  assert.deepEqual(lineStarts(''), [0]);
  assert.deepEqual(lineStarts('a\n'), [0, 2]);
});

test('lines: positionAt finds line and character', () => {
  const starts = lineStarts('ab\ncd\nef');
  assert.deepEqual(positionAt(starts, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAt(starts, 2), { line: 0, character: 2 });
  assert.deepEqual(positionAt(starts, 3), { line: 1, character: 0 });
  assert.deepEqual(positionAt(starts, 7), { line: 2, character: 1 });
});

/* ------------------------------------------------------------- Markdown */

test('markdown: escapeMarkdown neutralises markup and line breaks', () => {
  assert.equal(escapeMarkdown('a|b'), 'a\\|b');
  assert.equal(escapeMarkdown('<script>x</script>'), '\\<script\\>x\\</script\\>');
  assert.equal(escapeMarkdown('[link](http://x) `code` *b* _i_'), '\\[link\\](http://x) \\`code\\` \\*b\\* \\_i\\_');
  assert.equal(escapeMarkdown('one\r\ntwo\nthree\rfour'), 'one two three four');
  assert.equal(escapeMarkdown('a\u0000b'), 'ab');
  assert.equal(escapeMarkdown(null), '');
});

test('markdown: report has a summary, problem tables, clean files and skipped files', async () => {
  const fs = memoryAdapter({
    '/ws/ok.edi': EDIFACT_ORDER,
    '/ws/bad.edi': PRETTY_EDI.replace("UNT+10+1'", "UNT+9+1'"),
    '/ws/notes.edi': 'plain notes',
  });
  const s = await scanFiles(fs, {});
  const md = toMarkdown(s);
  assert.match(md, /^# EDI Lens workspace report/);
  assert.match(md, /\| Files scanned \| 2 \|/);
  assert.match(md, /\| Files with errors \| 1 \|/);
  assert.match(md, /\| Files skipped \| 1 \|/);
  assert.match(md, /## Files with problems\n\n### bad\.edi/);
  assert.match(md, /\| Line \| Segment \| Severity \| Code \| Message \|/);
  assert.match(md, /## Files without problems\n\n- ok\.edi \(UN\/EDIFACT, 13 segments\)/);
  assert.match(md, /## Skipped or unreadable files\n\n- notes\.edi: /);
  assert.match(md, /By format: UN\/EDIFACT 2, ANSI X12 0, HL7 v2 0\./);
});

test('markdown: the same summary always gives the same report', async () => {
  const s = await scanFiles(memoryAdapter({ '/ws/a.edi': EDIFACT_ORDER }), {});
  assert.equal(toMarkdown(s), toMarkdown(s));
  assert.ok(!/Report date:/.test(toMarkdown(s)));
  assert.match(toMarkdown(s, { reportDate: '2026-01-01 10:00' }), /Report date: 2026-01-01 10:00/);
});

test('markdown: file names and messages from the files cannot inject markup', async () => {
  const core = {
    detectFormat: () => ({ format: 'edifact', reason: 'test' }),
    parse: () => ({ format: 'edifact', segments: [], issues: [] }),
    validate: () => [{ severity: 'error', code: 'X|Y', message: '<img src=x> | [a](javascript:alert(1))\nnext', offset: 0, end: 1, segmentIndex: -1 }],
  };
  const fs = memoryAdapter({ '/ws/we|ird<name>.edi': EDIFACT_ORDER });
  const md = toMarkdown(await scanFiles(fs, { core }));
  assert.ok(!/(^|[^\\])[<>]/m.test(md), 'every angle bracket must be escaped');
  assert.ok(md.includes('### we\\|ird\\<name\\>.edi'));
  assert.ok(md.includes('\\<img src=x\\> \\| \\[a\\](javascript:alert(1)) next'));
  const tableRows = md.split('\n').filter((l) => l.startsWith('| 1 |'));
  assert.equal(tableRows.length, 1);
});

test('markdown: only the first 50 issues of a file are listed, with a note for the rest', async () => {
  const many = [];
  for (let i = 0; i < 80; i += 1) {
    many.push({ severity: 'info', code: 'N' + i, message: 'note ' + i, offset: 0, end: 0, segmentIndex: -1 });
  }
  const core = {
    detectFormat: () => ({ format: 'hl7', reason: 'test' }),
    parse: () => ({ format: 'hl7', segments: [], issues: [] }),
    validate: () => many,
  };
  const md = toMarkdown(await scanFiles(memoryAdapter({ '/ws/a.hl7': HL7_ADT }), { core }));
  assert.equal(md.split('\n').filter((l) => /^\| 1 \|/.test(l)).length, 50);
  assert.match(md, /\.\.\. and 30 more issues not listed here\./);
});

test('markdown: an empty scan says that nothing was found', async () => {
  const md = toMarkdown(await scanFiles(memoryAdapter({}), {}));
  assert.match(md, /No EDI files were found\./);
});

test('markdown: grammar of counts', async () => {
  const core = {
    detectFormat: () => ({ format: 'x12', reason: 'test' }),
    parse: () => ({ format: 'x12', segments: [{ id: 'ISA', occurrence: 1 }], issues: [] }),
    validate: () => [{ severity: 'error', code: 'E', message: 'm', offset: 0, end: 1, segmentIndex: 0 }],
  };
  const md = toMarkdown(await scanFiles(memoryAdapter({ '/ws/a.x12': X12_PO }), { core }));
  assert.match(md, /ANSI X12, 1 segment: 1 error, 0 warnings, 0 notes\./);
});

/* ----------------------------------------------------------- vscode glue */

test('workspace: the module loads without the editor and the glue reports a clear failure', async () => {
  await assert.rejects(() => scanWorkspace({}), (err) => err instanceof Error);
});
