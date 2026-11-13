'use strict';
// Regression tests for the findings of the second review round of 0.2.0 (licence seats and storage,
// the test environment, date-time ranges, HL7 acknowledgements, a trial record from the future, the
// wording of the FAQ) and for the guarantees of Anonymise (distinct replacements, the key).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLicence, TRIAL_KEYS } = require('../src/licence/licence');
const config = require('../src/licence/config');
const messages = require('../src/licence/messages');
const { createService } = require('./helpers/licence-service');
const anon = require('../src/pro/anonymise');
const env = require('../src/pro/envelope');
const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DAY = 24 * 3600 * 1000;

// The rules of .gitignore as expressions (enough of the syntax for the patterns this project uses).
// Git on Windows reads them without regard to case; pass flags 'i' to read them that way.
function gitignoreRules(flags) {
  return read('.gitignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((pattern) => {
    const clean = pattern.replace(/^\//, '').replace(/\/$/, '');
    const anchored = pattern.startsWith('/') || clean.includes('/');
    const body = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp((anchored ? '^' : '(^|/)') + body + '(/|$)', flags);
  });
}

function stores() {
  const secretMap = new Map();
  const stateMap = new Map();
  return {
    secretMap,
    stateMap,
    secrets: { get: async (k) => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async (k) => { secretMap.delete(k); } },
    globalState: { get: (k) => stateMap.get(k), update: async (k, v) => { if (v === undefined) stateMap.delete(k); else stateMap.set(k, v); } }
  };
}

// A licence service wired to the stand-in licence server (live environment, as an installed copy).
function wired(extra) {
  const service = createService();
  const st = stores();
  const clock = { t: 1700000000000 };
  const calls = [];
  const licence = createLicence(Object.assign({
    secrets: st.secrets,
    globalState: st.globalState,
    now: () => clock.t,
    platform: 'win32',
    fetch: async (url, init) => {
      const u = new URL(url);
      const body = JSON.parse(init.body);
      calls.push({ path: u.pathname, body });
      const a = service.handle('POST', u.pathname, body, u.host);
      return { status: a.status, json: async () => { if (a.body === null) throw new Error('empty'); return a.body; } };
    }
  }, extra || {}));
  return { licence, service, st, clock, calls };
}

// ---- R2: a failed key replacement keeps the licence that was stored -------------------------------------

test('R2: when the new key cannot be stored the working licence stays, its seat stays, and only the new activation is released', async () => {
  const w = wired();
  assert.equal((await w.licence.activate('MOCK-KEY-0001')).ok, true);
  assert.equal(w.service.seats('MOCK-KEY-0001'), 1);
  const store = w.st.secrets.store;
  w.st.secrets.store = async () => { throw new Error('keyring unavailable'); };
  const r = await w.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(r, { ok: false, reason: 'storage', released: true, hadPrevious: true, previousKept: true });
  assert.equal(w.st.secretMap.get('licence.key.live'), 'MOCK-KEY-0001', 'the old key is still stored');
  assert.equal(w.st.stateMap.get('licence.instanceId.live'), 'lki_mock1');
  assert.equal(await w.licence.isPro(), true, 'Pro still works');
  assert.equal(w.service.seats('MOCK-KEY-0001'), 1, 'the old seat is still used by the working licence');
  assert.equal(w.service.seats('MOCK-KEY-BUSINESS'), 0, 'the new activation was released');
  assert.match(messages.activationFailureText(r), /could not be saved in the secret storage[\s\S]*released again and the new key was not stored\. Your previous licence was kept and is still active/);
  assert.doesNotMatch(messages.activationFailureText(r), /Pro stays off/);
  w.st.secrets.store = store;
  assert.equal((await w.licence.activate('MOCK-KEY-BUSINESS')).ok, true, 'a later try works and replaces the old licence');
  assert.equal(w.service.seats('MOCK-KEY-0001'), 0);
});

