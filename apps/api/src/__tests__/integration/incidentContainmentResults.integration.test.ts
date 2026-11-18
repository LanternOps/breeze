/**
 * Real-Postgres coverage for the execute_containment finalizer (#9662).
 *
 * The unit tests mock the query builder, so they cannot see the predicates
 * that decide which action row a command outcome may move: the
 * `result->>'commandId'` match, the open-status compare-and-set, the
 * server-timeout repair branch, and RLS on incident_actions / incidents. This
 * suite runs the finalizer through the production `db` pool as `breeze_app`
 * inside `withDbAccessContext`, the same shape as the agent-result transport
 * (device-org context), so forced RLS genuinely applies.
 *
 * Seeding uses the superuser pool (`getTestDb()`); setup.ts TRUNCATEs tenant
 * tables before each test, so every case re-seeds.
 *
 * DEFERRED locally when no integration Postgres is reachable: `it.runIf` gates
 * every case on DATABASE_URL.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { incidentActions, incidents } from '../../db/schema';
import { finalizeContainmentAction, type ContainmentOutcome } from '../../services/incidentContainmentResults';

// The post-commit event publish needs Redis; it is not what this suite tests.
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn(async () => 'evt') }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: null,
      userId: null,
      currentPartnerId: null,
    },
    fn,
  );
}

type Seeded = { orgId: string; incidentId: string; actionId: string; commandId: string };

async function seed(opts: {
  actionStatus?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  incidentStatus?: 'detected' | 'analyzing' | 'contained' | 'recovering' | 'closed';
} = {}): Promise<Seeded> {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const commandId = crypto.randomUUID();
  const [incident] = await db.insert(incidents).values({
    orgId: org.id,
    title: 'Suspicious process',
    classification: 'malware',
    severity: 'p2',
    status: opts.incidentStatus ?? 'detected',
    detectedAt: new Date('2026-10-22T10:00:00Z'),
    timeline: [{ at: '2026-10-22T10:00:00.000Z', type: 'created', actor: 'brain', summary: 'created' }],
  }).returning({ id: incidents.id });
  const [action] = await db.insert(incidentActions).values({
    incidentId: incident!.id,
    orgId: org.id,
    actionType: 'process_kill',
    description: 'Containment: process_kill on device d-1',
    executedBy: 'brain',
    status: opts.actionStatus ?? 'in_progress',
    result: opts.result ?? { commandId },
    executedAt: new Date('2026-10-22T10:01:00Z'),
  }).returning({ id: incidentActions.id });
  return { orgId: org.id, incidentId: incident!.id, actionId: action!.id, commandId };
}

async function readBack(s: Seeded) {
  const db = getTestDb();
  const [action] = await db.select().from(incidentActions).where(eq(incidentActions.id, s.actionId));
  const [incident] = await db.select().from(incidents).where(eq(incidents.id, s.incidentId));
  return { action: action!, incident: incident! };
}

const COMPLETED: ContainmentOutcome = { kind: 'agent', status: 'completed', output: { pid: 4242, killed: true } };
const TIMEOUT: ContainmentOutcome = { kind: 'timeout', error: 'Server-side timeout: no response from agent' };
const AT = new Date('2026-10-22T10:05:00Z');

function finalize(s: Seeded, outcome: ContainmentOutcome, orgId = s.orgId) {
  return orgContext(orgId, () => finalizeContainmentAction({
    commandId: s.commandId,
    payload: { incidentId: s.incidentId, actionType: 'process_kill' },
    outcome,
    completedAt: AT,
  }));
}

describe('finalizeContainmentAction (real Postgres, #9662)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  runDb('a completed agent result completes the action and contains the incident', async () => {
    const s = await seed();
    expect(await finalize(s, COMPLETED)).toBe('applied');

    const { action, incident } = await readBack(s);
    expect(action.status).toBe('completed');
    expect(action.result).toMatchObject({ commandId: s.commandId, commandStatus: 'completed', output: { pid: 4242 } });
    expect(incident.status).toBe('contained');
    expect(incident.containedAt?.toISOString()).toBe(AT.toISOString());
    expect(incident.timeline).toHaveLength(2);
    expect(incident.timeline[1]).toMatchObject({ type: 'containment_executed', metadata: { actionId: s.actionId } });
  });

  runDb('only matches the action carrying this command id', async () => {
    const s = await seed({ result: { commandId: crypto.randomUUID() } });
    expect(await finalize(s, COMPLETED)).toBe('no_action');

    const { action, incident } = await readBack(s);
    expect(action.status).toBe('in_progress');
    expect(incident.status).toBe('detected');
  });

  runDb('a server timeout fails the action, and a late real success repairs it', async () => {
    const s = await seed();
    expect(await finalize(s, TIMEOUT)).toBe('applied');
    let { action, incident } = await readBack(s);
    expect(action.status).toBe('failed');
    expect(action.result).toMatchObject({ timedOutBy: 'server' });
    expect(incident.status).toBe('detected');

    expect(await finalize(s, COMPLETED)).toBe('applied');
    ({ action, incident } = await readBack(s));
    expect(action.status).toBe('completed');
    expect(action.result).not.toHaveProperty('timedOutBy');
    expect(incident.status).toBe('contained');
    expect(incident.timeline.map((e) => e.type)).toEqual(['created', 'containment_failed', 'containment_executed']);
  });

  runDb('a timeout never overwrites a real answer', async () => {
    const s = await seed();
    await finalize(s, COMPLETED);
    expect(await finalize(s, TIMEOUT)).toBe('no_action');
    expect((await readBack(s)).action.status).toBe('completed');
  });

  runDb('an agent-reported failure is final: a duplicate success cannot flip it', async () => {
    const s = await seed();
    await finalize(s, { kind: 'agent', status: 'failed', error: 'process not found' });
    expect(await finalize(s, COMPLETED)).toBe('no_action');

    const { action, incident } = await readBack(s);
    expect(action.status).toBe('failed');
    expect(incident.status).toBe('detected');
  });

  runDb('a cancelled action is not resurrected by a late result', async () => {
    const s = await seed();
    await finalize(s, { kind: 'cancelled', error: 'Cancelled before the device received it' });
    expect((await readBack(s)).action.status).toBe('cancelled');
    expect(await finalize(s, COMPLETED)).toBe('no_action');
    expect((await readBack(s)).action.status).toBe('cancelled');
  });

  runDb('another org context cannot finalize the action (RLS)', async () => {
    const s = await seed();
    const other = await seed();
    expect(await finalize(s, COMPLETED, other.orgId)).toBe('no_action');

    const { action, incident } = await readBack(s);
    expect(action.status).toBe('in_progress');
    expect(incident.status).toBe('detected');
  });

  runDb('a success does not re-contain a closed incident', async () => {
    const s = await seed({ incidentStatus: 'closed' });
    expect(await finalize(s, COMPLETED)).toBe('applied');
    const { action, incident } = await readBack(s);
    expect(action.status).toBe('completed');
    expect(incident.status).toBe('closed');
    expect(incident.containedAt).toBeNull();
  });

  runDb('runs under the system context the reaper uses', async () => {
    const s = await seed();
    const outcome = await withSystemDbAccessContext(() => finalizeContainmentAction({
      commandId: s.commandId,
      payload: { incidentId: s.incidentId },
      outcome: TIMEOUT,
      completedAt: AT,
    }));
    expect(outcome).toBe('applied');
    expect((await readBack(s)).action.status).toBe('failed');
  });
});
