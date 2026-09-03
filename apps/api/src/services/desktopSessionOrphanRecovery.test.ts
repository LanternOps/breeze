import { describe, expect, it, vi } from 'vitest';

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
}));

import {
  __desktopSessionOrphanRecoveryTestOnly,
  createDesktopSessionOrphanRecoveryService,
  STALLED_STOP_PENDING_ESCALATION_MS,
  type DesktopOrphanRecoveryDependencies,
} from './desktopSessionOrphanRecovery';

const session = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'desktop',
  deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  status: 'active',
  startedAt: new Date('2026-07-25T12:00:00.000Z'),
  createdAt: new Date('2026-07-25T11:59:00.000Z'),
};

function dependencies(): DesktopOrphanRecoveryDependencies {
  let nowMs = 1_000;
  return {
    now: () => nowMs,
    setNow: (value: number) => {
      nowMs = value;
    },
    loadSession: vi.fn(async () => session),
    observeSharedState: vi.fn(async () => ({
      ownerPresent: false,
      finalizationId: null,
      canonicalPayload: null,
      consistent: true,
    })),
    findExistingStopIdentity: vi.fn(async () => null),
    claimOrphanIntent: vi.fn(async () => 'claimed' as const),
    finalize: vi.fn(async () => 'stop_pending' as const),
    releaseIntent: vi.fn(async () => true),
    enqueue: vi.fn(async () => ({ acknowledged: true as const, jobId: 'desktop-finalize-job' })),
    randomUUID: vi.fn(() => '55555555-5555-4555-8555-555555555555'),
  };
}

