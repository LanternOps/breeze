import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `open`: system contexts not yet committed (#7103 — the send must see 0).
const txState = vi.hoisted(() => ({ open: 0 }));
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    txState.open += 1;
    try {
      return await fn();
    } finally {
      txState.open -= 1;
    }
  }),
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
    runAs: 'system' as const,
    targetSessionId: null,
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

  describe('staged-version hold-back warning (#7039)', () => {
    const heldWarns = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes('withholding automatic edition migration'));

    it('names the org, the pin, the device and the action to take when a pin holds a device back', async () => {
      primeHappyPath();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await maybeDispatchEditionMigration(
        baseArgs({ pin: '0.107.0', resolveTarget: vi.fn().mockResolvedValue('0.107.0') }),
      );
      const msgs = heldWarns(warn);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('org org-1');
      expect(msgs[0]).toContain('agent version pin 0.107.0');
      expect(msgs[0]).toContain('device-1');
      expect(msgs[0]).toContain('HOST-1');
      expect(msgs[0]).toContain('staged release 0.108.0');
      expect(msgs[0]).toMatch(/raise or clear/);
      warn.mockRestore();
    });

    it('says "no pin" and points at promotion when the unpinned target is not the staged release', async () => {
      primeHappyPath();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await maybeDispatchEditionMigration(baseArgs({ resolveTarget: vi.fn().mockResolvedValue('0.107.0') }));
      const msgs = heldWarns(warn);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('org org-1');
      expect(msgs[0]).toContain('no agent version pin');
      expect(msgs[0]).toMatch(/promoted/);
      warn.mockRestore();
    });

    it('warns separately for each held-back org instead of once per process', async () => {
      primeHappyPath();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const held = { pin: '0.107.0', resolveTarget: vi.fn().mockResolvedValue('0.107.0') };
      await maybeDispatchEditionMigration(baseArgs(held));
      await maybeDispatchEditionMigration(
        baseArgs({ ...held, device: device({ id: 'device-2', orgId: 'org-2', hostname: 'HOST-2' }) }),
      );
      const msgs = heldWarns(warn);
      expect(msgs).toHaveLength(2);
      expect(msgs[1]).toContain('org org-2');
      warn.mockRestore();
    });

    it('re-warns hourly per org with the count of distinct held-back devices, not every heartbeat', async () => {
      primeHappyPath();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const now = vi.spyOn(Date, 'now');
      const t0 = 1_900_000_000_000;
      const held = { pin: '0.107.0', resolveTarget: vi.fn().mockResolvedValue('0.107.0') };

      now.mockReturnValue(t0);
      await maybeDispatchEditionMigration(baseArgs(held));
      now.mockReturnValue(t0 + 60_000);
      await maybeDispatchEditionMigration(baseArgs(held));
      await maybeDispatchEditionMigration(
        baseArgs({ ...held, device: device({ id: 'device-2', hostname: 'HOST-2' }) }),
      );
      expect(heldWarns(warn)).toHaveLength(1);

      now.mockReturnValue(t0 + 60 * 60_000 + 1);
      await maybeDispatchEditionMigration(baseArgs(held));
      const msgs = heldWarns(warn);
      expect(msgs).toHaveLength(2);
      expect(msgs[1]).toContain('2 stranded self-host device(s)');
      now.mockRestore();
      warn.mockRestore();
    });
  });

  it('withholds when the deployment release is unknown (BREEZE_VERSION unset)', async () => {
    primeHappyPath();
    vi.mocked(getGithubReleaseVersion).mockReturnValue('latest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await maybeDispatchEditionMigration(baseArgs({ pin: '0.108.0' }));
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    // #7039: the unknown-release cause wins over the pin wording — the pin is
    // not what is holding the device back here.
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('org org-1');
    expect(msgs[0]).toContain('Set BREEZE_VERSION');
    expect(msgs[0]).not.toContain('agent version pin');
    warn.mockRestore();
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

  /**
   * #4919 — dispatch now refuses a device inside a maintenance window that
   * suppresses scripts. The migration IS this device's update, so deferring is
   * correct; what must NOT happen is the deferral being treated like the
   * `insert_failed` refusal above. That path adds the device to the
   * process-lifetime `failedDevices` veto and reports to Sentry — which would
   * mean a device that happened to heartbeat during a nightly window never
   * migrated again until the API restarted, and would page on an operator's
   * own maintenance schedule.
   */
  it('defers (claim released, no Sentry, retryable next beat) when dispatch reports maintenance_suppressed', async () => {
    const claim = primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false,
      code: 'maintenance_suppressed',
      error: 'Device is in a maintenance window that suppresses script execution',
    } as never);

    await maybeDispatchEditionMigration(baseArgs());

    expect(captureException).not.toHaveBeenCalled();
    expect(claim.set).toHaveBeenCalledWith({ editionMigrationDispatchedAt: null });

    // The device is NOT vetoed in-process: the next heartbeat (window now
    // closed, dispatch permitted) tries again and succeeds.
    vi.mocked(dispatchScriptToDevice).mockClear();
    const claim2 = primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true, commandId: 'cmd-2', executionId: 'exec-2', delivered: true,
    } as never);

    await maybeDispatchEditionMigration(baseArgs());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(claim2.set).toHaveBeenCalledWith(
      expect.objectContaining({ editionMigrationDispatchedAt: expect.any(Date) }),
    );
  });

  it('treats an UNEVALUATABLE maintenance check as a fault: Sentry, and vetoed in-process', async () => {
    // Distinct from the deferral above. A maintenance config we cannot read is
    // a broken safety dependency; retrying it every 60s forever while staying
    // silent is exactly the shape that hides an outage.
    primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: false,
      code: 'maintenance_check_failed',
      error: 'Maintenance window could not be evaluated for this device; refusing to run the script (fail-closed)',
    } as never);

    await maybeDispatchEditionMigration(baseArgs());
    expect(captureException).toHaveBeenCalled();

    // Vetoed in-process: no second attempt this process lifetime.
    vi.mocked(dispatchScriptToDevice).mockClear();
    vi.mocked(db.update).mockClear();
    await maybeDispatchEditionMigration(baseArgs());
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

  // #7103 — the heartbeat wrapped this whole service in one system context, so
  // the reinstall command went out before its rows (and the claim) committed.
  it('writes the claim and the rows in its own context and sends only after it commits', async () => {
    const claim = primeHappyPath();
    const events: Array<{ kind: string; open: number }> = [];
    claim.returning.mockImplementation(async () => {
      events.push({ kind: 'claim', open: txState.open });
      return [{ id: 'device-1' }];
    });
    const base = {
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      executedAt: null,
      ignoredParameters: [],
      runAs: 'system' as const,
      targetSessionId: null,
    };
    vi.mocked(dispatchScriptToDevice).mockImplementation((async (input: { deferDelivery?: boolean }) => {
      events.push({ kind: 'create', open: txState.open });
      const deliver = async () => {
        events.push({ kind: 'send', open: txState.open });
        return { ...base, delivered: true, deliveryOutcome: 'sent' };
      };
      return input.deferDelivery
        ? { ...base, delivered: false, deliveryOutcome: 'deferred', deliver }
        : deliver();
    }) as never);

    await maybeDispatchEditionMigration(baseArgs());

    expect(vi.mocked(dispatchScriptToDevice).mock.calls[0]![0]).toMatchObject({ deferDelivery: true });
    expect(events).toEqual([
      { kind: 'claim', open: 1 },
      { kind: 'create', open: 1 },
      { kind: 'send', open: 0 },
    ]);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'agent_edition_auto_migration_dispatched' }),
    );
  });

  it('keeps the claim when a claim-time refusal comes back after commit', async () => {
    const claim = primeHappyPath();
    vi.mocked(dispatchScriptToDevice).mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      executedAt: null,
      ignoredParameters: [],
      runAs: 'system' as const,
      targetSessionId: null,
      delivered: false,
      deliveryOutcome: 'deferred',
      deliver: async () => ({ ok: false, code: 'secret_gate_unavailable', error: 'gate down' }),
    } as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(maybeDispatchEditionMigration(baseArgs())).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalled();
    expect(claim.set).not.toHaveBeenCalledWith({ editionMigrationDispatchedAt: null });
    error.mockRestore();
  });
});
