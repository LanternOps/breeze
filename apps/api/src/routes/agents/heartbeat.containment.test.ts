import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupHeartbeatHarness, heartbeatSavepointDepth, beat as heartbeat } from './heartbeatTestHarness';
import { buildContainmentHeartbeatBlock, reconcileContainmentReport, noteIsolationReportDropped } from '../../services/networkIsolation/reconcile';
import { captureException } from '../../services/sentry';
import { heartbeatSchema } from './schemas';
const beat = { status: 'ok', agentVersion: '999.0.0', metrics: { cpuPercent: 1, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 } };
describe('containment heartbeat contract', () => {
  it('accepts and preserves capabilities', () => {
    const securityCapabilities = { networkIsolationVersion: 1, networkIsolationMechanism: 'wfp', networkIsolationUnsupportedReason: 'diagnostic', networkIsolationReady: true };
    expect(heartbeatSchema.parse({ ...beat, securityCapabilities }).securityCapabilities).toMatchObject(securityCapabilities);
  });
  it('drops a malformed report without rejecting the heartbeat', () => {
    const parsed = heartbeatSchema.parse({ ...beat, containment: { networkIsolation: { state: 'garbage' } } });
    expect(parsed).toHaveProperty('containment');
    expect(parsed.containment?.networkIsolation).toBeUndefined();
  });
  it('truncates unsupported reason and drops unknown mechanisms', () => {
    const parsed = heartbeatSchema.parse({ ...beat, securityCapabilities: { networkIsolationUnsupportedReason: 'x'.repeat(1001), networkIsolationMechanism: 'invented' } });
    expect(parsed.securityCapabilities?.networkIsolationUnsupportedReason).toHaveLength(1000);
    expect(parsed.securityCapabilities?.networkIsolationMechanism).toBeUndefined();
  });
});