test('R2: a write of the editor state that fails after the key was replaced puts the old licence back', async () => {
  const w = wired();
  await w.licence.activate('MOCK-KEY-0001');
  const update = w.st.globalState.update;
  w.st.globalState.update = async (k, v) => {
    if (k === 'licence.instanceId.live' && v === 'lki_mock2') throw new Error('state unavailable');
    return update(k, v);
  };
  const r = await w.licence.activate('MOCK-KEY-BUSINESS');
  assert.equal(r.reason, 'storage');
  assert.equal(r.previousKept, true);
  assert.equal(w.st.secretMap.get('licence.key.live'), 'MOCK-KEY-0001', 'the key that had just been overwritten is back');
  assert.equal(w.st.stateMap.get('licence.instanceId.live'), 'lki_mock1');
  assert.equal(w.st.stateMap.get('licence.productId.live'), config.products.live.personal);
  assert.equal(await w.licence.isPro(), true);
  assert.equal(w.service.seats('MOCK-KEY-BUSINESS'), 0);
});

test('R2: when the old licence cannot be read back the message does not claim it was kept', async () => {
  const w = wired();
  await w.licence.activate('MOCK-KEY-0001');
  const get = w.st.secrets.get;
  let broken = false;
  w.st.secrets.get = async (k) => { if (broken) throw new Error('keyring unavailable'); return get(k); };
  w.st.secrets.store = async () => { broken = true; throw new Error('keyring unavailable'); };
  const r = await w.licence.activate('MOCK-KEY-BUSINESS');
  assert.equal(r.reason, 'storage');
  assert.equal(r.hadPrevious, true);
  assert.equal(r.previousKept, false);
  assert.match(messages.activationFailureText(r), /Your previous licence could not be confirmed on this computer afterwards/);
  assert.doesNotMatch(messages.activationFailureText(r), /was kept/);
});

// ---- R3: the old activation is released only with the key it belongs to ---------------------------------------

test('R3: when the stored key was lost, no release is sent with the new key and the message does not claim one', async () => {
  const w = wired();
  assert.equal((await w.licence.activate('MOCK-KEY-0001')).ok, true);
  w.st.secretMap.delete('licence.key.live'); // an editor that keeps secrets in memory only, after a restart
  w.calls.length = 0;
  const r = await w.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: false, previousKeyLost: true });
  assert.equal(w.calls.filter((c) => c.path === '/licenses/deactivate').length, 0, 'nothing is released with a key that does not own the activation');
  assert.equal(w.service.seats('MOCK-KEY-0001'), 1, 'the old seat is still used, and the message must not say otherwise');
  const text = messages.activatedText('business', r);
  assert.doesNotMatch(text, /was released\./);
  assert.match(text, /no longer available on this computer[\s\S]*could not be released from here[\s\S]*limit of 3/);
});

test('R3: a stored key that is still known is released with itself, as before', async () => {
  const w = wired();
  await w.licence.activate('MOCK-KEY-0001');
  const r = await w.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: true });
  assert.deepEqual(w.calls.at(-1).body, { license_key: 'MOCK-KEY-0001', license_key_instance_id: 'lki_mock1' });
  assert.equal(w.service.seats('MOCK-KEY-0001'), 0);
});

// ---- R4: the installed extension carries no test environment ------------------------------------------------

