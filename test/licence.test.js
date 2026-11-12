'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { createLicence, instanceName, platformLabel, CACHE_MS, GRACE_MS } = require('../src/licence/licence');
const config = require('../src/licence/config');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const KEY = 'TESTKEY-1234-ABCD-5678';

function fakeStores() {
  const secretMap = new Map();
  const stateMap = new Map();
  return {
    secrets: {
      get: async (k) => secretMap.get(k),
      store: async (k, v) => { secretMap.set(k, v); },
      delete: async (k) => { secretMap.delete(k); }
    },
    globalState: {
      get: (k) => stateMap.get(k),
      update: async (k, v) => { if (v === undefined) stateMap.delete(k); else stateMap.set(k, v); }
    },
    secretMap,
    stateMap
  };
}

// Builds a fetch stub driven by a handler(path, body) returning { status, body } or throwing.
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const parsed = new URL(url);
    const body = JSON.parse(init.body);
    calls.push({ url, path: parsed.pathname, host: parsed.origin, body, init });
    const r = await handler(parsed.pathname, body, calls.length, parsed.host);
    return { status: r.status, json: async () => { if (r.body === undefined) throw new Error('empty'); return r.body; } };
  };
  fn.calls = calls;
  return fn;
}

function setup(handler, extra) {
  const stores = fakeStores();
  const clock = { t: 1700000000000 };
  const fetchStub = fakeFetch(handler);
  const licence = createLicence(Object.assign({
    secrets: stores.secrets,
    globalState: stores.globalState,
    fetch: fetchStub,
    now: () => clock.t,
    platform: 'win32'
  }, extra || {}));
  return { licence, stores, clock, fetchStub };
}

// The answer of the licence server to an activation, as documented: the instance id, the product
// and the buyer (which the extension must not keep).
function activation(id, productId) {
  return {
    id: id, business_id: 'bus_1', name: 'VS Code on Windows', license_key_id: 'lic_1', created_at: '2024-03-05T10:15:00Z',
    product: { product_id: productId, name: 'EDI Lens Pro' },
    customer: { customer_id: 'cus_1', name: 'Mira Hartwell', email: 'mira.hartwell@example.invalid', phone_number: '555-0142', metadata: { team: 'integration-desk' } }
  };
}

const okHandler = (path, body, n, host) => {
  const products = /^test\./.test(host || '') ? config.products.test : config.products.live;
  if (path === '/licenses/activate') return { status: 200, body: activation('lki_instance_1', products.personal) };
  if (path === '/licenses/validate') return { status: 200, body: { valid: true } };
  if (path === '/licenses/deactivate') return { status: 204 };
  return { status: 404 };
};

test('instance name is "VS Code on <platform>" and never the host name', async () => {
  assert.equal(instanceName('win32'), 'VS Code on Windows');
  assert.equal(instanceName('darwin'), 'VS Code on macOS');
  assert.equal(instanceName('linux'), 'VS Code on Linux');
  assert.equal(platformLabel('freebsd'), 'freebsd');
  const env = setup(okHandler);
  const r = await env.licence.activate(KEY);
  assert.equal(r.ok, true);
  const body = env.fetchStub.calls[0].body;
  assert.equal(body.name, 'VS Code on Windows');
  assert.notEqual(body.name, os.hostname());
  assert.ok(!JSON.stringify(body).includes(os.hostname()) || os.hostname().length < 3);
});

test('activate success stores key in secrets and instance id in global state', async () => {
  const env = setup(okHandler);
  const r = await env.licence.activate('  ' + KEY + '  ');
  assert.deepEqual(r, { ok: true, licenceType: 'personal' });
  assert.equal(env.fetchStub.calls[0].path, '/licenses/activate');
  assert.equal(env.fetchStub.calls[0].body.license_key, KEY);
  assert.equal(env.fetchStub.calls[0].host, 'https://live.dodopayments.com');
  assert.equal(env.fetchStub.calls[0].init.method, 'POST');
  assert.equal([...env.stores.secretMap.values()][0], KEY);
  assert.ok([...env.stores.stateMap.values()].includes('lki_instance_1'));
  // The key is never kept in global state.
  assert.ok(![...env.stores.stateMap.values()].includes(KEY));
});

test('activate accepts HTTP 201 as success', async () => {
  const env = setup(() => ({ status: 201, body: activation('lki_2', config.products.live.business) }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: true, licenceType: 'business' });
});

test('activate reports the activation limit (HTTP 422)', async () => {
  const env = setup(() => ({ status: 422, body: { message: 'limit' } }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'limit', hasStored: false });
  assert.equal(env.stores.secretMap.size, 0);
  assert.equal(env.stores.stateMap.size, 0);
});

test('activate reports an unknown key (HTTP 400 and 404) and an inactive key (HTTP 403)', async () => {
  for (const status of [400, 404]) {
    const env = setup(() => ({ status, body: {} }));
    assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'invalid' });
    assert.equal(env.stores.secretMap.size, 0);
  }
  const env = setup(() => ({ status: 403, body: {} }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'inactive' });
  assert.equal(env.stores.secretMap.size, 0);
});

test('activate rejects malformed keys without any network call', async () => {
  const env = setup(okHandler);
  for (const bad of ['', '   ', 'has space inside', 'x'.repeat(300), null, undefined, 42]) {
    assert.deepEqual(await env.licence.activate(bad), { ok: false, reason: 'invalid' });
  }
  assert.equal(env.fetchStub.calls.length, 0);
});

test('activate reports an unreachable server as "network"', async () => {
  const env = setup(() => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'network' });
  assert.equal(env.stores.secretMap.size, 0);
});

test('activate reports other statuses with the HTTP status', async () => {
  const env = setup(() => ({ status: 500, body: {} }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'error', status: 500 });
  const env2 = setup(() => ({ status: 200, body: {} }));
  assert.deepEqual(await env2.licence.activate(KEY), { ok: false, reason: 'error', status: 200 });
});

test('activate tolerates an empty response body', async () => {
  const env = setup(() => ({ status: 404 }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'invalid' });
});

test('isPro is false without a key and makes no network call', async () => {
  const env = setup(okHandler);
  assert.equal(await env.licence.isPro(), false);
  assert.equal(env.fetchStub.calls.length, 0);
});

test('isPro right after activation is true and uses the cache for 24 hours', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  const callsAfterActivate = env.fetchStub.calls.length;
  assert.equal(await env.licence.isPro(), true);
  env.clock.t += 23 * HOUR;
  assert.equal(await env.licence.isPro(), true);
  assert.equal(env.fetchStub.calls.length, callsAfterActivate, 'no validation inside the 24 h cache');
  env.clock.t += 2 * HOUR; // 25 h after activation
  assert.equal(await env.licence.isPro(), true);
  assert.equal(env.fetchStub.calls.length, callsAfterActivate + 1);
  const last = env.fetchStub.calls[env.fetchStub.calls.length - 1];
  assert.equal(last.path, '/licenses/validate');
  assert.equal(last.body.license_key, KEY);
  assert.equal(last.body.license_key_instance_id, 'lki_instance_1');
  assert.equal(CACHE_MS, DAY);
});

