import { describe, expect, it, vi } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';
process.env.APP_ENCRYPTION_KEY_ID = 'current';
process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material' });

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { EXACT_REDACTION_MARKER } from './exactSecretRedaction';
import {
  OUTPUT_VERIFICATION_FAILED_MARKER,
  redactResultAgainstCommandSecrets,
} from './commandSecretRedaction';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

function sealedCommand(secretEnv: Record<string, string>) {
  const payload = encryptSensitivePayloadFields(
    'script',
    { scriptId: 's', secretEnv },
    { commandId: COMMAND_ID, deviceId: DEVICE_ID },
  );
  // Non-vacuity: everything below is meaningless if nothing was actually sealed.
  expect(payload.secretEnvEnvelope).toBeDefined();
  return { id: COMMAND_ID, type: 'script', deviceId: DEVICE_ID, payload };
}

describe('redactResultAgainstCommandSecrets', () => {
  it('redacts stdout, stderr AND error', () => {
    const out = redactResultAgainstCommandSecrets(
      sealedCommand({ api_token: 'hunter2000' }),
      { stdout: 'a hunter2000', stderr: 'b hunter2000', error: 'c hunter2000' },
      'a hunter2000',
    );
    expect(out.result.stdout).toBe(`a ${EXACT_REDACTION_MARKER}`);
    expect(out.result.stderr).toBe(`b ${EXACT_REDACTION_MARKER}`);
    expect(out.result.error).toBe(`c ${EXACT_REDACTION_MARKER}`);
    expect(out.stdout).toBe(`a ${EXACT_REDACTION_MARKER}`);
  });

  it('redacts every secret in the envelope, not just the first', () => {
    const out = redactResultAgainstCommandSecrets(
      sealedCommand({ api_token: 'hunter2000', db_password: 'correct-horse' }),
      { stdout: 'hunter2000 / correct-horse', stderr: null, error: null },
      'hunter2000 / correct-horse',
    );
    expect(out.result.stdout).toBe(`${EXACT_REDACTION_MARKER} / ${EXACT_REDACTION_MARKER}`);
  });

  it('is an identity passthrough for a command with no envelope', () => {
    const result = { stdout: 'hunter2000', stderr: null, error: null };
    const out = redactResultAgainstCommandSecrets(
      { id: COMMAND_ID, type: 'script', deviceId: DEVICE_ID, payload: { scriptId: 's' } },
      result,
      'hunter2000',
    );
    expect(out.result).toBe(result);
    expect(out.stdout).toBe('hunter2000');
  });

  it('is an identity passthrough for a non-object payload', () => {
    const result = { stdout: 'x', stderr: null, error: null };
    const out = redactResultAgainstCommandSecrets(
      { id: COMMAND_ID, type: 'script', deviceId: DEVICE_ID, payload: null },
      result,
      'x',
    );
    expect(out.result).toBe(result);
  });

  it('fails closed when the envelope will not open', () => {
    // Status and exit code survive upstream; unverifiable OUTPUT never
    // persists, because it may contain a credential we can no longer find.
    const cmd = sealedCommand({ api_token: 'hunter2000' });
    const tampered = { ...cmd, deviceId: '33333333-3333-4333-8333-333333333333' };
    const out = redactResultAgainstCommandSecrets(
      tampered,
      { stdout: 'hunter2000', stderr: 'x', error: 'y' },
      'hunter2000',
    );
    expect(out.result.stdout).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.result.stderr).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.result.error).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.stdout).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
  });

  it('leaves empty output fields empty when failing closed', () => {
    // Nothing there to leak; inventing output would make an empty result look
    // like a suppressed one.
    const cmd = sealedCommand({ api_token: 'hunter2000' });
    const tampered = { ...cmd, deviceId: '33333333-3333-4333-8333-333333333333' };
    const out = redactResultAgainstCommandSecrets(
      tampered,
      { stdout: 'hunter2000', stderr: null, error: null },
      'hunter2000',
    );
    expect(out.result.stdout).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.result.stderr).toBeNull();
    expect(out.result.error).toBeNull();
  });

  it('preserves other result fields when failing closed', () => {
    const cmd = sealedCommand({ api_token: 'hunter2000' });
    const tampered = { ...cmd, deviceId: '33333333-3333-4333-8333-333333333333' };
    const out = redactResultAgainstCommandSecrets(
      tampered,
      { status: 'completed', exitCode: 0, stdout: 'hunter2000', stderr: null, error: null },
      'hunter2000',
    );
    expect(out.result.status).toBe('completed');
    expect(out.result.exitCode).toBe(0);
  });

  it('preserves null output fields as null on the happy path', () => {
    const out = redactResultAgainstCommandSecrets(
      sealedCommand({ api_token: 'hunter2000' }),
      { stdout: null, stderr: null, error: null },
      null,
    );
    expect(out.result.stdout).toBeNull();
    expect(out.result.stderr).toBeNull();
    expect(out.result.error).toBeNull();
    expect(out.stdout).toBeNull();
  });
});
