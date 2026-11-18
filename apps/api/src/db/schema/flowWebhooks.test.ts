import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { flowWebhookDeliveries } from './flowWebhooks';
import { flowUsageCounters } from './flowUsage';
import { flows } from './flows';
import { flowRunSteps, flowRuns } from './flowRuns';
import { actionIntents } from './actionIntents';
import { aiInvocations } from './aiInvocations';

// Tool Catalog W05 (#5220) Task A2. The two new tables follow the
// connection_health_incidents shape (partner always set, org nullable), and
// five existing tables gain W5 columns. CHECKs, RLS, triggers and DEFERRABLE
// clauses are in migrations/2027-01-07-140000-flow-webhooks-tools-budgets.sql.

function columnsOf(table: PgTable): Map<string, { notNull: boolean }> {
  return new Map(getTableConfig(table).columns.map((c) => [c.name, { notNull: c.notNull }]));
}

describe('flow_webhook_deliveries / flow_usage_counters (#5220 A2)', () => {
  it('flow_webhook_deliveries declares every column', () => {
    expect([...columnsOf(flowWebhookDeliveries).keys()].sort()).toEqual([
      'attempts', 'auth_mode', 'body_bytes', 'body_sha256', 'delivery_id', 'flow_id', 'id', 'last_attempt_at',
      'org_id', 'partner_id', 'received_at', 'refusal_code', 'resolver_value', 'run_id', 'signature_digest', 'status',
    ]);
  });

  it('flow_usage_counters declares every column', () => {
    expect([...columnsOf(flowUsageCounters).keys()].sort()).toEqual([
      'flow_id', 'id', 'org_id', 'partner_id', 'period_key', 'runs', 'updated_at',
    ]);
  });

  it('partner_id is NOT NULL and org_id nullable on both (connection_health_incidents shape)', () => {
    for (const table of [flowWebhookDeliveries, flowUsageCounters]) {
      const cols = columnsOf(table);
      expect(cols.get('partner_id')?.notNull, getTableConfig(table).name).toBe(true);
      expect(cols.get('org_id')?.notNull, getTableConfig(table).name).toBe(false);
    }
  });

  it('neither table has a device, site or ticket column', () => {
    for (const table of [flowWebhookDeliveries, flowUsageCounters]) {
      const names = [...columnsOf(table).keys()];
      for (const forbidden of ['device_id', 'site_id', 'ticket_id']) expect(names).not.toContain(forbidden);
    }
  });

  it('a delivery row never stores a body', () => {
    const names = [...columnsOf(flowWebhookDeliveries).keys()];
    for (const forbidden of ['body', 'payload', 'headers', 'raw_body']) expect(names).not.toContain(forbidden);
  });
});

describe('W5 columns on existing tables (#5220 A2)', () => {
  it('flows gains the webhook secret, auth-failure and admission-refusal columns', () => {
    const cols = getTableColumns(flows);
    for (const k of [
      'webhookSecretEncrypted', 'webhookSecretFingerprint', 'webhookSecretRotatedAt', 'webhookLastAuthFailureAt',
      'webhookLastAuthFailureReason', 'lastAdmissionRefusalAt', 'lastAdmissionRefusalCode',
    ]) expect(cols, k).toHaveProperty(k);
  });

  it('flow_runs gains ai_tokens_used, parent_agent_run_id and triggered_by_api_key_id', () => {
    const cols = columnsOf(flowRuns);
    expect(cols.get('ai_tokens_used')?.notNull).toBe(true);
    expect(cols.get('parent_agent_run_id')?.notNull).toBe(false);
    expect(cols.get('triggered_by_api_key_id')?.notNull).toBe(false);
  });

  it('flow_run_steps gains nullable ai usage columns', () => {
    const cols = columnsOf(flowRunSteps);
    for (const k of ['ai_input_tokens', 'ai_output_tokens', 'ai_cost_cents']) expect(cols.get(k)?.notNull, k).toBe(false);
  });

  it('action_intents gains invoked_flow_id and ai_invocations gains flow_run_id', () => {
    expect(columnsOf(actionIntents).get('invoked_flow_id')?.notNull).toBe(false);
    expect(columnsOf(aiInvocations).get('flow_run_id')?.notNull).toBe(false);
  });
});
