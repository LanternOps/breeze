/**
 * Live-Postgres behavioral coverage for the `trigger_kind`/`trigger_ref_id`/
 * `trigger_key` CHECK constraints the W01 migration
 * (`2026-10-16-182900-remediation-trigger-provenance.sql`) added on
 * `action_intents`, `script_executions`, and `automation_action_results`:
 *
 *   - `<table>_trigger_kind_chk`  — `trigger_kind` must be NULL or one of the
 *     eleven `REMEDIATION_TRIGGER_KINDS` values.
 *   - `<table>_trigger_shape_chk` — a `trigger_ref_id`/`trigger_key` without a
 *     `trigger_kind` is an unreadable half-record; both must be NULL unless
 *     `trigger_kind` is set.
 *
 * Review fix (PR #5780, "CHECK constraints have no runtime coverage") — the
 * migration and the Drizzle schema both declare these, but nothing before
 * this file executed an actual violating INSERT against a real database, so
 * a typo'd CHECK expression or a dropped constraint would have shipped green.
 *
 * Same fixture-per-test posture as the sibling
 * `actionIntentsImmutabilityTrigger.integration.test.ts`: the shared setup
 * TRUNCATEs core tenant tables in a global `beforeEach`, so every case seeds
 * its own partner/org/device from scratch via `db-utils.ts`'s helpers, which
 * write through `getTestDb()` — the privileged, RLS-bypassing test
 * connection also used by `automationTerminalReconciliation.integration.test.ts`
 * for the same tables. CHECK constraints are enforced by Postgres
 * independently of role/RLS, so bypassing RLS here removes noise without
 * weakening what's being proven.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  actionIntents,
  automationActionResults,
  automationRuns,
  devices,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

interface Fixture {
  orgId: string;
  partnerId: string;
  deviceId: string;
  userId: string;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `trigger-check-${unique}@example.test`,
  });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `trigger-check-agent-${unique}`,
    hostname: `trigger-check-host-${unique}`,
    osType: 'linux',
    osVersion: '22.04',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();
  if (!device) throw new Error('fixture seeding failed');
  return { orgId: org.id, partnerId: partner.id, deviceId: device.id, userId: user.id };
}

/** A SQLSTATE-bearing error, however postgres-js/drizzle wraps it — some
 *  paths put the code directly on the thrown error, others nest it one level
 *  under `.cause` (same posture as the sibling immutability suite). */
function sqlState(err: unknown): string | undefined {
  const direct = (err as { code?: string })?.code;
  if (direct) return direct;
  return ((err as { cause?: { code?: string } })?.cause)?.code;
}

async function expectCheckViolation(insert: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await insert;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a CHECK constraint violation').toBeDefined();
  expect(sqlState(caught)).toBe('23514');
}