test('R4: without the test-environment file nothing reaches the test environment and the config holds no test host or test product id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edilens-packaged-'));
  try {
    for (const f of ['config.js', 'licence.js']) fs.copyFileSync(path.join(ROOT, 'src', 'licence', f), path.join(dir, f));
    assert.equal(fs.existsSync(path.join(dir, 'test-environment.js')), false);
    const text = fs.readFileSync(path.join(dir, 'config.js'), 'utf8') + fs.readFileSync(path.join(dir, 'licence.js'), 'utf8');
    assert.doesNotMatch(text, /test\.(checkout\.)?dodopayments/);
    for (const id of Object.values(require('../src/licence/test-environment').products)) assert.ok(!text.includes(id), 'the test product id ' + id + ' is in the packaged files');
    const packaged = require(path.join(dir, 'config.js'));
    const L = require(path.join(dir, 'licence.js'));
    assert.equal(packaged.testEnvironmentAvailable, false);
    assert.deepEqual(packaged.resolve('test'), { mode: 'live', api: 'https://live.dodopayments.com', buyUrl: packaged.buyUrlLive });
    assert.deepEqual(packaged.allowedProductIds('test'), packaged.allowedProductIds('live'));
    assert.equal(packaged.buyUrlFor('test', 'business', 2), 'https://checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=2');
    assert.equal(packaged.assertShippable(require('../package.json')), true);
    const urls = [];
    const st = stores();
    const lic = L.createLicence({ secrets: st.secrets, globalState: st.globalState, getMode: () => 'test', fetch: async (url) => { urls.push(url); return { status: 404, json: async () => ({}) }; } });
    await lic.activate('SOME-KEY');
    assert.deepEqual(urls, ['https://live.dodopayments.com/licenses/activate']);
    assert.equal(st.stateMap.size + st.secretMap.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R4: the development checkout keeps the test environment for the unit tests, and the package leaves its file out', () => {
  assert.equal(config.testEnvironmentAvailable, true);
  assert.equal(config.resolve('test').mode, 'test');
  const ignore = read('.vscodeignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignore.includes('src/licence/test-environment.js'));
  assert.equal(config.assertShippable(require('../package.json')), true);
  // The live product ids are the ones of the listing and differ from the test ones.
  assert.notEqual(config.products.live.personal, config.products.test.personal);
  assert.notEqual(config.products.live.business, config.products.test.business);
  assert.equal(config.products.live.personal, 'pdt_0NriIrMqPm9xOakMMZtw4');
  assert.equal(config.products.live.business, 'pdt_0NrkGSyl3UXB82kEhwUxy');
});

// ---- R5: date-time ranges ------------------------------------------------------------------------------------

test('R5: both dates of a date-time range move by the same number of days and the times stay', () => {
  assert.equal(anon.shiftDate('202401011030-202401311200', -10), '202312221030-202401211200');
  assert.equal(anon.shiftDate('20240101-20240131', -10), '20231222-20240121');
  assert.equal(anon.shiftDate('202402281030-202403011200', 3), '202403021030-202403041200');
  // A time zone offset after the date or the time is not a range.
  assert.equal(anon.shiftDate('20240101103000-0500', -10), '20231222103000-0500');
  assert.equal(anon.shiftDate('20240101-0500', -10), '20231222-0500');
  // A range whose second part is not a real date of the same layout is no date: the whole value is replaced like an identifier.
  for (const bad of ['202401011030-2024013X', '20240101-2024013X', '20240101-2024013', '202401011030-20240131', '20240101-202401311200', '202401011030-202402301200', '20240101-20240131-20240201']) {
    assert.equal(anon.shiftDate(bad, -10), null, bad);
  }
});

test('R5: Anonymise moves the second date of an X12 RDT and an EDIFACT 719 value and no date stays in clear text', () => {
  const x12 = "ISA*00*          *00*          *ZZ*SENDERQ1       *ZZ*RECEIVERQ2     *240305*1015*U*00401*000000001*0*P*>~GS*HC*SENDERQ1*RECEIVERQ2*20240305*1015*1*X*004010X222A1~ST*837*0001~DTP*472*RDT*202401011030-202401311200~SE*3*0001~GE*1*1~IEA*1*000000001~";
  const compiled = anon.compile({ profiles: [], rules: [{ format: 'x12', path: 'DTP-3', action: 'fake-date' }] }, [], { envelopeIds: 'keep' });
  const r = anon.anonymiseText(x12, compiled, { seed: 'range' });
  const m = /DTP\*472\*RDT\*(\d{8})(\d{4})-(\d{8})(\d{4})~/.exec(r.text);
  assert.ok(m, r.text);
  assert.ok(m[1] !== '20240101' && m[3] !== '20240131', 'neither date survives: ' + m[0]);
  assert.deepEqual([m[2], m[4]], ['1030', '1200'], 'the times stay');
  const day = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6))) / 86400000;
  assert.equal(day(m[3]) - day(m[1]), 30);
  assert.equal(day(m[1]) - day('20240101'), r.rewriter.dateShiftDays);
  const edifact = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1+9'DTM+163:202401011030-202401311200:719'UNT+4+1'UNZ+1+R1'";
  const e = anon.anonymiseText(edifact, anon.compile({ profiles: [], rules: [{ format: 'edifact', path: 'DTM-1.2', action: 'fake-date' }] }, [], { envelopeIds: 'keep' }), { seed: 'range' });
  const n = /DTM\+163:(\d{8})1030-(\d{8})1200:719/.exec(e.text);
  assert.ok(n, e.text);
  assert.ok(n[1] !== '20240101' && n[2] !== '20240131');
  assert.equal(day(n[2]) - day(n[1]), 30);
  // A malformed second part is replaced as an identifier and counted, never left in clear text.
  const bad = anon.anonymiseText(x12.replace('202401011030-202401311200', '202401011030-2024013X1200'), compiled, { seed: 'range' });
  assert.ok(!bad.text.includes('2024013X'), bad.text);
  assert.equal(bad.report.datesNotRecognised, 1);
});

