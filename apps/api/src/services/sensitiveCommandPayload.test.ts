import { beforeAll, describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';
// #3409 PR4a: the script secret envelope requires v3 (AAD-bound) encryption,
// which only happens when a key id and keyring are configured.
process.env.APP_ENCRYPTION_KEY_ID = 'current';
process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material' });

import {
  encryptSensitivePayloadFields,
  decryptSensitivePayloadFields,
  decryptCommandForDelivery,
  decryptCommandsForDelivery,
  hasSensitivePayload,
  TERMINAL_PAYLOAD_STRIP_KEYS,
  terminalPayloadErasureSet,
} from './sensitiveCommandPayload';

const DEVICE = '99999999-9999-4999-8999-999999999999';

describe('sensitiveCommandPayload', () => {
  it('flags encryption_rotate_key as sensitive, others not', () => {
    expect(hasSensitivePayload('encryption_rotate_key')).toBe(true);
    expect(hasSensitivePayload('security_scan')).toBe(false);
  });

  it('round-trips password and currentRecoveryKey; leaves other fields alone', () => {
    const input = { username: 'jane', password: 'hunter2', currentRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', volumeMount: 'C:' };
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', input);
    expect(encrypted.username).toBe('jane');
    expect(encrypted.volumeMount).toBe('C:');
    expect(encrypted.password).not.toBe('hunter2');
    expect(String(encrypted.password)).toMatch(/^enc:/);
    expect(String(encrypted.currentRecoveryKey)).toMatch(/^enc:/);

    const decrypted = decryptSensitivePayloadFields('encryption_rotate_key', encrypted) as Record<string, unknown>;
    expect(decrypted.password).toBe('hunter2');
    expect(decrypted.currentRecoveryKey).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
  });

  it('is a passthrough for non-sensitive command types and non-object payloads', () => {
    const payload = { password: 'plaintext-untouched' };
    expect(encryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', null)).toBe(null);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', 'str')).toBe('str');
  });

  it('skips absent/non-string sensitive fields', () => {
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', { volumeMount: 'C:' });
    expect(encrypted).toEqual({ volumeMount: 'C:' });
  });
});

describe('decryptCommandForDelivery', () => {
  it('decrypts sensitive fields and preserves id/type', () => {
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', { username: 'jane', password: 'hunter2', currentRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' });
    const out = decryptCommandForDelivery({ id: 'cmd-1', type: 'encryption_rotate_key', deviceId: DEVICE, payload: encrypted });
    expect(out).not.toBeNull();
    expect(out!.id).toBe('cmd-1');
    expect(out!.type).toBe('encryption_rotate_key');
    const payload = out!.payload as Record<string, unknown>;
    expect(payload.password).toBe('hunter2');
    expect(payload.currentRecoveryKey).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
    expect(payload.username).toBe('jane');
  });

  it('passes a non-sensitive command through unchanged', () => {
    const out = decryptCommandForDelivery({ id: 'cmd-2', type: 'security_scan', deviceId: DEVICE, payload: { scanType: 'quick' } });
    expect(out).toEqual({ id: 'cmd-2', type: 'security_scan', deviceId: DEVICE, payload: { scanType: 'quick' } });
  });

  it('returns null (drop, do not throw) when a sensitive field cannot be decrypted', () => {
    // A well-formed-looking but undecryptable ciphertext (e.g. after an
    // APP_ENCRYPTION_KEY rotation) must not blow up the delivery path.
    const out = decryptCommandForDelivery({ id: 'cmd-3', type: 'encryption_rotate_key', deviceId: DEVICE, payload: { password: 'enc:v3:deadbeef:not-real-ciphertext' } });
    expect(out).toBeNull();
  });
});

describe('decryptCommandsForDelivery', () => {
  it('delivers decryptable commands and drops only the undecryptable one — one bad payload never sinks the batch', () => {
    const good = encryptSensitivePayloadFields('encryption_rotate_key', { password: 'pw' });
    const batch = [
      { id: 'a', type: 'security_scan', deviceId: DEVICE, payload: { scanType: 'quick' } },
      { id: 'b', type: 'encryption_rotate_key', deviceId: DEVICE, payload: good },
      { id: 'c', type: 'encryption_rotate_key', deviceId: DEVICE, payload: { password: 'enc:v3:deadbeef:garbage' } },
    ];
    const out = decryptCommandsForDelivery(batch);
    expect(out.map((cmd) => cmd.id)).toEqual(['a', 'b']);
    expect((out[1]?.payload as Record<string, unknown> | undefined)?.password).toBe('pw');
  });

  it('returns an empty array for an empty batch', () => {
    expect(decryptCommandsForDelivery([])).toEqual([]);
  });
});

