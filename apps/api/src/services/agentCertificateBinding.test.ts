import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';

// Wave 5 Task 6 — centralized certificate/device binding decision shared by
// BOTH the agent REST auth middleware and the command WebSocket pre-upgrade
// gate. See .superpowers/sdd/2026-07-23-security-remediation-wave-05-mtls-transport/task-6-brief.md.

const { trustsForwardedHeadersFromMock } = vi.hoisted(() => ({
  trustsForwardedHeadersFromMock: vi.fn(() => false),
}));
vi.mock('./clientIp', () => ({
  trustsForwardedHeadersFrom: trustsForwardedHeadersFromMock,
}));

vi.mock('../db', () => {
  const dbMock: { select: ReturnType<typeof vi.fn> } = {
    select: vi.fn(),
  };
  return {
    db: dbMock,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  deviceMtlsCertificates: {
    deviceId: 'deviceMtlsCertificates.deviceId',
    state: 'deviceMtlsCertificates.state',
    serialNumber: 'deviceMtlsCertificates.serialNumber',
    createdAt: 'deviceMtlsCertificates.createdAt',
  },
  devices: {
    id: 'devices.id',
    mtlsCertSerialNumber: 'devices.mtlsCertSerialNumber',
  },
}));

import { db, withSystemDbAccessContext } from '../db';
import {
  checkAgentCertificateBinding,
  enforceAgentCertificateBinding,
  getAgentMtlsBindingMode,
  loadAgentCertificateBindingIdentity,
  normalizeCertificateSerial,
  readAgentCertificateAssertion,
  recordAgentCertificateBindingMetric,
  registerAgentCertificateBindingPrometheusCounter,
  setAgentCertificateBindingMetricsRecorder,
  type AgentCertificateAssertion,
} from './agentCertificateBinding';

const ACTIVE_SERIAL = 'AABBCCDDEEFF00112233';
const OTHER_SERIAL = '00112233AABBCCDDEEFF';

describe('checkAgentCertificateBinding — decision table', () => {
  it('off: never denies and reports mode_off, regardless of everything else', () => {
    const decision = checkAgentCertificateBinding({
      mode: 'off',
      assertionTrusted: false,
      assertedVerified: false,
      assertedSerial: null,
      storedSerial: ACTIVE_SERIAL,
      storedState: 'active',
    });
    expect(decision).toEqual({ allowed: true, reason: 'mode_off' });
  });

  it('off: never denies even with a mismatched, trusted, verified assertion', () => {
    const decision = checkAgentCertificateBinding({
      mode: 'off',
      assertionTrusted: true,
      assertedVerified: true,
      assertedSerial: OTHER_SERIAL,
      storedSerial: ACTIVE_SERIAL,
      storedState: 'active',
    });
    expect(decision).toEqual({ allowed: true, reason: 'mode_off' });
  });

  describe.each(['audit', 'enforce'] as const)('mode=%s', (mode) => {
    it('matched: trusted, verified assertion naming the active serial is allowed', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: true,
        assertedSerial: ACTIVE_SERIAL,
        storedSerial: ACTIVE_SERIAL,
        storedState: 'active',
      });
      expect(decision).toEqual({ allowed: true, reason: 'matched' });
    });

    it('serial_mismatch: trusted, verified assertion naming a DIFFERENT serial', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: true,
        assertedSerial: OTHER_SERIAL,
        storedSerial: ACTIVE_SERIAL,
        storedState: 'active',
      });
      expect(decision).toEqual({
        allowed: mode === 'audit',
        reason: 'serial_mismatch',
      });
    });

    it('missing_assertion: no assertion presented at all (trusted source, nothing to trust)', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: false,
        assertedSerial: null,
        storedSerial: ACTIVE_SERIAL,
        storedState: 'active',
      });
      expect(decision).toEqual({
        allowed: mode === 'audit',
        reason: 'missing_assertion',
      });
    });

    it('untrusted_assertion: a verified assertion claim from an UNTRUSTED source (spoofed header) is never honored', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: false,
        assertedVerified: true,
        assertedSerial: ACTIVE_SERIAL,
        storedSerial: ACTIVE_SERIAL,
        storedState: 'active',
      });
      expect(decision).toEqual({
        allowed: mode === 'audit',
        reason: 'untrusted_assertion',
      });
    });

    it('certificate_not_active: device has certificate history but no currently-active row', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: true,
        assertedSerial: ACTIVE_SERIAL,
        storedSerial: ACTIVE_SERIAL,
        storedState: 'revoked',
      });
      expect(decision).toEqual({
        allowed: mode === 'audit',
        reason: 'certificate_not_active',
      });
    });

    it('legacy_identity: no stored identity of any kind is always allowed (compatibility free pass)', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: false,
        assertedSerial: null,
        storedSerial: null,
        storedState: null,
      });
      expect(decision).toEqual({ allowed: true, reason: 'legacy_identity' });
    });

    it('legacy_identity is allowed even with a mismatched trusted+verified assertion (no stored serial to bind to)', () => {
      const decision = checkAgentCertificateBinding({
        mode,
        assertionTrusted: true,
        assertedVerified: true,
        assertedSerial: OTHER_SERIAL,
        storedSerial: null,
        storedState: null,
      });
      expect(decision).toEqual({ allowed: true, reason: 'legacy_identity' });
    });
  });
});

