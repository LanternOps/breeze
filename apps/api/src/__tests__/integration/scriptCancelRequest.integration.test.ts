/**
 * Real-Postgres coverage for the REQUEST side of script cancellation (#3525
 * W02b) — specifically the property no mocked suite can observe:
 *
 *   by the time `cancelScriptExecution` returns, the `script_cancel` row is
 *   COMMITTED and visible to a different connection.
 *
 * Why only a real database can prove it. `authMiddleware` wraps every request
 * handler in ONE `withDbAccessContext` transaction, so a bare
 * `db.transaction(...)` inside a service is only a SAVEPOINT — it commits
 * nothing. A cancel written that way looks perfect in unit tests (the mock
 * `db.transaction` resolves, the row "exists") and is invisible in production
 * to the agent's ack lookup, which reads on a fresh snapshot in
 * `routes/agentWs.ts` and routes an unmatched ack as ORPHANED. The service
 * therefore escapes the request context deliberately
 * (`inDeliberateSystemContext`), and this suite is the guard on that escape:
 * point it back at the ambient transaction and the visibility assertions below
 * fail, while every unit test still passes.
 *
 * The wire-contract assertion is duplicated from the unit suite on purpose: it
 * is the one field whose corruption is a fleet-wide silent no-op, so it is
 * worth pinning against the real jsonb column as well as the mock.
 *
 * Run:
 *   pnpm test-stack up            # from repo root
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/scriptCancelRequest.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, scriptExecutions, scripts } from '../../db/schema';
import { cancelScriptExecution } from '../../services/scriptCancellation';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  deviceId: string;
  scriptId: string;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `cancel-user-${randomUUID()}@example.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `cancel-agent-${unique}`,
      hostname: `cancel-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    }).returning(),
  );

  const [script] = await withSystemDbAccessContext(() =>
    db.insert(scripts).values({
      orgId: org.id,
      name: `Long sleep ${unique}`,
      language: 'bash',
      osTypes: ['linux'],
      content: 'sleep 120',
      createdBy: user.id,
    }).returning(),
  );

  if (!device || !script) throw new Error('fixture seeding failed');

  return {
    partnerId: partner.id,
    orgId: org.id,
    userId: user.id,
    deviceId: device.id,
    scriptId: script.id,
  };
}

/**
 * An execution paired with its originating `script` command, exactly as
 * `scriptDispatch` writes them.
 */
async function seedRun(
  fx: Fixture,
  commandStatus: 'pending' | 'sent',
  executionStatus: 'running' | 'queued' = 'running',
): Promise<{ executionId: string; commandId: string }> {
  const [execution] = await withSystemDbAccessContext(() =>
    db.insert(scriptExecutions).values({
      scriptId: fx.scriptId,
      deviceId: fx.deviceId,
      orgId: fx.orgId,
      triggeredBy: fx.userId,
      status: executionStatus,
    }).returning(),
  );
  if (!execution) throw new Error('execution seeding failed');

  const [command] = await withSystemDbAccessContext(() =>
    db.insert(deviceCommands).values({
      deviceId: fx.deviceId,
      type: 'script',
      status: commandStatus,
      payload: { executionId: execution.id, scriptId: fx.scriptId },
      createdBy: fx.userId,
    }).returning(),
  );
  if (!command) throw new Error('command seeding failed');

  return { executionId: execution.id, commandId: command.id };
}

/** The org-scoped request context authMiddleware builds and HOLDS for the turn. */
function requestContext(fx: Fixture) {
  return {
    scope: 'organization' as const,
    orgId: fx.orgId,
    accessibleOrgIds: [fx.orgId],
    accessiblePartnerIds: [],
    userId: fx.userId,
    currentPartnerId: fx.partnerId,
  };
}

/**
 * Read a row from a transaction that is NOT the caller's. This is the
 * production reader's position: the agent WS handles an ack on a different
 * connection, so anything still uncommitted is invisible to it.
 */
async function readFromAnotherTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