// ---- R6: acknowledgements of damaged HL7 headers ---------------------------------------------------------------

test('R6: no HL7 acknowledgement is written when MSH-12 is not a version number, and none is handed out with a warning', () => {
  const E = '^~\\&';
  const msh = (v) => 'MSH|' + E + '|ADMITSYS|RIVERSIDE|LABPORTAL|CITYLAB|20240305101500||ORU^R01|RS2403-0142|P|' + v + '\nPID|1||RS-4471902\nOBX|1|NM|1||5\n';
  const now = new Date(2024, 2, 11, 10, 15, 30);
  for (const damaged of [E, '^^^', '2.5SCH', 'FHS', '2..5', 'x']) {
    const r = env.acknowledge(msh(damaged), { now });
    assert.equal(r.ok, false, JSON.stringify(damaged));
    assert.equal(r.code, 'ENV-BAD-ENVELOPE', JSON.stringify(damaged));
  }
  for (const [v, shown] of [['2.5', '2.5'], ['2.5.1^X', '2.5.1'], ['', '2.5'], ['   ', '2.5'], ['2.3', '2.3']]) {
    const r = env.acknowledge(msh(v), { now });
    assert.equal(r.ok, true, JSON.stringify(v));
    assert.match(r.text.split('\n')[0], new RegExp('\\|T\\|' + shown.replace(/\./g, '\\.') + '$'));
    assert.deepEqual(validate(parse(r.text), { includeParseIssues: true }).filter((i) => i.severity !== 'info'), [], JSON.stringify(v));
  }
});

test('R6: damaged headers of every corpus message never give an acknowledgement with an error or a warning (single-character damage near the header)', () => {
  const dir = path.join(__dirname, 'fixtures', 'corpus');
  let made = 0;
  let refused = 0;
  const now = new Date(2024, 2, 11, 10, 15, 30);
  for (const format of ['hl7', 'x12', 'edifact']) {
    for (const name of fs.readdirSync(path.join(dir, format)).sort()) {
      const src = fs.readFileSync(path.join(dir, format, name), 'utf8');
      const end = Math.min(src.length, format === 'hl7' ? 150 : 120);
      for (let at = 0; at < end; at += 1) {
        for (const text of [src.slice(0, at) + src.slice(at + 1), src.slice(0, at) + src.slice(at + 10), src.slice(0, at) + '|' + src.slice(at + 1)]) {
          const r = env.acknowledge(text, { now });
          if (!r.ok) { refused++; continue; }
          made++;
          const bad = validate(parse(r.text), { includeParseIssues: true }).filter((i) => i.severity === 'error' || i.severity === 'warning');
          assert.deepEqual(bad.map((i) => i.code), [], name + ' at ' + at);
        }
      }
    }
  }
  assert.ok(made > 1000 && refused > 500, made + ' made, ' + refused + ' refused');
});

