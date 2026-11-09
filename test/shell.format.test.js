'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../src/format');

const X12_ONE_LINE = 'ISA*00*          *00*          *ZZ*ACMEBUYER      *ZZ*GLOBALSUPPLY   *240115*0930*U*00401*000000101*0*P*>~' +
  'GS*PO*ACMEBUYER*GLOBALSUPPLY*20240115*0930*101*X*004010~ST*850*0001~BEG*00*SA*PO-1**20240115~SE*3*0001~GE*1*101~IEA*1*000000101~';
const EDIFACT_ONE_LINE = "UNA:+.? 'UNB+UNOC:3+SENDER+RECEIVER+240115:0930+REF1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO1+9'UNT+3+1'UNZ+1+REF1'";
const HL7_CR = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|MSG1|P|2.5\rEVN|A01|20240115\rPID|1||123^^^H^MR||Doe^Jane\r';

test('language helpers map ids and formats both ways', () => {
  assert.equal(fmt.languageIdForFormat('x12'), 'x12');
  assert.equal(fmt.languageIdForFormat('hl7'), 'hl7');
  assert.equal(fmt.languageIdForFormat('edifact'), 'edifact');
  assert.equal(fmt.languageIdForFormat('csv'), null);
  assert.equal(fmt.formatForLanguageId('edifact'), 'edifact');
  assert.equal(fmt.formatForLanguageId('plaintext'), null);
  assert.equal(fmt.isSupportedLanguage('hl7'), true);
  assert.equal(fmt.isSupportedLanguage('json'), false);
  assert.equal(fmt.formatLabel('edifact'), 'UN/EDIFACT');
  assert.equal(fmt.formatLabel('x12'), 'ANSI X12');
  assert.equal(fmt.formatLabel('hl7'), 'HL7 v2');
  assert.equal(fmt.formatLabel('other'), 'other');
  assert.equal(fmt.LANGUAGES.length, 3);
});

test('shorten keeps short values and cuts long ones with an ellipsis', () => {
  assert.equal(fmt.shorten('abc', 10), 'abc');
  assert.equal(fmt.shorten('abcdefghij', 10), 'abcdefghij');
  assert.equal(fmt.shorten('abcdefghijk', 10), 'abcdefghi…');
  assert.equal(fmt.shorten('', 10), '');
  assert.equal(fmt.shorten(undefined, 10), '');
  assert.equal(fmt.shorten(null, 10), '');
  assert.equal(fmt.shorten(42, 10), '42');
});

test('shorten replaces control characters and does not split surrogate pairs', () => {
  assert.equal(fmt.shorten('a\r\nb\tc', 20), 'a··b·c');
  const emoji = '\u{1F600}\u{1F600}\u{1F600}\u{1F600}';
  const cut = fmt.shorten(emoji, 3);
  assert.equal(cut, '\u{1F600}\u{1F600}…');
  assert.equal(Array.from(cut).length, 3);
});

test('codePointLength counts code points, not UTF-16 units', () => {
  assert.equal(fmt.codePointLength(''), 0);
  assert.equal(fmt.codePointLength('abc'), 3);
  assert.equal(fmt.codePointLength('äö'), 2);
  assert.equal(fmt.codePointLength('a\u{1F600}b'), 3);
  assert.equal(fmt.codePointLength('\ud83d'), 1, 'a lone surrogate counts once');
  assert.equal(fmt.codePointLength(undefined), 0);
  assert.equal(fmt.codePointLength(null), 0);
});

test('exceedsLimit compares a character count with a size limit in MB', () => {
  assert.equal(fmt.exceedsLimit(10, 1), false);
  assert.equal(fmt.exceedsLimit(1024 * 1024, 1), false);
  assert.equal(fmt.exceedsLimit(1024 * 1024 + 1, 1), true);
  assert.equal(fmt.exceedsLimit(11 * 1024 * 1024, 10), true);
  assert.equal(fmt.exceedsLimit(5 * 1024 * 1024, undefined), false, 'default limit is 10 MB');
  assert.equal(fmt.exceedsLimit(11 * 1024 * 1024, 'x'), true);
  assert.equal(fmt.exceedsLimit(100, 0), false, 'a zero limit falls back to the default');
});

