import { describe, it, expect, vi, beforeEach } from 'vitest';

// #5129 — the acknowledged STRICT-pattern set has to reach the agent, or the
// whole feature is inert: the script record says "approved" and the device
// still refuses. Mocks mirror scriptDispatch.test.ts; this file covers only
// the acknowledgement field so it stays readable next to that suite.

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
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

const HKLM = 'PowerShell HKLM modification';

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

const savedScript = (o = {}) =>
  ({
    id: 'script-1',
    orgId: 'org-a',
    partnerId: null,
    isSystem: false,
    osTypes: ['linux'],
    language: 'bash',
    content: "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Contoso' -Name Enabled -Value 1",
    timeoutSeconds: 60,
    runAs: 'system',
    deletedAt: null,
    acknowledgedSecurityPatterns: [],
    ...o,
  }) as never;

const device = (o = {}) =>
  ({
    id: 'device-1',
    orgId: 'org-a',
    osType: 'linux',
    status: 'online',
    agentId: null,
    hostname: 'host-1',
    siteId: 'site-1',
    customFields: {},
    ...o,
  }) as never;

function dispatchedPayload(): Record<string, unknown> {
  const call = vi.mocked(queueCommand).mock.calls[0];
  expect(call, 'queueCommand was never called').toBeDefined();
  return call![2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as never);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as never);
});

describe('dispatchScriptToDevice — acknowledged security patterns (#5129)', () => {
  it('puts the acknowledged set on the payload for a saved script', async () => {
    const result = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ acknowledgedSecurityPatterns: [HKLM] }) },
    });

    expect(result.ok).toBe(true);
    expect(dispatchedPayload().acknowledgedSecurityPatterns).toEqual([HKLM]);
  });

  it('omits the key entirely when the script acknowledges nothing', async () => {
    // The wire stays byte-identical to pre-#5129 for every unacknowledged
    // script, and an absent key is what the agent already treats as fail
    // closed.
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ acknowledgedSecurityPatterns: [] }) },
    });

    expect(dispatchedPayload()).not.toHaveProperty('acknowledgedSecurityPatterns');
  });

  it('omits the key when the column is null on a pre-migration row', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ acknowledgedSecurityPatterns: null }) },
    });

    expect(dispatchedPayload()).not.toHaveProperty('acknowledgedSecurityPatterns');
  });

  it('never acknowledges anything for a raw ad-hoc source', async () => {
    // A `raw` source has no script record and so no human decision on file.
    // Ad-hoc content keeps the pre-#5129 behaviour: any Strict match is
    // refused on the device.
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'raw',
        content: "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\X' -Name Y -Value 1",
        language: 'powershell',
        provenance: 'automation:auto-1',
      },
      timeoutSeconds: 300,
      runAs: 'system',
    });

    expect(dispatchedPayload()).not.toHaveProperty('acknowledgedSecurityPatterns');
  });

  it('forwards several acknowledged descriptions verbatim', async () => {
    // Byte-for-byte: the agent compares against ITS description strings, so
    // any rewriting here silently stops the acknowledgement working.
    const patterns = [HKLM, 'scheduled task creation'];
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'saved', script: savedScript({ acknowledgedSecurityPatterns: patterns }) },
    });

    expect(dispatchedPayload().acknowledgedSecurityPatterns).toEqual(patterns);
  });
});
