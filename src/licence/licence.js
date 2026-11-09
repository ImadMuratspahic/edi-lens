'use strict';
// Licence handling for the Pro tier. Only the public licence endpoints are used:
//   POST /licenses/activate    { license_key, name }
//   POST /licenses/validate    { license_key, license_key_instance_id }
//   POST /licenses/deactivate  { license_key, license_key_instance_id }
// The key lives in the editor's secret storage, the instance id in global state. A successful
// validation is trusted for 24 hours; when the server cannot be reached, the last successful
// validation keeps Pro working for a 14 day grace period.
//
// This module has no dependency on the editor API: storage and the network function are
// injected, which keeps every code path unit-testable.

const config = require('./config');

const HOUR_MS = 60 * 60 * 1000;
const CACHE_MS = 24 * HOUR_MS;
const GRACE_MS = 14 * 24 * HOUR_MS;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_KEY_LENGTH = 256;

/** Returns the readable platform name used in the activation label (never the host name). */
function platformLabel(platform) {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return String(platform || 'unknown');
  }
}

/** Returns the label sent as the activation name: `VS Code on <platform>`. */
function instanceName(platform) {
  return 'VS Code on ' + platformLabel(platform);
}

/**
 * Creates the licence service. Options (all optional except the two stores):
 *   secrets      object with async get(name) / store(name, value) / delete(name)
 *   globalState  object with get(name) / update(name, value)
 *   fetch        fetch-compatible function (defaults to the global fetch)
 *   now          function returning the current time in milliseconds
 *   getMode      function returning 'test', 'live' or anything else for the built-in default
 *   platform     platform id for the activation label (defaults to process.platform)
 * The service methods never throw; every failure is reported through the returned value.
 */
