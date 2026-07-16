import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';

const { writeAuditEvent } = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));

vi.mock('../auditEvents', () => ({ writeAuditEvent }));

import {
  M365_CUSTOMER_GRAPH_READ_EVENTS,
  M365_CUSTOMER_GRAPH_READ_OUTCOMES,
  registerM365CustomerGraphReadPrometheusCounter,
  recordM365CustomerGraphReadEvent,
  recordM365CustomerGraphReadMetric,
  setM365CustomerGraphReadMetricsRecorder,
} from './metrics';

const requestLike = {
  req: { header: vi.fn(() => undefined) },
};

describe('M365 customer Graph read observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setM365CustomerGraphReadMetricsRecorder(null);
  });

  it('exposes exactly the seven fixed lifecycle events and a bounded outcome enum', () => {
    expect(M365_CUSTOMER_GRAPH_READ_EVENTS).toEqual([
      'm365.customer_graph_read.consent_initiated',
      'm365.customer_graph_read.admin_consent_returned',
      'm365.customer_graph_read.tenant_binding_verified',
      'm365.customer_graph_read.verification_failed',
      'm365.customer_graph_read.grant_drift_detected',
      'm365.customer_graph_read.retested',
      'm365.customer_graph_read.disconnected',
    ]);
    expect(new Set(M365_CUSTOMER_GRAPH_READ_OUTCOMES).size)
      .toBe(M365_CUSTOMER_GRAPH_READ_OUTCOMES.length);
  });

  it('records only fixed enum label pairs and drops unbounded runtime labels', () => {
    const onEvent = vi.fn();
    setM365CustomerGraphReadMetricsRecorder({ onEvent });

    recordM365CustomerGraphReadMetric(
      'm365.customer_graph_read.retested',
      'active',
    );
    recordM365CustomerGraphReadMetric('attacker-event' as never, 'provider-body' as never);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(
      'm365.customer_graph_read.retested',
      'active',
    );
  });

  it('registers one idempotent Prometheus counter with only event and outcome labels', async () => {
    const registry = new Registry();
    const first = registerM365CustomerGraphReadPrometheusCounter(registry);
    const second = registerM365CustomerGraphReadPrometheusCounter(registry);

    expect(second).toBe(first);
    expect(registry.getMetricsAsArray().filter(
      (metric) => metric.name === 'breeze_m365_customer_graph_read_events_total',
    )).toHaveLength(1);

    recordM365CustomerGraphReadMetric(
      'm365.customer_graph_read.consent_initiated',
      'initiated',
    );
    const scrape = await registry.metrics();
    expect(scrape).toContain(
      'breeze_m365_customer_graph_read_events_total{event="m365.customer_graph_read.consent_initiated",outcome="initiated"} 1',
    );
  });

  it('constructs audit details from the explicit safe allowlist only', () => {
    const onEvent = vi.fn();
    setM365CustomerGraphReadMetricsRecorder({ onEvent });

    recordM365CustomerGraphReadEvent(requestLike, {
      event: 'm365.customer_graph_read.tenant_binding_verified',
      orgId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
      profile: 'customer-graph-read',
      consentAttemptId: '33333333-3333-4333-8333-333333333333',
      manifestVersion: 2,
      outcome: 'active',
      actorId: '66666666-6666-4666-8666-666666666666',
      correlationId: '44444444-4444-4444-8444-444444444444',
      verifiedTenantId: '55555555-5555-4555-8555-555555555555',
      state: 'raw-state',
      cookie: 'signed-cookie',
      authorizationCode: 'secret-code',
      nonce: 'secret-nonce',
      codeVerifier: 'secret-verifier',
      executorAuthorization: 'secret-executor-auth',
      accessToken: 'secret-token',
      certificatePem: 'secret-cert',
      privateKeyPem: 'secret-key',
      vaultRef: 'akv://secret-vault/path/version',
      administratorObjectId: 'secret-admin-id',
      providerDescription: 'secret-provider-description',
      requestBody: 'secret-request-body',
    } as never);

    expect(writeAuditEvent).toHaveBeenCalledWith(requestLike, {
      orgId: '11111111-1111-4111-8111-111111111111',
      action: 'm365.customer_graph_read.tenant_binding_verified',
      resourceType: 'm365_connection',
      resourceId: '22222222-2222-4222-8222-222222222222',
      details: {
        profile: 'customer-graph-read',
        consentAttemptId: '33333333-3333-4333-8333-333333333333',
        manifestVersion: 2,
        outcome: 'active',
        correlationId: '44444444-4444-4444-8444-444444444444',
        tenantId: '55555555-5555-4555-8555-555555555555',
      },
      result: 'success',
      actorType: 'user',
      actorId: '66666666-6666-4666-8666-666666666666',
    });
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toMatch(
      /raw-state|signed-cookie|secret-code|secret-nonce|secret-verifier|secret-executor-auth|secret-token|secret-cert|secret-key|secret-vault|secret-admin-id|secret-provider-description|secret-request-body/,
    );
    expect(onEvent).toHaveBeenCalledWith(
      'm365.customer_graph_read.tenant_binding_verified',
      'active',
    );
  });
});