// ---- R7: a trial record from the future ---------------------------------------------------------------------------

test('R7: a trial whose start and last use are both far in the future counts as ended and is written back as ended', async () => {
  const st = stores();
  const clock = { t: 1700000000000 };
  const licence = createLicence({ secrets: st.secrets, globalState: st.globalState, now: () => clock.t, fetch: async () => ({ status: 404, json: async () => ({}) }) });
  st.stateMap.set(TRIAL_KEYS.startedAt, clock.t + 1000 * DAY);
  st.stateMap.set(TRIAL_KEYS.lastSeenAt, clock.t + 1000 * DAY);
  const s = licence.trialStatus();
  assert.equal(s.state, 'expired');
  assert.equal(s.daysLeft, 0);
  assert.ok(s.endsAt <= clock.t, 'it did not end in the future');
  assert.equal(await licence.hasAccess(), false);
  await licence.touchTrial();
  assert.ok(st.stateMap.get(TRIAL_KEYS.startedAt) <= clock.t - 14 * DAY + 1, 'the record was written back as a trial that has ended');
  assert.equal(st.stateMap.get(TRIAL_KEYS.lastSeenAt), 1700000000000 + 1000 * DAY, 'the last use never moves backwards');
  assert.equal(licence.trialStatus().state, 'expired');
  clock.t += 2000 * DAY;
  assert.equal(licence.trialStatus().state, 'expired', 'it stays ended when the clock passes the old date');
  assert.match(messages.licenceStatusText({ pro: false, hasKey: false, mode: 'live', trial: licence.trialStatus() }), /Free\. Your 14-day Pro trial ended on/);
});

test('R7: a clock set back by a few days still does not stretch the trial, and a start a few hours ahead is left alone', async () => {
  const st = stores();
  const clock = { t: 1700000000000 };
  const licence = createLicence({ secrets: st.secrets, globalState: st.globalState, now: () => clock.t, fetch: async () => ({ status: 404, json: async () => ({}) }) });
  await licence.startTrial();
  clock.t += 10 * DAY;
  await licence.touchTrial();
  clock.t -= 9 * DAY;
  assert.equal(licence.trialStatus().daysLeft, 4, 'the last use wins over an earlier clock');
  clock.t += 9 * DAY + 3 * 3600 * 1000;
  st.stateMap.set(TRIAL_KEYS.startedAt, clock.t + 3 * 3600 * 1000);
  assert.equal(licence.trialStatus().state, 'active');
});

// ---- R8: the wording of the FAQ and the docs --------------------------------------------------------------------------

test('R8: other editors are not claimed to work, and the Linux keyring case is described as it behaves', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('Editors built on the same extension interface run it as well'));
  assert.match(readme, /should run it as well; they were not tested/);
  assert.match(readme, /On Linux without a keyring the editor may keep the licence key only until it is closed: enter it again after a restart \(no further activation is used\)/);
  for (const f of ['README.md', 'docs/licence.md', 'docs/troubleshooting.md']) {
    const text = read(f);
    assert.ok(!text.includes('where no credential store exists, the key cannot be saved'), f);
    assert.ok(!text.includes('in editors without a credential store the key cannot be saved'), f);
    assert.ok(!text.includes('The editor has no credential store (Linux without a keyring, some containers). The activation was released again.'), f);
  }
  assert.match(read('docs/licence.md'), /only until it is closed[\s\S]*enter it again after a restart: no further activation is used/);
  assert.match(read('docs/troubleshooting.md'), /only until it is closed[\s\S]*Editors other than VS Code were not tested/);
});

