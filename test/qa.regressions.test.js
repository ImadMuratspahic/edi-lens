'use strict';
// Regression tests for the fixes of 0.1.1.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const { pretty, minify, toJSON } = require('../src/core/serialize');
const { locate, resolvePath } = require('../src/core/path');
const { createLicence } = require('../src/licence/licence');
const { activationFailureText } = require('../src/commands');
const { shorten } = require('../src/format');
const { fixture, fixtureNames, checkInvariants } = require('./core.helpers');

function isLazy(segment) {
  const d = Object.getOwnPropertyDescriptor(segment, 'elements');
  return !!(d && typeof d.get === 'function');
}

// ---- lazy elements ---------------------------------------------------------------------------

test('segments build their elements on first access and keep them', () => {
  const m = parse("UNA:+.? 'UNB+UNOC:3+S+R+240115:0930+1'UNH+1+ORDERS:D:96A:UN'BGM+220+A+9'UNT+3+1'UNZ+1+1'");
  assert.equal(isLazy(m.segments[0]), false, 'UNA has its advice element right away');
  assert.equal(isLazy(m.segments[3]), true, 'BGM is not built yet');
  const first = m.segments[3].elements;
  assert.equal(isLazy(m.segments[3]), false, 'BGM holds a plain property after the first read');
  assert.equal(m.segments[3].elements, first, 'the same list is returned again');
  assert.deepEqual(first.map((e) => e.raw), ['220', 'A', '9']);
  assert.ok(Object.keys(m.segments[3]).includes('elements'), 'elements stays an enumerable key');
  assert.equal(JSON.stringify(m.segments[3]).indexOf('"elements":[') > 0, true, 'serialises like a plain object');
  m.segments[4].elements = [];
  assert.deepEqual(m.segments[4].elements, [], 'the property can be assigned');
});

test('lazy elements are identical to the eager ones for every fixture and keep all invariants', () => {
  for (const name of fixtureNames()) {
    const text = fixture(name);
    const m = parse(text);
    const snapshot = JSON.parse(JSON.stringify(m));
    checkInvariants(m);
    const again = parse(text);
    // Reading in a different order (last segment first) gives the same structure.
    for (let i = again.segments.length - 1; i >= 0; i--) again.segments[i].elements;
    assert.deepEqual(JSON.parse(JSON.stringify(again)), snapshot, name);
    assert.deepEqual(toJSON(again), toJSON(m), name);
    assert.equal(pretty(again), pretty(m), name);
    assert.equal(minify(again), minify(m), name);
  }
});

test('a later UNA, ISA or MSH does not change the delimiters captured for earlier segments', () => {
  const edi = "UNA:+.? 'UNB+UNOC:3+S+R+240115:0930+1'BGM+220+A:B+9'UNZ+1+1'UNA;*,!^|UNB*UNOC;3*S*R*240115;0930*2|BGM*220*A;B*9|UNZ*1*2|";
  const m = parse(edi);
  const bgmFirst = m.segments.find((s) => s.id === 'BGM');
  const bgmSecond = m.segments.filter((s) => s.id === 'BGM')[1];
  assert.deepEqual(bgmSecond.elements.map((e) => e.raw), ['220', 'A;B', '9'], 'second interchange uses * and ;');
  assert.equal(bgmSecond.elements[1].repetitions[0].components.length, 2);
  assert.deepEqual(bgmFirst.elements.map((e) => e.raw), ['220', 'A:B', '9'], 'first interchange still uses + and :');
  assert.equal(bgmFirst.elements[1].repetitions[0].components.length, 2);

  const isa1 = 'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *240115*0930*U*00401*000000001*0*P*>~';
  const isa2 = 'ISA|00|          |00|          |ZZ|SENDERID       |ZZ|RECEIVERID     |240115|0930|U|00401|000000002|0|P|:~';
  const x = parse(isa1 + 'REF*A*B>C~IEA*0*000000001~' + isa2 + 'REF|A|B:C~IEA|0|000000002~');
  const refs = x.segments.filter((s) => s.id === 'REF');
  for (let i = refs.length - 1; i >= 0; i--) refs[i].elements;
  assert.deepEqual(refs[0].elements[1].repetitions[0].components.map((c) => c.raw), ['B', 'C']);
  assert.deepEqual(refs[1].elements[1].repetitions[0].components.map((c) => c.raw), ['B', 'C']);
  assert.equal(x.segments[0].elements.length, 16, 'ISA keeps its 16 unsplit elements');
  assert.equal(x.segments[0].elements[15].raw, '>');

  const h = parse('MSH|^~\\&|A|B|C|D|1||ADT^A01|1|P|2.5\rPID|1||X^Y\rMSH#!+/$#A#B#C#D#1##ADT!A01#2#P#2.5\rPID#1##X!Y');
  const pids = h.segments.filter((s) => s.id === 'PID');
  assert.deepEqual(pids[1].elements[2].repetitions[0].components.map((c) => c.raw), ['X', 'Y']);
  assert.deepEqual(pids[0].elements[2].repetitions[0].components.map((c) => c.raw), ['X', 'Y']);
  assert.equal(h.segments[2].elements[1].raw, '!+/$', 'second MSH-2 holds its own encoding characters');
});

