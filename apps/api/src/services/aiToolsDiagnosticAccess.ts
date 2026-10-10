/**
 * AI tools for administrator-approved, READ-ONLY diagnostic file access.
 *
 * - request_diagnostic_access (tier 2): records a request and sends it to the
 *   approvals inbox / phones of every eligible administrator. It grants
 *   nothing by itself; an AI or MCP caller cannot approve its own request.
 * - list_diagnostic_access_grants (tier 1): the caller's requests and grants.
 * - revoke_diagnostic_access (tier 2): withdraw a request or active grant.
 * - diagnostic_list_directory / diagnostic_read_file (tier 2, read-only): list
 *   or read under an ACTIVE grant held by this exact caller. These are the only
 *   way to reach paths the default AI restriction refuses (e.g. a user's
 *   AppData application logs). They dispatch diag_file_list / diag_file_read;
 *   the signed per-command authorization is minted at delivery
 *   (services/diagnosticAccess/delivery.ts) and results come back sealed to a
 *   key only this process holds.
 *
 * Credential material (browser secrets, credential stores, private keys,
 * stored tokens) is never grantable, and file content is passed through secret
 * redaction (diagnosticAccess/contentRedaction.ts) before it is returned.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, diagnosticAccessGrants } from '../db/schema';
import { isAiAgentPrincipal, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiExecuteCommand } from './aiDispatch';
import { CommandTypes } from './commandTypes';
import {
  createDiagnosticAccessRequest,
  DEFAULT_GRANT_MINUTES,
  DiagnosticAccessError,
  findCoveringGrant,
  listDiagnosticGrants,
  pushDiagnosticApprovals,
  recordDiagnosticAccess,
  revokeDiagnosticGrant,
  type CoverageDenial,
  type DiagnosticOperation,
  type GrantRow,
} from './diagnosticAccess/grants';
import { redactDiagnosticContent } from './diagnosticAccess/contentRedaction';
import { generateResultKeyPair, isSealedDiagnosticResult, openSealedDiagnosticResult } from './diagnosticAccess/seal';
import { describeAgentDiagnosticError, splitResolvedTarget } from './diagnosticAccess/errors';
import { deviceScopeCondition, siteScopeCondition } from './aiToolsSiteScope';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';

type AiToolTier = 1 | 2 | 3 | 4;

const READ_DEFAULT_BYTES = 256 * 1024;
const READ_MAX_BYTES = 1024 * 1024;
const LIST_DEFAULT_LIMIT = 500;
const LIST_MAX_LIMIT = 5000;

function out(value: unknown): string {
  return JSON.stringify(value);
}

function refuseAgentPrincipal(action: string): string {
  return out({ error: `Action "${action}" requires a real user or API-key identity and cannot be performed by an AI agent.` });
}

/** Same base the rest of the API uses for dashboard links (DASHBOARD_URL / PUBLIC_APP_URL). */
function approvalsUrl(): string {
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
  return `${base}/approvals`;
}

function grantView(g: GrantRow) {
  return {
    grantId: g.id,
    deviceId: g.deviceId,
    status: g.status,
    operations: g.operations,
    paths: g.scopes,
    purpose: g.purpose,
    durationMinutes: g.durationMinutes,
    requestedAt: g.requestedAt.toISOString(),
    requestExpiresAt: g.status === 'pending_approval' ? g.requestExpiresAt.toISOString() : undefined,
    approvedBy: g.approvedByUserId,
    approvedAt: g.approvedAt?.toISOString() ?? null,
    expiresAt: g.expiresAt?.toISOString() ?? null,
    revokedAt: g.revokedAt?.toISOString() ?? null,
    useCount: g.useCount,
  };
}

const COVERAGE_MESSAGES: Record<CoverageDenial, string> = {
  no_grant: 'No diagnostic access grant covers this device for you. Ask for one with request_diagnostic_access; an administrator approves it in Breeze.',
  grant_pending: 'Your diagnostic access request is still waiting for an administrator to approve it.',
  grant_expired: 'Your diagnostic access grant has expired. Request a new one with request_diagnostic_access.',
  grant_revoked: 'Your diagnostic access grant was revoked. Request a new one if access is still needed.',
  operation_not_granted: 'Your grant does not include this operation (list vs read).',
  out_of_scope: 'This path is outside every location in your approved grant. Request access to it explicitly.',
  credential_material: 'This path holds credential material (browser secrets, credential stores, private keys or stored tokens), which is never available through diagnostic access.',
  hard_denied: 'This location is never available through diagnostic access.',
  invalid_path: 'The path is not an acceptable absolute path.',
};

