/**
 * AI Script & Command Execution Tools
 *
 * Tools for executing commands, running scripts, managing processes,
 * scheduled tasks, registry operations, and browsing the script library.
 *
 * - execute_command (Tier 3): Execute a system command on a device
 * - run_script (Tier 3): Execute a script on one or more devices
 * - manage_services (Tier 3): List, start, stop, or restart system services
 * - list_scripts (Tier 1): Search and filter scripts in the org library
 * - get_script_details (Tier 1): Get script metadata with optional content/versions/stats
 * - list_script_templates (Tier 1): Browse available script templates
 * - get_script_execution_history (Tier 1): Get past execution results for a script
 * - get_script_execution (Tier 1): Get a single execution by ID (status + output)
 * - search_script_library (Tier 1): Search scripts and templates together
 * - manage_processes (Tier 1): List or kill running processes on a device
 * - manage_scheduled_tasks (Tier 1): List/run/enable/disable/delete scheduled tasks
 * - registry_operations (Tier 1): Read or modify Windows registry keys/values
 */

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  devices,
  organizations,
  scripts,
  scriptVersions,
  scriptTemplates,
  scriptExecutions,
} from '../db/schema';
import { eq, and, desc, sql, ilike, isNull, or, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext, VerifiedRunScript } from './toolExecutionContext';
import { dispatchScriptToDevice } from './scriptDispatch';
import { loadTenantVariableScope } from './tenantVariableResolution';
import { captureException } from './sentry';
import { scriptNeedsVariableScope } from './sourcedParameters';

type AiToolTier = 1 | 2 | 3 | 4;

// ============================================
// Cached dynamic import for commandQueue
// ============================================

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

// ============================================
// Shared helpers
// ============================================

// Known registry hive tokens the agent accepts (internal/remote/tools/registry_windows.go
// resolveRegistryRoot), long forms first so a long-form prefix isn't mistaken
// for a truncated short form.
const REGISTRY_HIVE_PREFIXES = [
  'HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG',
  'HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC',
];

/**
 * Split a `registry_operations` tool `keyPath` (e.g.
 * "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion") into the {hive, path}
 * shape the agent's registry handlers actually read. Defaults to hive "HKLM"
 * when the path carries no recognized hive prefix, mirroring the agent's own
 * `GetPayloadString(payload, "hive", "HKLM")` default.
 */
export function splitRegistryKeyPath(keyPath: string): { hive: string; path: string } {
  const upper = keyPath.toUpperCase();
  for (const prefix of REGISTRY_HIVE_PREFIXES) {
    if (upper === prefix || upper.startsWith(`${prefix}\\`) || upper.startsWith(`${prefix}:`)) {
      const rest = keyPath.slice(prefix.length).replace(/^[\\:]+/, '');
      return { hive: prefix, path: rest };
    }
  }
  return { hive: 'HKLM', path: keyPath };
}

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  // Site axis: deny devices outside the caller's site allowlist (no-op when unrestricted).
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
    return { error: 'Device not found or access denied' };
  }
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

/**
 * The `run_script` script lookup, unchanged from the pre-#3409-PR4c-1 inline
 * version — extracted only so the handler can choose between it and a verified
 * release's already-resolved row without nesting the query in a conditional.
 */
async function queryRunScriptRow(
  scriptId: string,
  auth: AuthContext,
): Promise<typeof scripts.$inferSelect | undefined> {
  const scriptConditions: SQL[] = [eq(scripts.id, scriptId), isNull(scripts.deletedAt)];
  // Partner-wide scripts have org_id NULL; the plain orgCondition would
  // exclude them even though RLS makes them visible to this session.
  // Defense-in-depth stays: org-owned scripts must satisfy orgCondition,
  // org-less rows pass here and are constrained per-device below.
  const orgCond = auth.orgCondition(scripts.orgId);
  if (orgCond) scriptConditions.push(or(isNull(scripts.orgId), orgCond)!);

  const [script] = await db
    .select()
    .from(scripts)
    .where(and(...scriptConditions))
    .limit(1);
  return script;
}

/**
 * The verified release material for THIS call, or `undefined` — in which case
 * `run_script` behaves exactly as it always has (direct chat, MCP and the
 * script builder never supply a context).
 *
 * The pinned row's id is re-checked against the requested `scriptId` because
 * the context and the arguments arrive on different channels: the release
 * paths compute both from the same `action_intents.arguments`, so a
 * disagreement can only mean a plumbing bug, and executing SOMEONE ELSE'S
 * verified script would be the worst possible response to one. Falling back to
 * the ordinary query keeps the call correct; the log + Sentry capture keep the
 * bug from being invisible (a silent fallback would look exactly like the
 * feature never shipping).
 */
