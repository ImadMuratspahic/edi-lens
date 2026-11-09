'use strict';
// A local stand-in for the licence service, used by the release smoke test when no real activation
// slot is free. It is an HTTP proxy that answers the three public licence endpoints for the two
// licence hosts over TLS with a throw-away certificate (the editor profile is started with
// `http.proxyStrictSSL` off). It never forwards anything to the internet and stores nothing.
//
// Usage: const mock = await startMock(); ... mock.settings is the settings object to merge into the
// editor profile; mock.state tells how many activations are held; await mock.stop() at the end.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

function makeCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edilens-mockcert-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const r = cp.spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '2', '-subj', '/CN=test.dodopayments.com',
    '-addext', 'subjectAltName=DNS:test.dodopayments.com,DNS:live.dodopayments.com'
  ], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('openssl could not create the throw-away certificate: ' + (r.stderr || ''));
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), certFile: certFile, dir: dir };
}

/** Starts the stand-in. `options.limit` is the activation limit (default 3). */
async function startMock(options) {
  const limit = (options && options.limit) || 3;
  const state = { active: new Map(), seq: 0, requests: [], connects: [], tlsErrors: [] };
  const material = makeCertificate();
  const tls = https.createServer({ key: material.key, cert: material.cert }, function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
      state.requests.push(req.url);
      function send(status, value) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      }
      if (req.method !== 'POST') return send(404, { code: 'NOT_FOUND' });
      if (req.url === '/licenses/activate') {
        if (state.active.size >= limit) return send(422, { code: 'LICENSE_KEY_LIMIT_REACHED' });
        state.seq += 1;
        const id = 'lki_mock' + state.seq;
        state.active.set(id, data.name || '');
        return send(201, { id: id, name: data.name });
      }
      if (req.url === '/licenses/validate') {
        const id = data.license_key_instance_id;
        return send(200, { valid: id === undefined || state.active.has(id) });
      }
      if (req.url === '/licenses/deactivate') {
        state.active.delete(data.license_key_instance_id);
        return send(200, null);
      }
      return send(404, { code: 'NOT_FOUND' });
    });
  });
  const proxy = http.createServer(function (req, res) { res.writeHead(502); res.end(); });
  tls.on('tlsClientError', function (err) { state.tlsErrors.push(String(err && err.message)); });
  proxy.on('connect', function (req, socket) {
    state.connects.push(req.url);
    socket.on('error', function () {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tls.emit('connection', socket);
  });
  await new Promise(function (resolve) { proxy.listen(0, '127.0.0.1', resolve); });
  const port = proxy.address().port;
  return {
    state: state,
    port: port,
    // Point NODE_EXTRA_CA_CERTS at this file so the editor's extension process trusts the stand-in.
    certFile: material.certFile,
    settings: {
      'http.proxy': 'http://127.0.0.1:' + port,
      'http.proxySupport': 'on',
      'http.proxyStrictSSL': false
    },
    stop: function () {
      return new Promise(function (resolve) {
        proxy.close(function () {
          tls.close(function () {
            fs.rmSync(material.dir, { recursive: true, force: true });
            resolve();
          });
        });
      });
    }
  };
}

module.exports = { startMock: startMock };
