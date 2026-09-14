import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #4209 (W03) — the autonomous private-note lane's load-bearing invariants.
 *
 * Every assertion here is a security property, not a preference. Three of the
 * four were already true before this wave and none of them was pinned; in this
 * repo contract tests have caught that class of regression 5/5 where code
 * review caught it 0/5. If a change makes one of these fail, the change is
 * wrong — do not relax the assertion.
 *
 * The source-text assertions are deliberate: the properties are about what the
 * lane's code may NOT do (write a users FK, accept an isPublic parameter,
 * reach an actorFrom-based branch), and a behavioural test can only prove the
 * paths it happens to exercise. They are scoped to a single extracted function
 * body, never the whole file, so unrelated edits do not red them.
 */

const { dbState, killState, effectivePolicyState } = vi.hoisted(() => ({
  dbState: { runRow: null as Record<string, unknown> | null },
  killState: { killed: false, epoch: 0 },
  effectivePolicyState: {
    resolved: null as null | { agentId: string; effective: { mode: string; triggers: Record<string, unknown> } },
    /** `resolveEffectiveAgentSystem` really does throw (HTTPException on a missing org) — that is the gate_evaluation_failed path. */
    throws: false,
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (dbState.runRow ? [dbState.runRow] : [])),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema/aiAgents', () => ({
  aiAgentRuns: {
    id: { name: 'id' },
    agentId: { name: 'agent_id' },
    orgId: { name: 'org_id' },
    triggerKind: { name: 'trigger_kind' },
    policySnapshot: { name: 'policy_snapshot' },
  },
}));

vi.mock('../aiKillState', () => ({ readAiKillState: vi.fn(async () => killState) }));
vi.mock('./effectivePolicy', () => ({
  resolveEffectiveAgentSystem: vi.fn(async () => {
    if (effectivePolicyState.throws) throw new Error('organization not found');
    return effectivePolicyState.resolved;
  }),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import {
  evaluateTicketAutonomy,
  type EvaluateTicketAutonomyArgs,
  type TicketAutonomyDenialReason,
} from '../actionIntents/ticketAutonomy';

const ORG = 'org-1';
const RUN = 'run-1';
const AGENT = 'agent-1';
const TICKET = 'ticket-1';
const DEVICE = 'device-1';

const SERVICES_DIR = resolve(__dirname, '..');
const MIGRATIONS_DIR = resolve(__dirname, '../../../migrations');

function readService(file: string): string {
  return readFileSync(resolve(SERVICES_DIR, file), 'utf8');
}

/**
 * Slices out one top-level `export async function <name>(` body by brace
 * counting from the opening `{` of the signature. Scoping every assertion to
 * one function is what keeps this contract from reacting to edits elsewhere in
 * a 2000-line service file.
 */
function extractFunction(src: string, name: string): string {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(signature);
  if (start < 0) throw new Error(`function ${name} not found`);
  // Walk the parameter list to its balanced close, then find the body's `{` —
  // skipping any `{` that belongs to a return-type annotation
  // (`: Promise<{ comment: { id: string } }>`), which is why a naive
  // indexOf('{', indexOf(')')) picks up the wrong brace here.
  const parenOpen = src.indexOf('(', start);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { parenClose = i; break; }
    }
  }
  if (parenClose < 0) throw new Error(`function ${name} has an unbalanced parameter list`);
  let angleDepth = 0;
  let bodyStart = -1;
  for (let i = parenClose + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === '{' && angleDepth === 0) { bodyStart = i; break; }
  }
  if (bodyStart < 0) throw new Error(`function ${name} has no body`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`function ${name} body is unbalanced`);
}

function liveRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN,
    agentId: AGENT,
    orgId: ORG,
    triggerKind: 'ticket',
    policySnapshot: { kind: 'helpdesk', effective: { mode: 'act', triggers: { ticketAutonomousWrites: true } } },
    ...overrides,
  };
}

function liveResolved(overrides: Partial<{ agentId: string; mode: string; ticketAutonomousWrites: boolean }> = {}) {
  return {
    agentId: overrides.agentId ?? AGENT,
    effective: {
      mode: overrides.mode ?? 'act',
      triggers: { ticketAutonomousWrites: overrides.ticketAutonomousWrites ?? true },
    },
  };
}

function grantingArgs(overrides: Partial<EvaluateTicketAutonomyArgs> = {}): EvaluateTicketAutonomyArgs {
  return {
    requestedAutonomyKind: 'ticket_autonomy',
    principalKind: 'ai_agent',
    agentRunId: RUN,
    orgId: ORG,
    scope: { ticketId: TICKET },
    ...overrides,
  };
}

