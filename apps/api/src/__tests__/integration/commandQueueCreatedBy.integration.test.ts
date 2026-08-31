/**
 * Real-Postgres coverage for `device_commands.created_by` attribution at the
 * `queueCommand` insert site (#3978).
 *
 * `queueCommand` used to stamp `createdBy: userId || null` verbatim. Two
 * synthetic-auth classes reach it with a `userId` that is NOT a `users` row —
 * `ai_agent` principals (`buildAgentAuthContext` sets `auth.user.id` to the
 * agent's `ai_agents` id) and helper sessions (`auth.user.id` IS the device
 * id) — so the insert died on the `device_commands_created_by_users_id_fk`
 * foreign key with SQLSTATE 23503. For an agent-released intent that lands
 * AFTER a human approved the action, at execution time.
 *
 * Only a real database can prove this: the FK lives in Postgres, so a mocked
 * unit suite can assert the value handed to `.values()` but can never observe
 * the 23503 the guard exists to prevent. Hence this suite.
 *
 * The `human attribution` tests guard the OTHER failure mode — a fix that stops
 * the 23503 but silently destroys real attribution. The probe reads `users`,
 * which is RLS-protected:
 *
 *   breeze_has_partner_access(partner_id)
 *   OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *   OR id = breeze_current_user_id()
 *
 * A guard that probes inside the CALLER's context (the obvious fix —
 * `withSystemDbAccessContext` alone is a no-op when a context is already open,
 * because `withDbAccessContext` short-circuits on an existing store) sees zero
 * rows for a partner-level user (`org_id IS NULL`) when the caller context is
 * org-scoped with `userId: null` — the shape `dbAccessContextFromAuth` builds
 * for an `ai_agent` principal. That fix would degrade a REAL human to
 * `created_by NULL` and still pass an agent-only test suite.
 *
 * BE PRECISE ABOUT WHICH TEST CATCHES THAT. Measured against a naive
 * `withSystemDbAccessContext`-only implementation, 8 of these 9 tests still
 * pass; the ONLY one that fails is
 *   'a partner-level human keeps their id when queued inside an org-scoped,
 *    user-less context'
 * because it is the only case that opens an org-scoped caller context AND uses
 * a user invisible within it. The sibling contextless-dispatch test does NOT
 * cover this (with no ambient store, `withSystemDbAccessContext` opens a real
 * system context and behaves correctly). Do not prune that test as redundant —
 * it is the whole regression guard for the context-escape half of the fix.
 *
 * Run:
 *   pnpm test-stack up            # from repo root
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/commandQueueCreatedBy.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiAgents, deviceCommands, devices } from '../../db/schema';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

// `list_processes` is deliberately NOT in AUDITED_COMMANDS, so queueCommand
// takes its short path: the users probe is the only SELECT and no audit row is
// written. That keeps each assertion about created_by and nothing else.
const UNAUDITED_TYPE = CommandTypes.LIST_PROCESSES;

interface Fixture {
  partnerId: string;
  orgId: string;
  /** A conventional org-scoped human: `users.org_id` is set. */
  orgUserId: string;
  /**
   * A partner-level human (`users.org_id IS NULL`) — an MSP tech operating
   * inside a customer org. Invisible to an org-scoped RLS probe that has no
   * `breeze.user_id` set, which is what makes it the discriminating fixture.
   */
  partnerUserId: string;
  deviceId: string;
  /** An `ai_agents` row id — a valid uuid that is NOT a `users` row. */
  aiAgentId: string;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const orgUser = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `org-user-${randomUUID()}@example.test`,
  });
  const partnerUser = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `partner-user-${randomUUID()}@example.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `test-agent-${unique}`,
        hostname: `test-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning(),
  );

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: `Test Agent ${unique}`,
        createdBy: orgUser.id,
      })
      .returning(),
  );

  if (!device || !agent) {
    throw new Error('fixture seeding failed: device and ai_agent rows are required');
  }

  return {
    partnerId: partner.id,
    orgId: org.id,
    orgUserId: orgUser.id,
    partnerUserId: partnerUser.id,
    deviceId: device.id,
    aiAgentId: agent.id,
  };
}