function verifiedRunScriptFor(
  context: ToolExecutionContext | undefined,
  scriptIdArg: unknown,
): VerifiedRunScript | undefined {
  const verified = context?.verifiedRunScript;
  if (!verified) return undefined;
  if (verified.scriptRow.id !== scriptIdArg) {
    const message =
      '[aiToolsScripts] run_script verified snapshot does not match the requested scriptId; re-querying';
    console.error(message, { requested: scriptIdArg, verified: verified.scriptRow.id });
    captureException(new Error(message));
    return undefined;
  }
  return verified;
}

/**
 * Whether `auth` may run a script row that a RELEASE path resolved under a
 * SYSTEM DB context (#3409 PR4c-1 fix round 1).
 *
 * The query this replaces was protected TWICE, and skipping it drops BOTH
 * layers, so both have to be re-expressed here:
 *
 *  1. APP LAYER — `or(isNull(orgId), auth.orgCondition(orgId))`.
 *     `canAccessOrg` and `orgCondition` are built by the same
 *     `buildOrgAccessClosures` from the same `accessibleOrgIds`
 *     (middleware/auth.ts), so the check below is that filter exactly:
 *     unrestricted for `accessibleOrgIds === null`, membership otherwise, and
 *     an org-less row passes (it is constrained per-device by the partner
 *     guard in the handler).
 *
 *  2. RLS — the query ran inside the CALLER's context
 *     (`withAuthDbAccessContext` on the durable worker, `withDbAccessContext`
 *     inline), so Postgres filtered it too. The pinned row is read
 *     system-scoped, so that layer is simply gone. The `scripts` SELECT policy
 *     (migration `2026-06-13-catalog-partner-read-branch.sql`) is:
 *
 *       breeze_has_org_access(org_id)
 *       OR breeze_has_partner_access(partner_id)
 *       OR is_system                       -- the COLUMN, not a session flag
 *       OR (org_id IS NULL AND partner_id = breeze_current_partner_id())
 *
 *     Every row that policy hides is already refused by layer 1 or by the
 *     per-device partner guard — EXCEPT ONE SHAPE:
 *     `(org_id NULL, partner_id NULL, is_system false)`. That orphan is
 *     representable today (`resolveScriptCreateScope`'s system-scope branch
 *     yields `{orgId: null, partnerId: null}` and `insertScriptRow` DEFAULTS
 *     `is_system` to false on that branch unless the caller explicitly
 *     requests it; there is no XOR CHECK on `scripts`), it is
 *     invisible to every non-system caller, and it would sail straight past
 *     layer 1 (org id is null) and past the partner guard (partner id is
 *     null). It is refused below.
 *
 * THE NULL CHECK IS NOT REDUNDANT — deleting it re-opens exactly the RLS
 * clause the system-scoped read skipped. It is also deliberately
 * unconditional: `breeze_has_org_access(NULL)` is TRUE for a system-scope
 * SESSION, so this is marginally stricter than RLS for a system-scope token
 * (the membership-less caller the handler's own comment warns about) — the
 * orphan shape is a data bug, and refusing to execute one through an approved
 * intent is the right direction to be wrong in.
 */
function callerMayUseVerifiedScript(
  script: typeof scripts.$inferSelect,
  auth: AuthContext,
): boolean {
  if (script.orgId !== null) return auth.canAccessOrg(script.orgId);
  return script.partnerId !== null || script.isSystem;
}