function createLicence(options) {
  const secrets = options.secrets;
  const state = options.globalState;
  const now = options.now || Date.now;
  const getMode = options.getMode || function () { return undefined; };
  const platform = options.platform || process.platform;

  let inflight = null;
  let retryNotBefore = 0;

  function env() { return config.resolve(getMode()); }
  function names() {
    const mode = env().mode;
    return {
      key: 'licence.key.' + mode,
      instance: 'licence.instanceId.' + mode,
      checkedAt: 'licence.checkedAt.' + mode,
      checkedValid: 'licence.checkedValid.' + mode,
      lastGood: 'licence.lastGoodAt.' + mode
    };
  }

  // One POST to the licence server. Resolves to { status, data } or { status: 0, networkError }.
  async function post(path, body) {
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') return { status: 0, data: null, networkError: true };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(env().api + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data: data };
    } catch (e) {
      return { status: 0, data: null, networkError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function asTime(value) { return typeof value === 'number' && isFinite(value) ? value : 0; }

  // Evaluates the licence: from the 24 h cache, from the server, or from the grace period.
  async function evaluate(force) {
    const n = names();
    const key = await secrets.get(n.key);
    const instanceId = state.get(n.instance);
    const mode = env().mode;
    if (!key || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: !!key };

    const t = now();
    const lastGoodAt = asTime(state.get(n.lastGood));
    const checkedAt = asTime(state.get(n.checkedAt));
    const age = t - checkedAt;
    if (!force && checkedAt && age >= 0 && age < CACHE_MS) {
      const cachedValid = state.get(n.checkedValid) === true;
      return { pro: cachedValid, via: cachedValid ? 'cache' : 'rejected', mode: mode, hasKey: true, lastGoodAt: lastGoodAt, checkedAt: checkedAt, key: key };
    }

    let result = null;
    if (force || t >= retryNotBefore) {
      result = await post('/licenses/validate', { license_key: key, license_key_instance_id: instanceId });
    }
    if (result && result.status === 200 && result.data && typeof result.data.valid === 'boolean') {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, result.data.valid);
      if (result.data.valid) {
        await state.update(n.lastGood, t);
        return { pro: true, via: 'server', mode: mode, hasKey: true, lastGoodAt: t, checkedAt: t, key: key };
      }
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, lastGoodAt: lastGoodAt, checkedAt: t, key: key };
    }
    if (result && (result.status === 403 || result.status === 404 || result.status === 422)) {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, false);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, lastGoodAt: lastGoodAt, checkedAt: t, key: key };
    }

    // Server unreachable or answered with something unexpected: use the grace period.
    if (result) retryNotBefore = t + RETRY_BACKOFF_MS;
    const graceAge = t - lastGoodAt;
    if (lastGoodAt && graceAge >= 0 && graceAge < GRACE_MS) {
      return { pro: true, via: 'grace', mode: mode, hasKey: true, lastGoodAt: lastGoodAt, graceEndsAt: lastGoodAt + GRACE_MS, key: key };
    }
    return { pro: false, via: 'expired', mode: mode, hasKey: true, lastGoodAt: lastGoodAt, key: key };
  }

  /**
   * Reports whether Pro is active. Safe to call often: concurrent calls share one check, a
   * validation is trusted for 24 hours, and an unreachable server falls back to the 14 day
   * grace period. Never throws and never shows a message.
   */
  function isPro() {
    if (inflight) return inflight;
    inflight = evaluate(false).then(function (r) { return r.pro === true; }, function () { return false; })
      .then(function (value) { inflight = null; return value; });
    return inflight;
  }

  /**
   * Returns the detailed licence state for the status command. With `force` the server is asked
   * now instead of trusting the cache. The stored key is never returned in full.
   */
  async function status(force) {
    let r;
    try { r = await evaluate(force === true); } catch (e) { r = { pro: false, via: 'none', mode: env().mode, hasKey: false }; }
    const key = r.key;
    const out = {
      pro: r.pro, via: r.via, mode: r.mode, hasKey: r.hasKey,
      lastGoodAt: r.lastGoodAt || 0, graceEndsAt: r.graceEndsAt || 0,
      keyHint: key ? '...' + key.slice(-4) : ''
    };
    return out;
  }

  /**
   * Activates a key on this machine. Resolves to `{ ok: true }` or `{ ok: false, reason }` with
   * reason 'invalid' (unknown, revoked or malformed key), 'limit' (activation limit reached),
   * 'network' (server unreachable) or 'error' (anything else, with the HTTP `status`).
   */
  async function activate(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, reason: 'invalid' };
    const r = await post('/licenses/activate', { license_key: key, name: instanceName(platform) });
    if ((r.status === 200 || r.status === 201) && r.data && typeof r.data.id === 'string' && r.data.id) {
      const n = names();
      const t = now();
      await secrets.store(n.key, key);
      await state.update(n.instance, r.data.id);
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, true);
      await state.update(n.lastGood, t);
      retryNotBefore = 0;
      return { ok: true };
    }
    if (r.networkError) return { ok: false, reason: 'network' };
    if (r.status === 422) return { ok: false, reason: 'limit' };
    if (r.status === 403 || r.status === 404 || r.status === 400) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error', status: r.status };
  }

  /**
   * Removes the licence from this machine: asks the server to free the activation (best effort)
   * and always clears the local key and state. Resolves to `{ ok: true, deactivated }` where
   * `deactivated` is false when the server could not be told (for example offline).
   */
  async function remove() {
    const n = names();
    let deactivated = false;
    try {
      const key = await secrets.get(n.key);
      const instanceId = state.get(n.instance);
      if (key && instanceId) {
        const r = await post('/licenses/deactivate', { license_key: key, license_key_instance_id: instanceId });
        deactivated = r.status === 200 || r.status === 201 || r.status === 204;
      } else {
        deactivated = true;
      }
    } catch (e) {
      deactivated = false;
    }
    try { await secrets.delete(n.key); } catch (e) { /* nothing stored */ }
    await state.update(n.instance, undefined);
    await state.update(n.checkedAt, undefined);
    await state.update(n.checkedValid, undefined);
    await state.update(n.lastGood, undefined);
    retryNotBefore = 0;
    return { ok: true, deactivated: deactivated };
  }

  /** Returns the checkout link for the current environment, or an empty string if none exists. */
  function buyUrl() { return env().buyUrl; }

  return { isPro: isPro, status: status, activate: activate, remove: remove, buyUrl: buyUrl };
}

module.exports = {
  createLicence: createLicence,
  instanceName: instanceName,
  platformLabel: platformLabel,
  CACHE_MS: CACHE_MS,
  GRACE_MS: GRACE_MS
};
