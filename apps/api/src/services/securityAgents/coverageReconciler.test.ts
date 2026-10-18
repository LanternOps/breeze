import { describe, expect, it } from 'vitest';
import {
  alertTransition,
  classifyOrgCoverage,
  normalizeHostname,
  type DeviceCoverageInput,
  type VendorEndpointView,
} from './coverageReconciler';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

function device(overrides: Partial<DeviceCoverageInput> = {}): DeviceCoverageInput {
  return {
    deviceId: 'd1',
    orgId: ORG,
    hostnames: ['pc-1'],
    install: 'missing',
    installRemediationStatus: 'none',
    installArmed: true,
    ...overrides,
  };
}

function endpoint(overrides: Partial<VendorEndpointView> = {}): VendorEndpointView {
  return { endpointId: 'e1', orgId: ORG, deviceId: null, hostname: null, online: true, ...overrides };
}

function classify(opts: {
  devices?: DeviceCoverageInput[];
  endpoints?: VendorEndpointView[];
  reportsVendorOrg?: boolean;
  knownDeviceHostnames?: string[];
}) {
  return classifyOrgCoverage({
    orgId: ORG,
    reportsVendorOrg: opts.reportsVendorOrg ?? true,
    devices: opts.devices ?? [device()],
    endpoints: opts.endpoints ?? [],
    knownDeviceHostnames: new Set(opts.knownDeviceHostnames ?? []),
  });
}

describe('classifyOrgCoverage — per-device state machine', () => {
  it.each<[string, Partial<DeviceCoverageInput>, VendorEndpointView[], { state: string; reasonCode: string | null; vendorEndpointId?: string | null }]>([
    ['linked same-org online agent → covered', {}, [endpoint({ deviceId: 'd1' })], { state: 'covered', reasonCode: null, vendorEndpointId: 'e1' }],
    ['linked same-org offline agent → vendor_offline', {}, [endpoint({ deviceId: 'd1', online: false })], { state: 'vendor_offline', reasonCode: null, vendorEndpointId: 'e1' }],
    ['unknown online status counts as reporting → covered', {}, [endpoint({ deviceId: 'd1', online: null })], { state: 'covered', reasonCode: null }],
    ['a stale offline duplicate never hides a live agent', {}, [
      endpoint({ endpointId: 'old', deviceId: 'd1', online: false }),
      endpoint({ endpointId: 'new', deviceId: 'd1', online: true }),
    ], { state: 'covered', reasonCode: null, vendorEndpointId: 'new' }],
    ['unlinked same-org agent with the device hostname → covered', {}, [endpoint({ hostname: 'PC-1 ' })], { state: 'covered', reasonCode: null }],
    ['not reported, missing, attempts exhausted → gap', { installRemediationStatus: 'gave_up' }, [], { state: 'gap', reasonCode: 'install_failed' }],
    ['not reported, missing, install not armed → gap', { installArmed: false }, [], { state: 'gap', reasonCode: 'install_not_armed' }],
    ['not reported, missing, install in flight → pending', { installRemediationStatus: 'in_progress' }, [], { state: 'pending', reasonCode: 'install_pending' }],
    ['not reported, missing, deferred by the pass cap → pending', { installRemediationStatus: 'skipped' }, [], { state: 'pending', reasonCode: 'install_pending' }],
    ['not reported, missing, a retryable failure → pending', { installRemediationStatus: 'failed' }, [], { state: 'pending', reasonCode: 'install_pending' }],
    ['not reported, installed per inventory → pending (awaiting the vendor)', { install: 'installed' }, [], { state: 'pending', reasonCode: 'awaiting_vendor_report' }],
    ['never evaluated by compliance → pending', { install: 'unknown' }, [], { state: 'pending', reasonCode: 'awaiting_evaluation' }],
  ])('%s', (_name, deviceOverrides, endpoints, expected) => {
    const { decisions } = classify({ devices: [device(deviceOverrides)], endpoints });
    expect(decisions.get('d1')).toMatchObject(expected);
  });

  it('mismatched_org: the device is linked to an agent the vendor reports under another org (device moved)', () => {
    const { decisions } = classify({
      devices: [device({ install: 'installed' })],
      endpoints: [endpoint({ deviceId: 'd1', orgId: OTHER_ORG })],
    });
    expect(decisions.get('d1')).toMatchObject({ state: 'mismatched_org', reasonCode: 'vendor_org_mismatch', vendorEndpointId: 'e1' });
  });

  it("mismatched_org: an unlinked agent in another org's vendor account carries this device's hostname", () => {
    const { decisions } = classify({ endpoints: [endpoint({ orgId: OTHER_ORG, hostname: 'pc-1' })] });
    expect(decisions.get('d1')?.state).toBe('mismatched_org');
  });

  it("mismatch detail never names the other organization (it is visible to this org's users)", () => {
    const { decisions } = classify({ endpoints: [endpoint({ deviceId: 'd1', orgId: OTHER_ORG })] });
    const detail = decisions.get('d1')?.detail ?? '';
    expect(detail).not.toContain(OTHER_ORG);
    expect(detail.length).toBeGreaterThan(0);
  });

  it('mismatch wins over the install view: an agent under the wrong org is never a gap (no redeploy path)', () => {
    const { decisions } = classify({
      devices: [device({ install: 'missing', installRemediationStatus: 'gave_up' })],
      endpoints: [endpoint({ deviceId: 'd1', orgId: OTHER_ORG })],
    });
    expect(decisions.get('d1')?.state).toBe('mismatched_org');
  });

  it('a same-org agent wins over a cross-org one (covered, not mismatched)', () => {
    const { decisions } = classify({
      endpoints: [endpoint({ endpointId: 'x', orgId: OTHER_ORG, hostname: 'pc-1' }), endpoint({ endpointId: 'own', deviceId: 'd1' })],
    });
    expect(decisions.get('d1')).toMatchObject({ state: 'covered', vendorEndpointId: 'own' });
  });

  it('a vendor with no vendor-side org never claims a mismatch', () => {
    const { decisions } = classify({
      reportsVendorOrg: false,
      endpoints: [endpoint({ deviceId: 'd1', orgId: OTHER_ORG })],
    });
    expect(decisions.get('d1')?.state).toBe('covered');
  });

  it('an ambiguous hostname (two devices in the org share it) is never matched by name', () => {
    const { decisions } = classify({
      devices: [device({ deviceId: 'd1' }), device({ deviceId: 'd2' })],
      endpoints: [endpoint({ hostname: 'pc-1' }), endpoint({ endpointId: 'x', orgId: OTHER_ORG, hostname: 'pc-1' })],
    });
    expect(decisions.get('d1')?.state).toBe('pending');
    expect(decisions.get('d2')?.state).toBe('pending');
  });

  // Spec 2.7 caveat: Huntress sync drops agents whose Huntress org is not
  // mapped to a Breeze org and links hostnames only inside the mapped org. An
  // agent installed under an UNMAPPED vendor org therefore has no row at all,
  // so the reconciler can only report what sync retained: installed-but-
  // unreported is `pending`, never a guessed mismatch or gap.
  it('only retained vendor rows are classified: an agent dropped by sync leaves the device pending, not mismatched', () => {
    const { decisions, vendorOnly } = classify({ devices: [device({ install: 'installed' })], endpoints: [] });
    expect(decisions.get('d1')).toMatchObject({ state: 'pending', reasonCode: 'awaiting_vendor_report' });
    expect(vendorOnly).toEqual([]);
  });
});

