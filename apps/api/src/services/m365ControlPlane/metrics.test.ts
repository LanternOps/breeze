import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';

const { writeAuditEvent } = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));

vi.mock('../auditEvents', () => ({ writeAuditEvent }));

import {
  M365_CUSTOMER_GRAPH_ACTIONS_EVENTS,
  M365_CUSTOMER_GRAPH_READ_EVENTS,
  M365_CUSTOMER_GRAPH_READ_OUTCOMES,
  recordM365CustomerGraphActionsEvent,
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

  it('exposes exactly the nine fixed lifecycle events and a bounded outcome enum', () => {
    expect(M365_CUSTOMER_GRAPH_READ_EVENTS).toEqual([
      'm365.customer_graph_read.consent_initiated',
      'm365.customer_graph_read.upgrade_consent_initiated',
      'm365.customer_graph_read.admin_consent_returned',
      'm365.customer_graph_read.tenant_binding_verified',
      'm365.customer_graph_read.verification_failed',
      'm365.customer_graph_read.grant_drift_detected',
      'm365.customer_graph_read.retested',
      'm365.customer_graph_read.disconnected',
      // W05, appended.
      'm365.customer_graph_read.sync_requested',
      // #7910 identity-first consent, appended.
      'm365.customer_graph_read.admin_identity_verified',
      // #7913 W03 confirm-tenant interstitial, appended last.
      'm365.customer_graph_read.tenant_confirmed',
    ]);
    expect(M365_CUSTOMER_GRAPH_ACTIONS_EVENTS).toEqual([
      'm365.customer_graph_actions.consent_initiated',
      'm365.customer_graph_actions.admin_consent_returned',
      'm365.customer_graph_actions.tenant_binding_verified',
      'm365.customer_graph_actions.verification_failed',
      'm365.customer_graph_actions.grant_drift_detected',
      'm365.customer_graph_actions.retested',
      'm365.customer_graph_actions.disconnected',
      // #7910 identity-first consent, appended.
      'm365.customer_graph_actions.admin_identity_verified',
      // #7913 W03 confirm-tenant interstitial, appended last.
      'm365.customer_graph_actions.tenant_confirmed',
    ]);
    expect(M365_CUSTOMER_GRAPH_READ_OUTCOMES).toEqual([
      'initiated',
      'identity_verification_started',
      'active',
      'degraded',
      'revoked',
      'consent_expired',
      'consent_state_mismatch',
      'consent_cancelled',
      'admin_role_required',
      'tenant_mismatch',
      'tenant_already_bound',
      'credential_unavailable',
      'identity_token_invalid',
      'application_token_invalid',
      'grant_reconciliation_unavailable',
      'grant_missing',
      'grant_unexpected',
      'manifest_stale',
      'organization_probe_failed',
      'executor_unavailable',
      'conditional_access_blocked',
      'consent_provider_error',
      // #7910 identity-first consent, appended.
      'identity_verified',
      'application_verification_started',
      // #7913 W03: the operator confirmed the verified tenant, appended last.
      'tenant_confirmed',
    ]);
    expect(new Set(M365_CUSTOMER_GRAPH_READ_OUTCOMES).size)
      .toBe(M365_CUSTOMER_GRAPH_READ_OUTCOMES.length);
    // The consent callback's provider-error outcomes must be recordable
    // labels, or their audit/metric would be silently dropped.
    expect(M365_CUSTOMER_GRAPH_READ_OUTCOMES).toContain('conditional_access_blocked');
    expect(M365_CUSTOMER_GRAPH_READ_OUTCOMES).toContain('consent_provider_error');
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

  it('records the identity-verified administrator as its own field, never as the consenting actor', () => {
    recordM365CustomerGraphActionsEvent(requestLike, {
      event: 'm365.customer_graph_actions.admin_identity_verified',
      orgId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
      profile: 'customer-graph-actions',
      consentAttemptId: '33333333-3333-4333-8333-333333333333',
      outcome: 'identity_verified',
      actorId: '66666666-6666-4666-8666-666666666666',
      verifiedTenantId: '55555555-5555-4555-8555-555555555555',
      verifiedAdministratorObjectId: '77777777-7777-4777-8777-777777777777',
      administratorUsername: 'secret-upn@tenant.example',
      unknownField: 'dropped',
    } as never);

    expect(writeAuditEvent).toHaveBeenCalledWith(requestLike, expect.objectContaining({
      action: 'm365.customer_graph_actions.admin_identity_verified',
      details: {
        profile: 'customer-graph-actions',
        consentAttemptId: '33333333-3333-4333-8333-333333333333',
        outcome: 'identity_verified',
        tenantId: '55555555-5555-4555-8555-555555555555',
        verifiedAdministratorObjectId: '77777777-7777-4777-8777-777777777777',
      },
      result: 'success',
      // The Breeze user who started the flow stays the actor.
      actorId: '66666666-6666-4666-8666-666666666666',
    }));
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toMatch(/secret-upn|dropped/);
  });

  it('counts application_verification_started as a success outcome', () => {
    recordM365CustomerGraphReadEvent(requestLike, {
      event: 'm365.customer_graph_read.admin_consent_returned',
      orgId: '11111111-1111-4111-8111-111111111111',
      connectionId: '22222222-2222-4222-8222-222222222222',
      profile: 'customer-graph-read',
      consentAttemptId: '33333333-3333-4333-8333-333333333333',
      outcome: 'application_verification_started',
    });
    expect(writeAuditEvent).toHaveBeenCalledWith(requestLike, expect.objectContaining({ result: 'success' }));
  });
});