// ---- Anonymise: distinct replacements, the key, the seed ----------------------------------------------------------------

const CTX = { format: 'x12', release: '', escape: '', fixedWidth: false };

test('anonymise: 50,000 distinct six-digit values get 50,000 distinct replacements of the same shape', () => {
  const rw = anon.createRewriter('many values');
  const seen = new Set();
  for (let i = 0; i < 50000; i++) {
    const original = String(100000 + i * 7);
    const out = rw.rewrite('pseudonym', original, CTX).value;
    assert.match(out, /^\d{6}$/);
    assert.notEqual(out, original);
    seen.add(out);
  }
  assert.equal(seen.size, 50000, 'two different values shared a replacement');
  assert.equal(rw.distinct(), true);
  assert.equal(rw.collisions(), 0);
  // The same value finds the same replacement again.
  assert.equal(rw.rewrite('pseudonym', '100007', CTX).value, rw.rewrite('pseudonym', '100007', CTX).value);
});

test('anonymise: all ten one-digit values and all 676 two-letter values are kept apart', () => {
  const digits = anon.createRewriter('digits');
  const out = [];
  for (let d = 0; d < 10; d++) out.push(digits.rewrite('pseudonym', String(d), CTX).value);
  assert.equal(new Set(out).size, 10);
  assert.equal(digits.distinct(), true);
  assert.ok(out.filter((v, d) => v === String(d)).length <= 1, 'a digit stays as it is only when it is the one replacement left');
  const letters = anon.createRewriter('letters');
  const pairs = [];
  for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) pairs.push(String.fromCharCode(65 + a) + String.fromCharCode(65 + b));
  const replaced = pairs.map((p) => letters.rewrite('pseudonym', p, CTX).value);
  assert.equal(new Set(replaced).size, 676);
  assert.ok(replaced.every((v) => /^[A-Z]{2}$/.test(v)));
  assert.equal(letters.distinct(), true);
  // Names: pseudonym and fake-name replacements of different values do not meet either.
  const mixed = anon.createRewriter('mixed');
  const names = [];
  for (let i = 0; i < 3000; i++) {
    const original = 'Name' + String(1000 + i);
    names.push(mixed.rewrite(i % 2 ? 'fake-name' : 'pseudonym', original, CTX).value);
  }
  assert.equal(new Set(names).size, 3000);
});

test('anonymise: when a shape has more values than replacements the run says so instead of hiding it', () => {
  const rw = anon.createRewriter('overfull');
  for (let d = 0; d < 10; d++) rw.rewrite('pseudonym', String(d), CTX);
  assert.equal(rw.distinct(), true);
  rw.rewrite('fake-name', '5', CTX); // an eleventh (value, action) pair for ten one-digit replacements
  assert.equal(rw.distinct(), false);
  assert.equal(rw.collisions(), 1);
  assert.match(anon.toReport([], { seeded: true, distinct: false }), /Warning: in this run two different original values may have received the same replacement/);
  assert.match(anon.toReport([], { seeded: true, distinct: true }), /Different original values received different replacements throughout this run\./);
});

test('anonymise: 400 distinct three-digit identifiers in one HL7 message keep 400 distinct replacements and the message stays valid', () => {
  const lines = ['MSH|^~\\&|APP|FAC|APP2|FAC2|20240305101500||ADT^A01|MSG1|P|2.5'];
  for (let i = 0; i < 400; i++) lines.push('PID|1||' + String(100 + i * 2));
  const text = lines.join('\r') + '\r';
  const compiled = anon.compile({ profiles: [], rules: [{ format: 'hl7', path: 'PID-3', action: 'pseudonym' }] }, [], { envelopeIds: 'keep' });
  const r = anon.anonymiseText(text, compiled, { seed: 'ids' });
  assert.equal(r.ok, true);
  const ids = r.text.split('\r').filter((l) => l.startsWith('PID|')).map((l) => l.split('|')[3]);
  assert.equal(ids.length, 400);
  assert.equal(new Set(ids).size, 400, 'two patients shared one replacement');
  assert.equal(r.rewriter.distinct(), true);
  assert.deepEqual(validate(parse(r.text), { includeParseIssues: true }).filter((i) => i.severity === 'error'), []);
});