describe('desktop orphan recovery', () => {
  it('requires two absent observations separated by one full lease TTL', async () => {
    const deps = dependencies();
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await expect(service.recover(session.id, 'admission')).resolves.toBe('retained');
    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();

    deps.setNow!(30_999);
    await expect(service.recover(session.id, 'admission')).resolves.toBe('retained');
    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();

    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'admission')).resolves.toBe('retained');
    expect(deps.claimOrphanIntent).toHaveBeenCalledTimes(1);
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it('never claims when an owner or intent exists or Redis state is inconsistent', async () => {
    for (const observed of [
      {
        ownerPresent: true,
        finalizationId: null,
        canonicalPayload: null,
        consistent: true,
      },
      {
        ownerPresent: false,
        finalizationId: '55555555-5555-4555-8555-555555555555',
        canonicalPayload: null,
        consistent: false,
      },
      {
        ownerPresent: false,
        finalizationId: null,
        canonicalPayload: null,
        consistent: false,
      },
    ]) {
      const deps = dependencies();
      vi.mocked(deps.observeSharedState).mockResolvedValue(observed);
      const service = createDesktopSessionOrphanRecoveryService(deps);

      await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
      deps.setNow!(31_000);
      await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
      expect(deps.claimOrphanIntent).not.toHaveBeenCalled();
    }
  });

  it('finalizes and releases only after the exact durable stop is confirmed', async () => {
    const deps = dependencies();
    vi.mocked(deps.finalize).mockResolvedValue('finalized');
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await service.recover(session.id, 'background');
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('finalized');

    expect(deps.releaseIntent).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues the stable identity when finalization succeeds but exact intent release fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.finalize).mockResolvedValue('already_finalized');
    vi.mocked(deps.releaseIntent).mockResolvedValue(false);
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await service.recover(session.id, 'background');
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');

    expect(deps.releaseIntent).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith({
      sessionId: session.id,
      finalizationId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('never claims a live non-desktop session (terminal 60s revocation regression, #2871)', async () => {
    const deps = dependencies();
    vi.mocked(deps.loadSession).mockResolvedValue({
      ...session,
      type: 'terminal',
    });
    const service = createDesktopSessionOrphanRecoveryService(deps);

    // Two passes separated by more than a full lease TTL — the exact cadence
    // that previously claimed and finalized a healthy live terminal session.
    await expect(service.recover(session.id, 'background')).resolves.toBe('not_orphaned');
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('not_orphaned');

    expect(deps.observeSharedState).not.toHaveBeenCalled();
    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('refuses to finalize when the row flips to a non-desktop type between observations', async () => {
    const deps = dependencies();
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await service.recover(session.id, 'background');
    // Within the second recover() call the row is loaded twice: the entry
    // check sees a desktop row, but the post-lease-TTL RE-load returns a
    // non-desktop row. The re-load guard must refuse the claim — this is the
    // deep checkpoint, distinct from the entry guard covered above.
    vi.mocked(deps.loadSession)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, type: 'terminal' });
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('not_orphaned');

    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('does not treat a recent pending row as orphaned', async () => {
    const deps = dependencies();
    vi.mocked(deps.loadSession).mockResolvedValue({
      ...session,
      status: 'pending',
      createdAt: new Date(500),
    });
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await expect(service.recover(session.id, 'admission')).resolves.toBe('not_orphaned');
    expect(deps.observeSharedState).not.toHaveBeenCalled();
  });

  it('resumes a complete persisted intent instead of retaining it forever', async () => {
    const deps = dependencies();
    const persistedInput = {
      version: 1 as const,
      finalizationId: '66666666-6666-4666-8666-666666666666',
      sessionId: session.id,
      connection: {
        connectionId: '77777777-7777-4777-8777-777777777777',
        generation: 4,
        instanceId: '88888888-8888-4888-8888-888888888888',
        leaseToken: '99999999-9999-4999-8999-999999999999',
      },
      orgId: session.orgId,
      userId: session.userId,
      deviceId: session.deviceId,
      reason: 'socket_error' as const,
      terminalStatus: 'failed' as const,
      endedAt: '2026-07-25T12:01:00.000Z',
      startedAt: '2026-07-25T12:00:00.000Z',
      inputEvents: 4,
      frameBytes: 128,
    };
    vi.mocked(deps.observeSharedState).mockResolvedValue({
      ownerPresent: false,
      finalizationId: persistedInput.finalizationId,
      canonicalPayload: JSON.stringify(persistedInput),
      consistent: true,
    });
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');

    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith(persistedInput);
    expect(deps.enqueue).toHaveBeenCalledWith({
      sessionId: session.id,
      finalizationId: persistedInput.finalizationId,
    });
  });

  it('escalates a stop_pending intent that outlives the BullMQ re-enqueue no-op (#3945)', async () => {
    // `deps.enqueue` re-adds the same stable jobId every scan, which BullMQ
    // silently no-ops once that job hash exists in a terminal state
    // (removeOnFail retention) -- so a permanently offline agent used to
    // yield one 'retained' result and then zero further signal, forever
    // (#3945). The scanner itself must escalate once the intent has outlived
    // that no-op for long enough to mean "not coming back soon".
    const deps = dependencies();
    const persistedInput = {
      version: 1 as const,
      finalizationId: '66666666-6666-4666-8666-666666666666',
      sessionId: session.id,
      connection: {
        connectionId: '77777777-7777-4777-8777-777777777777',
        generation: 4,
        instanceId: '88888888-8888-4888-8888-888888888888',
        leaseToken: '99999999-9999-4999-8999-999999999999',
      },
      orgId: session.orgId,
      userId: session.userId,
      deviceId: session.deviceId,
      reason: 'socket_error' as const,
      terminalStatus: 'failed' as const,
      endedAt: '2026-07-25T12:01:00.000Z',
      startedAt: '2026-07-25T12:00:00.000Z',
      inputEvents: 4,
      frameBytes: 128,
    };
    vi.mocked(deps.observeSharedState).mockResolvedValue({
      ownerPresent: false,
      finalizationId: persistedInput.finalizationId,
      canonicalPayload: JSON.stringify(persistedInput),
      consistent: true,
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureExceptionMock.mockClear();
    deps.setNow!(0);
    const service = createDesktopSessionOrphanRecoveryService(deps);

    // First observation of this stop_pending episode: too early to escalate.
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
    expect(captureExceptionMock).not.toHaveBeenCalled();

    // Still under the escalation age on a later scan.
    deps.setNow!(STALLED_STOP_PENDING_ESCALATION_MS - 1);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
    expect(captureExceptionMock).not.toHaveBeenCalled();

    // Past the escalation age: must now report once.
    deps.setNow!(STALLED_STOP_PENDING_ESCALATION_MS + 1);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('stop_pending'),
      expect.anything(),
    );

    // A further scan while still stalled must NOT report again (once per
    // episode, matching the reportedWedgedJobIds pattern in
    // jobs/patchJobExecutor.ts).
    deps.setNow!(STALLED_STOP_PENDING_ESCALATION_MS + 60_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('logs and reports a malformed persisted intent instead of swallowing it (#3945)', async () => {
    const deps = dependencies();
    vi.mocked(deps.observeSharedState).mockResolvedValue({
      ownerPresent: false,
      finalizationId: '66666666-6666-4666-8666-666666666666',
      // Not valid JSON -- exercises the JSON.parse failure branch of the
      // bare `catch { return 'retained' }` this used to be (#3945). A
      // canonicalizeDesktopFinalization shape failure takes the same path.
      canonicalPayload: '{not-json',
      consistent: true,
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureExceptionMock.mockClear();
    const service = createDesktopSessionOrphanRecoveryService(deps);

    // Fail-closed behavior is unchanged: a malformed intent must still be
    // retained, never reclaimed.
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse'),
      expect.objectContaining({ sessionId: session.id }),
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    consoleErrorSpy.mockRestore();
  });

  it('reuses the unique durable pre-intent stop identity after a crash', async () => {
    const deps = dependencies();
    vi.mocked(deps.findExistingStopIdentity).mockResolvedValue({
      finalizationId: '66666666-6666-4666-8666-666666666666',
    });
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await service.recover(session.id, 'background');
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');

    expect(deps.claimOrphanIntent).toHaveBeenCalledWith(expect.objectContaining({
      finalizationId: '66666666-6666-4666-8666-666666666666',
    }));
    expect(deps.randomUUID).not.toHaveBeenCalled();
  });

  it('fails closed when multiple durable pre-intent stop identities exist', async () => {
    const deps = dependencies();
    vi.mocked(deps.findExistingStopIdentity).mockResolvedValue('conflict');
    const service = createDesktopSessionOrphanRecoveryService(deps);

    await service.recover(session.id, 'background');
    deps.setNow!(31_000);
    await expect(service.recover(session.id, 'background')).resolves.toBe('retained');

    expect(deps.claimOrphanIntent).not.toHaveBeenCalled();
    expect(deps.randomUUID).not.toHaveBeenCalled();
  });

  it('rotates a full orphan scan batch and wraps after a short batch', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `session-${index}`);
    expect(__desktopSessionOrphanRecoveryTestOnly.nextScanCursor(ids, 50))
      .toBe('session-49');
    expect(__desktopSessionOrphanRecoveryTestOnly.nextScanCursor(ids.slice(0, 49), 50))
      .toBeNull();
  });

  it('keeps periodic recovery scheduled when the initial scan fails', async () => {
    vi.useFakeTimers();
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(undefined);

    await expect(
      __desktopSessionOrphanRecoveryTestOnly.initializeWithScan(scan),
    ).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(2);
    await __desktopSessionOrphanRecoveryTestOnly.shutdown();
  });
});
