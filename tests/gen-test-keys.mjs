// Test-only: makes throwaway keys + a .dev.vars that points the Worker at tests/mock-stores.mjs.
// Usage: node tests/gen-test-keys.mjs <keydir> <mock-base> <devvars-path>
import crypto from 'node:crypto';
import fs from 'node:fs';
const [dir, mock, devvars] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const pem = (k, t) => k.export({ type: t, format: 'pem' });
const id = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ap = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const idJwk = { ...id.publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' };
const bundle = 'app.seascout.marine';
fs.writeFileSync(dir + '/keys.json', JSON.stringify({ idJwk, idPriv: pem(id.privateKey, 'pkcs8'), saPub: pem(sa.publicKey, 'spki'), applePub: pem(ap.publicKey, 'spki'), bundle }));
const saJson = JSON.stringify({ type: 'service_account', client_email: 'play@test.iam.gserviceaccount.com', private_key: pem(sa.privateKey, 'pkcs8'), private_key_id: 'sa1', token_uri: mock + '/token' });
const q = (v) => JSON.stringify(v);
fs.writeFileSync(devvars, [
  `GOOGLE_CLIENT_IDS=${q('test-google-client')}`, `APPLE_CLIENT_IDS=${q(bundle)}`,
  `GOOGLE_JWKS_URL=${q(mock + '/jwks')}`, `APPLE_JWKS_URL=${q(mock + '/jwks')}`,
  `RESEND_API_KEY=${q('re_test')}`, `RESEND_API_URL=${q(mock + '/emails')}`, `EMAIL_FROM=${q('Sea Scout <no-reply@example.com>')}`,
  `GOOGLE_PLAY_PACKAGE=${q(bundle)}`, `GOOGLE_SERVICE_ACCOUNT_JSON='${saJson}'`, `GOOGLE_API_BASE=${q(mock)}`, `GOOGLE_TOKEN_URL=${q(mock + '/token')}`,
  `GOOGLE_RTDN_AUDIENCE=${q('https://seascout.test/rtdn')}`, `GOOGLE_RTDN_SA_EMAIL=${q('pubsub@test.iam.gserviceaccount.com')}`,
  `APPLE_BUNDLE_ID=${q(bundle)}`, `APPLE_ISSUER_ID=${q('issuer-1')}`, `APPLE_KEY_ID=${q('KEY123')}`, `APPLE_PRIVATE_KEY=${q(pem(ap.privateKey, 'pkcs8'))}`, `APPLE_API_BASE=${q(mock)}`,
].join('\n') + '\n');
console.log('keys + ' + devvars + ' written');
