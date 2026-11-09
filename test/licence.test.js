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
    const r = await handler(parsed.pathname, body, calls.length);
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

const okHandler = (path) => {
  if (path === '/licenses/activate') return { status: 200, body: { id: 'lki_instance_1' } };
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
  assert.deepEqual(r, { ok: true });
  assert.equal(env.fetchStub.calls[0].path, '/licenses/activate');
  assert.equal(env.fetchStub.calls[0].body.license_key, KEY);
  assert.equal(env.fetchStub.calls[0].host, 'https://test.dodopayments.com');
  assert.equal(env.fetchStub.calls[0].init.method, 'POST');
  assert.equal([...env.stores.secretMap.values()][0], KEY);
  assert.ok([...env.stores.stateMap.values()].includes('lki_instance_1'));
  // The key is never kept in global state.
  assert.ok(![...env.stores.stateMap.values()].includes(KEY));
});

test('activate accepts HTTP 201 as success', async () => {
  const env = setup(() => ({ status: 201, body: { id: 'lki_2' } }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: true });
});

test('activate reports the activation limit (HTTP 422)', async () => {
  const env = setup(() => ({ status: 422, body: { message: 'limit' } }));
  assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'limit' });
  assert.equal(env.stores.secretMap.size, 0);
  assert.equal(env.stores.stateMap.size, 0);
});

test('activate reports an unknown key (HTTP 403 and 404)', async () => {
  for (const status of [403, 404]) {
    const env = setup(() => ({ status, body: {} }));
    assert.deepEqual(await env.licence.activate(KEY), { ok: false, reason: 'invalid' });
    assert.equal(env.stores.secretMap.size, 0);
  }
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
  const env = setup(() => ({ status: 403 }));
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
  assert.equal(st.mode, 'test');
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

test('config: the release check refuses live mode without a buy URL', () => {
  const saved = { mode: config.mode, url: config.buyUrlLive };
  try {
    config.mode = 'test';
    config.buyUrlLive = '';
    assert.equal(config.assertShippable({}), true);
    assert.throws(() => config.assertShippable({
      contributes: { configuration: { properties: { 'ediLens.licenceMode': { default: 'live' } } } }
    }), /buyUrlLive is empty/);
    config.mode = 'live';
    assert.throws(() => config.assertShippable({}), /buyUrlLive is empty/);
    config.buyUrlLive = 'http://insecure.example/buy';
    assert.throws(() => config.assertShippable({}), /https/);
    config.buyUrlLive = 'https://checkout.example/buy/abc';
    assert.equal(config.assertShippable({}), true);
  } finally {
    config.mode = saved.mode;
    config.buyUrlLive = saved.url;
  }
});

test('the shipped package manifest passes the release check', () => {
  assert.equal(config.assertShippable(require('../package.json')), true);
});
