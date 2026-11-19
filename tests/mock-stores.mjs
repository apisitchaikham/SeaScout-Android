// Test-only stand-in for Google (JWKS, OAuth token, Play Developer API), Apple (JWKS, App Store Server API)
// and Resend (email). Lets tests/integrations.test.mjs run every sign-in / billing / email path without real accounts.
// Usage: node tests/mock-stores.mjs <keydir> <port>   (keys made by tests/gen-test-keys.mjs)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [dir, port] = [process.argv[2], +process.argv[3] || 8790];
const K = JSON.parse(fs.readFileSync(dir + '/keys.json', 'utf8'));
const state = { emails: [], acks: [], google: {}, apple: {}, fb: {} };
const b64u = (b) => Buffer.from(b).toString('base64url');
const unsigned = (o) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify(o)) + '.sig';

function verifyJwt(tok, pubPem, alg) {
  const [h, p, s] = tok.split('.');
  const ok = crypto.verify(alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(h + '.' + p), alg === 'ES256' ? { key: pubPem, dsaEncoding: 'ieee-p1363' } : pubPem, Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(p, 'base64url')) : null;
}
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body == null ? '' : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/jwks') return send(res, 200, { keys: [K.idJwk] });
  if (u.pathname === '/token') { // Google OAuth (service-account JWT bearer)
    const a = new URLSearchParams(body).get('assertion'); const c = a && verifyJwt(a, K.saPub, 'RS256');
    if (!c || c.scope !== 'https://www.googleapis.com/auth/androidpublisher') return send(res, 401, { error: 'bad_assertion' });
    return send(res, 200, { access_token: 'gtok', expires_in: 3600 });
  }
  if (u.pathname.startsWith('/androidpublisher/')) {
    if (req.headers.authorization !== 'Bearer gtok') return send(res, 401, {});
    if (u.pathname.endsWith(':acknowledge')) { state.acks.push(u.pathname); return send(res, 200, {}); }
    const token = decodeURIComponent(u.pathname.split('/tokens/')[1]);
    const s = state.google[token]; return s ? send(res, 200, s) : send(res, 404, {});
  }
  if (u.pathname.startsWith('/inApps/v1/subscriptions/')) {
    const c = verifyJwt((req.headers.authorization || '').replace('Bearer ', ''), K.applePub, 'ES256');
    if (!c || c.aud !== 'appstoreconnect-v1' || c.bid !== K.bundle) return send(res, 401, {});
    const id = u.pathname.split('/').pop(), s = state.apple[id];
    if (!s) return send(res, 404, {});
    return send(res, 200, { bundleId: K.bundle, data: [{ subscriptionGroupIdentifier: 'g1', lastTransactions: [{ originalTransactionId: id, status: s.status,
      signedTransactionInfo: unsigned({ originalTransactionId: id, productId: s.productId, expiresDate: s.expiresDate, originalPurchaseDate: Date.now() - 1000, appAccountToken: s.appAccountToken, bundleId: K.bundle }),
      signedRenewalInfo: unsigned({ autoRenewStatus: s.autoRenew ? 1 : 0 }) }] }] });
  }
  if (u.pathname === '/graph/debug_token') { // Facebook Graph API
    if (u.searchParams.get('access_token') !== K.fbAppId + '|' + K.fbSecret) return send(res, 400, { error: { message: 'bad app token' } });
    const t = state.fb[u.searchParams.get('input_token')];
    return send(res, 200, { data: t ? { is_valid: true, app_id: t.app_id, user_id: t.id } : { is_valid: false } });
  }
  if (u.pathname === '/graph/me') { const t = state.fb[u.searchParams.get('access_token')]; return t ? send(res, 200, { id: t.id, name: t.name, ...(t.email ? { email: t.email } : {}) }) : send(res, 400, {}); }
  if (u.pathname === '/_fb' && req.method === 'POST') { const j = JSON.parse(body); state.fb[j.token] = j.user; return send(res, 200, {}); }
  if (u.pathname === '/emails') {
    if (req.headers.authorization !== 'Bearer re_test') return send(res, 401, {});
    state.emails.push(JSON.parse(body)); return send(res, 200, { id: 'em_' + state.emails.length });
  }
  // test control
  if (u.pathname === '/_state' && req.method === 'GET') return send(res, 200, state);
  if (u.pathname === '/_google' && req.method === 'POST') { const j = JSON.parse(body); state.google[j.token] = j.sub; return send(res, 200, {}); }
  if (u.pathname === '/_apple' && req.method === 'POST') { const j = JSON.parse(body); state.apple[j.id] = j.sub; return send(res, 200, {}); }
  send(res, 404, { error: 'mock_not_found', path: u.pathname });
}).listen(port, '127.0.0.1', () => console.log('mock stores on ' + port));