/**
 * Device and site axes for grant listings: a device-bound run sees grants on
 * its own devices only, a site-restricted user grants on devices in their
 * sites only (the org axis is applied by listDiagnosticGrants).
 */
function grantListScope(auth: AuthContext) {
  const site = siteScopeCondition(auth, devices.siteId);
  return [
    deviceScopeCondition(auth, diagnosticAccessGrants.deviceId),
    site ? inArray(diagnosticAccessGrants.deviceId, db.select({ id: devices.id }).from(devices).where(site)) : undefined,
  ];
}

async function loadDevice(deviceId: string, auth: AuthContext) {
  // A device parked in the partner holding org is not managed yet.
  const conditions = [eq(devices.id, deviceId), notParkedDeviceCondition()];
  const orgCond = auth.orgCondition(devices.orgId);
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      osType: devices.osType,
      status: devices.status,
    })
    .from(devices)
    .where(and(...conditions, ...(orgCond ? [orgCond] : [])))
    .limit(1);
  if (!device) return null;
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) return null;
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) return null;
  return device;
}

/** Sends the queued diagnostic command and waits for the device's answer. */
type DiagnosticDispatch = (
  type: string,
  payload: Record<string, unknown>,
) => ReturnType<typeof aiExecuteCommand>;

/**
 * Runs one grant-covered diagnostic command and opens its sealed result.
 * The authorization itself is audited durably at delivery (delivery.ts);
 * this records the outcome and resolved target when the answer comes back.
 * Neither record carries content.
 *
 * The device round-trip is the caller's `dispatch`, so each tool's own
 * registration carries its wait and timeout (aiTools.deviceWaitContext
 * contract, #7918): one 30 s command, bounded under the production
 * idle-in-transaction timeout.
 */
async function runDiagnosticCommand(
  auth: AuthContext,
  deviceId: string,
  operation: DiagnosticOperation,
  path: string,
  paging: { offset: number; maxBytes?: number; limit?: number; encoding?: 'text' | 'base64' },
  dispatch: DiagnosticDispatch,
): Promise<string> {
  const device = await loadDevice(deviceId, auth);
  if (!device) return out({ error: 'Device not found or access denied', condition: 'device_not_found' });

  const coverage = await findCoveringGrant(auth, device, path, operation);
  if (!coverage.ok) {
    return out({
      error: COVERAGE_MESSAGES[coverage.reason],
      condition: coverage.reason,
      detail: coverage.detail,
      approvalsUrl: coverage.reason === 'grant_pending' ? approvalsUrl() : undefined,
    });
  }
  const grant = coverage.grant;
  if (device.status !== 'online') {
    await recordDiagnosticAccess(grant, auth, { operation, path, resolvedPath: null, commandId: null, outcome: 'device_offline' });
    return out({
      error: `Device ${device.hostname} is offline (status: ${device.status}). Diagnostic reads need a live connection.`,
      condition: 'device_offline',
    });
  }

  const keys = generateResultKeyPair();
  const payload: Record<string, unknown> = {
    grantId: grant.id,
    path,
    offset: paging.offset,
    resultPublicKey: keys.publicKeyB64,
  };
  if (operation === 'read') {
    payload.maxBytes = paging.maxBytes;
    payload.encoding = paging.encoding;
  } else {
    payload.limit = paging.limit;
  }
  const type = operation === 'read' ? CommandTypes.DIAG_FILE_READ : CommandTypes.DIAG_FILE_LIST;
  const result = await dispatch(type, payload);
  const commandId = (result as { commandId?: string }).commandId ?? null;

  if (result.status !== 'completed') {
    const { text, resolvedPath } = splitResolvedTarget(result.error ?? result.stderr ?? null);
    const described = describeAgentDiagnosticError(text, result.status);
    await recordDiagnosticAccess(grant, auth, { operation, path, resolvedPath, commandId, outcome: described.condition });
    return out({ error: described.message, condition: described.condition, commandId });
  }

  let body: Record<string, unknown>;
  try {
    const sealed = JSON.parse(result.stdout ?? '');
    if (!isSealedDiagnosticResult(sealed)) throw new Error('result is not sealed');
    body = openSealedDiagnosticResult(keys.privateKey, sealed, sealed.authorizationId) as Record<string, unknown>;
  } catch {
    await recordDiagnosticAccess(grant, auth, { operation, path, resolvedPath: null, commandId, outcome: 'result_unreadable' });
    return out({ error: 'The device answered, but its sealed result could not be opened.', condition: 'result_unreadable', commandId });
  }

  // File content is redacted for secrets before it is returned to the
  // assistant; the flag tells the model that some of it was withheld.
  let contentRedacted: boolean | undefined;
  if (operation === 'read') {
    const raw = typeof body.content === 'string' ? body.content : '';
    const redaction = redactDiagnosticContent(raw, paging.encoding === 'base64' ? 'base64' : 'text');
    body = { ...body, content: redaction.content };
    contentRedacted = redaction.redacted;
  }

  const resolvedPath = typeof body.resolvedPath === 'string' ? body.resolvedPath : null;
  await recordDiagnosticAccess(grant, auth, {
    operation,
    path,
    resolvedPath,
    commandId,
    outcome: 'ok',
    bytesRead: typeof body.bytesRead === 'number' ? body.bytesRead : undefined,
    entries: Array.isArray(body.entries) ? body.entries.length : undefined,
    contentRedacted,
  });
  return out({ ...body, contentRedacted, grantExpiresAt: grant.expiresAt?.toISOString() ?? null, commandId });
}

