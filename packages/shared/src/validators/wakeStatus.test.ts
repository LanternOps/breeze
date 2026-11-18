import { describe, expect, it } from 'vitest';
import { WAKE_AGENT_READINESS_STATES, wakeStatusSnapshotSchema } from './wakeStatus';

const valid = () => ({
  readinessState: 'unproven',
  reasonCodes: ['firmware_adapter_unavailable'],
  vendor: 'dell',
  fingerprint: 'a'.repeat(64),
  collectedAt: '2026-11-15T10:00:00Z',
  lastApplyAt: null,
  lastApplyResult: null,
  lastWiredAdapterSeenAt: '2026-11-15T09:59:00+00:00',
  details: { os: 'windows', adapters: [] },
});

describe('wakeStatusSnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    expect(wakeStatusSnapshotSchema.safeParse(valid()).success).toBe(true);
  });

  it('accepts every agent readiness state and rejects others', () => {
    for (const readinessState of WAKE_AGENT_READINESS_STATES) {
      expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), readinessState }).success).toBe(true);
    }
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), readinessState: 'unsupported_os' }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), readinessState: 'bogus' }).success).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), deviceId: 'x' }).success).toBe(false);
  });

  it('rejects more than 16 reason codes and malformed codes', () => {
    const many = Array.from({ length: 17 }, (_, i) => `code_${i}`);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), reasonCodes: many }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), reasonCodes: many.slice(0, 16) }).success).toBe(true);
    for (const bad of ['Upper', 'has space', 'dash-ed', '', 'a'.repeat(65)]) {
      expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), reasonCodes: [bad] }).success).toBe(false);
    }
  });

  it('rejects non-ISO dates', () => {
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), collectedAt: 'yesterday' }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), collectedAt: '2026-11-15' }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), lastApplyAt: 'nope' }).success).toBe(false);
  });

  it('bounds vendor, fingerprint and lastApplyResult', () => {
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), vendor: '' }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), vendor: 'x'.repeat(33) }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), fingerprint: '' }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), fingerprint: 'f'.repeat(129) }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), lastApplyResult: 'r'.repeat(33) }).success).toBe(false);
    expect(wakeStatusSnapshotSchema.safeParse({ ...valid(), vendor: null }).success).toBe(true);
  });
});