export function registerScriptTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // execute_command - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'execute_command',
      description: 'Execute a system command on a device. Read-only command types (list_processes, file_list, event_logs_list) run without a durable approval step in auto-execute session modes (still audit logged); under the default per-step mode they still take a lightweight inline confirmation. list_services, event_logs_query, and all mutating/file_read command types always require full user approval. Use for process management, service control, file operations, etc. Paging/filter payload params: list_processes { page, limit (max 500; larger values reset to 50), search, sortBy, sortDesc }; event_logs_query (Windows only) { page (max 20), limit (max 500), logName, level, source, eventId }; file_list { path, limit (max 5000) } — no paging, narrow the path to see more. Large results are compacted for chat — if the result carries stdoutTruncation/_chat metadata, page or narrow the payload rather than repeating the same call.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          commandType: {
            type: 'string',
            enum: [
              'list_processes', 'kill_process',
              'list_services', 'start_service', 'stop_service', 'restart_service',
              'file_list', 'file_read',
              'event_logs_list', 'event_logs_query'
            ],
            description: 'The type of command to execute'
          },
          payload: { type: 'object', description: 'Command-specific parameters' }
        },
        required: ['deviceId', 'commandType']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      // Verify device access
      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });
      const { device } = access;

      // Import and use executeCommand from commandQueue
      const { executeCommand } = await getCommandQueue();
      const result = await executeCommand(deviceId, input.commandType as string, (input.payload as Record<string, unknown>) ?? {}, {
        userId: auth.user.id,
        timeoutMs: 30000
      });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // run_script - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'run_script',
      description: 'Execute a script on one or more devices. Existing scripts can be referenced by ID; inline scripts require approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of an existing script to run' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs to run on' },
          parameters: { type: 'object', description: 'Script parameters' }
        },
        required: ['scriptId', 'deviceIds']
      }
    },
    handler: async (input, auth, context) => {
      const { waitForCommandResult } = await getCommandQueue();
      const deviceIds = input.deviceIds as string[];
      const results: Record<string, unknown> = {};

      // #3409 PR4c-1 — a release path may have ALREADY read this script row and
      // resolved its tenant variables, in order to recompute the approval's
      // pinned effect digest. Reading them again here would reopen the exact
      // check/use window the digest exists to close: the digest proves the
      // target was unchanged as of THAT read, and a second read proves nothing.
      const verified = verifiedRunScriptFor(context, input.scriptId);

      // AUTHORIZATION, NOT CACHING. The skipped query was filtered by BOTH its
      // app-layer org condition AND by RLS (it ran in the caller's own DB
      // context); the pinned row is read system-scoped, so both layers are
      // re-expressed in `callerMayUseVerifiedScript`. The digest verifies
      // CONTENT IDENTITY; it says nothing about this caller's authority.
      if (verified && !callerMayUseVerifiedScript(verified.scriptRow, auth)) {
        return JSON.stringify({ error: 'Script not found or has no content' });
      }

      // Resolve script content upfront so the agent receives the full payload
      const script = verified ? verified.scriptRow : await queryRunScriptRow(input.scriptId as string, auth);

      if (!script || !script.content) {
        return JSON.stringify({ error: 'Script not found or has no content' });
      }

      // This guard is NOT here because the intent-release worker runs under a
      // system context — it doesn't. jobs/intentReleaseWorker.ts executes this
      // tool inside `withAuthDbAccessContext(auth, ...)`, which is RLS-scoped
      // to the reconstructed approver identity, same as a live request. The
      // real reason this app-layer check is load-bearing: a membership-less
      // user is issued a system-SCOPE token (see
      // middleware/auth.ts — payload.scope === 'system'), under which
      // `auth.orgCondition(...)` returns `undefined` and RLS is effectively
      // off for that session. For that caller, this org-equality check plus
      // the device-org→partner lookup below are the ONLY defenses stopping a
      // partner-wide script from running on a device outside the script's
      // partner. Do not delete this thinking RLS already covers it.
      const scriptPartnerId = script.partnerId ?? null;

      for (const deviceId of deviceIds.slice(0, 10)) { // Limit to 10 devices
        try {
          // Verify access
          const access = await verifyDeviceAccess(deviceId, auth);
          if ('error' in access) {
            results[deviceId] = { error: access.error };
            continue;
          }

          // Identity hardening for the verified path (#3409 PR4c-1 fix round
          // 1). `verifiedRunScriptFor` re-checks the pinned scriptId; this is
          // the same check on the OTHER argument. The snapshot's
          // `deviceOrgIds` is built from every id in `args.deviceIds`, and
          // this loop dispatches a subset of that same array, so the device's
          // org is always a member when the context and the arguments came
          // from the same intent. If it is not, the pinned SCOPE may not cover
          // this device's org — dispatch would resolve its tenant variables
          // against a scope that was never loaded for it and quietly render
          // "no value set". Fail this device closed rather than dispatch on
          // unverified material; log + capture so the plumbing bug is visible.
          if (verified && !verified.snapshot.deviceOrgIds.includes(access.device.orgId)) {
            const message =
              '[aiToolsScripts] run_script verified snapshot does not cover the dispatched device org';
            console.error(message, { deviceId, deviceOrgId: access.device.orgId });
            captureException(new Error(message));
            results[deviceId] = { error: 'Device not found or access denied' };
            continue;
          }

          // Org-equality invariant (mirrors scriptExecution.ts / playbooks.ts):
          // a system/org-less script (orgId === null) is universally runnable,
          // but a non-null script org MUST match the target device's org. For a
          // multi-org caller, orgCondition resolves an org-A script and
          // verifyDeviceAccess admits an org-B device — both pass canAccessOrg —
          // so without this an org-A script's content lands on an org-B device.
          // Treat a mismatch like an inaccessible device.
          if (script.orgId !== null && script.orgId !== access.device.orgId) {
            results[deviceId] = { error: 'Device not found or access denied' };
            continue;
          }

          if (scriptPartnerId !== null) {
            const [deviceOrg] = await db
              .select({ partnerId: organizations.partnerId })
              .from(organizations)
              .where(eq(organizations.id, access.device.orgId))
              .limit(1);
            if (!deviceOrg || deviceOrg.partnerId !== scriptPartnerId) {
              results[deviceId] = { error: 'Device not found or access denied' };
              continue;
            }
          }

          // Escape the ambient held transaction before dispatch + poll (#3409 C1).
          //
          // Every AI tool handler (this one included) runs inside ONE held
          // Postgres transaction for the whole turn — aiAgentSdkTools.ts:400
          // and jobs/intentReleaseWorker.ts:459 both wrap tool dispatch in
          // withDbAccessContext (see db/index.ts:436-484 for what "held"
          // means: a real `baseDb.transaction()` that doesn't commit until
          // the callback returns). Everything above this point (the script
          // select, verifyDeviceAccess, the partner-org lookup) is RLS-scoped
          // read work that belongs in that ambient transaction. Dispatch does
          // not: if the device_commands INSERT stayed inside it, the row
          // would be invisible to the agent-WS handler that processes the
          // result on a *different* connection — its `UPDATE device_commands
          // ... WHERE id = commandId` would match 0 rows, and
          // waitForCommandResult would burn the full 60s timeout per device
          // while holding a pooled connection the entire time.
          //
          // `executeCommand` (services/commandQueue.ts) hit exactly this and
          // fixed it with a two-phase runOutsideDbContext escape — read its
          // docstring there before changing this. Mirror that shape, not one
          // long-lived transaction spanning the whole poll:
          //
          //   Phase 1 (write): runOutsideDbContext + withSystemDbAccessContext
          //   wrap ONLY dispatchScriptToDevice, so its script_executions /
          //   device_commands inserts run inside a real (non-contextless)
          //   transaction that commits the instant dispatch returns. System
          //   scope is safe here because ownership was already validated
          //   above under RLS (device access + org-equality + partner guard)
          //   — same justification as the automation worker path, which runs
          //   this identical dispatch core under system context for the
          //   whole run (jobs/automationWorker.ts). The insert must NOT run
          //   contextless (bare runOutsideDbContext with no
          //   withSystemDbAccessContext) — that would just trade the 0-row
          //   trap for the contextless-write guard (#1375).
          //
          //   Phase 2 (poll): waitForCommandResult runs OUTSIDE any held
          //   transaction — still escaped via runOutsideDbContext, but NOT
          //   nested inside withSystemDbAccessContext — so each poll
          //   iteration is a plain, quickly-released pool read, exactly like
          //   executeCommand's own poll loop. Nesting the poll inside the
          //   same withSystemDbAccessContext call as dispatch would reproduce
          //   the identical 0-row bug under a different (system-scoped)
          //   transaction: the INSERT wouldn't commit until the 60s wait
          //   finished either.
          // Task 4 (#3409 PR2): the variable-scope preload joins this SAME
          // escape rather than getting its own — it must run inside the
          // identical system-context transaction as dispatchScriptToDevice
          // (see the long comment above for why a bare/contextless read
          // would reproduce the 0-row trap this escape exists to avoid). One
          // device per iteration here (max 10, capped above), so one org per
          // preload — there is no wider fan-out to batch it against.
          const dispatch = await runOutsideDbContext(() =>
            withSystemDbAccessContext(async () => {
              // #3409 PR3 P1: gated on `scriptNeedsVariableScope`, not
              // content tokens alone — a `tenantVariable`-bound parameter
              // lives in `scripts.parameters`, and a content-only gate would
              // hand dispatch an empty scope for it.
              //
              // #3409 PR4c-1: with a verified release, the scope is the one
              // the digest's variable references were pinned from — reusing
              // it is the point of the whole exercise. It was loaded through
              // the SAME gate over the SAME row, for every device org in the
              // call, so it is a superset of what this per-device load would
              // have produced (and equally empty when the script needs none).
              const variableScope = verified
                ? verified.scope
                : await loadTenantVariableScope(
                    scriptNeedsVariableScope(script) ? [access.device.orgId] : []
                  );
              return dispatchScriptToDevice({
                device: access.device,
                source: { kind: 'saved', script },
                parameters: (input.parameters as Record<string, unknown>) ?? {},
                triggerType: 'manual',
                triggeredBy: auth.user.id,
                createdBy: auth.user.id,
                requireOnline: true,
                variableScope,
              });
            })
          );
          if (!dispatch.ok) {
            results[deviceId] = { error: dispatch.error };
            continue;
          }
          // Project the polled row instead of returning it whole: the row
          // carries `payload` (full script content + parameters), which must
          // never reach the model context or persisted chat history — this
          // repo already redacts that via sanitizeCommandPayloadForAudit /
          // sanitizeCommandForHistory (services/commandAudit.ts) for the
          // audit/history paths, and the AI path must not bypass that
          // convention. Mirrors executeCommand's own return shape
          // (services/commandQueue.ts) so callers reading top-level
          // .stdout/.exitCode keep working, plus the new executionId.
          const cmd = await runOutsideDbContext(() => waitForCommandResult(dispatch.commandId, 60000));
          results[deviceId] = {
            ...(cmd.result as unknown as Record<string, unknown> ?? { status: 'failed', error: 'Command did not complete' }),
            commandId: cmd.id,
            executionId: dispatch.executionId,
          };
        } catch (err) {
          // A thrown error here is indistinguishable from "device unsupported"
          // once caught below unless it's surfaced — a genuine DB/infra fault
          // during dispatch must not silently masquerade as graceful
          // per-device degradation.
          console.error('[aiToolsScripts] run_script dispatch failed', { deviceId, error: err });
          captureException(err);
          results[deviceId] = { error: err instanceof Error ? err.message : 'Execution failed' };
        }
      }

      return JSON.stringify({ results });
    }
  });

  // ============================================
  // manage_services - Tier 3 for start/stop/restart
  // ============================================

  registerTool({
    tier: 3,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_services',
      description: 'List, start, stop, or restart system services on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['list', 'start', 'stop', 'restart'], description: 'Action to perform' },
          serviceName: { type: 'string', description: 'Service name (required for start/stop/restart)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const commandTypeMap: Record<string, string> = {
        list: 'list_services',
        start: 'start_service',
        stop: 'stop_service',
        restart: 'restart_service'
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      const result = await executeCommand(deviceId, commandType, {
        name: input.serviceName
      }, { userId: auth.user.id, timeoutMs: 30000 });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // manage_processes - Tier 1 (list), Tier 3 via guardrails (kill)
  // ============================================

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_processes',
      description: 'List running processes on a device with CPU and memory usage, or terminate a process.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'kill'],
            description: 'Action to perform'
          },
          deviceId: { type: 'string', description: 'The device UUID' },
          processId: { type: 'string', description: 'The PID of the process to kill (required for kill action)' },
          processName: {
            type: 'string',
            description: 'The name of the process being killed, from a prior list_processes/manage_services:list read (e.g. "notepad.exe"). Recommended alongside processId for kill: a bare PID gets reused by the OS the instant a process exits, so including the name lets a reviewer verify what a kill call actually targets. This is used for verification/filtering, not a same-process guarantee — it is not re-checked against the live process list at dispatch time.'
          },
          search: { type: 'string', description: 'Filter process list by name' },
          sortBy: {
            type: 'string',
            enum: ['cpu', 'memory', 'name', 'pid'],
            description: 'Sort process list by field (default: cpu)'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of processes to return (default: 50, max: 200)'
          }
        },
        required: ['action', 'deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();

      if (action === 'list') {
        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const result = await executeCommand(deviceId, 'list_processes', {
          search: input.search ?? undefined,
          sortBy: input.sortBy ?? 'cpu',
          limit
        }, { userId: auth.user.id, timeoutMs: 30000 });

        return JSON.stringify(result);
      }

      if (action === 'kill') {
        if (!input.processId) {
          return JSON.stringify({ error: 'processId is required for kill action' });
        }

        const result = await executeCommand(deviceId, 'kill_process', {
          pid: input.processId
        }, { userId: auth.user.id, timeoutMs: 30000 });

        return JSON.stringify(result);
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });

  // ============================================
  // list_scripts - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'list_scripts',
      description: 'Search and filter scripts in the organization library. Returns a list of matching scripts including name, description, language, OS targets, and category.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Search by script name (partial match)' },
          category: { type: 'string', description: 'Filter by script category' },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'], description: 'Filter by script language' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by OS type (scripts targeting this OS)' },
          limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
        },
      },
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [isNull(scripts.deletedAt)];
      const orgCondition = auth.orgCondition(scripts.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.search) {
        const searchPattern = '%' + escapeLike(input.search as string) + '%';
        conditions.push(sql`${scripts.name} ILIKE ${searchPattern}`);
      }
      if (input.category) conditions.push(eq(scripts.category, input.category as string));
      if (input.language) conditions.push(eq(scripts.language, input.language as typeof scripts.language.enumValues[number]));
      if (input.osType) conditions.push(sql`${scripts.osTypes} @> ARRAY[${input.osType}]::text[]`);

      const limit = Math.min(Math.max(1, Number(input.limit) || 20), 50);

      const results = await db
        .select({
          id: scripts.id,
          name: scripts.name,
          description: scripts.description,
          language: scripts.language,
          osTypes: scripts.osTypes,
          category: scripts.category,
          createdAt: scripts.createdAt,
        })
        .from(scripts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(scripts.updatedAt))
        .limit(limit);

      return JSON.stringify({ scripts: results, count: results.length });
    },
  });

  // ============================================
  // get_script_details - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_details',
      description: 'Get script details including parameters, version history, and execution statistics. Script content is omitted unless explicitly requested and may be minimized in AI transcripts.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of the script' },
          includeContent: { type: 'boolean', description: 'Include the script content (default false)' },
          includeVersionHistory: { type: 'boolean', description: 'Include version history (default false)' },
          includeExecutionStats: { type: 'boolean', description: 'Include execution statistics (default false)' },
        },
        required: ['scriptId'],
      },
    },
    handler: async (input, auth) => {
      const scriptId = input.scriptId as string;
      const includeContent = (input.includeContent as boolean) ?? false;
      const includeVersionHistory = (input.includeVersionHistory as boolean) ?? false;
      const includeExecutionStats = (input.includeExecutionStats as boolean) ?? false;

      // Query script with org scoping
      const conditions: SQL[] = [eq(scripts.id, scriptId), isNull(scripts.deletedAt)];
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) conditions.push(orgCond);

      const [script] = await db
        .select()
        .from(scripts)
        .where(and(...conditions))
        .limit(1);

      if (!script) {
        return JSON.stringify({ error: 'Script not found or access denied' });
      }

      const result: Record<string, unknown> = {
        id: script.id,
        name: script.name,
        description: script.description,
        category: script.category,
        language: script.language,
        osTypes: script.osTypes,
        parameters: script.parameters,
        timeoutSeconds: script.timeoutSeconds,
        runAs: script.runAs,
        isSystem: script.isSystem,
        version: script.version,
        createdBy: script.createdBy,
        createdAt: script.createdAt,
        updatedAt: script.updatedAt,
      };

      if (includeContent) {
        result.content = script.content;
      }

      if (includeVersionHistory) {
        const versions = await db
          .select({
            id: scriptVersions.id,
            version: scriptVersions.version,
            changelog: scriptVersions.changelog,
            createdBy: scriptVersions.createdBy,
            createdAt: scriptVersions.createdAt,
          })
          .from(scriptVersions)
          .where(eq(scriptVersions.scriptId, scriptId))
          .orderBy(desc(scriptVersions.version))
          .limit(10);

        result.versionHistory = versions;
      }

      if (includeExecutionStats) {
        const [stats] = await db
          .select({
            totalExecutions: sql<number>`count(*)::int`,
            completedCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'completed')::int`,
            failedCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'failed')::int`,
            pendingCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'pending')::int`,
            runningCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'running')::int`,
            timeoutCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'timeout')::int`,
            cancelledCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'cancelled')::int`,
            avgDurationSeconds: sql<number>`avg(extract(epoch from (${scriptExecutions.completedAt} - ${scriptExecutions.startedAt})))::numeric(10,2)`,
          })
          .from(scriptExecutions)
          .where(eq(scriptExecutions.scriptId, scriptId));

        result.executionStats = stats;
      }

      return JSON.stringify(result);
    },
  });

  // ============================================
  // list_script_templates - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'list_script_templates',
      description: 'Browse available script templates for common tasks. Templates are pre-built scripts that can be used as starting points.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Search by template name (partial match)' },
          category: { type: 'string', description: 'Filter by template category' },
          limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
        },
      },
    },
    handler: async (input, _auth) => {
      const conditions: SQL[] = [];

      if (input.search) {
        const searchPattern = '%' + escapeLike(input.search as string) + '%';
        conditions.push(sql`${scriptTemplates.name} ILIKE ${searchPattern}`);
      }
      if (input.category) conditions.push(eq(scriptTemplates.category, input.category as string));

      const limit = Math.min(Math.max(1, Number(input.limit) || 20), 50);

      const results = await db
        .select({
          id: scriptTemplates.id,
          name: scriptTemplates.name,
          description: scriptTemplates.description,
          language: scriptTemplates.language,
          category: scriptTemplates.category,
          rating: scriptTemplates.rating,
        })
        .from(scriptTemplates)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(scriptTemplates.rating))
        .limit(limit);

      return JSON.stringify({ templates: results, count: results.length });
    },
  });

  // ============================================
  // get_script_execution_history - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_execution_history',
      description: 'Get past execution results for a script. Shows status, exit codes, stdout/stderr, and timing information.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of the script to get execution history for' },
          limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
        },
        required: ['scriptId'],
      },
    },
    handler: async (input, auth) => {
      // Verify the script belongs to the user's org before returning execution
      // data. Partner-wide/system scripts have org_id NULL — same guard as
      // run_script, or the history of the repo's default ownership shape would
      // read as "Script not found".
      const scriptConditions: SQL[] = [eq(scripts.id, input.scriptId as string), isNull(scripts.deletedAt)];
      const orgCondition = auth.orgCondition(scripts.orgId);
      if (orgCondition) scriptConditions.push(or(isNull(scripts.orgId), orgCondition)!);

      const [script] = await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(and(...scriptConditions))
        .limit(1);

      if (!script) return JSON.stringify({ error: 'Script not found' });

      const limit = Math.min(Math.max(1, Number(input.limit) || 10), 50);

      const results = await db
        .select({
          id: scriptExecutions.id,
          status: scriptExecutions.status,
          exitCode: scriptExecutions.exitCode,
          stdout: scriptExecutions.stdout,
          stderr: scriptExecutions.stderr,
          createdAt: scriptExecutions.createdAt,
          completedAt: scriptExecutions.completedAt,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.scriptId, input.scriptId as string))
        .orderBy(desc(scriptExecutions.createdAt))
        .limit(limit);

      return JSON.stringify({ executions: results, count: results.length });
    },
  });

  // ============================================
  // get_script_execution - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_execution',
      description: 'Get a single script execution by ID, including status, exit code, stdout, stderr, and timing. Use this for runs started OUTSIDE the current tool call — e.g. the user clicked Test Run in the script editor, or you have an execution id from get_script_execution_history. Also use it in exactly one other case: when run_script returned status "timeout" for a device, that means the 60s wait expired, NOT that the script failed — the device is still running it, and its real exit code and output land on the executionId run_script returned. Re-check that executionId before concluding anything about the script; do not "fix" a script on the strength of a timeout alone. For any other run_script outcome, the returned result is final — do not re-check it.',
      input_schema: {
        type: 'object' as const,
        properties: {
          executionId: { type: 'string', description: 'UUID of the script execution to fetch' },
        },
        required: ['executionId'],
      },
    },
    handler: async (input, auth) => {
      // Partner-wide/system scripts have org_id NULL; the plain orgCondition
      // would exclude their executions (same trap run_script guards against
      // above). Org-less scripts pass here; the device-site check below and
      // RLS still constrain what the session can see.
      const orgCond = auth.orgCondition(scripts.orgId);
      const scriptOrgCondition = orgCond ? or(isNull(scripts.orgId), orgCond) : undefined;

      const [execution] = await db
        .select({
          id: scriptExecutions.id,
          scriptId: scriptExecutions.scriptId,
          scriptName: scripts.name,
          deviceId: scriptExecutions.deviceId,
          deviceHostname: devices.hostname,
          deviceSiteId: devices.siteId,
          status: scriptExecutions.status,
          exitCode: scriptExecutions.exitCode,
          stdout: scriptExecutions.stdout,
          stderr: scriptExecutions.stderr,
          errorMessage: scriptExecutions.errorMessage,
          startedAt: scriptExecutions.startedAt,
          completedAt: scriptExecutions.completedAt,
          createdAt: scriptExecutions.createdAt,
        })
        .from(scriptExecutions)
        .innerJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
        .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
        .where(and(
          eq(scriptExecutions.id, input.executionId as string),
          ...(scriptOrgCondition ? [scriptOrgCondition] : []),
        ))
        .limit(1);

      if (!execution) return JSON.stringify({ error: 'Execution not found' });
      // Site axis: same rule verifyDeviceAccess applies on the write path.
      if (auth.canAccessSite && !auth.canAccessSite(execution.deviceSiteId)) {
        return JSON.stringify({ error: 'Execution not found' });
      }

      const { deviceSiteId: _siteId, ...result } = execution;
      return JSON.stringify({ execution: result });
    },
  });

  // ============================================
  // search_script_library - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'search_script_library',
      description: 'Search the script library including org scripts and built-in templates. Filter by category, language, OS, or search text.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Partial match on script name or description' },
          category: { type: 'string', description: 'Filter by category name' },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd', 'zsh'], description: 'Filter by scripting language' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by supported OS (checks osTypes array)' },
          includeTemplates: { type: 'boolean', description: 'Include built-in script templates (default false)' },
          limit: { type: 'number', description: 'Max results to return (default 25, max 100)' },
        },
      },
    },
    handler: async (input, auth) => {
      const limit = Math.min(Math.max((input.limit as number) || 25, 1), 100);
      const search = input.search as string | undefined;
      const category = input.category as string | undefined;
      const language = input.language as string | undefined;
      const osType = input.osType as string | undefined;
      const includeTemplates = (input.includeTemplates as boolean) ?? false;

      // Query org scripts
      const conditions: SQL[] = [isNull(scripts.deletedAt)];
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) conditions.push(orgCond);

      if (search) {
        const pattern = '%' + escapeLike(search) + '%';
        conditions.push(
          sql`(${scripts.name} ILIKE ${pattern} OR ${scripts.description} ILIKE ${pattern})`
        );
      }
      if (category) conditions.push(eq(scripts.category, category));
      if (language) conditions.push(eq(scripts.language, language as typeof scripts.language.enumValues[number]));
      if (osType) conditions.push(sql`${sql.param(osType)} = ANY(${scripts.osTypes})`);

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const orgScripts = await db
        .select({
          id: scripts.id,
          name: scripts.name,
          description: scripts.description,
          category: scripts.category,
          language: scripts.language,
          osTypes: scripts.osTypes,
          version: scripts.version,
          isSystem: scripts.isSystem,
          createdAt: scripts.createdAt,
        })
        .from(scripts)
        .where(whereClause)
        .orderBy(desc(scripts.updatedAt))
        .limit(limit);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scripts)
        .where(whereClause);
      const totalOrgScripts = countResult?.count ?? 0;

      // Optionally query built-in templates
      let templates: Array<{
        id: string;
        name: string;
        description: string | null;
        category: string | null;
        language: string | null;
        isBuiltIn: boolean;
        source: string;
      }> = [];
      let totalTemplates = 0;

      if (includeTemplates) {
        const tplConditions: SQL[] = [];
        if (search) {
          const pattern = '%' + escapeLike(search) + '%';
          tplConditions.push(
            sql`(${scriptTemplates.name} ILIKE ${pattern} OR ${scriptTemplates.description} ILIKE ${pattern})`
          );
        }
        if (category) tplConditions.push(eq(scriptTemplates.category, category));
        if (language) tplConditions.push(eq(scriptTemplates.language, language as typeof scriptTemplates.language.enumValues[number]));

        const tplWhere = tplConditions.length > 0 ? and(...tplConditions) : undefined;

        const tplRows = await db
          .select({
            id: scriptTemplates.id,
            name: scriptTemplates.name,
            description: scriptTemplates.description,
            category: scriptTemplates.category,
            language: scriptTemplates.language,
            isBuiltIn: scriptTemplates.isBuiltIn,
          })
          .from(scriptTemplates)
          .where(tplWhere)
          .limit(limit);

        templates = tplRows.map(t => ({ ...t, source: 'template' }));

        const [tplCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(scriptTemplates)
          .where(tplWhere);
        totalTemplates = tplCount?.count ?? 0;
      }

      return JSON.stringify({
        scripts: orgScripts.map(s => ({ ...s, source: 'library' })),
        templates,
        totalMatches: totalOrgScripts + totalTemplates,
        totalOrgScripts,
        totalTemplates,
      });
    },
  });

  // ============================================
  // manage_scheduled_tasks - Tier 1 base, with action escalation
  // ============================================

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_scheduled_tasks',
      description: 'List, run, enable, or disable Windows scheduled tasks on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: {
            type: 'string',
            enum: ['list', 'run', 'disable', 'enable'],
            description: 'Action to perform on scheduled tasks'
          },
          taskName: {
            type: 'string',
            description: 'Full scheduled-task path (e.g. \\Microsoft\\Windows\\...\\TaskName) — required for run/disable/enable'
          },
          search: { type: 'string', description: 'Filter task list by name (only for list action)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand, CommandTypes } = await getCommandQueue();
      const commandTypeMap: Record<string, string> = {
        list: CommandTypes.TASKS_LIST,
        run: CommandTypes.TASK_RUN,
        disable: CommandTypes.TASK_DISABLE,
        enable: CommandTypes.TASK_ENABLE,
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      const payload: Record<string, unknown> = {};
      if (action === 'list') {
        if (input.search) payload.search = input.search;
      } else {
        if (!input.taskName) return JSON.stringify({ error: 'taskName is required for this action' });
        // Agent reads the full Task Scheduler path from `path`, not `taskName`.
        payload.path = input.taskName;
      }

      const result = await executeCommand(deviceId, commandType, payload, {
        userId: auth.user.id,
        timeoutMs: 30000
      });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // registry_operations - Tier 1 base, with action escalation
  // ============================================

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'registry_operations',
      description: 'Read or modify Windows registry keys and values on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['read_key', 'get_value', 'set_value', 'create_key', 'delete_key'],
            description: 'Registry operation to perform'
          },
          deviceId: { type: 'string', description: 'The device UUID' },
          keyPath: {
            type: 'string',
            description: 'Full registry key path (e.g. HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion)'
          },
          valueName: { type: 'string', description: 'Registry value name (for get_value/set_value)' },
          valueData: { type: 'string', description: 'Data to write (for set_value)' },
          valueType: {
            type: 'string',
            enum: ['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_EXPAND_SZ', 'REG_MULTI_SZ'],
            description: 'Registry value type (for set_value)'
          }
        },
        required: ['action', 'deviceId', 'keyPath']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand, CommandTypes } = await getCommandQueue();

      const commandTypeMap: Record<string, string> = {
        read_key: CommandTypes.REGISTRY_VALUES,
        get_value: CommandTypes.REGISTRY_GET,
        set_value: CommandTypes.REGISTRY_SET,
        create_key: CommandTypes.REGISTRY_KEY_CREATE,
        delete_key: CommandTypes.REGISTRY_KEY_DELETE,
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      // Agent reads {hive, path, name, type, data} (internal/remote/tools/registry.go),
      // not a single keyPath/valueName/valueData/valueType shape. Split the
      // tool's keyPath into hive + path so the payload matches what the agent
      // actually parses.
      const { hive, path } = splitRegistryKeyPath(input.keyPath as string);
      const payload: Record<string, unknown> = { hive, path };

      if (input.valueName) payload.name = input.valueName;
      if (input.valueData !== undefined) payload.data = input.valueData;
      if (input.valueType) payload.type = input.valueType;

      const result = await executeCommand(deviceId, commandType, payload, {
        userId: auth.user.id,
        timeoutMs: 30000,
      });

      return JSON.stringify(result);
    }
  });
}