test('decodeUtf8 strips a byte order mark and reports it', () => {
  const plain = fmt.decodeUtf8(Buffer.from('UNB+X\'', 'utf8'));
  assert.deepEqual(plain, { text: "UNB+X'", bom: false });
  const withBom = fmt.decodeUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('MSH|^~\\&', 'utf8')]));
  assert.deepEqual(withBom, { text: 'MSH|^~\\&', bom: true });
  assert.deepEqual(fmt.decodeUtf8(Buffer.alloc(0)), { text: '', bom: false });
  assert.deepEqual(fmt.decodeUtf8(Buffer.from('Käse', 'utf8')), { text: 'Käse', bom: false });
});

test('decodeUtf8 refuses bytes that are not valid UTF-8', () => {
  assert.equal(fmt.decodeUtf8(Buffer.from([0x4b, 0xe4, 0x73, 0x65])), null, 'Latin-1 bytes');
  assert.equal(fmt.decodeUtf8(Buffer.from([0xff, 0xfe, 0x00])), null);
  assert.equal(fmt.decodeUtf8(new Uint8Array([0xc3])), null, 'truncated sequence');
});

test('eolOf reports the line break style of a text', () => {
  assert.equal(fmt.eolOf('a\r\nb\r\n'), '\r\n');
  assert.equal(fmt.eolOf('a\nb\n'), '\n');
  assert.equal(fmt.eolOf('a\rb\r'), '\r');
  assert.equal(fmt.eolOf('single line'), '\n');
  assert.equal(fmt.eolOf(''), '\n');
  assert.equal(fmt.eolOf('a\nb\r\n'), '\r\n', 'CRLF wins when present');
});

test('mergeIssues drops duplicates, orders by position and applies the limit', () => {
  const a = { severity: 'warning', code: 'W1', message: 'a', offset: 20, end: 25, segmentIndex: 1 };
  const b = { severity: 'error', code: 'E1', message: 'b', offset: 5, end: 9, segmentIndex: 0 };
  const dup = { severity: 'error', code: 'E1', message: 'same code and range', offset: 5, end: 9, segmentIndex: 0 };
  const c = { severity: 'info', code: 'I1', message: 'c', offset: 5, end: 7, segmentIndex: 0 };
  const merged = fmt.mergeIssues([a, b], [dup, c], 10);
  assert.deepEqual(merged.map((i) => i.code), ['E1', 'I1', 'W1']);
  assert.equal(fmt.mergeIssues([a, b, c], [], 2).length, 2);
  assert.deepEqual(fmt.mergeIssues(undefined, undefined, 5), []);
  assert.deepEqual(fmt.mergeIssues(null, [null, { code: 'X' }, a], 5).map((i) => i.code), ['W1'], 'malformed entries are ignored');
  assert.equal(fmt.mergeIssues([a], [], 0).length, 1, 'a limit of zero falls back to the default');
});

test('countIssues counts by severity', () => {
  assert.deepEqual(fmt.countIssues([]), { error: 0, warning: 0, info: 0 });
  assert.deepEqual(fmt.countIssues(undefined), { error: 0, warning: 0, info: 0 });
  assert.deepEqual(fmt.countIssues([{ severity: 'error' }, { severity: 'error' }, { severity: 'warning' }, { severity: 'info' }]), { error: 2, warning: 1, info: 1 });
});

