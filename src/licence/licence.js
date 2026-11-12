'use strict';
// Licence handling for the Pro tier. Only the public licence endpoints are used:
//   POST /licenses/activate    { license_key, name }   -> 201 { id, product: { product_id, name }, customer: { ... }, ... }
//   POST /licenses/validate    { license_key, license_key_instance_id }   -> 200 { valid }
//   POST /licenses/deactivate  { license_key, license_key_instance_id }   -> 200, empty
// The key lives in the editor's secret storage, the instance id in global state. A successful
// validation is trusted for 24 hours; when the server cannot be reached, the last successful
// validation keeps Pro working for a 14 day grace period.
//
// A key only unlocks Pro when it belongs to one of the products listed in the configuration.
// The product is named in the answer to the activation (the validation answer carries only
// `valid`), so it is checked when a key is entered and its id is kept next to the activation id.
// Nothing else of the activation answer is kept: not the buyer's name, not the e-mail address.
// A licence stored by version 0.1.x has no product id; it is from the only product that existed
// then and keeps working.
//
// The free trial lives in the same module. It is recorded only in the editor's global state of
// this machine (start time and the time of the last reminder), never sent anywhere, and it needs
// no key and no network. It starts when the user first runs a Pro feature, not at install.
//
// This module has no dependency on the editor API: storage and the network function are
// injected, which keeps every code path unit-testable.

const config = require('./config');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_MS = config.cacheHours * HOUR_MS;
const GRACE_MS = config.graceDays * DAY_MS;
const TRIAL_MS = config.trialDays * DAY_MS;
const REMINDER_MS = DAY_MS;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_KEY_LENGTH = 256;

const TRIAL_KEYS = Object.freeze({
  startedAt: 'trial.startedAt',
  lastSeenAt: 'trial.lastSeenAt',
  lastNoticeAt: 'trial.lastNoticeAt'
});

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

function asTime(value) { return typeof value === 'number' && isFinite(value) ? value : 0; }