describe('terminal payload erasure', () => {
  it('strips every field name any sensitive command type can carry', () => {
    // Derived from the registry, not hand-listed: adding a sensitive field to
    // a command type must automatically extend the erasure set.
    expect(TERMINAL_PAYLOAD_STRIP_KEYS).toEqual(
      expect.arrayContaining(['password', 'currentRecoveryKey', 'secretEnvEnvelope']),
    );
  });

  it('emits a jsonb key-subtraction that preserves a NULL payload', () => {
    const { payload } = terminalPayloadErasureSet();
    // Render through the real dialect: a Drizzle SQL object holds a circular
    // reference to the table, and asserting on the emitted SQL is what
    // actually proves the key list reaches Postgres.
    const query = new PgDialect().sqlToQuery(payload);
    expect(query.sql).toContain('"device_commands"."payload" IS NULL');
    // Keys travel as bound parameters, never interpolated into the SQL text.
    expect(query.params).toEqual(expect.arrayContaining([...TERMINAL_PAYLOAD_STRIP_KEYS]));
    expect(query.sql).not.toContain('secretEnvEnvelope');
  });
});

describe('script secret envelope in the payload registry', () => {
  const ctx = {
    commandId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };

  it('replaces secretEnv with a sealed secretEnvEnvelope on encrypt', () => {
    const out = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    expect(out.secretEnv).toBeUndefined();
    expect(String(out.secretEnvEnvelope).startsWith('enc:v3:')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
    expect(JSON.stringify(out)).not.toContain('api_token');
  });

  it('restores secretEnv from the envelope on decrypt', () => {
    const sealed = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    // Non-vacuity: without this the round-trip would also "pass" if encrypt
    // and decrypt were both pure pass-throughs.
    expect(sealed.secretEnvEnvelope).toBeDefined();
    const opened = decryptSensitivePayloadFields('script', sealed, ctx) as Record<string, unknown>;
    expect(opened.secretEnv).toEqual({ api_token: 'super-secret-value' });
    expect(opened.secretEnvEnvelope).toBeUndefined();
    expect(opened.scriptId).toBe('s');
  });

  it('is a pure passthrough for a script payload with no secrets', () => {
    const payload = { scriptId: 's', content: 'echo hi' };
    expect(encryptSensitivePayloadFields('script', payload, ctx)).toEqual(payload);
    expect(decryptSensitivePayloadFields('script', payload, ctx)).toEqual(payload);
  });

  it('throws rather than shipping plaintext when no context is supplied', () => {
    // A caller that forgets the context must FAIL, never silently enqueue
    // plaintext credentials into a system-scoped, unbounded-retention table.
    expect(() =>
      encryptSensitivePayloadFields('script', { secretEnv: { api_token: 'super-secret-value' } }),
    ).toThrow(/encryption context/);
  });

  it('reports script as carrying a sensitive payload', () => {
    expect(hasSensitivePayload('script')).toBe(true);
  });

  it('drops the command (returns null) when the envelope will not open', () => {
    const sealed = encryptSensitivePayloadFields(
      'script',
      { secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    expect(
      decryptCommandForDelivery({
        id: ctx.commandId,
        type: 'script',
        deviceId: '33333333-3333-4333-8333-333333333333',
        payload: sealed,
      }),
    ).toBeNull();
  });

  it('delivers the opened map when the context matches', () => {
    const sealed = encryptSensitivePayloadFields(
      'script',
      { secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    expect(sealed.secretEnvEnvelope).toBeDefined();
    const delivered = decryptCommandForDelivery({
      id: ctx.commandId,
      type: 'script',
      deviceId: ctx.deviceId,
      payload: sealed,
    });
    expect((delivered?.payload as Record<string, unknown>).secretEnv).toEqual({
      api_token: 'super-secret-value',
    });
  });
});