/** Read the persisted column back, not the value queueCommand returned. */
async function persistedCreatedBy(commandId: string): Promise<string | null> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ createdBy: deviceCommands.createdBy })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1),
  );
  if (!row) {
    throw new Error(`no device_commands row persisted for command ${commandId}`);
  }
  return row.createdBy;
}

/**
 * The org-scoped, user-less context every BullMQ worker and every agent run
 * executes under (`agentDbAccessContext` builds exactly this shape).
 */
function orgScopedWorkerContext(fx: Fixture) {
  return {
    scope: 'organization' as const,
    orgId: fx.orgId,
    accessibleOrgIds: [fx.orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: fx.partnerId,
  };
}

describe('queueCommand created_by attribution (#3978)', () => {
  let fx: Fixture;

  // setup.ts TRUNCATEs every table between tests, so fixtures are per-test.
  beforeEach(async () => {
    fx = await seed();
  });

  describe('synthetic principals must not violate the users FK', () => {
    it('an ai_agent id degrades to created_by NULL instead of raising 23503', async () => {
      // Pre-fix this THROWS with SQLSTATE 23503 on
      // device_commands_created_by_users_id_fk — the failure an operator would
      // see after already approving the intent.
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, { filter: 'x' }, fx.aiAgentId);

      expect(await persistedCreatedBy(command.id)).toBeNull();
    });

    it('an ai_agent id still degrades when dispatched inside the agent run DB context', async () => {
      // The real agent path: the tool handler runs inside the run's org-scoped
      // context, so the probe must escape it to reach `users` at all.
      const command = await withDbAccessContext(orgScopedWorkerContext(fx), () =>
        queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.aiAgentId),
      );

      expect(await persistedCreatedBy(command.id)).toBeNull();
    });

    it('a helper session (userId === deviceId) degrades to created_by NULL', async () => {
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.deviceId);

      expect(await persistedCreatedBy(command.id)).toBeNull();
    });

    it('an unknown uuid that matches no users row degrades to created_by NULL', async () => {
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, randomUUID());

      expect(await persistedCreatedBy(command.id)).toBeNull();
    });

    it('no userId at all stays NULL (system/worker dispatch)', async () => {
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, {});

      expect(await persistedCreatedBy(command.id)).toBeNull();
    });
  });

  describe('human attribution must survive the guard', () => {
    it('an org-scoped human keeps their real user id', async () => {
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.orgUserId);

      expect(await persistedCreatedBy(command.id)).toBe(fx.orgUserId);
    });

    it('a partner-level human (org_id IS NULL) keeps their id from a contextless worker dispatch', async () => {
      // No DB context at all — the BullMQ shape. Under forced RLS every branch
      // of the users SELECT policy denies here, so a probe that does not open a
      // system context reads zero rows and wrongly degrades this real human.
      const command = await queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.partnerUserId);

      expect(await persistedCreatedBy(command.id)).toBe(fx.partnerUserId);
    });

    it('a partner-level human keeps their id when queued inside an org-scoped, user-less context', async () => {
      // LOAD-BEARING — the single test in this file that fails against a naive
      // `withSystemDbAccessContext`-without-`runOutsideDbContext` guard (see the
      // file header). `withSystemDbAccessContext` alone short-circuits to the
      // caller's org-scoped context here, and this user has org_id NULL with no
      // breeze.user_id set, so a naive guard silently returns NULL. If this test
      // is ever deleted as "duplicate" of the contextless case, the context
      // escape becomes untested.
      const command = await withDbAccessContext(orgScopedWorkerContext(fx), () =>
        queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.partnerUserId),
      );

      expect(await persistedCreatedBy(command.id)).toBe(fx.partnerUserId);
    });

    it('an org-scoped human keeps their id when queued inside an org-scoped context', async () => {
      const command = await withDbAccessContext(orgScopedWorkerContext(fx), () =>
        queueCommand(fx.deviceId, UNAUDITED_TYPE, {}, fx.orgUserId),
      );

      expect(await persistedCreatedBy(command.id)).toBe(fx.orgUserId);
    });
  });
});
