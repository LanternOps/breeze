import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  staged: undefined as any,
  publish: vi.fn(),
  link: vi.fn(),
  cooldown: vi.fn(),
  transition: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../db', () => ({ db: m, withDbTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('./eventBus', () => ({ publishEvent: m.publish }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: async () => null }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
// #10926 — a legacy create stages its envelope and hands the id to the outbox.
vi.mock('./subjectAlertOutbox', () => ({ scheduleStagedAlertDispatch: m.schedule }));
vi.mock('./monitors/episodeService', () => ({
  linkEpisodeAlert: m.link,
  recordMonitorEvaluation: vi.fn(),
  detachMonitorFromDevice: vi.fn(),
}));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: async () => false,
  isFlapping: async () => false,
  setCooldown: m.cooldown,
  recordStateTransition: m.transition,
}));

import { createAlert, checkAutoResolve } from './alertService';

const params = {
  ruleId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  severity: 'high' as const,
  title: 'Disk failed',
  message: 'Slot 3',
};

/** The `_subjectDispatch` envelope a legacy `createAlert` wrote into its INSERT's context param. */
function stagedLegacyEnvelope() {
  const query = new PgDialect().sqlToQuery(m.execute.mock.calls[0]![0]);
  const context = query.params.find(param => typeof param === 'string' && param.includes('_subjectDispatch'));
  expect(context, 'the INSERT context param carries the outbox envelope').toBeDefined();
  return JSON.parse(context as string)._subjectDispatch as {
    eventType: string; payload: Record<string, unknown>; retryOnPublishFailure: boolean;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const results = [[{ id: params.ruleId, templateId: 'template', overrideSettings: null }], [{ cooldownMinutes: 5 }], []];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => results.shift() ?? [] }) }) }));
  m.execute.mockResolvedValue([{ id: 'alert' }]);
  m.publish.mockResolvedValue(undefined);
  m.link.mockResolvedValue({ owner: true });
  m.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  m.update.mockReturnValue({
    set: (value: any) => {
      m.staged = value;
      return { where: vi.fn().mockResolvedValue(undefined) };
    },
  });
});

it.each([true, false])('stages subject ownership %s without external effects', async owner => {
  m.link.mockResolvedValue({ owner });
  expect(await createAlert({ ...params, subjectKey: 'disk:3', episodeId: 'episode' })).toBe('alert');
  expect(m.staged.context._subjectDispatch.payload).toMatchObject({ subjectKey: 'disk:3', responsesOwner: owner });
  expect(m.publish).not.toHaveBeenCalled();
  // The subject path stages via UPDATE and is drained by the worker; it is not
  // the legacy after-commit hand-off.
  expect(m.schedule).not.toHaveBeenCalled();
  expect(m.cooldown).not.toHaveBeenCalled();
  expect(m.transition).not.toHaveBeenCalled();
  const query = new PgDialect().sqlToQuery(m.execute.mock.calls[0]![0]);
  expect(query.sql).toContain("COALESCE(subject_key, '')");
  expect(query.sql).toContain('DO NOTHING RETURNING id');
});

it('treats a losing insert as dedupe without publishing or burning cooldown', async () => {
  m.execute.mockResolvedValue([]);
  expect(await createAlert({ ...params, subjectKey: 'disk:3' })).toBeNull();
  expect(m.publish).not.toHaveBeenCalled();
  expect(m.schedule).not.toHaveBeenCalled();
  expect(m.cooldown).not.toHaveBeenCalled();
  expect(m.transition).not.toHaveBeenCalled();
});

it('legacy identity is NULL and owns responses', async () => {
  await createAlert(params);
  // Staged for the outbox, never published inline (#10926).
  expect(m.publish).not.toHaveBeenCalled();
  expect(stagedLegacyEnvelope()).toMatchObject({
    eventType: 'alert.triggered',
    retryOnPublishFailure: true,
    payload: { subjectKey: null, responsesOwner: true },
  });
  expect(m.schedule).toHaveBeenCalledExactlyOnceWith('alert');
});

it('subject claim failure aborts before staging or publication', async () => {
  m.link.mockRejectedValueOnce(new Error('claim failed'));
  await expect(createAlert({ ...params, subjectKey: 'disk:3', episodeId: 'episode' })).rejects.toThrow('claim failed');
  expect(m.update).not.toHaveBeenCalled();
  expect(m.publish).not.toHaveBeenCalled();
  expect(m.cooldown).not.toHaveBeenCalled();
});

it('NULL-subject creation never requires a prepublication episode claim', async () => {
  m.link.mockRejectedValueOnce(new Error('bookkeeping failed'));
  expect(await createAlert({ ...params, episodeId: 'episode' })).toBe('alert');
  expect(m.link).not.toHaveBeenCalled();
  expect(m.delete).not.toHaveBeenCalled();
  expect(m.publish).not.toHaveBeenCalled();
  expect(stagedLegacyEnvelope()).toMatchObject({
    eventType: 'alert.triggered',
    payload: { subjectKey: null, responsesOwner: true },
  });
  expect(m.schedule).toHaveBeenCalledExactlyOnceWith('alert');
});

it('never invokes device-level auto-resolve for a subject', async () => {
  m.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ status: 'active', subjectKey: 'disk:3', ruleId: params.ruleId, requiresHuman: false }],
      }),
    }),
  });
  expect(await checkAutoResolve('alert')).toBe(false);
  expect(m.select).toHaveBeenCalledTimes(1);
});
