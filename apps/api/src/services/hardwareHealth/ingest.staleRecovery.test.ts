import { describe, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: { transaction: vi.fn() }, withDbTransaction: vi.fn() }));
import { hardwareHealthSnapshotSchema, type HardwareComponentReport } from '@breeze/shared';
import { reduceSnapshot, type ComponentRow } from './ingest';

// #6895: the W06 Storage Spaces lab timeline. A pre-fix agent reported the
// missing mirror member under a phantom key; on recovery that phantom goes
// stale while still critical, and nothing re-evaluates it for 7 days.
const device = { id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' };
const ctrl = { componentKey: 'storage_spaces:ctrl', componentType: 'controller', source: 'storage_spaces', name: 'Storage Spaces', state: 'ok' } as const;
const vd = (state: string) => ({ componentKey: 'storage_spaces:vd:1', componentType: 'virtual_disk', parentKey: 'storage_spaces:ctrl', source: 'storage_spaces', name: 'Mirror', state }) as const;
const disk = (key: string, state: string) => ({ componentKey: key, componentType: 'physical_disk', parentKey: 'storage_spaces:ctrl', source: 'storage_spaces', name: key, state }) as const;
const winpd = (key: string, state: string) => ({ componentKey: key, componentType: 'physical_disk', source: 'windows_physical_disk', name: key, state }) as const;

let seq = 0;
type WireSource = { source: string; status: string; complete?: boolean };
function step(rows: ComponentRow[], components: Array<Partial<HardwareComponentReport>>, sources: WireSource[] = [{ source: 'storage_spaces', status: 'ok', complete: true }]) {
  seq++;
  const at = new Date(Date.UTC(2026, 8, 24, 11, seq * 5));
  const snapshot = hardwareHealthSnapshotSchema.parse({
    snapshotId: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`, sequence: seq, collectedAt: at.toISOString(),
    agentVersion: '1', pollIntervalMinutes: 5, diskHealthIntervalMinutes: 15, tiersRun: ['raid'], sources, components,
  });
  return reduceSnapshot(rows, device, snapshot, at);
}

const healthy = [ctrl, vd('optimal'), disk('A', 'online'), disk('B', 'online')];
const faulted = [ctrl, vd('degraded'), disk('A', 'online'), disk('PHANTOM', 'missing')];

describe('stale subjects under a recovered parent (#6895)', () => {
  it('retires the stale phantom only once its whole subtree is healthy for two snapshots', () => {
    let r = step([], healthy);
    r = step(r.rows, faulted);
    r = step(r.rows, faulted);
    expect(r.retiredStaleKeys).toEqual([]); // B is stale but healthy: nothing to retire
    expect(r.health).toBe('critical');
    r = step(r.rows, healthy);
    expect(r.rows.find(x => x.componentKey === 'PHANTOM')).toMatchObject({ stale: true, health: 'critical' });
    expect(r.retiredStaleKeys).toEqual([]); // VD healthy for one snapshot only
    expect(r.health).toBe('ok'); // stale rows never hold the rollup (spec §7.5)
    r = step(r.rows, healthy);
    expect(r.retiredStaleKeys).toEqual(['PHANTOM']);
    expect(r.health).toBe('ok');
  });

  it('never retires while a sibling in the subtree is still unhealthy', () => {
    let r = step([], faulted);
    r = step(r.rows, faulted);
    r = step(r.rows, [ctrl, vd('degraded'), disk('A', 'online'), disk('B', 'online')]);
    r = step(r.rows, [ctrl, vd('degraded'), disk('A', 'online'), disk('B', 'online')]);
    expect(r.rows.find(x => x.componentKey === 'PHANTOM')?.stale).toBe(true);
    expect(r.retiredStaleKeys).toEqual([]);
  });

  it('never retires a stale component with no parent (a disk that vanished is itself a fault)', () => {
    const src = [{ source: 'windows_physical_disk', status: 'ok', complete: true }];
    let r = step([], [winpd('winpd:A', 'online'), winpd('winpd:X', 'failed')], src);
    r = step(r.rows, [winpd('winpd:A', 'online'), winpd('winpd:X', 'failed')], src);
    for (let i = 0; i < 3; i++) r = step(r.rows, [winpd('winpd:A', 'online')], src);
    expect(r.rows.find(x => x.componentKey === 'winpd:X')?.stale).toBe(true);
    expect(r.retiredStaleKeys).toEqual([]);
  });

  it('a live predictive-failure sibling blocks retirement; a stale predictive row is eligible', () => {
    const predictiveB = { ...disk('storage_spaces:B', 'online'), predictiveFailure: true };
    let r = step([], faulted);
    r = step(r.rows, faulted);
    for (let i = 0; i < 3; i++) r = step(r.rows, [ctrl, vd('optimal'), disk('A', 'online'), predictiveB]);
    expect(r.retiredStaleKeys).toEqual([]);
    let p = step([], [ctrl, vd('optimal'), disk('A', 'online'), { ...disk('P', 'online'), predictiveFailure: true }]);
    for (let i = 0; i < 2; i++) p = step(p.rows, [ctrl, vd('optimal'), disk('A', 'online')]);
    expect(p.retiredStaleKeys).toEqual(['P']);
  });

  it('never retires when the parent is from another source or is itself stale', () => {
    const src = [{ source: 'storage_spaces', status: 'ok', complete: true }, { source: 'windows_physical_disk', status: 'ok', complete: true }];
    const foreignParent = { ...winpd('winpd:H', 'online') };
    const child = (state: string) => ({ ...disk('C', state), parentKey: 'winpd:H' });
    let r = step([], [foreignParent, child('failed')], src);
    for (let i = 0; i < 3; i++) r = step(r.rows, [foreignParent], src);
    expect(r.rows.find(x => x.componentKey === 'C')?.stale).toBe(true);
    expect(r.retiredStaleKeys).toEqual([]);

    let s = step([], faulted);
    s = step(s.rows, faulted);
    for (let i = 0; i < 3; i++) s = step(s.rows, [vd('optimal'), disk('A', 'online')]); // ctrl gone too
    expect(s.rows.find(x => x.componentKey === 'storage_spaces:ctrl')?.stale).toBe(true);
    expect(s.retiredStaleKeys).toEqual([]);
  });

  it('terminates on a parent_key cycle', () => {
    const a = { ...disk('LOOP-A', 'ok'), componentType: 'enclosure', parentKey: 'LOOP-B' } as const;
    const b = { ...disk('LOOP-B', 'ok'), componentType: 'enclosure', parentKey: 'LOOP-A' } as const;
    let r = step([], [a, b, { ...disk('X', 'failed'), parentKey: 'LOOP-A' }]);
    for (let i = 0; i < 3; i++) r = step(r.rows, [a, b]);
    expect(r.retiredStaleKeys).toEqual(['X']);
  });

  it('only acts on a complete answer from the stale row\'s own source', () => {
    let r = step([], healthy);
    r = step(r.rows, faulted);
    r = step(r.rows, healthy);
    r = step(r.rows, healthy, [{ source: 'storage_spaces', status: 'ok', complete: false }]);
    expect(r.retiredStaleKeys).toEqual([]);
    r = step(r.rows, [], [{ source: 'storage_spaces', status: 'failed' }]);
    expect(r.retiredStaleKeys).toEqual([]);
  });
});