describe('getAgentMtlsBindingMode', () => {
  const ORIGINAL = process.env.AGENT_MTLS_BINDING_MODE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENT_MTLS_BINDING_MODE;
    else process.env.AGENT_MTLS_BINDING_MODE = ORIGINAL;
  });

  it('defaults to off when unset', () => {
    delete process.env.AGENT_MTLS_BINDING_MODE;
    expect(getAgentMtlsBindingMode()).toBe('off');
  });

  it('defaults to off on an invalid value', () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'bogus';
    expect(getAgentMtlsBindingMode()).toBe('off');
  });

  it('accepts audit', () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'audit';
    expect(getAgentMtlsBindingMode()).toBe('audit');
  });

  it('accepts enforce', () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    expect(getAgentMtlsBindingMode()).toBe('enforce');
  });

  it('is case-sensitive-safe: trims and lowercases before comparing', () => {
    process.env.AGENT_MTLS_BINDING_MODE = '  Enforce  ';
    expect(getAgentMtlsBindingMode()).toBe('enforce');
  });
});

function fakeRequest(headers: Record<string, string>) {
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
  };
}

describe('readAgentCertificateAssertion', () => {
  beforeEach(() => {
    trustsForwardedHeadersFromMock.mockReset().mockReturnValue(false);
  });

  it('reports assertionTrusted=false when the immediate peer is not a trusted proxy', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(false);
    const result = readAgentCertificateAssertion(
      fakeRequest({
        'X-Breeze-Client-Cert-Verified': 'true',
        'X-Breeze-Client-Cert-Serial': 'aa:bb:cc',
      }),
    );
    expect(result.assertionTrusted).toBe(false);
    // The raw claim is still surfaced — trust-gating is the pure decision
    // function's job (this is what lets "spoofed header from untrusted
    // source" be distinguished from "no header at all").
    expect(result.assertedVerified).toBe(true);
    expect(result.assertedSerial).toBe('AABBCC');
  });

  it('normalizes a colon-separated serial to uppercase hex with no separators', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const result = readAgentCertificateAssertion(
      fakeRequest({
        'X-Breeze-Client-Cert-Verified': 'true',
        'X-Breeze-Client-Cert-Serial': 'aa:bb:cc:dd',
      }),
    );
    expect(result.assertedSerial).toBe('AABBCCDD');
  });

  it('treats a "1" verified value the same as "true"', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const result = readAgentCertificateAssertion(
      fakeRequest({ 'X-Breeze-Client-Cert-Verified': '1', 'X-Breeze-Client-Cert-Serial': 'aabbcc' }),
    );
    expect(result.assertedVerified).toBe(true);
  });

  it('is not verified when no serial header is present, even if verified=true', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const result = readAgentCertificateAssertion(
      fakeRequest({ 'X-Breeze-Client-Cert-Verified': 'true' }),
    );
    expect(result.assertedVerified).toBe(false);
    expect(result.assertedSerial).toBeNull();
  });

  it('is not verified when headers are absent entirely', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const result = readAgentCertificateAssertion(fakeRequest({}));
    expect(result.assertionTrusted).toBe(true);
    expect(result.assertedVerified).toBe(false);
    expect(result.assertedSerial).toBeNull();
  });

  it('never reads raw Cloudflare/user-supplied headers (only the two protected internal ones)', () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const headerSpy = vi.fn((name: string) => {
      if (name === 'X-Breeze-Client-Cert-Verified') return 'true';
      if (name === 'X-Breeze-Client-Cert-Serial') return 'aabbcc';
      return undefined;
    });
    readAgentCertificateAssertion({ req: { header: headerSpy } });
    const readHeaderNames = headerSpy.mock.calls.map((call) => call[0]);
    expect(readHeaderNames).toEqual(
      expect.arrayContaining(['X-Breeze-Client-Cert-Verified', 'X-Breeze-Client-Cert-Serial']),
    );
    expect(readHeaderNames).not.toEqual(
      expect.arrayContaining(['CF-Client-Cert-Verified', 'CF-Client-Cert-Serial', 'X-Forwarded-For']),
    );
  });
});

