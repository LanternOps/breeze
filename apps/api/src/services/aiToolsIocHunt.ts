/**
 * AI IOC hunting tool — `ioc_hunt` (#6263 W05, PR B; plan decision W05-7).
 *
 * One base-Tier-1 multiplexer over PR A's sweep services:
 *  - reads (Tier 1): `list_rule_sets`, `preview_sweep`, `list_sweeps`, `sweep_status`;
 *  - `cancel_sweep` (Tier 2);
 *  - `sweep` (Tier 3: supervised up to IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD
 *    expected devices, four-eyes above; effect-digest pinned) and
 *    `import_iocs` (Tier 3 supervised; refused into auto-quarantine sets).
 * Tiering, approval scope and permissions live in aiGuardrails.ts.
 *
 * SINGLE ORG. `preview_sweep` and `sweep` take `orgId` and resolve the scope
 * inside it: a released intent's auth is rebuilt for `intent.orgId` only, so a
 * cross-org AI sweep could not be released faithfully. Partner sweeps across
 * orgs are a UI/API action.
 *
 * Not agent-mintable: `ioc_hunt` is in AGENT_HUMAN_ONLY_TOOLS (Gate B 10).
 *
 * DB context: the reads run in the caller's context (`inToolDbPhase` joins a
 * held one or opens a short caller-scoped one). `sweep` and `cancel_sweep` are
 * `selfManagedDbContext`: PR A's `createSweep` / `cancelSweep` rate-limit on
 * Redis first and open their own transaction, so they refuse an ambient one.
 */
import { z } from 'zod';
import { securitySweepRequestSchema, type SecuritySweepRequest } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { requireAiOrigin } from './aiDispatch';
import { inToolDbPhase } from './aiToolDbContext';
import { approverReleaseMismatch } from './aiToolReleaseGuards';
import { cancelSweep, createSweep, getSweep, listSweeps, previewSweep } from './securityScanSweeps';
import type { ToolExecutionContext } from './toolExecutionContext';
import { topSweepRuleHits } from './securityScanSweepHits';
import { listVisibleRuleSets } from './yaraRuleSetAccess';

export const IOC_HUNT_ACTIONS = [
  'list_rule_sets',
  'preview_sweep',
  'list_sweeps',
  'sweep_status',
  'sweep',
  'cancel_sweep',
  'import_iocs',
] as const;

const DEFAULT_PAGE_LIMIT = 25;
const TOP_RULES = 10;
const uuid = z.string().guid();

type ToolResult = Record<string, unknown>;

const invalid = (detail: string): ToolResult => ({ error: 'invalid_input', detail });

function paging(input: Record<string, unknown>): { page: number; limit: number } {
  const page = Number.isInteger(input.page) && (input.page as number) >= 1 ? (input.page as number) : 1;
  const limit = Number.isInteger(input.limit) && (input.limit as number) >= 1
    ? Math.min(100, input.limit as number)
    : DEFAULT_PAGE_LIMIT;
  return { page, limit };
}

/** A service failure, surfaced with its machine code (never a stack or SQL). */
function failure(f: { status: number; code: string; detail?: Record<string, unknown> }): ToolResult {
  return { error: f.code, code: f.code, status: f.status, ...(f.detail ? { detail: f.detail } : {}) };
}

/**
 * The sweep request inside ONE org. `scope.kind === 'orgs'` is accepted only
 * when it names exactly `orgId`; every other kind is resolved by the service
 * inside `onlyOrgId`.
 */
export function parseSingleOrgRequest(
  input: Record<string, unknown>,
): { ok: true; orgId: string; request: SecuritySweepRequest } | { ok: false; result: ToolResult } {
  const orgId = uuid.safeParse(input.orgId);
  if (!orgId.success) return { ok: false, result: invalid('orgId (uuid) is required') };
  const candidate: Record<string, unknown> = {
    ruleSetIds: input.ruleSetIds,
    scope: input.scope,
    scanType: input.scanType,
  };
  if (input.paths !== undefined) candidate.paths = input.paths;
  if (input.ttlHours !== undefined) candidate.ttlHours = input.ttlHours;
  const parsed = securitySweepRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, result: invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')) };
  }
  const scope = parsed.data.scope;
  if (scope.kind === 'orgs' && !(scope.orgIds.length === 1 && scope.orgIds[0]!.toLowerCase() === orgId.data.toLowerCase())) {
    return {
      ok: false,
      result: {
        error: 'single_org_only',
        detail: 'An AI sweep runs inside one organization. Use scope { kind: "all" } with orgId, or start a multi-organization sweep from the Security page.',
      },
    };
  }
  return { ok: true, orgId: orgId.data, request: parsed.data };
}