describe('classifyOrgCoverage — vendor_only', () => {
  it('an unlinked in-org agent no Breeze device matches is vendor_only', () => {
    const { vendorOnly } = classify({ devices: [], endpoints: [endpoint({ endpointId: 'lonely', hostname: 'ghost-pc' })] });
    expect(vendorOnly).toEqual([{ endpointId: 'lonely', detail: expect.any(String) }]);
  });

  it('is not vendor_only when ANY partner device carries that hostname (it is a mismatch elsewhere, or out of scope)', () => {
    const { vendorOnly } = classify({
      devices: [],
      endpoints: [endpoint({ hostname: 'Known-PC' })],
      knownDeviceHostnames: ['known-pc'],
    });
    expect(vendorOnly).toEqual([]);
  });

  it('is not vendor_only when sync linked it to a Breeze device (even one outside the policy scope)', () => {
    const { vendorOnly } = classify({ devices: [], endpoints: [endpoint({ deviceId: 'out-of-scope' })] });
    expect(vendorOnly).toEqual([]);
  });

  it('is not vendor_only when an in-scope device claimed it by hostname', () => {
    const { vendorOnly } = classify({ endpoints: [endpoint({ hostname: 'pc-1' })] });
    expect(vendorOnly).toEqual([]);
  });

  it("never reports another org's agent as this org's vendor_only", () => {
    const { vendorOnly } = classify({ devices: [], endpoints: [endpoint({ orgId: OTHER_ORG, hostname: 'ghost' })] });
    expect(vendorOnly).toEqual([]);
  });
});

describe('alertTransition — fires on transition only', () => {
  it.each<[string | null, string, string | null]>([
    [null, 'gap', 'gap'],
    ['pending', 'gap', 'gap'],
    ['not_applicable', 'gap', 'gap'],
    ['gap', 'gap', null],
    ['covered', 'mismatched_org', 'mismatched_org'],
    ['gap', 'mismatched_org', 'mismatched_org'],
    ['mismatched_org', 'mismatched_org', null],
    ['gap', 'covered', null],
    ['pending', 'vendor_offline', null],
  ])('%s → %s raises %s', (prior, next, expected) => {
    expect(alertTransition(prior as never, next as never)).toBe(expected);
  });
});

describe('normalizeHostname', () => {
  it('trims and lowercases; blank is null', () => {
    expect(normalizeHostname('  PC-1 ')).toBe('pc-1');
    expect(normalizeHostname('   ')).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
  });
});
