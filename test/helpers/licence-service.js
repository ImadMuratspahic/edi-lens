'use strict';
// A stand-in for the licence service of the payment provider, without any network. It answers the
// three public licence endpoints with the shapes the real service uses:
//   POST /licenses/activate    201 { id, business_id, name, license_key_id, created_at, product: { product_id, name }, customer: { ... } }
//   POST /licenses/validate    200 { valid }
//   POST /licenses/deactivate  200 null
// and 404 for an unknown key, 422 at the activation limit.
//
// createService(options): options.limit is the activation limit per key (default 3);
// options.keys maps a key to { tier: 'personal' | 'business' } or { product_id, name } for a key
// of another product. handle(method, url, data, host) returns { status, body }; `host` chooses
// the environment whose product ids are answered (a host that starts with "test." is the test
// environment, anything else the live one).

const config = require('../../src/licence/config');

const DEFAULT_KEYS = {
  'MOCK-KEY-0001': { tier: 'personal' },
  'MOCK-KEY-BUSINESS': { tier: 'business' },
  'MOCK-KEY-FOREIGN': { product_id: 'pdt_0MockOtherProductXYZ', name: 'Another product' }
};

function createService(options) {
  const o = options || {};
  const limit = o.limit || 3;
  const keys = Object.assign({}, o.keys || DEFAULT_KEYS);
  if (o.key && !keys[o.key]) keys[o.key] = { tier: 'personal' };
  const perKey = new Map();
  const state = { active: new Map(), keyOf: new Map(), activations: [], deactivated: [], validated: [], seq: 0, requests: [], connects: [], tlsErrors: [] };

  function productOf(entry, host) {
    if (!entry.tier) return { product_id: entry.product_id, name: entry.name || null };
    const environment = /^test\./.test(String(host || '')) ? 'test' : 'live';
    return { product_id: config.products[environment][entry.tier], name: 'EDI Lens Pro' + (entry.tier === 'business' ? ' Business' : '') + (environment === 'test' ? ' (Test)' : '') };
  }

  function handle(method, url, data, host) {
    const body = data || {};
    state.requests.push(url);
    function send(status, value) { return { status: status, body: value }; }
    if (method !== 'POST') return send(404, { code: 'NOT_FOUND' });
    if (url === '/licenses/activate') {
      const entry = Object.prototype.hasOwnProperty.call(keys, body.license_key) ? keys[body.license_key] : null;
      if (!entry) return send(404, { code: 'NOT_FOUND' });
      const used = perKey.get(body.license_key) || 0;
      if (used >= limit) return send(422, { code: 'LICENSE_KEY_LIMIT_REACHED' });
      state.seq += 1;
      const id = 'lki_mock' + state.seq;
      state.active.set(id, body.name || '');
      state.keyOf.set(id, body.license_key);
      state.activations.push(id);
      perKey.set(body.license_key, used + 1);
      return send(201, {
        id: id, business_id: 'bus_mock', name: body.name, license_key_id: 'lic_mock', created_at: new Date().toISOString(),
        product: productOf(entry, host),
        customer: { customer_id: 'cus_mock', name: 'Mock Buyer', email: 'buyer@example.invalid', phone_number: null, metadata: {} }
      });
    }
    if (url === '/licenses/validate') {
      const id = body.license_key_instance_id;
      state.validated.push(id);
      // An activation is valid only together with the key it was made for.
      const valid = id === undefined ? Object.prototype.hasOwnProperty.call(keys, body.license_key) : state.active.has(id) && state.keyOf.get(id) === body.license_key;
      return send(200, { valid: valid });
    }
    if (url === '/licenses/deactivate') {
      const owner = state.keyOf.get(body.license_key_instance_id);
      if (owner === body.license_key && state.active.delete(body.license_key_instance_id)) perKey.set(owner, Math.max(0, (perKey.get(owner) || 1) - 1));
      state.deactivated.push(body.license_key_instance_id);
      return send(200, null);
    }
    return send(404, { code: 'NOT_FOUND' });
  }

  return { state: state, handle: handle, seats: function (key) { return perKey.get(key) || 0; } };
}

module.exports = { createService: createService };