describe('autonomous private-note lane contract (#4209)', () => {
  beforeEach(() => {
    dbState.runRow = liveRunRow();
    killState.killed = false;
    effectivePolicyState.resolved = liveResolved();
    effectivePolicyState.throws = false;
  });

  it('addAiTriageNote never writes a users FK', () => {
    const fn = extractFunction(readService('ticketService.ts'), 'addAiTriageNote');
    expect(fn).toMatch(/userId:\s*null/);
    expect(fn).toMatch(/portalUserId:\s*null/);
    expect(fn).not.toMatch(/userId:\s*actor/);
  });

  it('addAiTriageNote hardcodes isPublic false and takes no isPublic parameter', () => {
    const src = readService('ticketService.ts');
    const fn = extractFunction(src, 'addAiTriageNote');
    expect(fn).toMatch(/isPublic:\s*false/);
    expect(fn).not.toMatch(/isPublic:\s*\w+\.isPublic/);
    // The signature itself must not grow an isPublic input — a caller-supplied
    // flag is exactly what the DB CHECK below exists to make unreachable.
    const signature = src.slice(src.indexOf('function addAiTriageNote'), src.indexOf('{', src.indexOf('function addAiTriageNote')));
    expect(signature).not.toMatch(/isPublic/);
  });

  it('addAiTriageNote leaves an ai_agent audit row naming the run', () => {
    const fn = extractFunction(readService('ticketService.ts'), 'addAiTriageNote');
    expect(fn).toMatch(/createAuditLogAsync\(/);
    expect(fn).toMatch(/actorType:\s*'ai_agent'/);
    expect(fn).toMatch(/actorId:\s*runId/);
  });

  it('manage_tickets refuses the three users-FK actions for an agent principal', () => {
    const src = readService('aiToolsTicketing.ts');
    for (const action of ['create', 'assign', 'update_status'] as const) {
      const branch = src.slice(src.indexOf(`if (action === '${action}') {`));
      // The deny must be the FIRST statement of the branch — after any DB read
      // it would still be correct, but a later refactor could slip a write in
      // ahead of it.
      expect(branch.slice(0, 200)).toMatch(/if \(agentRunIdFrom\(auth\)\) return refuseAgentPrincipal\(action\);/);
    }
    expect(src).toMatch(/error:\s*'agent_principal_unsupported_action'/);
  });

  it('the migration carries the database-level private CHECK', () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_DIR, '2026-10-16-183100-ticket-comment-agent-note-private-chk.sql'),
      'utf8',
    );
    expect(sql).toContain('ticket_comments_agent_note_private_chk');
    expect(sql).toMatch(/origin_principal_kind\s*<>\s*'ai_agent'\s*OR\s*is_public\s*=\s*false/);
    // A NOT VALID constraint would not check the rows already in the table.
    // Comment lines are stripped first — the file's own header explains why
    // NOT VALID was rejected, and that prose must not satisfy the assertion.
    const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/NOT\s+VALID/i);
  });

  it('evaluateTicketAutonomy grants only when all five gates hold', async () => {
    await expect(evaluateTicketAutonomy(grantingArgs())).resolves.toEqual({ granted: true });
  });

  it('evaluateTicketAutonomy still denies on every one of its documented reasons', async () => {
    const cases: Array<[() => EvaluateTicketAutonomyArgs, TicketAutonomyDenialReason, () => void]> = [
      [() => grantingArgs({ requestedAutonomyKind: undefined }), 'not_requested', () => {}],
      [() => grantingArgs({ principalKind: 'user_session' }), 'not_agent_run', () => {}],
      [() => grantingArgs({ scope: { deviceId: DEVICE } }), 'scope_not_ticket', () => {}],
      [() => grantingArgs(), 'not_agent_run', () => { dbState.runRow = null; }],
      [() => grantingArgs(), 'run_not_ticket_triggered', () => { dbState.runRow = liveRunRow({ triggerKind: 'alert' }); }],
      [
        () => grantingArgs(),
        'run_snapshot_not_authorized',
        () => {
          dbState.runRow = liveRunRow({
            policySnapshot: { kind: 'helpdesk', effective: { mode: 'suggest', triggers: { ticketAutonomousWrites: true } } },
          });
        },
      ],
      [() => grantingArgs(), 'live_policy_not_authorized', () => { effectivePolicyState.resolved = liveResolved({ ticketAutonomousWrites: false }); }],
      [() => grantingArgs(), 'kill_switch_engaged', () => { killState.killed = true; }],
      [() => grantingArgs(), 'gate_evaluation_failed', () => { effectivePolicyState.throws = true; }],
    ];

    const seen = new Set<TicketAutonomyDenialReason>();
    for (const [args, reason, arrange] of cases) {
      dbState.runRow = liveRunRow();
      killState.killed = false;
      effectivePolicyState.resolved = liveResolved();
      effectivePolicyState.throws = false;
      arrange();
      await expect(evaluateTicketAutonomy(args())).resolves.toEqual({ granted: false, reason });
      seen.add(reason);
    }

    // Every documented denial reason must be exercised — a new reason added to
    // the union without a case here means the gate grew an untested path.
    expect([...seen].sort()).toEqual([
      'gate_evaluation_failed',
      'kill_switch_engaged',
      'live_policy_not_authorized',
      'not_agent_run',
      'not_requested',
      'run_not_ticket_triggered',
      'run_snapshot_not_authorized',
      'scope_not_ticket',
    ]);
  });
});