test('a rejected validation ({"valid": false}) turns Pro off and is cached', async () => {
  let valid = true;
  const env = setup((path) => {
    if (path === '/licenses/validate') return { status: 200, body: { valid } };
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  valid = false;
  env.clock.t += DAY + HOUR;
  assert.equal(await env.licence.isPro(), false);
  const n = env.fetchStub.calls.length;
  assert.equal(await env.licence.isPro(), false);
  assert.equal(env.fetchStub.calls.length, n, 'rejection is cached for 24 h');
  const st = await env.licence.status(false);
  assert.equal(st.via, 'rejected');
  assert.equal(st.pro, false);
});

test('HTTP 403 on validation is a definitive rejection (no grace)', async () => {
  const env = setup((path) => {
    if (path === '/licenses/validate') return { status: 403, body: {} };
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  env.clock.t += 2 * DAY;
  assert.equal(await env.licence.isPro(), false);
});

test('offline: the last good validation keeps Pro for 14 days', async () => {
  let offline = false;
  const env = setup((path) => {
    if (offline && path === '/licenses/validate') throw new Error('offline');
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  offline = true;

  env.clock.t += 2 * DAY;
  assert.equal(await env.licence.isPro(), true);
  let st = await env.licence.status(false);
  assert.equal(st.via, 'grace');
  assert.ok(st.graceEndsAt > env.clock.t);

  env.clock.t += 11 * DAY; // 13 days after the last good check
  assert.equal(await env.licence.isPro(), true);

  env.clock.t += 2 * DAY; // 15 days
  assert.equal(await env.licence.isPro(), false);
  st = await env.licence.status(false);
  assert.equal(st.via, 'expired');
  assert.equal(GRACE_MS, 14 * DAY);
});

test('offline: grace ends exactly after 14 days', async () => {
  let offline = false;
  const env = setup((path) => {
    if (offline && path === '/licenses/validate') throw new Error('offline');
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  offline = true;
  env.clock.t += 14 * DAY - 1000;
  assert.equal(await env.licence.isPro(), true);
  env.clock.t += 2000;
  assert.equal(await env.licence.isPro(), false);
});

test('server errors (5xx) use the grace period instead of failing hard', async () => {
  let broken = false;
  const env = setup((path) => {
    if (broken && path === '/licenses/validate') return { status: 503, body: {} };
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  broken = true;
  env.clock.t += 3 * DAY;
  assert.equal(await env.licence.isPro(), true);
});

test('offline checks back off instead of hitting the network on every call', async () => {
  let offline = false;
  const env = setup((path) => {
    if (offline && path === '/licenses/validate') throw new Error('offline');
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  offline = true;
  env.clock.t += 2 * DAY;
  const before = env.fetchStub.calls.length;
  for (let i = 0; i < 5; i++) assert.equal(await env.licence.isPro(), true);
  assert.equal(env.fetchStub.calls.length, before + 1, 'one attempt, then back-off');
  env.clock.t += 6 * 60 * 1000;
  await env.licence.isPro();
  assert.equal(env.fetchStub.calls.length, before + 2, 'retries after the back-off');
});

test('a clock set far back never extends the grace period', async () => {
  let offline = false;
  const env = setup((path) => {
    if (offline && path === '/licenses/validate') throw new Error('offline');
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  offline = true;
  env.clock.t -= 30 * DAY;
  assert.equal(await env.licence.isPro(), false);
});

test('concurrent isPro calls share a single validation', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  env.clock.t += 2 * DAY;
  const before = env.fetchStub.calls.length;
  const results = await Promise.all([env.licence.isPro(), env.licence.isPro(), env.licence.isPro()]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(env.fetchStub.calls.length, before + 1);
});

test('isPro never throws, even when storage fails', async () => {
  const env = setup(okHandler);
  env.stores.secrets.get = async () => { throw new Error('secret storage unavailable'); };
  assert.equal(await env.licence.isPro(), false);
  const st = await env.licence.status(true);
  assert.equal(st.pro, false);
});

test('status(true) bypasses the cache and never exposes the full key', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  const n = env.fetchStub.calls.length;
  const st = await env.licence.status(true);
  assert.equal(env.fetchStub.calls.length, n + 1);
  assert.equal(st.pro, true);
  assert.equal(st.via, 'server');
  assert.equal(st.mode, 'live');
  assert.equal(st.keyHint, '...' + KEY.slice(-4));
  assert.ok(!JSON.stringify(st).includes(KEY));
});

test('remove deactivates on the server and clears all local state', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  const r = await env.licence.remove();
  assert.deepEqual(r, { ok: true, deactivated: true });
  const last = env.fetchStub.calls[env.fetchStub.calls.length - 1];
  assert.equal(last.path, '/licenses/deactivate');
  assert.equal(last.body.license_key_instance_id, 'lki_instance_1');
  assert.equal(env.stores.secretMap.size, 0);
  assert.equal(env.stores.stateMap.size, 0);
  assert.equal(await env.licence.isPro(), false);
});

test('remove while offline still clears the local key and says so', async () => {
  let offline = false;
  const env = setup((path) => {
    if (offline) throw new Error('offline');
    return okHandler(path);
  });
  await env.licence.activate(KEY);
  offline = true;
  const r = await env.licence.remove();
  assert.deepEqual(r, { ok: true, deactivated: false });
  assert.equal(env.stores.secretMap.size, 0);
  assert.equal(env.stores.stateMap.size, 0);
});

test('remove with nothing stored is harmless', async () => {
  const env = setup(okHandler);
  assert.deepEqual(await env.licence.remove(), { ok: true, deactivated: true });
  assert.equal(env.fetchStub.calls.length, 0);
});

test('the licence mode selects the server and keeps the environments apart', async () => {
  let mode = 'test';
  const env = setup(okHandler, { getMode: () => mode });
  await env.licence.activate(KEY);
  assert.equal(env.fetchStub.calls[0].host, 'https://test.dodopayments.com');
  assert.equal(await env.licence.isPro(), true);
  mode = 'live';
  assert.equal(await env.licence.isPro(), false, 'a test key is not a live licence');
  await env.licence.activate(KEY);
  assert.equal(env.fetchStub.calls[env.fetchStub.calls.length - 1].host, 'https://live.dodopayments.com');
  assert.equal(await env.licence.isPro(), true);
  mode = 'nonsense';
  assert.equal(config.resolve(mode).mode, config.mode);
});

test('without a usable fetch every network action fails gracefully', async () => {
  const stores = fakeStores();
  const licence = createLicence({ secrets: stores.secrets, globalState: stores.globalState, fetch: null });
  // Node 18+ has a global fetch; force "missing" by passing a non-function sentinel.
  const licence2 = createLicence({ secrets: stores.secrets, globalState: stores.globalState, fetch: 'nope' });
  assert.equal(await licence2.isPro(), false);
  const r = await licence2.activate(KEY);
  assert.deepEqual(r, { ok: false, reason: 'network' });
  assert.equal(typeof licence.isPro, 'function');
});

test('config: resolve picks the matching environment', () => {
  assert.deepEqual(config.resolve('test'), { mode: 'test', api: 'https://test.dodopayments.com', buyUrl: config.buyUrlTest });
  assert.deepEqual(config.resolve('live'), { mode: 'live', api: 'https://live.dodopayments.com', buyUrl: config.buyUrlLive });
  assert.equal(config.resolve('weird').mode, config.mode);
  assert.equal(config.apiBaseTest, 'https://test.dodopayments.com');
  assert.equal(config.apiBaseLive, 'https://live.dodopayments.com');
});

test('config: the release check refuses a build that is not live, offers the environment as a setting or has a wrong buy link', () => {
  const saved = { mode: config.mode, url: config.buyUrlLive };
  try {
    config.mode = 'test';
    assert.throws(() => config.assertShippable({}), /built-in licence mode must be live/);
    config.mode = 'live';
    assert.throws(() => config.assertShippable({
      contributes: { configuration: { properties: { 'ediLens.licenceMode': { default: 'live' } } } }
    }), /must not offer the licence environment as a setting/);
    config.buyUrlLive = '';
    assert.throws(() => config.assertShippable({}), /buyUrlLive is empty/);
    config.buyUrlLive = 'http://insecure.example/buy';
    assert.throws(() => config.assertShippable({}), /https/);
    config.buyUrlLive = 'https://checkout.example/buy/abc';
    assert.throws(() => config.assertShippable({}), /does not contain productIdLive/);
    config.buyUrlLive = 'https://checkout.example/buy/' + config.productIdLive;
    assert.throws(() => config.assertShippable({}), /not the Personal checkout link/);
    config.buyUrlLive = saved.url;
    assert.equal(config.assertShippable({}), true);
  } finally {
    config.mode = saved.mode;
    config.buyUrlLive = saved.url;
  }
});

test('the shipped build is in live mode and points at the live product only', () => {
  assert.equal(config.mode, 'live');
  assert.equal(config.productIdLive, 'pdt_0NriIrMqPm9xOakMMZtw4');
  assert.equal(config.buyUrlLive, 'https://checkout.dodopayments.com/buy/' + config.productIdLive + '?quantity=1');
  assert.equal(config.resolve(undefined).api, 'https://live.dodopayments.com');
  assert.equal(config.resolve(undefined).buyUrl, config.buyUrlLive);
  assert.ok(!/test/i.test(config.buyUrlLive) && !/test/i.test(config.apiBaseLive));
});

test('the shipped package manifest passes the release check', () => {
  assert.equal(config.assertShippable(require('../package.json')), true);
});

// ---- trial ---------------------------------------------------------------------------------

const { TRIAL_MS, TRIAL_KEYS } = require('../src/licence/licence');

test('trial: the length is one constant, 14 days, shared by the licence module and the configuration', () => {
  assert.equal(config.trialDays, 14);
  assert.equal(TRIAL_MS, config.trialDays * DAY);
  assert.equal(GRACE_MS, config.graceDays * DAY);
  assert.equal(CACHE_MS, config.cacheHours * HOUR);
});

test('trial: unused until started, then active with a day count, then expired; never any network', async () => {
  const env = setup(okHandler);
  let st = env.licence.trialStatus();
  assert.deepEqual(st, { state: 'unused', startedAt: 0, endsAt: 0, daysLeft: 14, lastNoticeAt: 0 });
  assert.equal(await env.licence.hasAccess(), false);

  st = await env.licence.startTrial();
  assert.equal(st.state, 'active');
  assert.equal(st.startedAt, env.clock.t);
  assert.equal(st.endsAt, env.clock.t + 14 * DAY);
  assert.equal(st.daysLeft, 14);
  assert.equal(await env.licence.hasAccess(), true);
  assert.equal(await env.licence.isPro(), false, 'a trial is not a licence');

  env.clock.t += 13 * DAY + 12 * HOUR;
  st = env.licence.trialStatus();
  assert.equal(st.state, 'active');
  assert.equal(st.daysLeft, 1, 'the last day counts as 1');
  env.clock.t += 12 * HOUR;
  st = env.licence.trialStatus();
  assert.equal(st.state, 'expired');
  assert.equal(st.daysLeft, 0);
  assert.equal(await env.licence.hasAccess(), false);
  assert.equal(env.fetchStub.calls.length, 0, 'the trial never touches the network');
  assert.deepEqual(await env.licence.startTrial(), st, 'an expired trial cannot be restarted');
});

test('trial: the day count steps down once a day and is never above 14 or below 1 while active', async () => {
  const env = setup(okHandler);
  await env.licence.startTrial();
  const seen = [];
  for (let h = 0; h < 14 * 24; h += 6) {
    env.clock.t = 1700000000000 + h * HOUR;
    const st = env.licence.trialStatus();
    assert.equal(st.state, 'active', 'hour ' + h);
    assert.ok(st.daysLeft >= 1 && st.daysLeft <= 14, 'hour ' + h);
    seen.push(st.daysLeft);
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1], 'days left never grows');
  assert.equal(seen[0], 14);
  assert.equal(seen[seen.length - 1], 1);
});

test('trial: a clock set back does not stretch the trial', async () => {
  const env = setup(okHandler);
  await env.licence.startTrial();
  env.clock.t += 10 * DAY;
  await env.licence.touchTrial();
  assert.equal(env.licence.trialStatus().daysLeft, 4);
  env.clock.t -= 9 * DAY;
  assert.equal(env.licence.trialStatus().daysLeft, 4, 'the last seen time wins over an earlier clock');
  env.clock.t += 20 * DAY;
  assert.equal(env.licence.trialStatus().state, 'expired');
  await env.licence.touchTrial();
  env.clock.t -= 30 * DAY;
  assert.equal(env.licence.trialStatus().state, 'expired', 'nor does a clock far in the past');
  await env.licence.touchTrial();
  assert.equal(env.stores.stateMap.get(TRIAL_KEYS.lastSeenAt), 1700000000000 + 21 * DAY, 'the last seen time never moves backwards');
});

test('trial: the reminder is granted at most once every 24 hours', async () => {
  const env = setup(okHandler);
  await env.licence.startTrial();
  assert.equal(await env.licence.noteTrialReminder(), true);
  assert.equal(await env.licence.noteTrialReminder(), false);
  env.clock.t += 23 * HOUR;
  assert.equal(await env.licence.noteTrialReminder(), false);
  env.clock.t += 2 * HOUR;
  assert.equal(await env.licence.noteTrialReminder(), true);
  assert.equal(await env.licence.noteTrialReminder(), false);
  assert.equal(env.licence.trialStatus().lastNoticeAt, env.clock.t);
});

test('trial: when the state store refuses the write nothing is recorded and the result says so', async () => {
  const env = setup(okHandler);
  env.stores.globalState.update = async () => { throw new Error('read-only'); };
  const st = await env.licence.startTrial();
  assert.equal(st.state, 'unavailable');
  assert.equal(env.stores.stateMap.size, 0);
  assert.equal(env.licence.trialStatus().state, 'unused');
  assert.equal(await env.licence.noteTrialReminder(), true, 'a failed reminder write still lets the message through once');
  await env.licence.touchTrial();
});

test('trial: a licence and the trial are independent; remove() keeps the trial record', async () => {
  const env = setup(okHandler);
  await env.licence.startTrial();
  await env.licence.activate(KEY);
  assert.equal(await env.licence.isPro(), true);
  assert.equal(await env.licence.hasAccess(), true);
  const st = await env.licence.status(false);
  assert.equal(st.pro, true);
  assert.equal(st.trial.state, 'active');
  await env.licence.remove();
  assert.equal(env.stores.stateMap.get(TRIAL_KEYS.startedAt), st.trial.startedAt, 'the trial survives the licence removal');
  assert.equal(await env.licence.hasAccess(), true, 'the trial still runs');
  env.clock.t += 15 * DAY;
  assert.equal(await env.licence.hasAccess(), false);
  assert.equal((await env.licence.status(false)).trial.state, 'expired');
});

test('trial: the key names are stable (they are what an installed editor already has on disk)', () => {
  assert.deepEqual(TRIAL_KEYS, { startedAt: 'trial.startedAt', lastSeenAt: 'trial.lastSeenAt', lastNoticeAt: 'trial.lastNoticeAt' });
});

// ---- product check and licence types -------------------------------------------------------

const messages = require('../src/licence/messages');
const FOREIGN = 'pdt_0ForeignProductOfSameSeller';

test('product list: two products per environment, kept apart, all well formed', () => {
  assert.deepEqual(config.allowedProductIds('live'), [config.products.live.personal, config.products.live.business]);
  assert.deepEqual(config.allowedProductIds('test'), [config.products.test.personal, config.products.test.business]);
  const all = config.allowedProductIds('live').concat(config.allowedProductIds('test'));
  assert.equal(new Set(all).size, 4, 'four different products');
  for (const id of all) assert.match(id, /^pdt_[A-Za-z0-9]{10,60}$/);
  assert.equal(config.products.live.personal, config.productIdLive);
  assert.equal(config.licenceTypeOf('live', config.products.live.personal), 'personal');
  assert.equal(config.licenceTypeOf('live', config.products.live.business), 'business');
  assert.equal(config.licenceTypeOf('live', config.products.test.personal), '', 'a test product is not a live product');
  assert.equal(config.licenceTypeOf('test', config.products.live.business), '');
  for (const bad of [FOREIGN, '', undefined, null, 42, {}, 'pdt_', 'PDT_BUSINESS_LIVE_PLACEHOLDER']) assert.equal(config.licenceTypeOf('live', bad), '');
});

test('a key of the Business product activates and is reported as a Business licence', async () => {
  const env = setup((path) => (path === '/licenses/activate' ? { status: 201, body: activation('lki_b', config.products.live.business) } : { status: 200, body: { valid: true } }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: true, licenceType: 'business' });
  assert.equal(env.stores.stateMap.get('licence.productId.live'), config.products.live.business);
  const st = await env.licence.status(false);
  assert.equal(st.pro, true);
  assert.equal(st.licenceType, 'business');
  assert.match(messages.licenceStatusText(st), /Pro is active on this computer \(Business licence, key \.\.\.5678\)/);
  assert.match(messages.activatedText('business'), /Business licence[\s\S]*colleague/);
});

test('a valid key of another product is refused, the activation is released and nothing is stored', async () => {
  const env = setup((path) => {
    if (path === '/licenses/activate') return { status: 201, body: activation('lki_foreign', FOREIGN) };
    if (path === '/licenses/validate') return { status: 200, body: { valid: true } };
    return { status: 200, body: null };
  });
  const r = await env.licence.activate(KEY);
  assert.deepEqual(r, { ok: false, reason: 'product', released: true });
  assert.deepEqual(env.fetchStub.calls.map((c) => c.path), ['/licenses/activate', '/licenses/deactivate']);
  assert.deepEqual(env.fetchStub.calls[1].body, { license_key: KEY, license_key_instance_id: 'lki_foreign' }, 'the seat of the foreign key is given back');
  assert.equal(env.stores.secretMap.size, 0);
  assert.equal(env.stores.stateMap.size, 0);
  assert.equal(await env.licence.isPro(), false);
  assert.equal(await env.licence.hasAccess(), false);
  assert.match(messages.activationFailureText(r), /This key belongs to another product/);
  assert.match(messages.activationFailureText(r), /released again/);
});

test('a key of the other environment or an answer without a usable product field is refused as well', async () => {
  const answers = [
    [activation('lki_1', config.products.test.personal), 'product'],
    [{ id: 'lki_2' }, 'unverified'],
    [{ id: 'lki_3', product: null }, 'unverified'],
    [{ id: 'lki_4', product: 'pdt_0NriIrMqPm9xOakMMZtw4' }, 'unverified'],
    [{ id: 'lki_5', product: { product_id: 42 } }, 'unverified'],
    [{ id: 'lki_6', product: { product_id: '' } }, 'unverified'],
    [{ id: 'lki_7', product: { name: 'EDI Lens Pro' } }, 'unverified'],
    [{ id: 'lki_8', product: [config.products.live.personal] }, 'unverified'],
    [{ id: 'lki_9', product: { product_id: config.products.live.personal + ' ' } }, 'product'],
    [{ id: 'lki_10', product: { product_id: config.products.live.personal.toUpperCase() } }, 'product']
  ];
  for (const [body, reason] of answers) {
    const env = setup((path) => (path === '/licenses/activate' ? { status: 200, body: body } : { status: 200, body: null }));
    const r = await env.licence.activate(KEY);
    assert.deepEqual(r, { ok: false, reason: reason, released: true }, JSON.stringify(body));
    assert.equal(env.fetchStub.calls.at(-1).path, '/licenses/deactivate', 'released: ' + JSON.stringify(body));
    assert.equal(env.stores.secretMap.size, 0);
    assert.equal(env.stores.stateMap.size, 0);
    assert.equal(await env.licence.isPro(), false);
  }
  assert.match(messages.activationFailureText({ ok: false, reason: 'unverified' }), /did not say which product/);
});

test('a stored product record that is not on the list turns Pro off without any network use', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  assert.equal(await env.licence.isPro(), true);
  const calls = env.fetchStub.calls.length;
  for (const bad of [FOREIGN, '', null, 7]) {
    env.stores.stateMap.set('licence.productId.live', bad);
    assert.equal(await env.licence.isPro(), false, String(bad));
    const st = await env.licence.status(true);
    assert.equal(st.pro, false);
    assert.equal(st.via, 'product');
    assert.match(messages.licenceStatusText(st), /belongs to another product/);
  }
  assert.equal(env.fetchStub.calls.length, calls, 'a foreign product is never validated');
  env.stores.stateMap.set('licence.productId.live', config.products.live.personal);
  assert.equal(await env.licence.isPro(), true);
});

test('a licence stored by 0.1.x (no product record) keeps working and counts as Personal', async () => {
  const env = setup(okHandler);
  env.stores.secretMap.set('licence.key.live', KEY);
  env.stores.stateMap.set('licence.instanceId.live', 'lki_old');
  env.stores.stateMap.set('licence.checkedAt.live', env.clock.t);
  env.stores.stateMap.set('licence.checkedValid.live', true);
  env.stores.stateMap.set('licence.lastGoodAt.live', env.clock.t);
  assert.equal(await env.licence.isPro(), true);
  const st = await env.licence.status(false);
  assert.equal(st.licenceType, 'personal');
  assert.equal(env.stores.stateMap.has('licence.productId.live'), false);
  assert.equal(env.fetchStub.calls.length, 0);
});

test('nothing of the buyer is kept: no name, no e-mail address, no customer id', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  await env.licence.status(true);
  const kept = JSON.stringify([...env.stores.stateMap.entries()]) + JSON.stringify([...env.stores.secretMap.entries()]);
  for (const secret of ['Mira', 'Hartwell', 'example.invalid', 'cus_1', 'bus_1', 'lic_1', '2024-03-05', '555-0142', 'integration-desk', 'EDI Lens Pro']) assert.ok(!kept.includes(secret), secret + ' was stored');
  assert.deepEqual([...env.stores.stateMap.keys()].sort(), ['licence.checkedAt.live', 'licence.checkedValid.live', 'licence.instanceId.live', 'licence.lastGoodAt.live', 'licence.productId.live']);
  assert.deepEqual([...env.stores.secretMap.keys()], ['licence.key.live']);
  const st = await env.licence.status(false);
  for (const secret of ['Mira', 'Hartwell', 'example.invalid', 'cus_1', '555-0142', 'integration-desk']) assert.ok(!JSON.stringify(st).includes(secret));
  // Only the three licence endpoints are ever called, and only with the key, the label and the instance id.
  for (const c of env.fetchStub.calls) {
    assert.ok(['/licenses/activate', '/licenses/validate', '/licenses/deactivate'].includes(c.path));
    assert.ok(Object.keys(c.body).every((k) => ['license_key', 'name', 'license_key_instance_id'].includes(k)));
  }
});

test('remove() clears the product record too', async () => {
  const env = setup(okHandler);
  await env.licence.activate(KEY);
  await env.licence.remove();
  assert.equal(env.stores.stateMap.size, 0);
});

test('checkout links: Personal is always one licence, Business carries the number of users', () => {
  assert.equal(config.buyUrlFor('live', 'personal'), 'https://checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1');
  assert.equal(config.buyUrlFor('live', 'personal', 7), 'https://checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1');
  assert.equal(config.buyUrlFor('live', 'business', 1), 'https://checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=1');
  assert.equal(config.buyUrlFor('live', 'business', 25), 'https://checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=25');
  assert.equal(config.buyUrlFor('live', 'business', 100), 'https://checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=100');
  assert.equal(config.buyUrlFor('test', 'personal'), 'https://test.checkout.dodopayments.com/buy/pdt_0NqrEZaiFzCqjDPsdymnW?quantity=1');
  assert.equal(config.buyUrlFor('test', 'business', 3), 'https://test.checkout.dodopayments.com/buy/pdt_0NrkHV1XKbwlRjMEHbo4V?quantity=3');
  for (const bad of [0, 101, -1, 1.5, '3', NaN, undefined, null, Infinity]) assert.equal(config.buyUrlFor('live', 'business', bad), '', String(bad));
  assert.equal(config.buyUrlFor('live', 'enterprise', 1), '');
  const env = setup(okHandler);
  assert.equal(env.licence.buyUrl(), config.buyUrlLive);
  assert.equal(env.licence.buyUrl('business', 4), 'https://checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=4');
});

test('the number of users is checked: whole numbers from 1 to 100 only', () => {
  assert.equal(messages.businessUsersQuestion(), 'How many users? (1-100)');
  for (const ok of ['1', '7', '100', ' 12 ']) assert.equal(messages.businessUsersError(ok), null, ok);
  for (const bad of ['', '0', '101', '-3', '2.5', '1e2', 'ten', '1 000', '0x10', '१२', undefined, null]) assert.match(String(messages.businessUsersError(bad)), /whole number from 1 to 100/, String(bad));
});

test('the release check refuses a placeholder or malformed product id, and equal products', () => {
  const saved = JSON.parse(JSON.stringify(config.products));
  try {
    config.products.live.business = 'PDT_BUSINESS_LIVE_PLACEHOLDER';
    assert.throws(() => config.assertShippable({}), /live business product id is missing or still a placeholder/);
    assert.deepEqual(config.allowedProductIds('live'), [saved.live.personal], 'a placeholder is never an accepted product');
    assert.equal(config.buyUrlFor('live', 'business', 2), '', 'and has no checkout link');
    config.products.live.business = saved.live.personal;
    assert.throws(() => config.assertShippable({}), /must be different/);
    config.products.live.business = saved.live.business;
    delete config.products.test.personal;
    assert.throws(() => config.assertShippable({}), /test personal product id is missing/);
  } finally {
    config.products.live = saved.live;
    config.products.test = saved.test;
  }
  assert.equal(config.assertShippable(require('../package.json')), true);
});

test('messages name both licence types and the one sentence about Business seats', () => {
  const notice = messages.proNoticeText('Query', { state: 'unused' });
  assert.match(notice, /Personal USD 29, Business USD 59 per user/);
  assert.match(notice, /each key works on up to 3 computers/);
  const choices = messages.buyChoices();
  assert.deepEqual(choices.map((c) => c.tier), ['personal', 'business']);
  assert.ok(choices[1].detail.includes(config.businessSeatsText));
  assert.match(choices[0].detail, /use at work is allowed/);
  assert.equal(messages.licenceTypeLabel('personal'), 'Personal licence');
  assert.equal(messages.licenceTypeLabel('other'), '');
});

// ---- against the stand-in licence service (the answer shapes of the real test service) -------

const { createService } = require('./helpers/licence-service');

// A licence service wired to the stand-in: the same code path as the editor, without a network.
function againstService(serviceOptions) {
  const service = createService(serviceOptions);
  const handler = (path, body) => {
    const answer = service.handle('POST', path, body, 'test.dodopayments.com');
    return { status: answer.status, body: answer.body === null ? undefined : answer.body };
  };
  const env = setup(handler, { getMode: () => 'test' });
  env.service = service;
  return env;
}

test('stand-in service: its answers have the documented shapes (activation with product and customer, validation with valid only)', () => {
  const service = createService();
  const a = service.handle('POST', '/licenses/activate', { license_key: 'MOCK-KEY-BUSINESS', name: 'VS Code on Windows' }, 'test.dodopayments.com');
  assert.equal(service.handle('POST', '/licenses/activate', { license_key: 'MOCK-KEY-BUSINESS' }, 'live.dodopayments.com').body.product.product_id, config.products.live.business, 'the live host answers with the live product');
  service.handle('POST', '/licenses/deactivate', { license_key: 'MOCK-KEY-BUSINESS', license_key_instance_id: 'lki_mock2' });
  assert.equal(a.status, 201);
  assert.deepEqual(Object.keys(a.body).sort(), ['business_id', 'created_at', 'customer', 'id', 'license_key_id', 'name', 'product']);
  assert.deepEqual(a.body.product, { product_id: config.products.test.business, name: 'EDI Lens Pro Business (Test)' });
  assert.deepEqual(Object.keys(a.body.customer).sort(), ['customer_id', 'email', 'metadata', 'name', 'phone_number']);
  assert.match(a.body.id, /^lki_/);
  assert.deepEqual(service.handle('POST', '/licenses/validate', { license_key: 'MOCK-KEY-BUSINESS', license_key_instance_id: a.body.id }), { status: 200, body: { valid: true } });
  assert.deepEqual(service.handle('POST', '/licenses/deactivate', { license_key: 'MOCK-KEY-BUSINESS', license_key_instance_id: a.body.id }), { status: 200, body: null });
  assert.deepEqual(service.handle('POST', '/licenses/validate', { license_key: 'MOCK-KEY-BUSINESS', license_key_instance_id: a.body.id }), { status: 200, body: { valid: false } });
  assert.equal(service.handle('POST', '/licenses/activate', { license_key: 'UNKNOWN' }).status, 404);
  assert.equal(service.handle('GET', '/licenses/activate', {}).status, 404);
});

test('stand-in service: a Personal and a Business key activate; the foreign key is refused and its seat is released', async () => {
  const personal = againstService();
  assert.deepEqual(await personal.licence.activate('MOCK-KEY-0001'), { ok: true, licenceType: 'personal' });
  assert.equal(await personal.licence.isPro(), true);
  assert.equal((await personal.licence.status(true)).licenceType, 'personal');

  const business = againstService();
  assert.deepEqual(await business.licence.activate('MOCK-KEY-BUSINESS'), { ok: true, licenceType: 'business' });
  assert.equal(business.stores.stateMap.get('licence.productId.test'), config.products.test.business);
  const kept = JSON.stringify([...business.stores.stateMap.entries()]) + JSON.stringify([...business.stores.secretMap.entries()]);
  for (const secret of ['Mock Buyer', 'buyer@example.invalid', 'cus_mock', 'EDI Lens Pro Business']) assert.ok(!kept.includes(secret), secret + ' was stored');

  const foreign = againstService();
  const r = await foreign.licence.activate('MOCK-KEY-FOREIGN');
  assert.deepEqual(r, { ok: false, reason: 'product', released: true });
  assert.equal(foreign.service.state.active.size, 0, 'the seat taken for the check was released');
  assert.equal(foreign.service.state.deactivated.length, 1);
  assert.equal(foreign.stores.stateMap.size + foreign.stores.secretMap.size, 0);
  assert.equal(await foreign.licence.isPro(), false);
  assert.match(messages.activationFailureText(r), /This key belongs to another product/);
  // The foreign key can be tried as often as one likes without ever using up its three seats.
  for (let i = 0; i < 5; i++) assert.equal((await foreign.licence.activate('MOCK-KEY-FOREIGN')).reason, 'product');
  assert.equal(foreign.service.state.active.size, 0);
});

test('stand-in service: three computers per key, the fourth is refused, removing one frees a seat; a removed licence is no longer valid', async () => {
  const service = createService();
  const handler = (path, body) => { const a = service.handle('POST', path, body, 'test.dodopayments.com'); return { status: a.status, body: a.body === null ? undefined : a.body }; };
  const machines = [1, 2, 3, 4].map(() => setup(handler, { getMode: () => 'test' }));
  for (const m of machines.slice(0, 3)) assert.equal((await m.licence.activate('MOCK-KEY-BUSINESS')).ok, true);
  assert.deepEqual(await machines[3].licence.activate('MOCK-KEY-BUSINESS'), { ok: false, reason: 'limit', hasStored: false });
  // The limit is per key: the Personal key is not affected by the Business key.
  assert.equal((await machines[3].licence.activate('MOCK-KEY-0001')).ok, true);
  await machines[3].licence.remove();
  assert.deepEqual(await machines[0].licence.remove(), { ok: true, deactivated: true });
  assert.equal((await machines[3].licence.activate('MOCK-KEY-BUSINESS')).ok, true, 'the freed seat can be used by a colleague');
  assert.equal(await machines[0].licence.isPro(), false);
  assert.equal(service.state.active.size, 3);
});

// ---- entering a key again never uses a second seat ---------------------------------------------

// A licence service wired to the stand-in in the live environment, as an installed copy uses it.
function live(serviceOptions, extra) {
  const service = createService(serviceOptions);
  const handler = (path, body, n, host) => {
    const answer = service.handle('POST', path, body, host);
    return { status: answer.status, body: answer.body === null ? undefined : answer.body };
  };
  const env = setup(handler, extra);
  env.service = service;
  return env;
}

test('seats: entering the same key four times uses one activation; the fourth call is not refused at the limit', async () => {
  const env = live();
  for (let i = 0; i < 4; i++) {
    const r = await env.licence.activate('MOCK-KEY-0001');
    assert.equal(r.ok, true, 'call ' + (i + 1));
    assert.equal(r.licenceType, 'personal');
    assert.equal(r.already === true, i > 0, 'calls after the first only validate');
  }
  assert.equal(env.service.state.activations.length, 1, 'one activation was made');
  assert.equal(env.service.seats('MOCK-KEY-0001'), 1);
  assert.equal(env.fetchStub.calls.filter((c) => c.path === '/licenses/activate').length, 1);
  assert.equal(env.fetchStub.calls.filter((c) => c.path === '/licenses/validate').length, 3);
  assert.equal(env.stores.stateMap.get('licence.instanceId.live'), 'lki_mock1');
  assert.equal(await env.licence.isPro(), true);
  assert.match(messages.activatedText('personal', { already: true }), /already active on this computer \(Personal licence\)[\s\S]*no further activation was used/);
});

test('seats: replacing a key stores the new one first and then releases the seat of the old one', async () => {
  const env = live();
  assert.equal((await env.licence.activate('MOCK-KEY-0001')).ok, true);
  const r = await env.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: true });
  assert.equal(env.service.seats('MOCK-KEY-0001'), 0, 'the old key has its seat back');
  assert.equal(env.service.seats('MOCK-KEY-BUSINESS'), 1);
  assert.deepEqual(env.fetchStub.calls.map((c) => c.path), ['/licenses/activate', '/licenses/activate', '/licenses/deactivate']);
  assert.deepEqual(env.fetchStub.calls[2].body, { license_key: 'MOCK-KEY-0001', license_key_instance_id: 'lki_mock1' }, 'the old activation is released with the key it belongs to');
  assert.equal(env.stores.secretMap.get('licence.key.live'), 'MOCK-KEY-BUSINESS');
  assert.equal(env.stores.stateMap.get('licence.productId.live'), config.products.live.business);
  assert.match(messages.activatedText('business', r), /activation of the key that was stored before was released\./);
  // Back and forth ten times: never more than one seat per key.
  for (let i = 0; i < 10; i++) {
    assert.equal((await env.licence.activate(i % 2 ? 'MOCK-KEY-BUSINESS' : 'MOCK-KEY-0001')).ok, true);
    assert.ok(env.service.seats('MOCK-KEY-0001') + env.service.seats('MOCK-KEY-BUSINESS') === 1, 'round ' + i);
  }
});

test('seats: when the old activation cannot be released the new licence is kept and the user is told', async () => {
  const service = createService();
  let failRelease = false;
  const env = setup((path, body, n, host) => {
    if (failRelease && path === '/licenses/deactivate') return { status: 500, body: { message: 'down' } };
    const a = service.handle('POST', path, body, host);
    return { status: a.status, body: a.body === null ? undefined : a.body };
  });
  await env.licence.activate('MOCK-KEY-0001');
  failRelease = true;
  const r = await env.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(r, { ok: true, licenceType: 'business', replaced: true, previousReleased: false });
  assert.equal(env.stores.secretMap.get('licence.key.live'), 'MOCK-KEY-BUSINESS', 'the new licence is stored');
  assert.equal(await env.licence.isPro(), true);
  assert.match(messages.activatedText('business', r), /could not be released \(the licence server did not confirm it\); it may still count against that key's limit of 3/);
});

test('seats: a new key that is refused leaves the stored licence exactly as it was', async () => {
  const env = live();
  await env.licence.activate('MOCK-KEY-0001');
  const before = JSON.stringify([...env.stores.stateMap.entries()].filter(([k]) => !/checkedAt|lastGood/.test(k)));
  for (const [key, reason] of [['MOCK-KEY-FOREIGN', 'product'], ['NO-SUCH-KEY', 'invalid']]) {
    const r = await env.licence.activate(key);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(env.stores.secretMap.get('licence.key.live'), 'MOCK-KEY-0001');
    assert.equal(JSON.stringify([...env.stores.stateMap.entries()].filter(([k]) => !/checkedAt|lastGood/.test(k))), before);
    assert.equal(await env.licence.isPro(), true);
  }
  assert.equal(env.service.seats('MOCK-KEY-0001'), 1);
  assert.equal(env.service.seats('MOCK-KEY-FOREIGN'), 0);
});

test('seats: an editor that forgot the key but kept the activation id reuses that activation', async () => {
  // Editors without a credential store keep secrets in memory only: after a restart the key is gone.
  const env = live();
  await env.licence.activate('MOCK-KEY-0001');
  for (let restart = 0; restart < 5; restart++) {
    env.stores.secretMap.clear();
    assert.equal(await env.licence.isPro(), false);
    const r = await env.licence.activate('MOCK-KEY-0001');
    assert.deepEqual(r, { ok: true, licenceType: 'personal', already: true }, 'restart ' + restart);
    assert.equal(await env.licence.isPro(), true);
  }
  assert.equal(env.service.state.activations.length, 1, 'five restarts, still one activation');
  // With another key than the one the activation belongs to, the stale activation is released.
  env.stores.secretMap.clear();
  const other = await env.licence.activate('MOCK-KEY-BUSINESS');
  assert.equal(other.ok, true);
  assert.equal(other.replaced, true);
  assert.equal(env.service.state.activations.length, 2);
});

test('seats: without a clear answer from the server nothing is activated and nothing is changed', async () => {
  const service = createService();
  let offline = false;
  const env = setup((path, body, n, host) => {
    if (offline) throw new Error('offline');
    const a = service.handle('POST', path, body, host);
    return { status: a.status, body: a.body === null ? undefined : a.body };
  });
  await env.licence.activate('MOCK-KEY-0001');
  offline = true;
  assert.deepEqual(await env.licence.activate('MOCK-KEY-0001'), { ok: false, reason: 'network' });
  offline = false;
  assert.equal(service.state.activations.length, 1);
  assert.equal(env.stores.secretMap.get('licence.key.live'), 'MOCK-KEY-0001');
  // The server forgot the activation (removed from another place): a new one is made, the dead one is not "released" again.
  service.handle('POST', '/licenses/deactivate', { license_key: 'MOCK-KEY-0001', license_key_instance_id: 'lki_mock1' });
  const r = await env.licence.activate('MOCK-KEY-0001');
  assert.deepEqual(r, { ok: true, licenceType: 'personal' });
  assert.equal(service.seats('MOCK-KEY-0001'), 1);
  assert.equal(env.stores.stateMap.get('licence.instanceId.live'), 'lki_mock2');
});

test('seats: at the limit the message names the way out and says whether a licence here was touched', async () => {
  const service = createService();
  const handler = (path, body, n, host) => { const a = service.handle('POST', path, body, host); return { status: a.status, body: a.body === null ? undefined : a.body }; };
  const others = [1, 2, 3].map(() => setup(handler));
  for (const m of others) assert.equal((await m.licence.activate('MOCK-KEY-BUSINESS')).ok, true);
  const here = setup(handler);
  const none = await here.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(none, { ok: false, reason: 'limit', hasStored: false });
  assert.match(messages.activationFailureText(none), /maximum number of computers \(3\), so it was not activated here\. Run "EDI Lens: Remove Licence From This Machine" on one of the other computers \(that frees its activation\)/);
  assert.ok(!/already stored on this computer/.test(messages.activationFailureText(none)));
  await here.licence.activate('MOCK-KEY-0001');
  const kept = await here.licence.activate('MOCK-KEY-BUSINESS');
  assert.deepEqual(kept, { ok: false, reason: 'limit', hasStored: true });
  assert.match(messages.activationFailureText(kept), /The licence that is already stored on this computer was not changed\.$/);
  assert.equal(await here.licence.isPro(), true, 'the Personal licence still works');
  // One of the three removes its licence: now it works.
  await others[0].licence.remove();
  assert.equal((await here.licence.activate('MOCK-KEY-BUSINESS')).ok, true);
});

test('a message never says an activation was released when the server did not confirm it', async () => {
  for (const [body, reason] of [[activation('lki_x', FOREIGN), 'product'], [{ id: 'lki_y' }, 'unverified']]) {
    const env = setup((path) => (path === '/licenses/activate' ? { status: 201, body: body } : { status: 500, body: { message: 'down' } }));
    const r = await env.licence.activate(KEY);
    assert.deepEqual(r, { ok: false, reason: reason, released: false });
    const text = messages.activationFailureText(r);
    assert.match(text, /could not be released \(the licence server did not confirm it\), so it may still count against the limit of 3/);
    assert.ok(!/was released again/.test(text), text);
  }
  const stores = fakeStores();
  stores.secrets.store = async () => { throw new Error('no keyring'); };
  const lic = createLicence({ secrets: stores.secrets, globalState: stores.globalState, platform: 'linux',
    fetch: fakeFetch((path) => (path === '/licenses/activate' ? { status: 201, body: activation('lki_z', config.products.live.personal) } : { status: 503 })) });
  const r = await lic.activate(KEY);
  assert.deepEqual(r, { ok: false, reason: 'storage', released: false });
  assert.match(messages.activationFailureText(r), /could not be saved in the secret storage[\s\S]*could not be released/);
  assert.match(messages.activationFailureText({ ok: false, reason: 'storage', released: true }), /was released again and nothing was stored/);
});

test('status: a stored key that does not work never hides a running trial', async () => {
  const env = setup((path) => (path === '/licenses/activate' ? { status: 200, body: activation('lki_1', config.products.live.personal) } : { status: 200, body: { valid: false } }));
  await env.licence.activate(KEY);
  await env.licence.startTrial();
  env.clock.t += 25 * HOUR;
  assert.equal(await env.licence.isPro(), false);
  assert.equal(await env.licence.hasAccess(), true, 'the trial still gives access');
  const st = await env.licence.status(false);
  const text = messages.licenceStatusText(st);
  assert.match(text, /is no longer valid \(revoked, expired or disabled\), so it does not unlock Pro\./);
  assert.match(text, /The Pro features stay on through your trial: 13 days left/);
  assert.ok(!/the Pro features are off/.test(text));
  // Without a trial the old sentence stands.
  env.clock.t += 20 * DAY;
  assert.match(messages.licenceStatusText(await env.licence.status(false)), /so the Pro features are off\./);
  // The same for a key of another product and for an ended grace period.
  const trial = { state: 'active', daysLeft: 3, endsAt: env.clock.t + 3 * DAY };
  assert.match(messages.licenceStatusText({ hasKey: true, via: 'product', keyHint: '...ABCD', trial }), /does not unlock Pro[\s\S]*stay on through your trial: 3 days left/);
  assert.match(messages.licenceStatusText({ hasKey: true, via: 'expired', keyHint: '...ABCD', trial }), /^The licence key[\s\S]*stay on through your trial/);
});

test('trial: a start time in the future gives no more than fourteen days from today, and is written back', async () => {
  const env = setup(okHandler);
  env.stores.stateMap.set('trial.startedAt', env.clock.t + 1000 * DAY);
  let s = env.licence.trialStatus();
  assert.equal(s.state, 'active');
  assert.equal(s.daysLeft, 14);
  assert.equal(s.endsAt, env.clock.t + 14 * DAY, 'the end is fourteen days from now, not in three years');
  await env.licence.touchTrial();
  assert.equal(env.stores.stateMap.get('trial.startedAt'), env.clock.t, 'the record was corrected');
  env.clock.t += 13 * DAY;
  assert.equal(env.licence.trialStatus().daysLeft, 1);
  env.clock.t += 2 * DAY;
  assert.equal(env.licence.trialStatus().state, 'expired');
  // A start a few hours ahead (a clock that was adjusted) is left alone.
  const near = setup(okHandler);
  near.stores.stateMap.set('trial.startedAt', near.clock.t + 3 * HOUR);
  s = near.licence.trialStatus();
  assert.equal(s.startedAt, near.clock.t + 3 * HOUR);
  assert.equal(s.state, 'active');
});

test('peek: the licence state for a report is read from storage and never asks the server', async () => {
  const env = setup(okHandler);
  assert.deepEqual([(await env.licence.peek()).via, (await env.licence.peek()).pro], ['none', false]);
  await env.licence.activate(KEY);
  const calls = env.fetchStub.calls.length;
  let p = await env.licence.peek();
  assert.deepEqual([p.pro, p.via, p.licenceType, p.mode], [true, 'cache', 'personal', 'live']);
  env.clock.t += 3 * DAY;
  p = await env.licence.peek();
  assert.deepEqual([p.pro, p.via], [false, 'stale'], 'an old check is reported as old, not refreshed');
  env.stores.stateMap.set('licence.productId.live', FOREIGN);
  assert.equal((await env.licence.peek()).via, 'product');
  assert.equal(env.fetchStub.calls.length, calls, 'no request was made');
  assert.ok(!JSON.stringify(p).includes(KEY), 'the key is not part of it');
});

test('the licence environment is fixed: an installed copy has no way to reach the test environment', () => {
  const pkg = require('../package.json');
  assert.equal(config.mode, 'live');
  assert.equal(pkg.contributes.configuration.properties['ediLens.licenceMode'], undefined);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.ok(!/c\.get\('licenceMode'/.test(source), 'the extension reads no licence environment from the settings');
  assert.match(source, /ExtensionMode\.Production/);
  for (const c of pkg.contributes.commands) assert.ok(!/mode|environment|sandbox/i.test(c.title), c.title);
});
