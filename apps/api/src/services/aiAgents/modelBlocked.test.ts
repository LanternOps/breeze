import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ recipients: vi.fn(), createNotification: vi.fn() }));
vi.mock('./recipients', () => ({ resolveRecipientUserIds: m.recipients }));
vi.mock('../userNotifications', () => ({ createNotification: m.createNotification }));
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));

import { AgentRunBlockedError, blockedOutcome, modelBlockedDedupeKey, notifyModelBlocked } from './modelBlocked';

beforeEach(() => vi.clearAllMocks());

describe('modelBlocked', () => {
  it('the dedupe key is per org, agent, reason and UTC day (once per policy per day, spec §9.1)', () => {
    const k1 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-20T23:59:00Z'));
    const k2 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-20T00:01:00Z'));
    const k3 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-21T00:01:00Z'));
    expect(k1).toBe('ai-model-blocked-o-a-model_unavailable-2026-11-20');
    expect(k1).toBe(k2);
    expect(k3).not.toBe(k1);
    expect(modelBlockedDedupeKey('o', 'a', 'model_refused', new Date('2026-11-20T00:00:00Z'))).not.toBe(k1);
  });

  it('carries the refusal category in the run outcome', () => {
    expect(blockedOutcome('model_refused', { message: 'm', refusalCategory: 'cyber', offeringId: 'o1', requestedModel: 'claude-opus-5-5' }))
      .toEqual({ blockedReason: 'model_refused', message: 'm', refusalCategory: 'cyber', offeringId: 'o1', requestedModel: 'claude-opus-5-5' });
  });

  it('omits detail fields that were not supplied, but keeps an explicit null category', () => {
    expect(blockedOutcome('model_unavailable', { message: 'm' })).toEqual({ blockedReason: 'model_unavailable', message: 'm' });
    expect(blockedOutcome('model_refused', { message: 'm', refusalCategory: null }))
      .toEqual({ blockedReason: 'model_refused', message: 'm', refusalCategory: null });
  });

  it('notifies every recipient with the day-scoped dedupe key', async () => {
    m.recipients.mockResolvedValue(['u1', 'u2']);
    await notifyModelBlocked({
      orgId: 'o', agentId: 'a', agentName: 'Triage', agent: { orgId: null, partnerId: 'p', recipients: {} },
      reason: 'model_unavailable', message: 'Model X is no longer available — choose another.',
      now: new Date('2026-11-20T12:00:00Z'),
    });
    expect(m.recipients).toHaveBeenCalledWith({ orgId: null, partnerId: 'p', recipients: {} }, 'o');
    expect(m.createNotification).toHaveBeenCalledTimes(2);
    expect(m.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: 'o', type: 'ai', priority: 'high',
      dedupeKey: 'ai-model-blocked-o-a-model_unavailable-2026-11-20',
      link: '/ai-agents/runs#agent=a',
      message: 'Model X is no longer available — choose another.',
    }));
  });

  it('sends nothing when the agent has no resolvable recipient', async () => {
    m.recipients.mockResolvedValue([]);
    await notifyModelBlocked({
      orgId: 'o', agentId: 'a', agentName: 'Triage', agent: { orgId: 'o', partnerId: null, recipients: {} },
      reason: 'model_refused', message: 'm',
    });
    expect(m.createNotification).not.toHaveBeenCalled();
  });

  it('AgentRunBlockedError carries the error code, outcome and what the run spent', () => {
    const err = new AgentRunBlockedError('model_refused', { blockedReason: 'model_refused' }, 'declined', { spent: { costCents: 3, turnCount: 1 } });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      errorCode: 'model_refused', outcome: { blockedReason: 'model_refused' }, message: 'declined',
      spent: { costCents: 3, turnCount: 1 }, notify: true,
    });
    expect(new AgentRunBlockedError('model_unavailable', {}, 'x', { notify: false })).toMatchObject({ spent: null, notify: false });
  });
});