describe('remediation trigger CHECK constraints (live DB)', () => {
  describe('action_intents', () => {
    function baseValues(fx: Fixture, overrides: Partial<NewActionIntent>): NewActionIntent {
      const sfx = randomUUID().slice(0, 8);
      return {
        orgId: fx.orgId,
        partnerId: fx.partnerId,
        // Exactly one actor (action_intents_one_actor_chk is a three-way
        // XOR over user/api-key/agent-run) — a human, chat-originated
        // intent is the simplest shape that satisfies it without also
        // needing an `api_keys`/`ai_agent_runs` fixture row.
        requestedByUserId: fx.userId,
        requestingApiKeyId: null,
        requestingAgentRunId: null,
        source: 'chat',
        originPrincipalKind: 'user_session',
        originPrincipalId: null,
        actionName: 'm365.mailbox.disable',
        actionVersion: 1,
        arguments: { mailbox: 'user@example.com' },
        argumentDigest: 'a'.repeat(64),
        targetSummary: 'Disable mailbox user@example.com',
        impactSummary: 'User loses mailbox access immediately',
        reason: 'Offboarding',
        riskTier: 3,
        connectionId: randomUUID(),
        tenantId: randomUUID(),
        idempotencyKey: `idem-${sfx}`,
        correlationId: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...overrides,
      };
    }

    it('rejects an invalid trigger_kind (action_intents_trigger_kind_chk)', async () => {
      const fx = await seedFixture();
      await expectCheckViolation(
        getTestDb().insert(actionIntents).values(
          baseValues(fx, { triggerKind: 'not_a_real_kind' as never }),
        ),
      );
    });

    it('rejects trigger_ref_id set with trigger_kind NULL (action_intents_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      await expectCheckViolation(
        getTestDb().insert(actionIntents).values(
          baseValues(fx, { triggerKind: null, triggerRefId: randomUUID() }),
        ),
      );
    });

    it('rejects trigger_key set with trigger_kind NULL (action_intents_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      await expectCheckViolation(
        getTestDb().insert(actionIntents).values(
          baseValues(fx, { triggerKind: null, triggerKey: 'alert:disk low' }),
        ),
      );
    });
  });

  describe('script_executions', () => {
    async function seedScript(fx: Fixture) {
      const unique = randomUUID().slice(0, 8);
      const [script] = await getTestDb().insert(scripts).values({
        orgId: fx.orgId,
        name: `Trigger check script ${unique}`,
        language: 'bash',
        osTypes: ['linux'],
        content: 'true',
      }).returning();
      if (!script) throw new Error('script seeding failed');
      return script.id;
    }

    it('rejects an invalid trigger_kind (script_executions_trigger_kind_chk)', async () => {
      const fx = await seedFixture();
      const scriptId = await seedScript(fx);
      await expectCheckViolation(
        getTestDb().insert(scriptExecutions).values({
          scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggerKind: 'not_a_real_kind' as never,
        }),
      );
    });

    it('rejects trigger_ref_id set with trigger_kind NULL (script_executions_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      const scriptId = await seedScript(fx);
      await expectCheckViolation(
        getTestDb().insert(scriptExecutions).values({
          scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggerKind: null,
          triggerRefId: randomUUID(),
        }),
      );
    });

    it('rejects trigger_key set with trigger_kind NULL (script_executions_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      const scriptId = await seedScript(fx);
      await expectCheckViolation(
        getTestDb().insert(scriptExecutions).values({
          scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggerKind: null,
          triggerKey: 'sweep:disk_pressure:C:',
        }),
      );
    });
  });

  describe('automation_action_results', () => {
    async function seedRun() {
      const [run] = await getTestDb().insert(automationRuns).values({
        triggeredBy: 'trigger-check-integration',
      }).returning();
      if (!run) throw new Error('automation run seeding failed');
      return run.id;
    }

    it('rejects an invalid trigger_kind (automation_action_results_trigger_kind_chk)', async () => {
      const fx = await seedFixture();
      const runId = await seedRun();
      await expectCheckViolation(
        getTestDb().insert(automationActionResults).values({
          runId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          actionIndex: 0,
          actionType: 'restart_service',
          triggerKind: 'not_a_real_kind' as never,
        }),
      );
    });

    it('rejects trigger_ref_id set with trigger_kind NULL (automation_action_results_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      const runId = await seedRun();
      await expectCheckViolation(
        getTestDb().insert(automationActionResults).values({
          runId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          actionIndex: 0,
          actionType: 'restart_service',
          triggerKind: null,
          triggerRefId: randomUUID(),
        }),
      );
    });

    it('rejects trigger_key set with trigger_kind NULL (automation_action_results_trigger_shape_chk)', async () => {
      const fx = await seedFixture();
      const runId = await seedRun();
      await expectCheckViolation(
        getTestDb().insert(automationActionResults).values({
          runId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          actionIndex: 0,
          actionType: 'restart_service',
          triggerKind: null,
          triggerKey: 'automation:1',
        }),
      );
    });
  });
});