test('anonymise: the default key is 32 random bytes, every replacement is HMAC-SHA256, and a given seed is the HMAC key itself', () => {
  const originalRandom = crypto.randomBytes;
  const originalHmac = crypto.createHmac;
  const asked = [];
  const hmacs = [];
  crypto.randomBytes = (n) => { asked.push(n); return originalRandom(n); };
  crypto.createHmac = (alg, key) => { hmacs.push([alg, String(key)]); return originalHmac(alg, key); };
  try {
    const noSeed = anon.createRewriter();
    noSeed.rewrite('pseudonym', 'PATIENT-0001', CTX);
    noSeed.rewrite('fake-date', '20240101', CTX);
    assert.deepEqual(asked, [32]);
    assert.ok(hmacs.length >= 2 && hmacs.every(([alg]) => alg === 'sha256'));
    assert.equal(new Set(hmacs.map(([, key]) => key)).size, 1, 'one key per run');
    assert.match(hmacs[0][1], /^[0-9a-f]{64}$/, 'the key is the 32 random bytes');
    hmacs.length = 0;
    asked.length = 0;
    const seeded = anon.createRewriter('my seed');
    seeded.rewrite('pseudonym', 'PATIENT-0001', CTX);
    assert.deepEqual(asked, [], 'a given seed draws no random bytes');
    assert.ok(hmacs.length >= 2 && hmacs.every(([alg, key]) => alg === 'sha256' && key === 'my seed'));
  } finally {
    crypto.randomBytes = originalRandom;
    crypto.createHmac = originalHmac;
  }
  // Without a seed two runs differ; with the same seed they agree, and anybody holding the seed can recompute them.
  const a = anon.createRewriter().rewrite('pseudonym', 'PATIENT-0001', CTX).value;
  const b = anon.createRewriter().rewrite('pseudonym', 'PATIENT-0001', CTX).value;
  assert.notEqual(a, b);
  assert.equal(anon.createRewriter('s1').rewrite('pseudonym', 'PATIENT-0001', CTX).value, anon.createRewriter('s1').rewrite('pseudonym', 'PATIENT-0001', CTX).value);
  assert.notEqual(anon.createRewriter('s1').rewrite('pseudonym', 'PATIENT-0001', CTX).value, anon.createRewriter('s2').rewrite('pseudonym', 'PATIENT-0001', CTX).value);
});

test('anonymise: the documentation says how the key is made and that a seed makes the mapping reproducible by whoever holds it', () => {
  const doc = read('docs/anonymise.md');
  assert.match(doc, /HMAC-SHA256/);
  assert.match(doc, /32 random bytes/);
  assert.match(doc, /crypto\.randomBytes/);
  assert.match(doc, /Anybody who holds the seed can reproduce the whole mapping/);
  assert.match(doc, /it is not stretched/);
  assert.match(doc, /two different original values never get the same replacement/);
  assert.match(doc, /a later run with the same seed over the same files gives the same replacements/);
  assert.match(doc, /With other files, such as a second batch, a value whose replacement had to move to stay distinct can get another one/);
  const readme = read('README.md');
  assert.match(readme, /A seed you give makes the replacements reproducible for the same files and rules by anyone who holds that seed/);
  assert.match(readme, /With other files, a value whose replacement had to move to stay distinct can get another one/);
  assert.match(readme, /two different values never get the same replacement/);
});

// ---- Identity: no personal name, personal site or personal mail address in the extension or its repository ------------