async function listRuleSetsAction(input: Record<string, unknown>, auth: AuthContext): Promise<ToolResult> {
  let orgId: string | undefined;
  if (input.orgId !== undefined) {
    const parsed = uuid.safeParse(input.orgId);
    if (!parsed.success) return invalid('orgId must be a uuid');
    orgId = parsed.data;
  }
  const result = await inToolDbPhase(auth, () => listVisibleRuleSets(auth, { orgId, ...paging(input) }));
  return { ruleSets: result.data, total: result.total, page: result.page, limit: result.limit };
}

async function previewSweepAction(input: Record<string, unknown>, auth: AuthContext): Promise<ToolResult> {
  const parsed = parseSingleOrgRequest(input);
  if (!parsed.ok) return parsed.result;
  const result = await inToolDbPhase(auth, () => previewSweep(auth, parsed.request, { onlyOrgId: parsed.orgId }));
  if (!result.ok) return failure(result);
  const { preview } = result;
  return {
    orgId: parsed.orgId,
    orgName: preview.byOrg.find((o) => o.orgId === parsed.orgId)?.orgName ?? preview.byOrg[0]?.orgName ?? null,
    targeted: preview.targeted,
    skipped: preview.skipped,
    ruleSets: preview.ruleSets,
    previewDigest: preview.previewDigest,
    expectedDeviceCount: preview.targeted,
    next: 'To run it, call ioc_hunt sweep with the same orgId, ruleSetIds, scope, scanType and paths, plus this previewDigest and expectedDeviceCount.',
  };
}

async function listSweepsAction(input: Record<string, unknown>, auth: AuthContext): Promise<ToolResult> {
  let orgId: string | undefined;
  if (input.orgId !== undefined) {
    const parsed = uuid.safeParse(input.orgId);
    if (!parsed.success) return invalid('orgId must be a uuid');
    orgId = parsed.data;
  }
  const result = await inToolDbPhase(auth, () => listSweeps(auth, { ...(orgId ? { orgId } : {}), ...paging(input) }));
  return { sweeps: result.data, total: result.total, page: result.page, limit: result.limit };
}

async function sweepStatusAction(input: Record<string, unknown>, auth: AuthContext): Promise<ToolResult> {
  const sweepId = uuid.safeParse(input.sweepId);
  if (!sweepId.success) return invalid('sweepId (uuid) is required');
  return inToolDbPhase(auth, async () => {
    const sweep = await getSweep(auth, sweepId.data);
    if (!sweep) return { error: 'not_found' };
    const topRules = await topSweepRuleHits(auth, sweep, TOP_RULES);
    return {
      sweep,
      degraded: sweep.progress.degraded,
      threatsFound: sweep.progress.threatsFound,
      topRules,
    };
  });
}

/**
 * `sweep` (Tier 3). Reaches the handler only through a released intent, in chat
 * and over MCP; the approval card showed "up to expectedDeviceCount devices"
 * and the intent pinned previewDigest + the set bytes. createSweep re-resolves
 * the targets under the (rebuilt) auth and refuses SWEEP_SCOPE_CHANGED when
 * the preview no longer matches or would target more devices; it also stamps
 * origin / ai_origin / intent_id and writes the security.scan_sweep.create
 * audit rows, so this handler adds neither a second check nor a second row.
 * Runs with NO ambient DB context (selfManagedDbContext).
 */
async function sweepAction(
  input: Record<string, unknown>,
  auth: AuthContext,
  context: ToolExecutionContext | undefined,
): Promise<ToolResult> {
  const parsed = parseSingleOrgRequest(input);
  if (!parsed.ok) return parsed.result;
  const expected = input.expectedDeviceCount;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return invalid('expectedDeviceCount (the targeted count from preview_sweep) is required');
  }
  const previewDigest = typeof input.previewDigest === 'string' && /^[0-9a-f]{64}$/.test(input.previewDigest)
    ? input.previewDigest
    : null;
  if (!previewDigest) return invalid('previewDigest (from preview_sweep) is required');

  // Defence in depth: never write under an auth that is not the approver the
  // release path named (no such release exists for ioc_hunt today — it is in
  // AGENT_HUMAN_ONLY_TOOLS — but the guard costs nothing).
  if (approverReleaseMismatch(auth, context)) return { error: 'approver_auth_mismatch' };
  // A Tier-3 call reaches a handler only through an approved release, which
  // always names its intent. Fail closed rather than create an unapproved,
  // unattributed fleet sweep.
  if (!context?.actionIntentId) return { error: 'intent_required' };

  const result = await createSweep(
    auth,
    { ...parsed.request, previewDigest },
    {
      origin: context.intentSource === 'mcp_api' ? 'mcp' : 'ai_chat',
      aiOrigin: requireAiOrigin(auth, 'ioc_hunt'),
      intentId: context.actionIntentId,
      mfaSatisfied: false,
      onlyOrgId: parsed.orgId,
      expectedDeviceCount: expected,
    },
  );
  if (!result.ok) return failure(result);
  return { groupId: result.groupId, sweeps: result.sweeps };
}

