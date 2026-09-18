import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectRows, windowStats, suspendMock, statusMailMock, opsAlertMock, auditMock, configMock, hostedMock } =
  vi.hoisted(() => ({
    selectRows: [] as unknown[][],
    windowStats: { value: null as unknown },
    suspendMock: vi.fn(async () => undefined),
    statusMailMock: vi.fn(async () => 1),
    opsAlertMock: vi.fn(async (_msg: { title: string; body: string }) => true),
    auditMock: vi.fn(async () => undefined),
    configMock: vi.fn(),
    hostedMock: vi.fn(() => true),
  }));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    // `innerJoin` is on the list because the loader joins `partners` for the
    // name the ops alert reads; a chain without it would throw before the
    // assertion under test could run.
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) c[m] = vi.fn(() => c);
    (c as { then: unknown }).then = (r: (v: unknown) => unknown) =>
      Promise.resolve(selectRows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./config', () => ({ getEmailDomainsConfig: configMock }));
vi.mock('./deliveryStats', () => ({
  STATS_WINDOW_DAYS: 7,
  loadPartnerSendingWindowStats: vi.fn(async () => windowStats.value),
}));
vi.mock('./sendingDomainService', () => ({ suspendSendingDomain: suspendMock }));
vi.mock('./statusMail', () => ({ sendSendingDomainStatusEmail: statusMailMock }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: opsAlertMock }));
vi.mock('../auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('../auditEvents', () => ({ ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000' }));
vi.mock('../../config/env', () => ({ isHosted: hostedMock }));

import { evaluateAutoSuspension } from './autoSuspend';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const DOMAIN_A = '22222222-2222-4222-8222-222222222222';
const DOMAIN_B = '33333333-3333-4333-8333-333333333333';

function stats(over: Partial<{ sent: number; delivered: number; bounced: number; complained: number; failed: number; suppressed: number }>) {
  const base = { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0, ...over };
  const messages = Math.max(base.sent, base.delivered + base.bounced + base.failed);
  return {
    partnerId: PARTNER, ...base, messages,
    bounceRate: messages > 0 ? base.bounced / messages : 0,
  };
}

function activeDomains() {
  return [
    { id: DOMAIN_A, domain: 'mail.acme.test', createdBy: 'u1', partnerName: 'Acme MSP' },
    { id: DOMAIN_B, domain: 'billing.acme.test', createdBy: null, partnerName: 'Acme MSP' },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.length = 0;
  hostedMock.mockReturnValue(true);
  configMock.mockReturnValue({ autoSuspend: { enabled: true, bounceRate: 0.08, minMessages: 50, complaints: 3 } });
  windowStats.value = stats({});
});

describe('evaluateAutoSuspension — the off switch', () => {
  it('is a no-op when auto-suspension is disabled (self-hosted default)', async () => {
    configMock.mockReturnValue({ autoSuspend: { enabled: false, bounceRate: 0.08, minMessages: 50, complaints: 3 } });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'disabled', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the partner has no sendable domain left', async () => {
    selectRows.push([]);
    windowStats.value = stats({ delivered: 10, bounced: 90 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'no_active_domains', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });
});

describe('evaluateAutoSuspension — the threshold matrix (spec §9.3)', () => {
  it('does NOT suspend exactly AT the bounce rate (strictly greater is required)', async () => {
    selectRows.push(activeDomains());
    // 8 bounced of 100 messages == 0.08 exactly.
    windowStats.value = stats({ sent: 100, delivered: 90, bounced: 8, failed: 2 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it('suspends just OVER the bounce rate', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 100, delivered: 89, bounced: 9, failed: 2 });
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_bounce_rate');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });

  it('ignores a high bounce rate BELOW the minimum message count', async () => {
    selectRows.push(activeDomains());
    // 49 messages, 40% bounced — loud, but not enough evidence.
    windowStats.value = stats({ sent: 49, delivered: 29, bounced: 20 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
  });

  it('acts at EXACTLY the minimum message count when the rate is over', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 50, delivered: 44, bounced: 5, failed: 1 }); // 0.10 > 0.08
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toMatchObject({ outcome: 'suspended_bounce_rate' });
  });

  it('does NOT suspend at 2 complaints', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 2 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'below_thresholds', suspendedDomainIds: [] });
  });

  it('suspends at EXACTLY 3 complaints, whatever the volume', async () => {
    selectRows.push(activeDomains());
    // Deliberately below minMessages: the complaint rule is absolute (spec §9.3).
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_complaints');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });
});

describe('evaluateAutoSuspension — the fan-out', () => {
  it('suspends EVERY domain of the partner with reason abuse_auto', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(suspendMock.mock.calls).toEqual([[DOMAIN_A, 'abuse_auto'], [DOMAIN_B, 'abuse_auto']]);
  });

  it('mails one status notice per domain and writes one audit row per domain', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(statusMailMock).toHaveBeenCalledTimes(2);
    expect(statusMailMock).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER, domain: 'mail.acme.test', event: 'suspended',
      statusReason: 'abuse_auto', createdBy: 'u1',
    }));
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner_sending_domain.auto_suspended',
      resourceType: 'partner_sending_domain',
      actorType: 'system',
      result: 'success',
    }));
  });

  it('raises exactly ONE ops alert for the whole partner, not one per domain', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    await evaluateAutoSuspension(PARTNER);
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
    const alert = opsAlertMock.mock.calls[0]![0];
    expect(alert.title).toContain('Acme MSP');
    expect(alert.body).toContain(PARTNER);
    expect(alert.body).toContain('complaints');
  });

  // A domain already suspended is filtered out by the query, so a repeat
  // evaluation has nothing to act on — the job is safe to run on every event.
  it('is idempotent: a second evaluation with everything already suspended does nothing', async () => {
    selectRows.push([]);
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 30 });
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toEqual({ outcome: 'no_active_domains', suspendedDomainIds: [] });
    expect(suspendMock).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  // Delivery of a notice must never roll back a suspension that already landed.
  it('still reports the suspension when the status mail throws', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    statusMailMock.mockRejectedValueOnce(new Error('smtp down'));
    const result = await evaluateAutoSuspension(PARTNER);
    expect(result.outcome).toBe('suspended_complaints');
    expect(result.suspendedDomainIds).toEqual([DOMAIN_A, DOMAIN_B]);
  });

  it('still reports the suspension when the ops alert throws', async () => {
    selectRows.push(activeDomains());
    windowStats.value = stats({ sent: 10, delivered: 10, complained: 3 });
    opsAlertMock.mockRejectedValueOnce(new Error('discord down'));
    await expect(evaluateAutoSuspension(PARTNER)).resolves.toMatchObject({ outcome: 'suspended_complaints' });
  });
});