describe('cancelScriptExecution against real Postgres (#3525 W02b)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  it('commits the script_cancel before returning, so a concurrent reader can see it', async () => {
    const { executionId, commandId } = await seedRun(fx, 'sent');

    await withDbAccessContext(requestContext(fx), async () => {
      const outcome = await cancelScriptExecution({
        executionId,
        actorId: fx.userId,
        actorLabel: 'tech@msp.example',
      });
      expect(outcome.kind).toBe('cancelling');
      if (outcome.kind !== 'cancelling') return;

      // STILL INSIDE the request transaction. A savepoint-only implementation
      // has written nothing another connection can see, and the agent's ack
      // would be routed as orphaned.
      const [cancelCommand] = await readFromAnotherTransaction(() =>
        db
          .select({
            id: deviceCommands.id,
            type: deviceCommands.type,
            status: deviceCommands.status,
            payload: deviceCommands.payload,
          })
          .from(deviceCommands)
          .where(eq(deviceCommands.id, outcome.cancelCommandId))
          .limit(1),
      );

      expect(cancelCommand).toBeDefined();
      expect(cancelCommand!.type).toBe('script_cancel');
      expect(cancelCommand!.status).toBe('pending');

      // THE WIRE CONTRACT: the agent keys its running-process map on the
      // ORIGINAL command's id. script_executions.id here is a silent no-op on
      // every agent in the fleet.
      const payload = cancelCommand!.payload as Record<string, unknown>;
      expect(payload.executionId).toBe(commandId);
      expect(payload.executionId).not.toBe(executionId);
      expect(payload.scriptExecutionId).toBe(executionId);
      expect(payload.graceSeconds).toBe(5);

      // The execution's transition is committed on the same terms.
      const [row] = await readFromAnotherTransaction(() =>
        db
          .select({
            status: scriptExecutions.status,
            cancelState: scriptExecutions.cancelState,
            cancelPrevStatus: scriptExecutions.cancelPrevStatus,
            cancelCommandId: scriptExecutions.cancelCommandId,
            cancelledBy: scriptExecutions.cancelledBy,
            completedAt: scriptExecutions.completedAt,
          })
          .from(scriptExecutions)
          .where(eq(scriptExecutions.id, executionId))
          .limit(1),
      );
      expect(row).toMatchObject({
        status: 'cancelling',
        cancelState: 'requested',
        cancelPrevStatus: 'running',
        cancelCommandId: outcome.cancelCommandId,
        cancelledBy: fx.userId,
      });
      // Transient, not terminal: completed_at must stay NULL so no batch
      // counter and no automation action result closes on an unproven stop.
      expect(row!.completedAt).toBeNull();
    });
  });

  it('satisfies the cancel_state CHECK constraint on every write it makes', async () => {
    // script_executions_cancel_state_chk enforces
    // (cancel_state IS NULL) = (cancel_requested_at IS NULL). A branch that
    // sets one without the other aborts with 23514 in production only.
    const { executionId } = await seedRun(fx, 'sent');
    await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId, actorId: fx.userId, actorLabel: 'tech' }),
    );

    const [row] = await readFromAnotherTransaction(() =>
      db
        .select({
          cancelState: scriptExecutions.cancelState,
          cancelRequestedAt: scriptExecutions.cancelRequestedAt,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, executionId))
        .limit(1),
    );
    expect(row!.cancelState).not.toBeNull();
    expect(row!.cancelRequestedAt).not.toBeNull();
  });

  it('retracts an undelivered command and terminalises as cancelled/confirmed', async () => {
    const { executionId, commandId } = await seedRun(fx, 'pending', 'queued');

    const outcome = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId, actorId: fx.userId, actorLabel: 'tech@msp.example' }),
    );
    expect(outcome.kind).toBe('retracted');

    const [command] = await readFromAnotherTransaction(() =>
      db
        .select({ status: deviceCommands.status, result: deviceCommands.result })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, commandId))
        .limit(1),
    );
    expect(command!.status).toBe('cancelled');
    // Never the server-timeout marker: this row was never delivered, so
    // claiming a timeout would be a false statement about the device.
    expect((command!.result as Record<string, unknown>).status).toBe('cancelled');

    const [row] = await readFromAnotherTransaction(() =>
      db
        .select({
          status: scriptExecutions.status,
          cancelState: scriptExecutions.cancelState,
          completedAt: scriptExecutions.completedAt,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, executionId))
        .limit(1),
    );
    expect(row).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
    expect(row!.completedAt).not.toBeNull();

    // Nothing was queued for the device: the retraction IS the proof.
    const queued = await readFromAnotherTransaction(() =>
      db
        .select({ id: deviceCommands.id })
        .from(deviceCommands)
        .where(eq(deviceCommands.type, 'script_cancel')),
    );
    expect(queued).toHaveLength(0);
  });

  it('never queues a second cancel for the same original command', async () => {
    const { executionId } = await seedRun(fx, 'sent');

    const first = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId, actorId: fx.userId, actorLabel: 'tech' }),
    );
    expect(first.kind).toBe('cancelling');

    // The row is `cancelling` now, so a repeat is idempotent rather than a
    // second command. Force the dedup branch too by reverting the status the
    // way an unconfirmed ack would.
    await withSystemDbAccessContext(() =>
      db.update(scriptExecutions)
        .set({ status: 'running', cancelState: 'unconfirmed' })
        .where(eq(scriptExecutions.id, executionId)),
    );

    const second = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId, actorId: fx.userId, actorLabel: 'tech' }),
    );
    expect(second).toMatchObject({ kind: 'cancelling', alreadyQueued: true });

    const queued = await readFromAnotherTransaction(() =>
      db
        .select({ id: deviceCommands.id })
        .from(deviceCommands)
        .where(eq(deviceCommands.type, 'script_cancel')),
    );
    expect(queued).toHaveLength(1);
    expect((second as { cancelCommandId: string }).cancelCommandId).toBe(queued[0]!.id);
  });

  it('queues the cancel for an actor that is not a users row', async () => {
    // The AI-agent principal's id is an `ai_agents` id, so `resolveCancelledBy`
    // degrades it to NULL. `device_commands.created_by` is a nullable UUID —
    // passing an empty string instead of NULL is `22P02 invalid input syntax
    // for type uuid`, which rolls the whole transaction back and 500s the very
    // caller the degrade exists to keep working. Mocked suites cannot see this:
    // only Postgres types the column.
    const { executionId } = await seedRun(fx, 'sent');

    const outcome = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({
        executionId,
        actorId: randomUUID(), // a valid uuid that is NOT a users row
        actorLabel: 'AI assistant (agent@breeze.test)',
      }),
    );
    expect(outcome.kind).toBe('cancelling');

    const [cancelCommand] = await readFromAnotherTransaction(() =>
      db
        .select({ createdBy: deviceCommands.createdBy })
        .from(deviceCommands)
        .where(eq(deviceCommands.type, 'script_cancel'))
        .limit(1),
    );
    expect(cancelCommand!.createdBy).toBeNull();

    const [row] = await readFromAnotherTransaction(() =>
      db
        .select({ cancelledBy: scriptExecutions.cancelledBy, status: scriptExecutions.status })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, executionId))
        .limit(1),
    );
    expect(row).toMatchObject({ cancelledBy: null, status: 'cancelling' });
  });

  it('fails closed when the execution has no paired script command', async () => {
    const [execution] = await withSystemDbAccessContext(() =>
      db.insert(scriptExecutions).values({
        scriptId: fx.scriptId,
        deviceId: fx.deviceId,
        orgId: fx.orgId,
        triggeredBy: fx.userId,
        status: 'running',
      }).returning(),
    );

    const outcome = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId: execution!.id, actorId: fx.userId, actorLabel: 'tech' }),
    );
    expect(outcome).toEqual({ kind: 'inconsistent' });

    const [row] = await readFromAnotherTransaction(() =>
      db
        .select({ status: scriptExecutions.status, cancelState: scriptExecutions.cancelState })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, execution!.id))
        .limit(1),
    );
    // Absence is not proof that nothing ran — the row must be untouched.
    expect(row).toMatchObject({ status: 'running', cancelState: null });
  });

  it('does not collide with an unrelated command carrying the same executionId', async () => {
    const { executionId, commandId } = await seedRun(fx, 'sent');
    // A non-`script` command whose payload happens to name the same execution.
    // Today's route omits the type predicate and can pick this row instead.
    await withSystemDbAccessContext(() =>
      db.insert(deviceCommands).values({
        deviceId: fx.deviceId,
        type: 'list_processes',
        status: 'pending',
        payload: { executionId },
        createdBy: fx.userId,
      }),
    );

    const outcome = await withDbAccessContext(requestContext(fx), () =>
      cancelScriptExecution({ executionId, actorId: fx.userId, actorLabel: 'tech' }),
    );
    // Colliding with the pending decoy would have produced a `retracted`
    // outcome and a confirmed cancellation of a script that is still running.
    expect(outcome.kind).toBe('cancelling');

    const [cancelCommand] = await readFromAnotherTransaction(() =>
      db
        .select({ payload: deviceCommands.payload })
        .from(deviceCommands)
        .where(eq(deviceCommands.type, 'script_cancel'))
        .limit(1),
    );
    expect((cancelCommand!.payload as Record<string, unknown>).executionId).toBe(commandId);
  });
});