/**
 * Creates the licence service. Options (all optional except the two stores):
 *   secrets      object with async get(name) / store(name, value) / delete(name)
 *   globalState  object with get(name) / update(name, value)
 *   fetch        fetch-compatible function (defaults to the global fetch)
 *   now          function returning the current time in milliseconds
 *   getMode      function returning 'test', 'live' or anything else for the built-in default
 *                (the editor passes 'live'; only tests and a development host pass 'test')
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
      product: 'licence.productId.' + mode,
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

  // Evaluates the licence: from the 24 h cache, from the server, or from the grace period.
  async function evaluate(force) {
    const n = names();
    const key = await secrets.get(n.key);
    const instanceId = state.get(n.instance);
    const mode = env().mode;
    if (!key || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: !!key };
    // The product recorded at activation. No record means a licence stored by 0.1.x (Personal).
    const productId = state.get(n.product);
    const licenceType = productId === undefined ? 'personal' : config.licenceTypeOf(mode, productId);
    if (!licenceType) return { pro: false, via: 'product', mode: mode, hasKey: true, key: key };

    const t = now();
    const lastGoodAt = asTime(state.get(n.lastGood));
    const checkedAt = asTime(state.get(n.checkedAt));
    const age = t - checkedAt;
    if (!force && checkedAt && age >= 0 && age < CACHE_MS) {
      const cachedValid = state.get(n.checkedValid) === true;
      return { pro: cachedValid, via: cachedValid ? 'cache' : 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, checkedAt: checkedAt, key: key };
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
        return { pro: true, via: 'server', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: t, checkedAt: t, key: key };
      }
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, checkedAt: t, key: key };
    }
    if (result && (result.status === 403 || result.status === 404 || result.status === 422)) {
      retryNotBefore = 0;
      await state.update(n.checkedAt, t);
      await state.update(n.checkedValid, false);
      return { pro: false, via: 'rejected', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, checkedAt: t, key: key };
    }

    // Server unreachable or answered with something unexpected: use the grace period.
    if (result) retryNotBefore = t + RETRY_BACKOFF_MS;
    const graceAge = t - lastGoodAt;
    if (lastGoodAt && graceAge >= 0 && graceAge < GRACE_MS) {
      return { pro: true, via: 'grace', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, graceEndsAt: lastGoodAt + GRACE_MS, key: key };
    }
    return { pro: false, via: 'expired', mode: mode, hasKey: true, licenceType: licenceType, lastGoodAt: lastGoodAt, key: key };
  }

  /**
   * Reports whether a valid licence is active. Safe to call often: concurrent calls share one
   * check, a validation is trusted for 24 hours, and an unreachable server falls back to the
   * 14 day grace period. Never throws and never shows a message. The trial does not count here;
   * see hasAccess().
   */
  function isPro() {
    if (inflight) return inflight;
    inflight = evaluate(false).then(function (r) { return r.pro === true; }, function () { return false; })
      .then(function (value) { inflight = null; return value; });
    return inflight;
  }

  /**
   * Returns the detailed licence state for the status command. With `force` the server is asked
   * now instead of trusting the cache. The stored key is never returned in full. The trial state
   * is included as `trial` (see trialStatus()).
   */
  async function status(force) {
    let r;
    try { r = await evaluate(force === true); } catch (e) { r = { pro: false, via: 'none', mode: env().mode, hasKey: false }; }
    const key = r.key;
    return {
      pro: r.pro, via: r.via, mode: r.mode, hasKey: r.hasKey,
      lastGoodAt: r.lastGoodAt || 0, graceEndsAt: r.graceEndsAt || 0,
      keyHint: key ? '...' + key.slice(-4) : '',
      licenceType: r.licenceType || '',
      trial: trialStatus()
    };
  }

  /**
   * Activates a key on this machine. Resolves to `{ ok: true, licenceType }` or
   * `{ ok: false, reason }` with reason 'invalid' (unknown or malformed key), 'inactive' (the
   * server knows the key but it is not active: expired, disabled or revoked), 'limit'
   * (activation limit reached), 'network' (server unreachable), 'storage' (the editor could not
   * keep the key, for example because no credential store is available), 'product' (the key is
   * valid but belongs to another product), 'unverified' (the server did not say which product
   * the key belongs to) or 'error' (anything else, with the HTTP `status`). For 'storage',
   * 'product' and 'unverified' the activation that was just made is given back; `released` says
   * whether the server confirmed that.
   *
   * An activation is only made when one is needed, so that entering a key again never uses up
   * a second seat:
   *   - the same key is already active here: it is validated instead (`already: true`);
   *   - an activation id is stored but the key is gone (an editor that keeps secrets only in
   *     memory): the stored activation is tried with the entered key first;
   *   - another key replaces the stored one: after the new key is active and stored, the
   *     activation of the old key is released. `previousReleased` is false when the server could
   *     not be told; the old licence is never dropped before the new one is safely stored.
   */
  async function activate(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return { ok: false, reason: 'invalid' };
    const n = names();
    const mode = env().mode;
    let oldKey;
    let oldInstance;
    let oldProduct;
    try {
      oldKey = await secrets.get(n.key);
      oldInstance = state.get(n.instance);
      oldProduct = state.get(n.product);
    } catch (e) {
      oldKey = undefined;
      oldInstance = undefined;
    }
    if (typeof oldInstance !== 'string' || !oldInstance) oldInstance = undefined;
    const oldType = oldProduct === undefined ? 'personal' : config.licenceTypeOf(mode, oldProduct);

    // The stored activation may already belong to this key: ask instead of activating again.
    if (oldInstance && (oldKey === key || !oldKey) && oldType) {
      const v = await post('/licenses/validate', { license_key: key, license_key_instance_id: oldInstance });
      if (v.status === 200 && v.data && v.data.valid === true) {
        const t = now();
        try {
          if (!oldKey) await secrets.store(n.key, key);
          await state.update(n.checkedAt, t);
          await state.update(n.checkedValid, true);
          await state.update(n.lastGood, t);
        } catch (e) {
          return { ok: false, reason: 'storage', released: false, kept: true };
        }
        retryNotBefore = 0;
        return { ok: true, licenceType: oldType, already: true };
      }
      const answered = (v.status === 200 && v.data && v.data.valid === false) || v.status === 403 || v.status === 404 || v.status === 422;
      // No clear answer: do not risk a second seat. Nothing is changed.
      if (!answered) return v.networkError ? { ok: false, reason: 'network' } : { ok: false, reason: 'error', status: v.status };
      // The server no longer knows that activation for this key; a new one is made below. When the
      // key was the stored one there is nothing left to release. When the stored key was lost, the
      // old activation may belong to another key: its release is still tried further down.
      if (oldKey === key) oldInstance = undefined;
    }

    const r = await post('/licenses/activate', { license_key: key, name: instanceName(platform) });
    if ((r.status === 200 || r.status === 201) && r.data && typeof r.data.id === 'string' && r.data.id) {
      const t = now();
      const release = async function () {
        const d = await post('/licenses/deactivate', { license_key: key, license_key_instance_id: r.data.id });
        return d.status === 200 || d.status === 201 || d.status === 204;
      };
      // Only keys of our own products count. The activation that was just made for a foreign
      // key is given back so that it does not use up a seat of that key.
      const product = r.data.product;
      const productId = product && typeof product === 'object' && typeof product.product_id === 'string' ? product.product_id : '';
      const licenceType = config.licenceTypeOf(mode, productId);
      if (!licenceType) {
        return { ok: false, reason: productId ? 'product' : 'unverified', released: await release() };
      }
      try {
        await secrets.store(n.key, key);
        await state.update(n.instance, r.data.id);
        await state.update(n.product, productId);
        await state.update(n.checkedAt, t);
        await state.update(n.checkedValid, true);
        await state.update(n.lastGood, t);
      } catch (e) {
        // Nothing usable can be kept on this machine. Undo what may have been written and give
        // the activation back, so that a retry does not use up another seat of the key.
        try { await secrets.delete(n.key); } catch (e2) { /* nothing stored */ }
        try { await state.update(n.instance, undefined); } catch (e2) { /* nothing stored */ }
        try { await state.update(n.product, undefined); } catch (e2) { /* nothing stored */ }
        return { ok: false, reason: 'storage', released: await release() };
      }
      retryNotBefore = 0;
      const result = { ok: true, licenceType: licenceType };
      // The new licence is stored; now give back the seat of the activation it replaced.
      if (oldInstance && oldInstance !== r.data.id) {
        const d = await post('/licenses/deactivate', { license_key: oldKey || key, license_key_instance_id: oldInstance });
        result.replaced = true;
        result.previousReleased = d.status === 200 || d.status === 201 || d.status === 204;
      }
      return result;
    }
    if (r.networkError) return { ok: false, reason: 'network' };
    if (r.status === 422) return { ok: false, reason: 'limit', hasStored: !!(oldKey && oldInstance) };
    if (r.status === 403) return { ok: false, reason: 'inactive' };
    if (r.status === 404 || r.status === 400) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error', status: r.status };
  }

  /**
   * Returns the licence state from what is stored, without any network request: for the
   * diagnostics block. `{ pro, via, mode, hasKey, licenceType, trial }` where via is 'cache',
   * 'rejected', 'stale' (the last check is older than a day; not asked again here), 'product' or
   * 'none'.
   */
  async function peek() {
    const mode = env().mode;
    try {
      const n = names();
      const key = await secrets.get(n.key);
      const instanceId = state.get(n.instance);
      if (!key || !instanceId) return { pro: false, via: 'none', mode: mode, hasKey: !!key, trial: trialStatus() };
      const productId = state.get(n.product);
      const licenceType = productId === undefined ? 'personal' : config.licenceTypeOf(mode, productId);
      if (!licenceType) return { pro: false, via: 'product', mode: mode, hasKey: true, trial: trialStatus() };
      const age = now() - asTime(state.get(n.checkedAt));
      const fresh = asTime(state.get(n.checkedAt)) > 0 && age >= 0 && age < CACHE_MS;
      const valid = state.get(n.checkedValid) === true;
      return { pro: fresh && valid, via: !fresh ? 'stale' : valid ? 'cache' : 'rejected', mode: mode, hasKey: true, licenceType: licenceType, trial: trialStatus() };
    } catch (e) {
      return { pro: false, via: 'none', mode: mode, hasKey: false, trial: { state: 'unused' } };
    }
  }

  /**
   * Removes the licence from this machine: asks the server to free the activation (best effort)
   * and always clears the local key and state. Resolves to `{ ok: true, deactivated }` where
   * `deactivated` is false when the server could not be told (for example offline). The trial
   * record is not touched.
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
    await state.update(n.product, undefined);
    await state.update(n.checkedAt, undefined);
    await state.update(n.checkedValid, undefined);
    await state.update(n.lastGood, undefined);
    retryNotBefore = 0;
    return { ok: true, deactivated: deactivated };
  }

  /**
   * Returns the checkout link for the current environment, or an empty string if none exists.
   * Without arguments it is the Personal link; `tier` 'business' with `users` (1 to 100) gives
   * the Business link for that number of users.
   */
  function buyUrl(tier, users) {
    if (tier === undefined) return env().buyUrl;
    return config.buyUrlFor(env().mode, tier, users);
  }

  // ---- trial ------------------------------------------------------------------------------

  // The clock used for the trial never runs backwards: a clock set back to an earlier date
  // does not stretch the trial. Reading does not write; see touchTrial() for the update.
  function trialNow() {
    return Math.max(now(), asTime(state.get(TRIAL_KEYS.lastSeenAt)));
  }

  /**
   * Returns the trial state without changing anything and without any network use:
   * `{ state, startedAt, endsAt, daysLeft, lastNoticeAt }` where state is 'unused' (never
   * started), 'active' or 'expired'. `daysLeft` counts started days (1 on the last day).
   */
  function trialStatus() {
    const startedAt = asTime(state.get(TRIAL_KEYS.startedAt));
    const lastNoticeAt = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (!startedAt) return { state: 'unused', startedAt: 0, endsAt: 0, daysLeft: config.trialDays, lastNoticeAt: lastNoticeAt };
    const t = trialNow();
    // A start time that lies in the future (a damaged or edited record) counts as "started now":
    // it can never give more than the trial length from today.
    if (startedAt > t + DAY_MS) {
      return { state: 'active', startedAt: t, endsAt: t + TRIAL_MS, daysLeft: config.trialDays, lastNoticeAt: lastNoticeAt, corrected: true };
    }
    const endsAt = startedAt + TRIAL_MS;
    if (t >= endsAt) return { state: 'expired', startedAt: startedAt, endsAt: endsAt, daysLeft: 0, lastNoticeAt: lastNoticeAt };
    const daysLeft = Math.min(config.trialDays, Math.max(1, Math.ceil((endsAt - t) / DAY_MS)));
    return { state: 'active', startedAt: startedAt, endsAt: endsAt, daysLeft: daysLeft, lastNoticeAt: lastNoticeAt };
  }

  /**
   * Starts the trial when it has never been started. Resolves to the trial status, or to
   * `{ state: 'unavailable' }` when the editor's storage refused the write (nothing is then
   * recorded and nothing changes).
   */
  async function startTrial() {
    const current = trialStatus();
    if (current.state !== 'unused') return current;
    const t = now();
    try {
      await state.update(TRIAL_KEYS.startedAt, t);
      await state.update(TRIAL_KEYS.lastSeenAt, t);
    } catch (e) {
      try { await state.update(TRIAL_KEYS.startedAt, undefined); } catch (e2) { /* nothing stored */ }
      return { state: 'unavailable', startedAt: 0, endsAt: 0, daysLeft: 0, lastNoticeAt: 0 };
    }
    return trialStatus();
  }

  /**
   * Records that the trial was used now (keeps the trial clock from running backwards). Only
   * writes when the trial has started. Never throws.
   */
  async function touchTrial() {
    if (!asTime(state.get(TRIAL_KEYS.startedAt))) return;
    const t = now();
    // Write a start time from the future back to now, once, so that the trial then runs out.
    if (asTime(state.get(TRIAL_KEYS.startedAt)) > trialNow() + DAY_MS) {
      try {
        await state.update(TRIAL_KEYS.startedAt, t);
        await state.update(TRIAL_KEYS.lastSeenAt, t);
      } catch (e) { /* the state is read-only */ }
      return;
    }
    if (t > asTime(state.get(TRIAL_KEYS.lastSeenAt))) {
      try { await state.update(TRIAL_KEYS.lastSeenAt, t); } catch (e) { /* the state is read-only; the trial still runs */ }
    }
  }

  /**
   * Returns true when a trial reminder may be shown now (none shown in the last 24 hours) and
   * records the reminder. Never throws.
   */
  async function noteTrialReminder() {
    const t = now();
    const last = asTime(state.get(TRIAL_KEYS.lastNoticeAt));
    if (last && t - last < REMINDER_MS && t >= last) return false;
    try { await state.update(TRIAL_KEYS.lastNoticeAt, t); } catch (e) { /* the state is read-only */ }
    return true;
  }

  /**
   * Reports whether the Pro features may be used right now: a valid licence or an active trial.
   * Never starts the trial and never shows a message.
   */
  async function hasAccess() {
    if (await isPro()) return true;
    return trialStatus().state === 'active';
  }

  return {
    isPro: isPro, hasAccess: hasAccess, status: status, peek: peek, activate: activate, remove: remove, buyUrl: buyUrl,
    trialStatus: trialStatus, startTrial: startTrial, touchTrial: touchTrial, noteTrialReminder: noteTrialReminder
  };
}

module.exports = {
  createLicence: createLicence,
  instanceName: instanceName,
  platformLabel: platformLabel,
  CACHE_MS: CACHE_MS,
  GRACE_MS: GRACE_MS,
  TRIAL_MS: TRIAL_MS,
  TRIAL_KEYS: TRIAL_KEYS
};
