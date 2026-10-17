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

describe('executeScriptSchema group target (#8598)', () => {
  const G = '11111111-1111-4111-8111-111111111111';
  const D = base.deviceIds[0];
  const groupTarget = { type: 'groups', groupIds: [G] };

  it('accepts a groups target in place of deviceIds', () => {
    const parsed = executeScriptSchema.safeParse({ target: groupTarget });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.target).toEqual(groupTarget);
      expect(parsed.data.deviceIds).toBeUndefined();
    }
  });

  it('rejects both deviceIds and target, and neither', () => {
    expect(executeScriptSchema.safeParse({ deviceIds: [D], target: groupTarget }).success).toBe(false);
    expect(executeScriptSchema.safeParse({}).success).toBe(false);
    expect(executeScriptSchema.safeParse({ runAs: 'system' }).success).toBe(false);
  });

  it('rejects targetSessionId with a group target', () => {
    expect(
      executeScriptSchema.safeParse({ target: groupTarget, runAs: 'user', targetSessionId: 2 }).success,
    ).toBe(false);
  });

  it('rejects non-groups target types and an empty group list', () => {
    expect(executeScriptSchema.safeParse({ target: { type: 'all' } }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ target: { type: 'devices', deviceIds: [D] } }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ target: { type: 'groups', groupIds: [] } }).success).toBe(false);
  });

  it('still caps explicit deviceIds at 500 and leaves a deviceIds parse without a target key', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(executeScriptSchema.safeParse({ deviceIds: ids }).success).toBe(false);
    const parsed = executeScriptSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('target' in parsed.data).toBe(false);
  });

  it('rejects an empty deviceIds list', () => {
    expect(executeScriptSchema.safeParse({ deviceIds: [] }).success).toBe(false);
  });
});