test('identity: publisher, links and legal texts name Small Steps Studio and no person', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.publisher, 'SmallStepsStudio');
  assert.equal(pkg.version, '0.2.1');
  assert.equal(pkg.homepage, 'https://github.com/small-steps-studio/edi-lens#readme');
  assert.equal(pkg.repository.url, 'https://github.com/small-steps-studio/edi-lens');
  assert.equal(pkg.bugs.url, 'https://github.com/small-steps-studio/edi-lens/issues');
  assert.equal(config.issuesUrl, 'https://github.com/small-steps-studio/edi-lens/issues');
  assert.equal(config.docsUrl, 'https://github.com/small-steps-studio/edi-lens#readme');
  assert.equal(config.repositoryUrl, 'https://github.com/small-steps-studio/edi-lens');
  assert.match(read('LICENSE.txt'), /Copyright \(c\) 2026 Small Steps Studio\./);
  assert.match(read('PRIVACY.md'), /small-steps-studio\/edi-lens\/issues/);
  assert.match(read('TERMS.md'), /small-steps-studio\/edi-lens\/issues/);
  // The walkthrough command opens the walkthrough of this extension id.
  assert.match(read('src/commands.js'), /'SmallStepsStudio\.edi-lens-viewer#ediLens\.gettingStarted'/);
});

test('identity: no file of the extension or of its public repository holds a personal name, a personal site or a personal mail address', () => {
  const words = new RegExp(['ima' + 'd', 'murat' + 'spahic', 'car' + 'rd', 'gma' + 'il'].join('|'), 'i');
  // The files of the public repository are the ones the repository's own ignore rules leave in.
  const rules = gitignoreRules('');
  const ignored = (rel) => rules.some((re) => re.test(rel));
  const hits = [];
  let scanned = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = (dir ? dir + '/' : '') + entry.name;
      if (entry.name === '.git' || ignored(rel)) continue;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (/\.(png|vsix|mp4)$/.test(entry.name)) continue;
      scanned++;
      if (words.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) hits.push(rel);
    }
  }
  walk('');
  assert.ok(scanned > 100, scanned + ' files scanned');
  assert.deepEqual(hits, []);
});

test('R1: git on Windows, which reads .gitignore without regard to case, leaves no source, documentation or workflow file out of the public repository', () => {
  const rules = gitignoreRules('i');
  const ignored = (rel) => rules.some((re) => re.test(rel));
  const left = [];
  let checked = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = (dir ? dir + '/' : '') + entry.name;
      if (entry.isDirectory()) { walk(rel); continue; }
      checked++;
      if (ignored(rel)) left.push(rel);
    }
  }
  for (const dir of ['src', 'docs', 'schemas', 'syntaxes', 'media', '.github']) walk(dir);
  assert.ok(checked > 60, checked + ' files checked');
  assert.deepEqual(left, [], 'these files would be left out of the repository by a case-insensitive reading of .gitignore');
  for (const f of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'TERMS.md', 'PRIVACY.md', 'language-configuration.json', '.gitattributes', '.gitignore']) assert.equal(ignored(f), false, f);
  // The tests that ship are all tests except the private ones and the smoke harness.
  for (const f of fs.readdirSync(__dirname).filter((n) => /\.js$/.test(n) && !/^private\./.test(n))) assert.equal(ignored('test/' + f), false, 'test/' + f);
  // The rules still keep the working notes and tools out.
  for (const f of ['STATUS-0.2.1.md', 'QA-0.2.1.md', ['RELEASE', 'NOTES-0.2.1.md'].join('-'), ['PRE', 'RELEASE', 'CHECKLIST.md'].join('-'), 'SPEC.md', 'scripts/tool.js', 'test/smoke/run.js', 'test/private.example.test.js', 'demo/x.py', 'edi-lens-0.2.1.vsix']) assert.equal(ignored(f), true, f);
});