export function registerDiagnosticAccessTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'devices',
    searchHint: 'administrator approval for read-only access to restricted diagnostic logs such as AppData',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'request_diagnostic_access',
      description:
        'Ask an administrator to approve READ-ONLY list/read of specific paths on one device, incl. locations the default restriction blocks (e.g. AppData logs). Grants nothing until approved. Credential stores, browser secrets, keys and tokens are never available.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          paths: {
            type: 'array',
            description: '1-20 absolute paths. recursive=true covers the whole subtree; false covers the folder and the files directly in it.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path, e.g. C:\\Users\\Name\\AppData\\Local\\Vendor\\Logs' },
                recursive: { type: 'boolean', description: 'Cover the whole subtree' },
              },
              required: ['path', 'recursive'],
            },
          },
          operations: {
            type: 'array',
            items: { type: 'string', enum: ['list', 'read'] },
            description: 'Operations to allow (default both)',
          },
          purpose: { type: 'string', description: 'Why the access is needed; shown to the approver' },
          durationMinutes: { type: 'number', description: `How long the grant lasts after approval (default ${DEFAULT_GRANT_MINUTES}, 5-1440)` },
        },
        required: ['deviceId', 'paths', 'purpose'],
      },
    },
    handler: async (input, auth) => {
      // Writes auth.user.id as the requester; an AI operator agent has no
      // user identity and can never hold a grant (see beneficiaryOf).
      if (isAiAgentPrincipal(auth)) return refuseAgentPrincipal('request_diagnostic_access');
      const device = await loadDevice(input.deviceId as string, auth);
      if (!device) return out({ error: 'Device not found or access denied' });
      try {
        const result = await createDiagnosticAccessRequest(auth, device, {
          deviceId: device.id,
          paths: input.paths as Array<{ path: string; recursive: boolean }>,
          operations: ((input.operations as DiagnosticOperation[] | undefined) ?? ['list', 'read']),
          purpose: input.purpose as string,
          durationMinutes: input.durationMinutes as number | undefined,
        });
        if (!result.reused) {
          await pushDiagnosticApprovals(result.approvals, `Read-only diagnostic access on ${device.hostname}`);
        }
        const g = result.grant;
        const status = g.status === 'active' ? 'active' : 'pending_approval';
        return out({
          ...grantView(g),
          status,
          reused: result.reused,
          approversNotified: result.reused ? undefined : result.approverCount,
          approvalsUrl: status === 'pending_approval' ? approvalsUrl() : undefined,
          message:
            status === 'active'
              ? 'An approved grant for exactly this scope is already active; use diagnostic_list_directory / diagnostic_read_file.'
              : result.approverCount === 0 && !result.reused
                ? 'Request recorded, but no administrator is eligible to approve it (needs devices:execute and approvals:decide with access to this device).'
                : `Waiting for administrator approval in Breeze (Approvals, or the Breeze mobile app): ${approvalsUrl()}. Check with list_diagnostic_access_grants.`,
        });
      } catch (err) {
        if (err instanceof DiagnosticAccessError) return out({ error: err.message, condition: err.code });
        throw err;
      }
    },
  });

  registerTool({
    tier: 1 as AiToolTier,
    domain: 'devices',
    searchHint: 'status of diagnostic access requests and approved read-only grants',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'list_diagnostic_access_grants',
      description: 'List YOUR diagnostic access requests and grants (pending, active; optionally past ones) with their paths, operations, approver and expiry.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Only this device' },
          includeInactive: { type: 'boolean', description: 'Include denied, revoked and expired grants' },
          limit: { type: 'number', description: 'Max grants to return (default 25, max 100)' },
        },
      },
    },
    handler: async (input, auth) => {
      const limit = Math.min(Math.max(Number(input.limit ?? 25) || 25, 1), 100);
      const rows = await listDiagnosticGrants(auth, {
        deviceId: input.deviceId as string | undefined,
        includeInactive: input.includeInactive === true,
        limit,
        scope: grantListScope(auth),
      });
      return out({ grants: rows.map(grantView), approvalsUrl: approvalsUrl() });
    },
  });

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'devices',
    searchHint: 'withdraw a diagnostic access request or end an approved read-only grant early',
    definition: {
      name: 'revoke_diagnostic_access',
      description: 'Revoke an active diagnostic access grant or withdraw a pending request. Takes effect for every command not yet delivered.',
      input_schema: {
        type: 'object' as const,
        properties: {
          grantId: { type: 'string', description: 'The grant id' },
          reason: { type: 'string', description: 'Optional reason, recorded in the audit log' },
        },
        required: ['grantId'],
      },
    },
    handler: async (input, auth) => {
      if (isAiAgentPrincipal(auth)) return refuseAgentPrincipal('revoke_diagnostic_access');
      const r = await revokeDiagnosticGrant(auth, input.grantId as string, (input.reason as string | undefined) ?? null);
      if (!r.ok) return out({ error: r.message, condition: r.code });
      return out({ ...grantView(r.grant), message: 'Revoked.' });
    },
  });

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'devices',
    searchHint: 'list a folder under an approved read-only diagnostic grant',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'diagnostic_list_directory',
      description: 'List one page of a directory under your ACTIVE diagnostic access grant (read-only). Links and junctions are shown, never followed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          path: { type: 'string', description: 'Absolute directory path inside the approved locations' },
          offset: { type: 'number', description: 'Entries to skip (use nextOffset from the previous page)' },
          limit: { type: 'number', description: `Max entries per page (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT})` },
        },
        required: ['deviceId', 'path'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      return runDiagnosticCommand(auth, deviceId, 'list', input.path as string, {
        offset: Math.max(0, Math.floor(Number(input.offset ?? 0) || 0)),
        limit: Math.min(Math.max(Math.floor(Number(input.limit ?? LIST_DEFAULT_LIMIT) || LIST_DEFAULT_LIMIT), 1), LIST_MAX_LIMIT),
      }, (type, payload) => aiExecuteCommand(auth, 'diagnostic_list_directory', deviceId, type, payload, {
        userId: auth.user?.id,
        timeoutMs: 30000,
      }));
    },
  });

  registerTool({
    tier: 2 as AiToolTier,
    domain: 'devices',
    searchHint: 'read part of a log file under an approved read-only diagnostic grant',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'diagnostic_read_file',
      description: 'Read a bounded chunk of a file under your ACTIVE diagnostic access grant (read-only). Page large logs with offset/nextOffset. Secrets in the content are redacted (contentRedacted: true when any were).',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          path: { type: 'string', description: 'Absolute file path inside the approved locations' },
          offset: { type: 'number', description: 'Byte offset to start at (use nextOffset from the previous read)' },
          maxBytes: { type: 'number', description: `Bytes to read (default ${READ_DEFAULT_BYTES}, max ${READ_MAX_BYTES})` },
          encoding: { type: 'string', enum: ['text', 'base64'], description: 'text (default) or base64 for binary files' },
        },
        required: ['deviceId', 'path'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      return runDiagnosticCommand(auth, deviceId, 'read', input.path as string, {
        offset: Math.max(0, Math.floor(Number(input.offset ?? 0) || 0)),
        maxBytes: Math.min(Math.max(Math.floor(Number(input.maxBytes ?? READ_DEFAULT_BYTES) || READ_DEFAULT_BYTES), 1), READ_MAX_BYTES),
        encoding: input.encoding === 'base64' ? 'base64' : 'text',
      }, (type, payload) => aiExecuteCommand(auth, 'diagnostic_read_file', deviceId, type, payload, {
        userId: auth.user?.id,
        timeoutMs: 30000,
      }));
    },
  });
}
