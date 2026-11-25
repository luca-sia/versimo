import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { createAppJwt, verifyWebhookSignature } from '../src/github/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decode(part: string) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

for (const [name, pem] of [['PKCS#1', pkcs1], ['PKCS#8', pkcs8]] as const) {
  test(`createAppJwt signs RS256 with a ${name} key`, async () => {
    const jwt = await createAppJwt({ appId: 12345, privateKey: pem, now: '2026-11-25T23:00:00Z' });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
    const iat = Date.parse('2026-11-25T23:00:00Z') / 1000 - 60;
    assert.deepEqual(decode(p), { iat, exp: iat + 600, iss: '12345' });
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
    assert.equal(ok, true);
  });
}

test('createAppJwt rejects a key that is not PEM', async () => {
  await assert.rejects(createAppJwt({ appId: 1, privateKey: 'nope' }), TypeError);
});

test('verifyWebhookSignature accepts a good signature and nothing else', async () => {
  const body = '{"ref":"refs/tags/billing/v2.4.0"}';
  const good = `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`;
  assert.equal(await verifyWebhookSignature('shh', body, good), true);
  assert.equal(await verifyWebhookSignature('shh', new TextEncoder().encode(body), good), true);
  assert.equal(await verifyWebhookSignature('other', body, good), false);
  assert.equal(await verifyWebhookSignature('shh', `${body} `, good), false);
  assert.equal(await verifyWebhookSignature('shh', body, good.replace('sha256=', 'sha1=')), false);
  assert.equal(await verifyWebhookSignature('shh', body, null), false);
  assert.equal(await verifyWebhookSignature('', body, good), false);
});
