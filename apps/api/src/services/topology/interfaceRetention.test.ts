import { describe, expect, it } from 'vitest';
import { planTopologyInterfacePartitions, TOPOLOGY_INTERFACE_PARTITION_LOOKAHEAD_DAYS } from './interfaceRetention';

const now = new Date('2026-11-10T12:00:00Z');
const leaf = (resolution: string, day: string) => ({ resolution, day, name: `topology_interface_samples_${resolution}_p${day.replaceAll('-', '')}` });

describe('planTopologyInterfacePartitions', () => {
  it('provisions yesterday through the lookahead for every resolution before ingress', () => {
    const plan = planTopologyInterfacePartitions(now, [], null);
    for (const resolution of ['raw', '5m', '1h']) {
      const days = plan.ensure.filter(e => e.resolution === resolution).map(e => e.day);
      expect(days[0]).toBe('2026-11-09');
      expect(days).toHaveLength(TOPOLOGY_INTERFACE_PARTITION_LOOKAHEAD_DAYS + 2);
      expect(days.at(-1)).toBe('2026-11-17');
    }
    expect(plan.ensure.some(e => e.day === '2026-11-10' && e.resolution === 'raw')).toBe(true);
  });

  it('does not re-ensure leaves that already exist', () => {
    const plan = planTopologyInterfacePartitions(now, [leaf('raw', '2026-11-10')], null);
    expect(plan.ensure.some(e => e.resolution === 'raw' && e.day === '2026-11-10')).toBe(false);
  });

  it('drops only whole days past each retention horizon (raw 7 d, 5m 30 d, 1h 90 d)', () => {
    const existing = [
      leaf('raw', '2026-11-02'), leaf('raw', '2026-11-03'), // 11-02 ends at 11-03 00:00 <= 11-03 horizon day → drop; 11-03 is the boundary day
      leaf('5m', '2026-10-10'), leaf('5m', '2026-10-11'),
      leaf('1h', '2026-08-11'), leaf('1h', '2026-08-12'),
    ];
    const plan = planTopologyInterfacePartitions(now, existing, null);
    expect(plan.drop.map(d => `${d.resolution}:${d.day}`)).toEqual(['raw:2026-11-02', '5m:2026-10-10', '1h:2026-08-11']);
    expect(plan.backlog).toEqual([]);
  });

  it('refuses to drop a raw day that still has unrolled samples and reports backlog', () => {
    const plan = planTopologyInterfacePartitions(now, [leaf('raw', '2026-11-02')], new Date('2026-11-02T23:55:00Z'));
    expect(plan.drop).toEqual([]);
    expect(plan.backlog).toEqual([{ resolution: 'raw', day: '2026-11-02' }]);
  });

  it('computes the precise per-resolution row cutoffs', () => {
    const plan = planTopologyInterfacePartitions(now, [], null);
    expect(plan.cutoffs).toEqual({ raw: new Date('2026-11-03T12:00:00Z'), '5m': new Date('2026-10-11T12:00:00Z'), '1h': new Date('2026-08-12T12:00:00Z') });
  });
});
