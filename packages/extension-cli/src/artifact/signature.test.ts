import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEd25519PrivateKey, signEd25519 } from './signature';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'breeze-ext-signature-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function generateEd25519Pem() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function generateRsaPem() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('loadEd25519PrivateKey', () => {
  it('loads a key from a file path', async () => {
    const { privateKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const loaded = await loadEd25519PrivateKey({ key: keyPath });

    expect(loaded.asymmetricKeyType).toBe('ed25519');
  });

  it('loads a key from the named environment variable', async () => {
    const { privateKey } = generateEd25519Pem();
    process.env.TEST_BREEZE_SIGNING_KEY = privateKey;
    try {
      const loaded = await loadEd25519PrivateKey({ keyEnv: 'TEST_BREEZE_SIGNING_KEY' });
      expect(loaded.asymmetricKeyType).toBe('ed25519');
    } finally {
      delete process.env.TEST_BREEZE_SIGNING_KEY;
    }
  });

  it('rejects a non-Ed25519 (RSA) key with a clear message', async () => {
    const { privateKey } = generateRsaPem();
    const keyPath = join(workDir, 'rsa-key.pem');
    await writeFile(keyPath, privateKey);

    await expect(loadEd25519PrivateKey({ key: keyPath })).rejects.toThrow(/ed25519/i);
  });

  it('throws when the named environment variable is unset', async () => {
    await expect(
      loadEd25519PrivateKey({ keyEnv: 'NOT_A_REAL_ENV_VAR_XYZ' }),
    ).rejects.toThrow(/NOT_A_REAL_ENV_VAR_XYZ/);
  });

  it('throws when neither key nor keyEnv is provided', async () => {
    await expect(loadEd25519PrivateKey({})).rejects.toThrow();
  });
});

describe('signEd25519', () => {
  it('produces raw signature bytes that verify under the matching public key', async () => {
    const { privateKey: privateKeyPem, publicKey: publicKeyPem } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKeyPem);
    const privateKey = await loadEd25519PrivateKey({ key: keyPath });
    const publicKey = createPublicKey(publicKeyPem);
    const payload = Buffer.from('hello world');

    const signature = signEd25519(privateKey, payload);

    expect(Buffer.isBuffer(signature)).toBe(true);
    expect(signature.length).toBe(64); // raw Ed25519 signature length
    expect(cryptoVerify(null, payload, publicKey, signature)).toBe(true);
  });

  it('fails verification under a different keypair', async () => {
    const { privateKey: privateKeyPem } = generateEd25519Pem();
    const { publicKey: otherPublicKeyPem } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKeyPem);
    const privateKey = await loadEd25519PrivateKey({ key: keyPath });
    const otherPublicKey = createPublicKey(otherPublicKeyPem);
    const payload = Buffer.from('hello world');

    const signature = signEd25519(privateKey, payload);

    expect(cryptoVerify(null, payload, otherPublicKey, signature)).toBe(false);
  });
});