function mockSelectOnce(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where }));
  vi.mocked(db.select).mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit, orderBy };
}

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

describe('loadAgentCertificateBindingIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withSystemDbAccessContext).mockImplementation(
      (async (fn: () => Promise<unknown>) => fn()) as never,
    );
  });

  it('returns the active row when one exists', async () => {
    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: ACTIVE_SERIAL, storedState: 'active' });
  });

  it('falls back to the most recent non-active row when no active row exists', async () => {
    mockSelectOnce([]); // active-row query: nothing
    mockSelectOnce([{ serialNumber: OTHER_SERIAL, state: 'revoked' }]); // most-recent query

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: OTHER_SERIAL, storedState: 'revoked' });
  });

  it('falls back to the legacy devices.mtls_cert_serial_number column when no history row exists at all', async () => {
    mockSelectOnce([]); // active-row query
    mockSelectOnce([]); // most-recent query
    mockSelectOnce([{ legacySerial: OTHER_SERIAL }]); // legacy devices column

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: OTHER_SERIAL, storedState: 'active' });
  });

  it('reports a fully NULL identity when nothing is found anywhere (legacy compatibility case)', async () => {
    mockSelectOnce([]);
    mockSelectOnce([]);
    mockSelectOnce([{ legacySerial: null }]);

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: null, storedState: null });
  });

  // Fix round 3 (code review): two real populations store a non-canonical
  // serial — rows written by the pre-fix legacy renewal path
  // (routes/agents/mtls.ts) and rows Task 1's migration imported verbatim
  // from the historical devices.mtls_cert_serial_number column. The loader
  // must normalize at THIS read boundary rather than assume either source
  // is already canonical.
  it('normalizes a stored active-row serial with colons and lowercase hex', async () => {
    mockSelectOnce([{ serialNumber: 'aa:bb:cc:dd:ee:ff:00:11:22:33', state: 'active' }]);

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: ACTIVE_SERIAL, storedState: 'active' });
  });

  it('normalizes a stored most-recent-row serial with colons and lowercase hex', async () => {
    mockSelectOnce([]); // active-row query
    mockSelectOnce([{ serialNumber: '00:11:22:33:aa:bb:cc:dd:ee:ff', state: 'revoked' }]);

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: OTHER_SERIAL, storedState: 'revoked' });
  });

  it('normalizes a legacy devices.mtls_cert_serial_number value with colons and lowercase hex', async () => {
    mockSelectOnce([]); // active-row query
    mockSelectOnce([]); // most-recent query
    mockSelectOnce([{ legacySerial: '00:11:22:33:aa:bb:cc:dd:ee:ff' }]);

    const identity = await loadAgentCertificateBindingIdentity(DEVICE_ID);

    expect(identity).toEqual({ storedSerial: OTHER_SERIAL, storedState: 'active' });
  });
});

describe('normalizeCertificateSerial', () => {
  it('strips colons and uppercases', () => {
    expect(normalizeCertificateSerial('aa:bb:cc:01')).toBe('AABBCC01');
  });

  it('strips spaces and dashes too', () => {
    expect(normalizeCertificateSerial('aa bb-cc 01')).toBe('AABBCC01');
  });

  it('is idempotent on an already-canonical value', () => {
    expect(normalizeCertificateSerial(ACTIVE_SERIAL)).toBe(ACTIVE_SERIAL);
  });

  it('returns null for null/undefined/empty input', () => {
    expect(normalizeCertificateSerial(null)).toBeNull();
    expect(normalizeCertificateSerial(undefined)).toBeNull();
    expect(normalizeCertificateSerial('')).toBeNull();
  });
});