test('formatMessage uses the injected serializer and passes options only to the pretty printer', () => {
  const seen = [];
  const core = {
    pretty: (m, o) => { seen.push(['pretty', o]); return 'PRETTY'; },
    minify: (m, o) => { seen.push(['minify', o]); return 'MINI'; }
  };
  const message = { format: 'x12', segments: [{ id: 'ISA' }] };
  assert.deepEqual(fmt.formatMessage(message, 'pretty', core, { eol: '\r\n' }), { ok: true, text: 'PRETTY', format: 'x12' });
  assert.deepEqual(fmt.formatMessage(message, 'minify', core, { eol: '\r\n' }), { ok: true, text: 'MINI', format: 'x12' });
  assert.deepEqual(seen[0], ['pretty', { eol: '\r\n' }]);
  assert.deepEqual(seen[1], ['minify', undefined]);
});

test('formatMessage reports why it cannot format', () => {
  const core = { pretty: () => 'x', minify: () => 'y' };
  assert.deepEqual(fmt.formatMessage({ segments: [] }, 'pretty', core), { ok: false, reason: 'empty' });
  assert.deepEqual(fmt.formatMessage(null, 'pretty', core), { ok: false, reason: 'empty' });
  assert.deepEqual(fmt.formatMessage({ segments: [{}] }, 'pretty', {}), { ok: false, reason: 'unavailable' });
  assert.deepEqual(fmt.formatMessage({ segments: [{}] }, 'minify', { pretty: () => 'x' }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(fmt.formatMessage({ segments: [{}] }, 'pretty', { pretty: () => { throw new Error('boom'); } }), { ok: false, reason: 'failed' });
  assert.deepEqual(fmt.formatMessage({ segments: [{}] }, 'pretty', { pretty: () => 42 }), { ok: false, reason: 'failed' });
});

test('formatText parses first and never throws', () => {
  const core = { parse: (t) => ({ format: 'hl7', segments: t ? [{}] : [] }), pretty: () => 'OUT' };
  assert.deepEqual(fmt.formatText('x', 'pretty', core), { ok: true, text: 'OUT', format: 'hl7' });
  assert.deepEqual(fmt.formatText('', 'pretty', core), { ok: false, reason: 'empty' });
  assert.deepEqual(fmt.formatText('x', 'pretty', {}), { ok: false, reason: 'unavailable' });
  assert.deepEqual(fmt.formatText('x', 'pretty', { parse: () => { throw new Error('x'); } }), { ok: false, reason: 'failed' });
});

test('describeFormatFailure has a sentence for every reason', () => {
  for (const reason of ['empty', 'unavailable', 'failed', 'anything']) {
    const s = fmt.describeFormatFailure(reason);
    assert.equal(typeof s, 'string');
    assert.ok(s.endsWith('.'));
  }
  assert.notEqual(fmt.describeFormatFailure('empty'), fmt.describeFormatFailure('failed'));
});

test('message cache parses once per document version', () => {
  let calls = 0;
  const cache = fmt.createMessageCache((text) => { calls++; return { text, segments: [] }; });
  const doc = {};
  const first = cache.get(doc, 1, () => 'one');
  assert.equal(cache.get(doc, 1, () => 'one'), first);
  assert.equal(calls, 1);
  const second = cache.get(doc, 2, () => 'two');
  assert.notEqual(second, first);
  assert.equal(calls, 2);
  cache.get({}, 1, () => 'other doc');
  assert.equal(calls, 3);
});

test('message cache survives a throwing parser and does not retry the same version', () => {
  let calls = 0;
  const cache = fmt.createMessageCache(() => { calls++; throw new Error('bad'); });
  const doc = {};
  assert.equal(cache.get(doc, 1, () => 'x'), null);
  assert.equal(cache.get(doc, 1, () => 'x'), null);
  assert.equal(calls, 1);
});

test('registerFormatting registers one provider per language and returns edits only when text changes', async () => {
  const registered = [];
  const vscode = {
    Range: class { constructor(a, b) { this.start = a; this.end = b; } },
    TextEdit: { replace: (range, text) => ({ range, newText: text }) },
    languages: { registerDocumentFormattingEditProvider: (selector, provider) => { registered.push({ selector, provider }); return { dispose() {} }; } }
  };
  const disposables = fmt.registerFormatting(vscode, (doc) => doc.message);
  assert.equal(disposables.length, 3);
  assert.deepEqual(registered.map((r) => r.selector.language).sort(), ['edifact', 'hl7', 'x12']);

  const real = fmt.getCore();
  const message = real.parse(X12_ONE_LINE);
  const doc = { message, getText: () => X12_ONE_LINE, positionAt: (n) => n };
  const edits = registered[0].provider.provideDocumentFormattingEdits(doc);
  assert.equal(edits.length, 1);
  assert.ok(edits[0].newText.split('\n').length > 5);
  assert.equal(edits[0].range.end, X12_ONE_LINE.length);

  const formatted = { message, getText: () => edits[0].newText, positionAt: (n) => n };
  assert.deepEqual(registered[0].provider.provideDocumentFormattingEdits(formatted), [], 'already formatted: no edit');
  assert.deepEqual(registered[0].provider.provideDocumentFormattingEdits({ message: null, getText: () => '' }), []);
});

test('real core: pretty and minify keep the data for all three formats', () => {
  for (const [name, text] of [['x12', X12_ONE_LINE], ['edifact', EDIFACT_ONE_LINE], ['hl7', HL7_CR]]) {
    const pretty = fmt.formatText(text, 'pretty');
    assert.equal(pretty.ok, true, name);
    assert.equal(pretty.format, name);
    const core = fmt.getCore();
    assert.equal(core.minify(core.parse(pretty.text)), core.minify(core.parse(text)), name + ': same data after minify');
    const mini = fmt.formatText(pretty.text, 'minify');
    assert.equal(mini.ok, true, name);
    assert.ok(!/\n/.test(mini.text.replace(/\r/g, '')) || name === 'hl7', name + ': no line feeds in minified text');
  }
});

test('real core: pretty honours the requested line break', () => {
  const crlf = fmt.formatText(X12_ONE_LINE, 'pretty', undefined, { eol: '\r\n' });
  assert.equal(crlf.ok, true);
  assert.ok(crlf.text.includes('~\r\n'));
  assert.ok(!/[^\r]\n/.test(crlf.text));
});

test('real core: text without segments cannot be formatted', () => {
  assert.equal(fmt.formatText('just some words', 'pretty').ok, false);
  assert.equal(fmt.formatText('', 'minify').ok, false);
  assert.equal(fmt.formatText('\u0000\u0001\u0002 binary ÿ', 'pretty').ok, false);
});

test('getCore exposes the core functions', () => {
  const core = fmt.getCore();
  for (const name of ['detectFormat', 'parse', 'pretty', 'minify', 'toJSON', 'formatPath', 'resolvePath', 'locate', 'validate']) {
    assert.equal(typeof core[name], 'function', name);
  }
  const pro = fmt.getPro();
  for (const name of ['diff', 'exporter', 'dictionary', 'workspace']) assert.ok(pro[name], name);
});

test('describeSafe returns names from a dictionary and an empty object otherwise', () => {
  const loaded = fmt.getPro().dictionary.loadDictionary(JSON.stringify({
    format: 'edifact', name: 'T', segments: { BGM: { name: 'Beginning of message', elements: { 1: { name: 'Document', values: { 220: 'Order' } } } } }
  }));
  assert.equal(loaded.ok, true);
  const names = fmt.describeSafe(loaded.dictionary, 'BGM', 1, undefined, '220');
  assert.equal(names.segmentName, 'Beginning of message');
  assert.equal(names.elementName, 'Document');
  assert.equal(names.valueName, 'Order');
  assert.deepEqual(fmt.describeSafe(null, 'BGM', 1), {});
  assert.deepEqual(fmt.describeSafe(loaded.dictionary, 'ZZZ', 1), {});
});
