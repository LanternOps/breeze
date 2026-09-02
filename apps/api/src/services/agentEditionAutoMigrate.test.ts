import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./binaryEdition', () => ({ getBinaryEdition: vi.fn(() => 'hosted') }));
vi.mock('./binarySource', () => ({ getGithubReleaseVersion: vi.fn(() => '0.108.0') }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('node:fs', () => ({ createReadStream: vi.fn(() => ({})) }));
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({ mtimeMs: 1000, size: 4 })) }));
vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(async (_src: unknown, hash: { update: (b: Buffer) => void }) => {
    hash.update(Buffer.from('MSI!'));
  }),
}));

import { createHash } from 'node:crypto';
import { db } from '../db';
import { getBinaryEdition } from './binaryEdition';
import { getGithubReleaseVersion } from './binarySource';
import { dispatchScriptToDevice } from './scriptDispatch';
import { captureException, captureMessage } from './sentry';
import { stat } from 'node:fs/promises';
import {
  maybeDispatchEditionMigration,
  EDITION_MIGRATION_SCRIPT_NAME,
  __resetEditionAutoMigrateStateForTests,
} from './agentEditionAutoMigrate';

const MSI_SHA = createHash('sha256').update(Buffer.from('MSI!')).digest('hex');

const systemScriptRow = {
  id: 'script-1',
  orgId: null,
  isSystem: true,
  name: EDITION_MIGRATION_SCRIPT_NAME,
  osTypes: ['windows'],
  language: 'powershell',
  content: 'migration content',
  timeoutSeconds: 1800,
  runAs: 'system',
  deletedAt: null,
};

const device = (o: Record<string, unknown> = {}) => ({
  id: 'device-1',
  orgId: 'org-1',
  osType: 'windows',
  status: 'updating',
  agentId: 'agent-1',
  hostname: 'HOST-1',
  siteId: 'site-1',
  customFields: null,
  editionMigrationDispatchedAt: null,
  ...o,
}) as never;

// db.select chain resolving to `rows` (script lookup).
function selectResolving(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { from };
}

// db.update chain whose .returning resolves to `rows` (the atomic claim).
function updateReturning(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return { chain: { set }, set, where, returning };
}

function baseArgs(over: Record<string, unknown> = {}) {
  return {
    device: device(),
    reportedAgentVersion: '0.105.1',
    normalizedArch: 'amd64' as const,
    updateGateAllows: true,
    pin: null,
    resolveTarget: vi.fn().mockResolvedValue('0.108.0'),
    ...over,
  } as never;
}

function primeHappyPath() {
  vi.mocked(db.select).mockReturnValue(selectResolving([systemScriptRow]) as never);
  const claim = updateReturning([{ id: 'device-1' }]);
  vi.mocked(db.update).mockReturnValue(claim.chain as never);
  vi.mocked(dispatchScriptToDevice).mockResolvedValue({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    deliveryOutcome: 'sent',
    executedAt: null,
    ignoredParameters: [],
  } as never);
  return claim;
}