test('validation of a large file reads only the envelope segments', () => {
  const body = "LIN+1++4000000000015:EN'QTY+21:24'PRI+AAA:12.50'";
  const n = 20000;
  const text = "UNB+UNOC:3+S+R+240115:0930+1'UNH+1+ORDERS:D:96A:UN'" + body.repeat(n) + 'UNT+' + (2 + 3 * n) + "+1'UNZ+1+1'";
  const m = parse(text);
  const issues = validate(m);
  assert.deepEqual(issues, []);
  const built = m.segments.filter((s) => !isLazy(s)).map((s) => s.id);
  assert.ok(built.length <= 6, 'only envelope segments were built: ' + built.join(','));
  assert.equal(pretty(m).split('\n').length, m.segments.length, 'pretty print needs no elements');
  assert.equal(minify(m), text);
  assert.equal(m.segments.filter((s) => !isLazy(s)).length, built.length, 'pretty and minify built nothing');
  // Hover and paths touch one segment at a time.
  assert.equal(locate(m, text.indexOf('4000000000015')).path, 'LIN[1]-3.1');
  assert.equal(resolvePath(m, 'QTY[' + n + ']-1.2').value, '24');
  assert.ok(m.segments.filter((s) => !isLazy(s)).length <= built.length + 2);
});

test('a parsed 50 MB file with short segments stays far below the heap limit of the editor', () => {
  // About 2.8 million segments. Before 0.1.1 this needed roughly 4.5 GB of heap.
  const body = "LIN+1++4000000000015:EN'QTY+21:24'PRI+AAA:12.50'IMD+F++:::Widget blue 12 cm'";
  const n = Math.ceil((50 * 1024 * 1024) / body.length);
  const text = "UNB+UNOC:3+S+R+240115:0930+1'UNH+1+ORDERS:D:96A:UN'" + body.repeat(n) + 'UNT+' + (2 + 4 * n) + "+1'UNZ+1+1'";
  const before = process.memoryUsage().heapUsed;
  const m = parse(text);
  const issues = validate(m);
  const used = process.memoryUsage().heapUsed - before;
  assert.deepEqual(issues, []);
  assert.ok(m.segments.length > 2500000, String(m.segments.length));
  // Measured without a forced collection, so garbage counts too; the eager parser needed 4.5 GB.
  assert.ok(used < 2000 * 1024 * 1024, 'heap grew by ' + Math.round(used / 1048576) + ' MB');
  assert.ok(m.segments.filter((s) => !isLazy(s)).length < 10, 'only the envelope segments were built');
});

// ---- licence: secret storage failure ---------------------------------------------------------

function stores() {
  const secretMap = new Map();
  const stateMap = new Map();
  return {
    secretMap, stateMap,
    secrets: { get: async (k) => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async (k) => { secretMap.delete(k); } },
    globalState: { get: (k) => stateMap.get(k), update: async (k, v) => { if (v === undefined) stateMap.delete(k); else stateMap.set(k, v); } }
  };
}

