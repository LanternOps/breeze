import { describe, expect, it } from 'vitest';

import { executeScriptSchema } from './scripts';

const base = { deviceIds: ['0b56e4a6-5f2a-4b7e-9c3d-2e8f1a6b7c8d'] };

describe('executeScriptSchema targetSessionId', () => {
  it('accepts a session target with runAs=user on a single device', () => {
    const parsed = executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 3 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.targetSessionId).toBe(3);
  });

  it('rejects a target without runAs=user', () => {
    expect(executeScriptSchema.safeParse({ ...base, targetSessionId: 3 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'system', targetSessionId: 3 }).success).toBe(false);
  });

  it('rejects a target across multiple devices (session ids are per-device)', () => {
    const two = { deviceIds: [base.deviceIds[0], '1c67f5b7-6a3b-4c8f-8d4e-3f9a2b7c8d9e'], runAs: 'user', targetSessionId: 3 };
    expect(executeScriptSchema.safeParse(two).success).toBe(false);
  });

  it('rejects out-of-range and non-integer targets', () => {
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 70000 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 1.5 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: -1 }).success).toBe(false);
  });

  it('rejects session 0 (never an interactive session)', () => {
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 0 }).success).toBe(false);
  });

  it('still accepts untargeted runs unchanged', () => {
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user' }).success).toBe(true);
    expect(executeScriptSchema.safeParse(base).success).toBe(true);
  });
});