describe('maybeDispatchEditionMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetEditionAutoMigrateStateForTests();
    process.env.AGENT_EDITION_AUTO_MIGRATE_ENABLED = 'true';
    process.env.PUBLIC_API_URL = 'https://eu.example.app';
    vi.mocked(getBinaryEdition).mockReturnValue('hosted' as never);
    vi.mocked(getGithubReleaseVersion).mockReturnValue('0.108.0');
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1000, size: 4 } as never);
  });

  afterEach(() => {
    delete process.env.AGENT_EDITION_AUTO_MIGRATE_ENABLED;
    delete process.env.PUBLIC_API_URL;
  });

  it('dispatches the system migration script with msi url, sha256, and target edition', async () => {
    primeHappyPath();
    await maybeDispatchEditionMigration(baseArgs());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    const input = vi.mocked(dispatchScriptToDevice).mock.calls[0]![0];
    expect(input.source).toEqual({ kind: 'saved', script: systemScriptRow });
    expect(input.parameters).toEqual({
      msi_url: 'https://eu.example.app/api/v1/agents/download/windows/amd64/msi',
      msi_sha256: MSI_SHA,
      target_edition: 'hosted',
    });
    expect(input.triggerType).toBe('policy');
    expect(input.device.id).toBe('device-1');
    // Informational success signal goes through captureMessage (BREEZE-18),
    // never a fabricated Error.
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'agent_edition_auto_migration_dispatched' }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('claims the once-per-device marker atomically BEFORE dispatching (guarded on IS NULL)', async () => {
    const claim = primeHappyPath();
    await maybeDispatchEditionMigration(baseArgs());
    expect(claim.set).toHaveBeenCalledWith(
      expect.objectContaining({ editionMigrationDispatchedAt: expect.any(Date) }),
    );
    expect(claim.returning).toHaveBeenCalled();
    // Claim must resolve before dispatch fired.
    const claimOrder = claim.returning.mock.invocationCallOrder[0]!;
    const dispatchOrder = vi.mocked(dispatchScriptToDevice).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(dispatchOrder);
  });

  it('does nothing when the claim is lost (another heartbeat won the race)', async () => {
    primeHappyPath();
    const lost = updateReturning([]);
    vi.mocked(db.update).mockReturnValue(lost.chain as never);
    await maybeDispatchEditionMigration(baseArgs());
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it.each([
    ['flag disabled', () => { process.env.AGENT_EDITION_AUTO_MIGRATE_ENABLED = 'false'; }, {}],
    ['self-host server edition', () => { vi.mocked(getBinaryEdition).mockReturnValue('self-host' as never); }, {}],
    ['non-windows device', () => {}, { device: device({ osType: 'linux' }) }],
    ['non-amd64 arch', () => {}, { normalizedArch: 'arm64' }],
    ['org update policy gate closed', () => {}, { updateGateAllows: false }],
    ['already dispatched for this device', () => {}, { device: device({ editionMigrationDispatchedAt: new Date() }) }],
  ])('skips without any DB write or dispatch: %s', async (_label, setup, argsOver) => {
    primeHappyPath();
    setup();
    await maybeDispatchEditionMigration(baseArgs(argsOver));
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('skips when no upgrade target resolves, or the target is not newer (holdback pin respected)', async () => {
    primeHappyPath();
    await maybeDispatchEditionMigration(baseArgs({ resolveTarget: vi.fn().mockResolvedValue(null) }));
    await maybeDispatchEditionMigration(baseArgs({ resolveTarget: vi.fn().mockResolvedValue('0.105.1') }));
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('withholds when the resolved target does not match the staged release (pin/promotion respected)', async () => {
    primeHappyPath();
    // Org pinned to 0.107.0 but the deployment's staged installer is 0.108.0:
    // dispatching would install a version the tenant did not select.
    await maybeDispatchEditionMigration(baseArgs({ resolveTarget: vi.fn().mockResolvedValue('0.107.0') }));
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('withholds when the deployment release is unknown (BREEZE_VERSION unset)', async () => {
    primeHappyPath();
    vi.mocked(getGithubReleaseVersion).mockReturnValue('latest');
    await maybeDispatchEditionMigration(baseArgs());
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('skips (before claiming) when the staged MSI is unreadable', async () => {
    primeHappyPath();
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    await maybeDispatchEditionMigration(baseArgs());
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('skips (before claiming) when the system script row is missing', async () => {
    primeHappyPath();
    vi.mocked(db.select).mockReturnValue(selectResolving([]) as never);
    await maybeDispatchEditionMigration(baseArgs());
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('skips (before claiming) when no public base URL is configured', async () => {
    primeHappyPath();
    delete process.env.PUBLIC_API_URL;
    delete process.env.API_URL;
    await maybeDispatchEditionMigration(baseArgs());
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('releases the claim and records the failure when dispatch refuses, and does not re-attempt in-process', async () => {
    const claim = primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false,
      code: 'insert_failed',
      error: 'Failed to create command',
    } as never);

    await maybeDispatchEditionMigration(baseArgs());
    expect(captureException).toHaveBeenCalled();
    // Claim stamped once, then released (set back to null).
    expect(claim.set).toHaveBeenCalledWith(
      expect.objectContaining({ editionMigrationDispatchedAt: expect.any(Date) }),
    );
    expect(claim.set).toHaveBeenCalledWith({ editionMigrationDispatchedAt: null });

    // Second beat in the same process: no new dispatch attempt.
    vi.mocked(dispatchScriptToDevice).mockClear();
    vi.mocked(db.update).mockClear();
    await maybeDispatchEditionMigration(baseArgs());
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('never throws into the caller — a dispatch CRASH keeps the claim (queue state indeterminate)', async () => {
    const claim = primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockRejectedValue(new Error('boom'));
    await expect(maybeDispatchEditionMigration(baseArgs())).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalled();
    // A THROW from dispatchScriptToDevice may be post-insert: the command may
    // already exist, so the once-per-device claim must stand — only a typed
    // ok:false refusal (provably nothing queued) releases it.
    expect(claim.set).not.toHaveBeenCalledWith({ editionMigrationDispatchedAt: null });
  });
});