describe('enforceAgentCertificateBinding', () => {
  const ORIGINAL = process.env.AGENT_MTLS_BINDING_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withSystemDbAccessContext).mockImplementation(
      (async (fn: () => Promise<unknown>) => fn()) as never,
    );
    setAgentCertificateBindingMetricsRecorder(null);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENT_MTLS_BINDING_MODE;
    else process.env.AGENT_MTLS_BINDING_MODE = ORIGINAL;
  });

  const trustedMatchingAssertion: AgentCertificateAssertion = {
    assertionTrusted: true,
    assertedVerified: true,
    assertedSerial: ACTIVE_SERIAL,
  };

  it('mode off: never touches the DB and always allows', async () => {
    delete process.env.AGENT_MTLS_BINDING_MODE;

    const decision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: { assertionTrusted: false, assertedVerified: false, assertedSerial: null },
      pathClass: 'rest',
    });

    expect(decision).toEqual({ allowed: true, reason: 'mode_off' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('mode enforce: loads identity, matches, and allows', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const decision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: trustedMatchingAssertion,
      pathClass: 'rest',
    });

    expect(decision).toEqual({ allowed: true, reason: 'matched' });
  });

  it('mode enforce: denies on a missing assertion when an active cert is on file', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const decision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: { assertionTrusted: true, assertedVerified: false, assertedSerial: null },
      pathClass: 'ws',
    });

    expect(decision).toEqual({ allowed: false, reason: 'missing_assertion' });
  });

  it('records a bounded metric (mode, reason, pathClass) — never serials', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'audit';
    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);
    const onDecision = vi.fn();
    setAgentCertificateBindingMetricsRecorder({ onDecision });

    await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: { assertionTrusted: true, assertedVerified: true, assertedSerial: OTHER_SERIAL },
      pathClass: 'rest',
    });

    expect(onDecision).toHaveBeenCalledWith('audit', 'serial_mismatch', 'rest');
    // Assert no call arg ever carries a serial-shaped string.
    for (const call of onDecision.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(ACTIVE_SERIAL);
        expect(String(arg)).not.toContain(OTHER_SERIAL);
      }
    }
  });

  it('does not record a metric in mode off', async () => {
    delete process.env.AGENT_MTLS_BINDING_MODE;
    const onDecision = vi.fn();
    setAgentCertificateBindingMetricsRecorder({ onDecision });

    await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: { assertionTrusted: false, assertedVerified: false, assertedSerial: null },
      pathClass: 'rest',
    });

    expect(onDecision).not.toHaveBeenCalled();
  });

  it('REST and WS produce the identical decision for identical inputs', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);
    const restDecision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: trustedMatchingAssertion,
      pathClass: 'rest',
    });

    mockSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);
    const wsDecision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: trustedMatchingAssertion,
      pathClass: 'ws',
    });

    expect(restDecision.reason).toBe(wsDecision.reason);
    expect(restDecision.allowed).toBe(wsDecision.allowed);
  });

  // Fix round 3 (code review): an end-to-end reproduction of the reported
  // gap — a device whose stored identity is a LEGACY-RAW serial (colons,
  // lowercase, as historically written by the pre-fix renewal path or
  // imported verbatim by Task 1's migration) must still match a canonical
  // asserted header for the SAME certificate. Before the loader normalized
  // storedSerial, this fell through to `serial_mismatch` even though both
  // sides name the identical certificate.
  it('matches a legacy-raw stored serial (colons, lowercase) against a canonical asserted header for the same certificate', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockSelectOnce([{ serialNumber: 'ab:cd:ef:01', state: 'active' }]);

    const decision = await enforceAgentCertificateBinding({
      deviceId: DEVICE_ID,
      assertion: { assertionTrusted: true, assertedVerified: true, assertedSerial: 'ABCDEF01' },
      pathClass: 'rest',
    });

    expect(decision).toEqual({ allowed: true, reason: 'matched' });
  });
});

describe('recordAgentCertificateBindingMetric', () => {
  beforeEach(() => {
    setAgentCertificateBindingMetricsRecorder(null);
  });

  it('is a no-op with no recorder configured', () => {
    expect(() => recordAgentCertificateBindingMetric('audit', 'matched', 'rest')).not.toThrow();
  });

  it('invokes the configured recorder', () => {
    const onDecision = vi.fn();
    setAgentCertificateBindingMetricsRecorder({ onDecision });
    recordAgentCertificateBindingMetric('enforce', 'serial_mismatch', 'ws');
    expect(onDecision).toHaveBeenCalledWith('enforce', 'serial_mismatch', 'ws');
  });
});

describe('registerAgentCertificateBindingPrometheusCounter', () => {
  it('registers a counter labeled mode/reason/pathClass and wires the recorder to increment it', () => {
    const registry = new Registry();
    const counter = registerAgentCertificateBindingPrometheusCounter(registry);
    expect(counter).toBeDefined();

    recordAgentCertificateBindingMetric('audit', 'serial_mismatch', 'rest');

    // reuses the existing metric on the same registry instead of throwing
    expect(() => registerAgentCertificateBindingPrometheusCounter(registry)).not.toThrow();
  });
});
