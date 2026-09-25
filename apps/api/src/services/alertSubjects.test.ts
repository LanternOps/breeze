import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ open: [] as any[], create: vi.fn(), resolve: vi.fn(), allocate: vi.fn(), record: vi.fn() }));
vi.mock('../db', () => ({ db: { select: () => ({ from: () => ({ where: async () => [...m.open] }) }) } }));
vi.mock('./alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'], createAlert: m.create, resolveAlert: m.resolve }));
vi.mock('./monitors/episodeService', () => ({ allocateSubjectEpisode: m.allocate, recordMonitorEvaluation: m.record }));
vi.mock('./monitors/escalationLatch', () => ({ fireEscalationLatch: vi.fn() }));

import { evaluateSubjectAlerts } from './alertSubjects';

const rule = { id: 'rule', name: 'Disk health', overrideSettings: null, managedByMonitorId: 'monitor' };
const template = {
  id: 'template', severity: 'high', autoResolve: true, cooldownMinutes: 60,
  autoResolveConditions: { type: 'offline' }, titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}', messageTemplate: '{{stateDetail}}',
};

function input(statuses: Record<string, string>, autoResolve = true) {
  return {
    rule: { ...rule, overrideSettings: { autoResolve } },
    template,
    device: { id: 'device', orgId: 'device-org', hostname: 'server' },
    monitor: { id: 'monitor', kind: 'hardware_health' },
    evidence: {
      dataState: 'ok',
      subjects: Object.entries(statuses).map(([subjectKey, status]) => ({
        subjectKey, status, description: status, context: { componentLabel: subjectKey, stateLabel: 'failed', stateDetail: 'Failed' },
      })),
      createdAlertIds: [],
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.open = [];
  m.allocate.mockResolvedValue('episode');
  m.create.mockImplementation(async (p: any) => {
    if (m.open.some(a => a.subjectKey === p.subjectKey)) return null;
    if (p.allocateSubjectEpisode) await p.allocateSubjectEpisode();
    m.open.push({ id: p.subjectKey, subjectKey: p.subjectKey, status: 'active', requiresHuman: false });
    return p.subjectKey;
  });
  m.resolve.mockImplementation(async (id: string) => {
    m.open = m.open.filter(a => a.id !== id);
    return true;
  });
});

it('creates two subjects; acknowledging one never blocks its sibling', async () => {
  expect(await evaluateSubjectAlerts(input({ a: 'breaching' }))).toBe('breach');
  m.open[0]!.status = 'acknowledged';
  const second = input({ a: 'breaching', b: 'breaching' });
  expect(await evaluateSubjectAlerts(second)).toBe('breach');
  expect(m.open).toHaveLength(2);
  expect(second.evidence.createdAlertIds).toEqual(['b']);
  expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'device-org', subjectKey: 'b', allocateSubjectEpisode: expect.any(Function) }));
});

it.each(['active', 'acknowledged', 'suppressed'])('recovers only its own %s alert', async status => {
  m.open = [{ id: 'a', subjectKey: 'a', status }, { id: 'b', subjectKey: 'b', status: 'active' }];
  expect(await evaluateSubjectAlerts(input({ a: 'recovered', b: 'unknown' }))).toBe('breach');
  expect(m.resolve).toHaveBeenCalledWith('a', 'Auto-resolved: recovered', undefined, true);
  expect(m.open.map(a => a.id)).toEqual(['b']);
});

it.each(['unknown', 'absent', 'autoResolveOff', 'requiresHuman'])('%s preserves open alert and episode', async variant => {
  m.open = [{ id: 'a', subjectKey: 'a', status: 'active', requiresHuman: variant === 'requiresHuman' }];
  const arg = input(variant === 'absent' ? {} : { a: variant === 'unknown' ? 'unknown' : 'recovered' }, variant !== 'autoResolveOff');
  expect(await evaluateSubjectAlerts(arg)).toBe('breach');
  expect(m.resolve).not.toHaveBeenCalled();
});

it('no open alerts means unknown for missing evidence; observed recovery means ok', async () => {
  expect(await evaluateSubjectAlerts(input({ a: 'unknown' }))).toBe('unknown');
  const arg = input({});
  arg.evidence.dataState = 'unknown';
  expect(await evaluateSubjectAlerts(arg)).toBe('unknown');
  expect(await evaluateSubjectAlerts(input({ a: 'recovered' }))).toBe('ok');
});

it('never records a provisional breach when every subject is suppressed', async () => {
  m.create.mockResolvedValue(null);
  const arg = input({ a: 'breaching', b: 'breaching' });
  expect(await evaluateSubjectAlerts(arg)).toBe('ok');
  expect(arg.evidence.createdAlertIds).toEqual([]);
  expect(m.allocate).not.toHaveBeenCalled();
  expect(m.record).not.toHaveBeenCalled();
});
