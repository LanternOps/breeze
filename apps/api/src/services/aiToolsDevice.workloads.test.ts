import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ access: vi.fn(), view: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: m.access }));
vi.mock('./workloads/view', () => ({ getDeviceWorkloadsView: m.view }));

import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';

const name = 'query_device_workloads';
const deviceId = '11111111-1111-4111-8111-111111111111';

const runtime = (r: string, extra: Record<string, unknown> = {}) => ({
  runtime: r,
  detection: 'detected',
  collection: 'enabled',
  complete: true,
  runtimeVersion: '1.0',
  observedCount: 3,
  reportedCount: 3,
  lastError: null,
  collectedAt: 'x',
  lastAttemptAt: 'x',
  lastSuccessAt: '2026-10-12T00:00:00.000Z',
  ...extra,
});
const wl = (i: number, r = 'docker', state = 'running') => ({
  id: `id-${i}`,
  runtime: r,
  kind: 'container',
  workloadId: `w${i}`,
  name: `n${i}`,
  state,
  rawState: 'secret-raw',
  imageRef: 'img:1',
  guestOs: null,
  composeProject: null,
  composeService: null,
  startedAt: null,
  composeWorkingDir: '/srv/secret',
});

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  return tools.get(name)!;
}

describe(name, () => {
  beforeEach(() => {
    m.access.mockReset();
    m.view.mockReset();
  });

  it('denies access before reading the view', async () => {
    m.access.mockResolvedValue({ error: 'Device not found or access denied' });
    const out = JSON.parse(await getTool().handler({ deviceId }, {} as any));
    expect(out).toHaveProperty('error');
    expect(m.view).not.toHaveBeenCalled();
  });

  it('reports agent-too-old for capability 0', async () => {
    m.access.mockResolvedValue({ device: { id: deviceId, hostname: 'h1' } });
    m.view.mockResolvedValue({ capability: 0, runtimes: [], workloads: [] });
    const out = JSON.parse(await getTool().handler({ deviceId }, {} as any));
    expect(out).toMatchObject({ deviceId, capability: 0, agentTooOld: true, truncated: false });
    expect(out.counts.total).toBe(0);
    expect(out.collectionNote).toMatch(/off by default/i);
  });

  it('caps workloads at 200, flags truncation, counts everything, omits containerd counts and internals', async () => {
    m.access.mockResolvedValue({ device: { id: deviceId, hostname: 'h1' } });
    m.view.mockResolvedValue({
      capability: 1,
      runtimes: [
        runtime('docker', { observedCount: 250, reportedCount: 250 }),
        runtime('containerd', { observedCount: 9, reportedCount: 9 }),
      ],
      workloads: Array.from({ length: 250 }, (_, i) => wl(i, 'docker', i % 2 ? 'stopped' : 'running')),
    });
    const out = JSON.parse(await getTool().handler({ deviceId }, {} as any));
    expect(out.agentTooOld).toBe(false);
    expect(out.workloads).toHaveLength(200);
    expect(out.truncated).toBe(true);
    expect(out.counts).toMatchObject({ total: 250, byRuntime: { docker: 250 }, byState: { running: 125, stopped: 125 } });
    expect(out.counts.byRuntime).not.toHaveProperty('containerd');
    const ctd = out.runtimes.find((r: any) => r.runtime === 'containerd');
    expect(ctd.observedCount ?? null).toBeNull();
    expect(ctd.reportedCount ?? null).toBeNull();
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('honours a smaller limit and flags truncation', async () => {
    m.access.mockResolvedValue({ device: { id: deviceId } });
    m.view.mockResolvedValue({ capability: 1, runtimes: [runtime('docker')], workloads: [wl(1), wl(2), wl(3)] });
    const out = JSON.parse(await getTool().handler({ deviceId, limit: 2 }, {} as any));
    expect(out.workloads).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.counts.total).toBe(3);
  });

  it('applies runtime/state filters to the workload list and counts', async () => {
    m.access.mockResolvedValue({ device: { id: deviceId } });
    m.view.mockResolvedValue({
      capability: 1,
      runtimes: [runtime('docker'), runtime('podman')],
      workloads: [wl(1, 'docker', 'running'), wl(2, 'podman', 'running'), wl(3, 'docker', 'stopped')],
    });
    const out = JSON.parse(await getTool().handler({ deviceId, runtime: 'docker', state: 'running' }, {} as any));
    expect(out.workloads.map((w: any) => w.name)).toEqual(['n1']);
    expect(out.counts.total).toBe(1);
  });
});