/** `cancel_sweep` (Tier 2): queued scans are cancelled, running ones finish. No ambient DB context. */
async function cancelSweepAction(input: Record<string, unknown>, auth: AuthContext): Promise<ToolResult> {
  const sweepId = uuid.safeParse(input.sweepId);
  if (!sweepId.success) return invalid('sweepId (uuid) is required');
  const result = await cancelSweep(auth, sweepId.data);
  if (!result.ok) return { error: result.status === 404 ? 'not_found' : 'forbidden', status: result.status };
  return {
    sweeps: result.sweeps,
    cancelledQueued: result.cancelledQueued,
    cancelledUndelivered: result.cancelledUndelivered,
    stillRunning: result.stillRunning,
  };
}

async function handle(
  input: Record<string, unknown>,
  auth: AuthContext,
  context: ToolExecutionContext | undefined,
): Promise<ToolResult> {
  switch (input.action) {
    case 'list_rule_sets':
      return listRuleSetsAction(input, auth);
    case 'preview_sweep':
      return previewSweepAction(input, auth);
    case 'list_sweeps':
      return listSweepsAction(input, auth);
    case 'sweep_status':
      return sweepStatusAction(input, auth);
    case 'sweep':
      return sweepAction(input, auth, context);
    case 'cancel_sweep':
      return cancelSweepAction(input, auth);
    default:
      return { error: `Unknown action: ${String(input.action)}` };
  }
}

export function registerIocHuntTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('ioc_hunt', {
    tier: 1,
    domain: 'security',
    searchHint: 'IOC sweep: detection rule sets, preview/run/cancel a sweep, sweep status, import IOCs',
    // createSweep / cancelSweep open their own transaction after a Redis
    // rate-limit round-trip and refuse an ambient context (PR A seams).
    selfManagedDbContext: ['sweep', 'cancel_sweep'],
    definition: {
      name: 'ioc_hunt',
      description:
        'Threat hunting with IOC sweeps in one organization. Reads: list_rule_sets, preview_sweep, list_sweeps, sweep_status. '
        + 'sweep runs a previewed detect-only IOC scan (approval); cancel_sweep; import_iocs adds IOC detection rules to a set (approval).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...IOC_HUNT_ACTIONS], description: 'IOC hunt action' },
          orgId: { type: 'string', description: 'Organization UUID (required for preview_sweep and sweep; optional filter for list_rule_sets and list_sweeps)' },
          ruleSetIds: { type: 'array', items: { type: 'string' }, description: 'Detection rule set UUIDs to scan with (preview_sweep, sweep); 1-20' },
          scope: {
            type: 'object',
            description: 'Devices in the org: {kind:"all"}, {kind:"sites",siteIds}, {kind:"groups",groupIds}, {kind:"devices",deviceIds} or {kind:"orgs",orgIds:[orgId]}',
          },
          scanType: { type: 'string', enum: ['quick', 'full', 'custom'], description: 'IOC scan type (preview_sweep, sweep)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths to scan; required for a custom scan and not allowed otherwise' },
          ttlHours: { type: 'number', description: 'Hours a queued sweep scan may wait for its device (1-72, default 24)' },
          expectedDeviceCount: { type: 'number', description: 'sweep: the targeted count preview_sweep returned' },
          previewDigest: { type: 'string', description: 'sweep: the previewDigest preview_sweep returned' },
          sweepId: { type: 'string', description: 'Sweep UUID (sweep_status, cancel_sweep)' },
          ruleSetId: { type: 'string', description: 'import_iocs: the rule set UUID to add IOC rules to' },
          iocs: {
            type: 'array',
            items: { type: 'object' },
            description: 'import_iocs: [{kind, value}], kind one of md5, sha1, sha256, filename, filepath, domain, ip, string; up to 1000',
          },
          label: { type: 'string', description: 'import_iocs: short label for the generated rules (e.g. the advisory name)' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'import_iocs: severity of the generated rules' },
          page: { type: 'number', description: 'Page number for list_rule_sets and list_sweeps (default 1)' },
          limit: { type: 'number', description: 'Page size for list_rule_sets and list_sweeps (default 25, max 100)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth, context) => JSON.stringify(await handle(input, auth, context)),
  });
}