test('activation releases the seat and reports "storage" when the key cannot be kept', async () => {
  const st = stores();
  st.secrets.store = async () => { throw new Error('keyring unavailable'); };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/licenses/activate')) return { status: 201, json: async () => ({ id: 'lki_seat', name: 'x', product: { product_id: 'pdt_0NriIrMqPm9xOakMMZtw4' } }) };
    return { status: 200, json: async () => null };
  };
  const lic = createLicence({ secrets: st.secrets, globalState: st.globalState, fetch: fetchImpl, getMode: () => 'live' });
  const r = await lic.activate('KEY-1');
  assert.deepEqual(r, { ok: false, reason: 'storage', released: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('/licenses/deactivate'));
  assert.deepEqual(calls[1].body, { license_key: 'KEY-1', license_key_instance_id: 'lki_seat' });
  assert.equal(st.secretMap.size, 0);
  assert.equal(st.stateMap.size, 0);
  assert.equal(await lic.isPro(), false);
  assert.match(activationFailureText(r), /secret storage/);
  assert.match(activationFailureText(r), /released again/);
});

test('activation that fails while writing the editor state is undone as well', async () => {
  const st = stores();
  st.globalState.update = async () => { throw new Error('state unavailable'); };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/licenses/activate')) return { status: 201, json: async () => ({ id: 'lki_2', product: { product_id: 'pdt_0NriIrMqPm9xOakMMZtw4' } }) };
    return { status: 200, json: async () => null };
  };
  const lic = createLicence({ secrets: st.secrets, globalState: st.globalState, fetch: fetchImpl, getMode: () => 'live' });
  const r = await lic.activate('KEY-2');
  assert.deepEqual(r, { ok: false, reason: 'storage', released: true });
  assert.equal(st.secretMap.size, 0, 'the stored key was deleted again');
  assert.ok(calls[1].endsWith('/licenses/deactivate'));
});

test('a working activation is unchanged by the storage guard', async () => {
  const st = stores();
  const fetchImpl = async (url) => ({ status: 201, json: async () => ({ id: 'lki_ok', product: { product_id: 'pdt_0NriIrMqPm9xOakMMZtw4' } }) });
  const lic = createLicence({ secrets: st.secrets, globalState: st.globalState, fetch: fetchImpl, getMode: () => 'live' });
  assert.deepEqual(await lic.activate('KEY-3'), { ok: true, licenceType: 'personal' });
  assert.equal(st.secretMap.get('licence.key.live'), 'KEY-3');
  assert.equal(st.stateMap.get('licence.instanceId.live'), 'lki_ok');
  assert.equal(await lic.isPro(), true);
});

// ---- shorten on huge values ----------------------------------------------------------------------

test('shorten gives the same results as before and is fast on a value of 20 MB', () => {
  assert.equal(shorten('abc', 5), 'abc');
  assert.equal(shorten('abcde', 5), 'abcde');
  assert.equal(shorten('abcdef', 5), 'abcd…');
  assert.equal(shorten('a\u0001b\u007f', 10), 'a·b·');
  assert.equal(shorten('😀😀😀😀😀😀', 5), '😀😀😀😀…');
  assert.equal(shorten('😀😀😀😀😀', 5), '😀😀😀😀😀');
  assert.equal(shorten('x'.repeat(81), 40), 'x'.repeat(39) + '…');
  assert.equal(shorten('x'.repeat(82), 40), 'x'.repeat(39) + '…');
  assert.equal(shorten('x'.repeat(83), 40), 'x'.repeat(39) + '…');
  assert.equal(shorten(null, 5), '');
  const big = 'y'.repeat(20 * 1024 * 1024);
  const t0 = Date.now();
  assert.equal(shorten(big, 40), 'y'.repeat(39) + '…');
  assert.equal(shorten(big, 200), 'y'.repeat(199) + '…');
  assert.ok(Date.now() - t0 < 200, 'took ' + (Date.now() - t0) + ' ms');
});
