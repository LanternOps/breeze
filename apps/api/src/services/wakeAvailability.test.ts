import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WAKE_AGENT_READINESS_STATES } from '@breeze/shared/validators';

const { selectMock, resolveSettingsMock, withDbTransactionMock, captureExceptionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  resolveSettingsMock: vi.fn(),
  withDbTransactionMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  withDbTransaction: (fn: () => Promise<unknown>) => withDbTransactionMock(fn),
}));
vi.mock('./featureConfigResolver', () => ({
  resolveWakeOnLanSettingsForDevices: (...args: unknown[]) => resolveSettingsMock(...(args as [])),
}));
vi.mock('./sentry', () => ({ captureException: (...args: unknown[]) => captureExceptionMock(...args) }));

import { WAKE_READINESS_STATES } from '../db/schema/deviceWake';
import {
  MIN_WAKE_STATUS_AGENT_VERSION,
  WAKE_BLOCK_THRESHOLD,
  WAKE_LOOKUP_FAILED_AVAILABILITY,
  WAKE_PROOF_LIFETIME_MS,
  decideWakeAvailability,
  resolveWakeAvailability,
  type WakeStatusInput,
} from './wakeAvailability';

const NOW = new Date('2026-11-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const verified = { configureSettings: false, buttonMode: 'verified' } as const;
const always = { configureSettings: false, buttonMode: 'always' } as const;
const win = { osType: 'windows', agentVersion: '0.130.0' } as const;

const status = (over: Partial<WakeStatusInput> = {}): WakeStatusInput => ({
  readinessState: 'ready',
  fingerprint: 'fp-1',
  proofFingerprint: null,
  lastCameOnlineAt: null,
  consecutiveTimeouts: 0,
  ...over,
});

const decide = (input: {
  settings: typeof verified | typeof always | null;
  status: WakeStatusInput | null;
  device?: { osType: 'windows' | 'macos' | 'linux'; agentVersion: string | null };
}) => decideWakeAvailability({ device: win, now: NOW, ...input });

describe('decideWakeAvailability', () => {
  it('no policy: shows today, mode none, nothing to test-wake', () => {
    expect(decide({ settings: null, status: status() })).toEqual({
      show: true, mode: 'none', state: 'ready', testWakeAllowed: false, flaggedTimeouts: false,
    });
  });

  it('always mode with 5 timeouts: shows and flags, never hides', () => {
    const out = decide({ settings: always, status: status({ consecutiveTimeouts: 5 }) });
    expect(out).toMatchObject({ show: true, mode: 'always', flaggedTimeouts: true, testWakeAllowed: false });
  });

  it('verified + ready shows', () => {
    expect(decide({ settings: verified, status: status() })).toMatchObject({ show: true, mode: 'verified', state: 'ready' });
  });

  it('verified + ready + 3 timeouts hides and flags', () => {
    const out = decide({ settings: verified, status: status({ consecutiveTimeouts: WAKE_BLOCK_THRESHOLD }) });
    expect(out).toMatchObject({ show: false, flaggedTimeouts: true, testWakeAllowed: false });
  });

  it('verified + ready + 2 timeouts still shows', () => {
    expect(decide({ settings: verified, status: status({ consecutiveTimeouts: 2 }) })).toMatchObject({ show: true, flaggedTimeouts: false });
  });

  describe('unproven devices', () => {
    const unproven = (over: Partial<WakeStatusInput>) => status({ readinessState: 'unproven', ...over });

    it('came online 89 days ago with a matching fingerprint: shows', () => {
      const out = decide({ settings: verified, status: unproven({ lastCameOnlineAt: ago(89), proofFingerprint: 'fp-1' }) });
      expect(out).toMatchObject({ show: true, testWakeAllowed: false });
    });

    it('came online exactly at the proof lifetime: still shows', () => {
      const out = decide({
        settings: verified,
        status: unproven({ lastCameOnlineAt: new Date(NOW.getTime() - WAKE_PROOF_LIFETIME_MS), proofFingerprint: 'fp-1' }),
      });
      expect(out.show).toBe(true);
    });

    it('came online 91 days ago: hides but allows a test wake', () => {
      const out = decide({ settings: verified, status: unproven({ lastCameOnlineAt: ago(91), proofFingerprint: 'fp-1' }) });
      expect(out).toMatchObject({ show: false, testWakeAllowed: true });
    });

    it('fingerprint differs from the proof fingerprint: hides, test wake allowed', () => {
      const out = decide({ settings: verified, status: unproven({ lastCameOnlineAt: ago(1), proofFingerprint: 'other' }) });
      expect(out).toMatchObject({ show: false, testWakeAllowed: true });
    });

    it('never proven: hides, test wake allowed', () => {
      expect(decide({ settings: verified, status: unproven({}) })).toMatchObject({ show: false, testWakeAllowed: true });
    });

    it('flagged timeouts block both the button and the test wake', () => {
      const out = decide({
        settings: verified,
        status: unproven({ lastCameOnlineAt: ago(1), proofFingerprint: 'fp-1', consecutiveTimeouts: 3 }),
      });
      expect(out).toMatchObject({ show: false, testWakeAllowed: false, flaggedTimeouts: true });
    });

    it('a null proof fingerprint never matches a null fingerprint', () => {
      const out = decide({ settings: verified, status: unproven({ fingerprint: null, proofFingerprint: null, lastCameOnlineAt: ago(1) }) });
      expect(out.show).toBe(false);
    });
  });

  it.each(['needs_reboot', 'not_configured', 'apply_failed', 'firmware_protected', 'no_wired_adapter', 'unsupported_vm'] as const)(
    'verified + %s hides without a test wake',
    (readinessState) => {
      const out = decide({ settings: verified, status: status({ readinessState }) });
      expect(out).toMatchObject({ show: false, state: readinessState, testWakeAllowed: false });
    },
  );

  it.each(['linux', 'macos'] as const)('%s is unsupported_os whatever the status says', (osType) => {
    const out = decide({ settings: verified, status: status(), device: { osType, agentVersion: '0.130.0' } });
    expect(out).toMatchObject({ show: false, state: 'unsupported_os' });
    expect(decide({ settings: always, status: null, device: { osType, agentVersion: null } })).toMatchObject({ show: true, state: 'unsupported_os' });
  });

  describe('no status row', () => {
    it('old agent: agent_update_required', () => {
      const out = decide({ settings: verified, status: null, device: { osType: 'windows', agentVersion: '0.129.9' } });
      expect(out).toMatchObject({ show: false, state: 'agent_update_required' });
    });

    it('unknown agent version: agent_update_required', () => {
      expect(decide({ settings: null, status: null, device: { osType: 'windows', agentVersion: null } }).state).toBe('agent_update_required');
    });

    it('agent at the minimum version: no_data', () => {
      const out = decide({ settings: verified, status: null, device: { osType: 'windows', agentVersion: MIN_WAKE_STATUS_AGENT_VERSION } });
      expect(out).toMatchObject({ show: false, state: 'no_data', testWakeAllowed: false });
    });

    it('a status row with a null readiness state is treated as no row', () => {
      const out = decide({ settings: verified, status: status({ readinessState: null }), device: { osType: 'windows', agentVersion: '0.131.0' } });
      expect(out.state).toBe('no_data');
    });

    it('no policy still shows with the derived state', () => {
      expect(decide({ settings: null, status: null, device: { osType: 'windows', agentVersion: '0.100.0' } })).toMatchObject({
        show: true, mode: 'none', state: 'agent_update_required',
      });
    });
  });
});

describe('WAKE_AGENT_READINESS_STATES', () => {
  it('equals the db schema WAKE_READINESS_STATES', () => {
    expect([...WAKE_AGENT_READINESS_STATES]).toEqual([...WAKE_READINESS_STATES]);
  });
});

describe('resolveWakeAvailability', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

  /** Each `select().from().where()` resolves to the next queued rows. */
  function queueSelects(rows: unknown[][]) {
    for (const r of rows) {
      selectMock.mockImplementationOnce(() => ({ from: () => ({ where: () => Promise.resolve(r) }) }));
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    resolveSettingsMock.mockReset();
    withDbTransactionMock.mockImplementation((fn: () => Promise<unknown>) => fn());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('decides per device from the resolver, devices and status reads', async () => {
    const [a, b, c] = ids(3) as [string, string, string];
    resolveSettingsMock.mockResolvedValue(new Map([[a, verified], [b, null]]));
    queueSelects([
      [
        { id: a, osType: 'windows', agentVersion: '0.130.0' },
        { id: b, osType: 'windows', agentVersion: '0.130.0' },
      ],
      [{ deviceId: a, readinessState: 'ready', fingerprint: 'f', proofFingerprint: null, lastCameOnlineAt: null, consecutiveTimeouts: 0 }],
    ]);
    const out = await resolveWakeAvailability([a, b, c, a]);
    expect(out.get(a)).toMatchObject({ show: true, mode: 'verified', state: 'ready' });
    expect(out.get(b)).toMatchObject({ show: true, mode: 'none', state: 'no_data' });
    // Not a visible device: absent, so callers fail closed.
    expect(out.has(c)).toBe(false);
    expect(resolveSettingsMock).toHaveBeenCalledTimes(1);
    expect(resolveSettingsMock.mock.calls[0]![0]).toEqual([a, b, c]);
  });

  it('a lookup failure maps every id to lookup_failed and never throws', async () => {
    const list = ids(3);
    resolveSettingsMock.mockRejectedValue(new Error('boom'));
    const out = await resolveWakeAvailability(list);
    expect(out.size).toBe(3);
    for (const id of list) {
      expect(out.get(id)).toEqual(WAKE_LOOKUP_FAILED_AVAILABILITY);
    }
    expect(WAKE_LOOKUP_FAILED_AVAILABILITY).toMatchObject({ show: false, mode: 'unknown', state: 'lookup_failed', testWakeAllowed: false });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('a failure after a first chunk succeeded discards the partial results', async () => {
    const list = ids(1000);
    resolveSettingsMock.mockResolvedValueOnce(new Map()).mockRejectedValueOnce(new Error('second chunk'));
    queueSelects([[{ id: list[0], osType: 'windows', agentVersion: '0.130.0' }], []]);
    const out = await resolveWakeAvailability(list);
    expect(out.size).toBe(1000);
    expect(out.get(list[0]!)).toEqual(WAKE_LOOKUP_FAILED_AVAILABILITY);
  });

  it('a transaction that cannot start is a lookup failure, not a throw', async () => {
    withDbTransactionMock.mockRejectedValue(new Error('no context'));
    const out = await resolveWakeAvailability(ids(2));
    expect([...out.values()].every((v) => v.state === 'lookup_failed')).toBe(true);
  });

  it('runs all reads inside ONE transaction with a fixed statement count per chunk of 500', async () => {
    const list = ids(1000);
    resolveSettingsMock.mockResolvedValue(new Map());
    queueSelects([[], [], [], []]);
    const out = await resolveWakeAvailability(list);
    expect(out.size).toBe(0);
    expect(withDbTransactionMock).toHaveBeenCalledTimes(1);
    expect(resolveSettingsMock).toHaveBeenCalledTimes(2);
    expect(resolveSettingsMock.mock.calls.map((call) => (call[0] as string[]).length)).toEqual([500, 500]);
    // devices + device_wake_status per chunk.
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('an empty list does no work', async () => {
    expect((await resolveWakeAvailability([])).size).toBe(0);
    expect(withDbTransactionMock).not.toHaveBeenCalled();
  });
});
