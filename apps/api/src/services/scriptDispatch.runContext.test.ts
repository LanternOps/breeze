import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #4888 — dispatch is the ONE seam a run context has to pass through
 * regardless of caller (route, AI tool, remediation). This pins the part
 * scriptDispatch.test.ts's existing suite doesn't cover: that a
 * caller-supplied `runAs`/`targetSessionId` actually lands in the
 * `script_executions` INSERT (so execution history can answer "SYSTEM or the
 * logged-in user?" without reading the sanitised command payload), that an
 * OMITTED `runAs` falls back to the script's own saved default rather than
 * some hardcoded value, and that the `ok: true` result carries the same
 * resolved value the row got stamped with — one source of truth, not two
 * independently-computed answers that could disagree.
 *
 * Reuses scriptDispatch.test.ts's own mocking approach (same modules mocked
 * the same way, same insertReturning/db.insert-values-capture idiom) rather
 * than inventing a parallel harness.
 */

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', () => ({ queueCommand: vi.fn() }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./scriptSecretDelivery', () => ({
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { dispatchScriptToDevice } from './scriptDispatch';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null,
  hostname: 'host-1', siteId: 'site-1', customFields: {}, ...o,
}) as any;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
});

describe('dispatchScriptToDevice — run context stamped on the execution row (#4888)', () => {
  it('stamps the CALLER-supplied runAs and targetSessionId on the script_executions insert', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ runAs: 'system' }) },
      runAs: 'user',
      targetSessionId: 3,
    });

    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ runAs: 'user', targetSessionId: 3 });
  });

  it('falls back to the SCRIPT\'S saved default runAs when the caller supplies none', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ runAs: 'elevated' }) },
      // No `runAs` in the input at all.
    });

    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ runAs: 'elevated', targetSessionId: null });
  });

  it('the ok:true result carries the SAME resolved runAs as the row — one source of truth, not two', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ runAs: 'system' }) },
      runAs: 'user',
      targetSessionId: 5,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok:true');
    expect(r.runAs).toBe('user');
    expect(r.targetSessionId).toBe(5);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues.runAs).toBe(r.runAs);
    expect(execValues.targetSessionId).toBe(r.targetSessionId);
  });

  it('the ok:true result falls back to the script default too, when the caller supplied none', async () => {
    const r = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ runAs: 'elevated' }) },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok:true');
    expect(r.runAs).toBe('elevated');
    expect(r.targetSessionId).toBeNull();
  });
});