describe('heartbeat isolation fault containment', () => {
  const row = { id: 'episode-1', generation: 2, desiredState: 'isolated', allowSnapshot: [{ kind: 'host', host: 'control.example.test', ports: [443], proto: 'tcp', scope: 'breeze' }] };
  beforeEach(() => {
    setupHeartbeatHarness();
    vi.mocked(buildContainmentHeartbeatBlock).mockResolvedValue({ networkIsolation: null });
    vi.mocked(reconcileContainmentReport).mockResolvedValue(undefined);
  });
  it('does not open a savepoint or build a block for a beat with no report and no episode (#4618)', async () => {
    let lookupDepth: number | undefined;
    vi.mocked(reconcileContainmentReport).mockImplementationOnce(async (_tx, _device, _report, _at, context) => {
      lookupDepth = heartbeatSavepointDepth();
      context!.row = null;
    });
    const response = await heartbeat();
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('containment', { networkIsolation: null });
    expect(reconcileContainmentReport).toHaveBeenCalledTimes(1);
    expect(buildContainmentHeartbeatBlock).not.toHaveBeenCalled();
    expect(vi.mocked(reconcileContainmentReport).mock.calls[0]?.[2]).toBeUndefined();
    expect(lookupDepth).toBe(0);
  });
  it('keeps a savepoint around real report reconciliation and block work', async () => {
    let reconcileDepth: number | undefined;
    let buildDepth: number | undefined;
    vi.mocked(reconcileContainmentReport).mockImplementationOnce(async (_tx, _device, _report, _at, context) => {
      reconcileDepth = heartbeatSavepointDepth();
      context!.row = row as never;
    });
    vi.mocked(buildContainmentHeartbeatBlock).mockImplementationOnce(async () => {
      buildDepth = heartbeatSavepointDepth();
      return { networkIsolation: null };
    });
    const response = await heartbeat({ containment: { networkIsolation: { isolationId: null, phase: 'none' } } });
    expect(response.status).toBe(200);
    expect(reconcileContainmentReport).toHaveBeenCalledTimes(1);
    expect(buildContainmentHeartbeatBlock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reconcileContainmentReport).mock.calls[0]?.[2]).toEqual({ isolationId: null, phase: 'none' });
    expect(reconcileDepth).toBe(1);
    expect(buildDepth).toBe(1);
  });
  it('keeps heartbeat 200 and the stored containment block when decrypt/build throws', async () => {
    vi.mocked(buildContainmentHeartbeatBlock).mockImplementationOnce(async (_tx, _device, context) => {
      context!.row = row as never;
      throw new Error('decrypt failed');
    });
    const response = await heartbeat();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.containment.networkIsolation).toMatchObject({ isolationId: row.id, allow: row.allowSnapshot });
    expect(body.containment.networkIsolation).not.toHaveProperty('breakGlassSecret');
    expect(body.configUpdate).not.toHaveProperty('containment');
  });
  it('keeps heartbeat 200 and containment present when reconciliation throws', async () => {
    let reconcileDepth: number | undefined;
    vi.mocked(reconcileContainmentReport).mockImplementationOnce(async () => {
      reconcileDepth = heartbeatSavepointDepth();
      throw new Error('SQL fault');
    });
    const response = await heartbeat({ containment: { networkIsolation: { isolationId: null, phase: 'none' } } });
    expect(reconcileDepth).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('containment', { networkIsolation: null });
    expect(buildContainmentHeartbeatBlock).toHaveBeenCalledTimes(1);
  });
  it('a failing savepoint-free lookup fails the beat', async () => {
    const failure = new Error('episode lookup failed');
    let lookupDepth: number | undefined;
    vi.mocked(reconcileContainmentReport).mockImplementationOnce(async (_tx, _device, report) => {
      lookupDepth = heartbeatSavepointDepth();
      if (report === undefined) throw failure;
    });

    const response = await heartbeat();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBeLessThan(600);
    expect(lookupDepth).toBe(0);
    expect(captureException).toHaveBeenCalledWith(failure, undefined, expect.objectContaining({ phase: 'isolation_heartbeat_block' }));
    // The claim runs before the lookup inside the same org transaction; the 5xx above is what
    // guarantees it rolls back, so the agent never receives a command the server did not commit.
    const body = await response.text();
    expect(body).not.toContain('"commands":[{');
  });
  it('a failing report reconcile inside its savepoint keeps the beat alive', async () => {
    const failure = new Error('report reconcile failed');
    const report = { isolationId: null, phase: 'none' };
    let reconcileDepth: number | undefined;
    vi.mocked(reconcileContainmentReport).mockImplementationOnce(async (_tx, _device, _report, _at, context) => {
      reconcileDepth = heartbeatSavepointDepth();
      context!.row = row as never;
      throw failure;
    });
    vi.mocked(buildContainmentHeartbeatBlock).mockRejectedValueOnce(new Error('block build failed'));

    const response = await heartbeat({ containment: { networkIsolation: report } });

    expect(response.status).toBe(200);
    expect(reconcileDepth).toBe(1);
    expect(vi.mocked(reconcileContainmentReport).mock.calls[0]?.[2]).toEqual(report);
    expect(captureException).toHaveBeenCalledWith(failure, undefined, expect.objectContaining({ phase: 'isolation_heartbeat_block' }));
    expect(await response.json()).toHaveProperty('containment', {
      networkIsolation: { isolationId: row.id, generation: row.generation, desired: row.desiredState, allow: row.allowSnapshot },
    });
  });
  it('passes the parsed report to reconciliation and detects a dropped raw report', async () => {
    const response = await heartbeat({ containment: { networkIsolation: { state: 'garbage' } } });
    expect(response.status).toBe(200);
    expect(noteIsolationReportDropped).toHaveBeenCalledWith('device-1', { state: 'garbage' });
    expect(reconcileContainmentReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'device-1' }), undefined, expect.any(Date), expect.anything());
  });
  it('returns containment on a main-agent beat reporting its installed watchdog', async () => {
    const response = await heartbeat({ watchdogVersion: '0.65.10' });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('containment', { networkIsolation: null });
    expect(buildContainmentHeartbeatBlock).toHaveBeenCalledTimes(1);
  });
  it('returns a top-level containment key on the watchdog branch', async () => {
    const response = await heartbeat({ role: 'watchdog', watchdogState: 'MONITORING' }, { role: 'watchdog' });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('containment', { networkIsolation: null });
    expect(reconcileContainmentReport).not.toHaveBeenCalled();
  });
});
