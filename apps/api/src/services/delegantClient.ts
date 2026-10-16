import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { M365_READ_ACTION_FIELDS, m365ReadActionSchema } from '@breeze/shared/m365';
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';

interface MintArgs {
  signingKeyPem: string;
  kid: string;
  agentPrincipalId: string;
  breezeOrgId: string; // accepted but not placed in token; delegantOrgId is authoritative
  delegantOrgId: string;
  actingUserBreezeId: string;
  actingUserDelegantId: string;
  sessionId: string;
  nowSeconds: number;
}

async function mintPrincipalJwt(args: MintArgs): Promise<string> {
  const key = await importPKCS8(args.signingKeyPem, 'EdDSA');
  return new SignJWT({
    breeze_org_id: args.delegantOrgId,
    principal_type: 'breeze_ai_agent',
    breeze_user_id: args.actingUserBreezeId,
    breeze_acting_user_id: args.actingUserDelegantId,
    breeze_session_id: args.sessionId,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: args.kid })
    .setSubject(args.agentPrincipalId)
    .setIssuer('breeze-api')
    .setAudience('delegant')
    .setIssuedAt(args.nowSeconds)
    .setExpirationTime(args.nowSeconds + 60)
    .setJti(randomUUID())
    .sign(key);
}

export const __mintPrincipalJwtForTest = mintPrincipalJwt;

export type DelegantToolName =
  | 'get_user' | 'get_user_signin_activity' | 'list_groups'
  | 'get_group_members' | 'disable_user' | 'reset_user_password'
  // Caller verification (#6354 W03): OID-only mailbox-set read. The broker
  // must implement it against its verified connection tenant; until it does,
  // the unsupported-tool error fails the gate closed.
  | 'get_user_mailboxes';

export type DelegantErrorCode =
  | 'tool_error' | 'unexpected_pending' | 'bad_request' | 'auth_failed'
  | 'forbidden' | 'not_found' | 'delegant_unavailable' | 'delegant_unreachable'
  | 'unexpected';

export interface DelegantInvokeArgs {
  connection: DelegantM365ConnectionRow;
  toolName: DelegantToolName;
  parameters: Record<string, unknown>;
  actingUser: { breezeUserId: string; delegantPrincipalId: string };
  agent: { delegantPrincipalId: string };
  sessionId: string;
}

export type DelegantInvokeResult =
  | { kind: 'ok'; data: unknown; toolCallId?: string }
  | { kind: 'error'; code: DelegantErrorCode; message: string };

interface InvokeDeps {
  env: {
    DELEGANT_BASE_URL: string; DELEGANT_SERVICE_TOKEN: string;
    DELEGANT_PRINCIPAL_SIGNING_KEY: string; DELEGANT_PRINCIPAL_KID: string;
  };
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

const TIMEOUT_MS = 15_000;

export async function invokeDelegantTool(
  args: DelegantInvokeArgs,
  deps: InvokeDeps,
): Promise<DelegantInvokeResult> {
  if (args.toolName === 'get_user_mailboxes') {
    // Pinned subject: an object id (never a UPN) on exactly this connection's tenant.
    const action = m365ReadActionSchema.safeParse({ type: 'm365.user.mailboxes', userId: args.parameters.userId });
    if (!action.success || typeof args.parameters.expectedTenantId !== 'string'
      || args.parameters.expectedTenantId !== args.connection.m365TenantId) {
      return { kind: 'error', code: 'bad_request', message: 'Mailbox subject does not match the connection.' };
    }
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const requestId = randomUUID();

  let token: string;
  try {
    token = await mintPrincipalJwt({
      signingKeyPem: deps.env.DELEGANT_PRINCIPAL_SIGNING_KEY,
      kid: deps.env.DELEGANT_PRINCIPAL_KID,
      agentPrincipalId: args.agent.delegantPrincipalId,
      breezeOrgId: args.connection.orgId,
      delegantOrgId: args.connection.delegantOrgId,
      actingUserBreezeId: args.actingUser.breezeUserId,
      actingUserDelegantId: args.actingUser.delegantPrincipalId,
      sessionId: args.sessionId,
      nowSeconds: now,
    });
  } catch (err) {
    return { kind: 'error', code: 'unexpected', message: `failed to mint token: ${String(err)}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let result: DelegantInvokeResult;
  try {
    const resp = await fetchImpl(`${deps.env.DELEGANT_BASE_URL}/v1/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deps.env.DELEGANT_SERVICE_TOKEN}`,
        'X-Delegant-Principal': token,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({ toolName: args.toolName, parameters: args.parameters }),
      signal: controller.signal,
      // Never follow redirects: a 3xx from a misconfigured/compromised Delegant
      // endpoint would otherwise re-send the Authorization bearer token AND the
      // signed principal JWT to the redirect target (arbitrary host). A redirect
      // is treated as a network error (-> delegant_unreachable).
      redirect: 'error',
    });
    result = await mapResponse(resp);
    if (args.toolName === 'get_user_mailboxes') result = projectMailboxes(result);
  } catch {
    result = { kind: 'error', code: 'delegant_unreachable', message: 'Could not reach the M365 service.' };
  } finally {
    clearTimeout(timer);
  }

  logInvoke({
    toolName: args.toolName, connectionId: args.connection.id,
    customerLabel: args.connection.customerLabel, sessionId: args.sessionId,
    requestId, durationMs: Date.now() - started, result,
  });
  return result;
}

/** Only the four mailbox fields ever leave the client; missing keys stay missing. */
function projectMailboxes(result: DelegantInvokeResult): DelegantInvokeResult {
  if (result.kind !== 'ok') return result;
  const raw = result.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'error', code: 'tool_error', message: 'Unexpected mailbox response.' };
  }
  const data = raw as Record<string, unknown>;
  return {
    ...result,
    data: Object.fromEntries(M365_READ_ACTION_FIELDS['m365.user.mailboxes'].filter((key) => key in data).map((key) => [key, data[key]])),
  };
}

async function mapResponse(resp: Response): Promise<DelegantInvokeResult> {
  const body = await resp.json().catch(() => null) as any;
  if (resp.status === 200) {
    if (body && body.pending === true) {
      return { kind: 'error', code: 'unexpected_pending',
        message: 'Delegant returned a pending approval; expected allow. Check Delegant policy for this org.' };
    }
    if (body && body.isError === true) {
      return { kind: 'error', code: 'tool_error', message: String(body.message ?? 'tool error') };
    }
    return {
      kind: 'ok',
      data: body?.data ?? body,
      ...(typeof body?.toolCallId === 'string' ? { toolCallId: body.toolCallId } : {}),
    };
  }
  const message = String(body?.message ?? body?.error ?? `HTTP ${resp.status}`);
  switch (resp.status) {
    case 400: return { kind: 'error', code: 'bad_request', message };
    case 401: return { kind: 'error', code: 'auth_failed', message };
    case 403: return { kind: 'error', code: 'forbidden', message };
    case 404: return { kind: 'error', code: 'not_found', message };
    default:
      if (resp.status >= 500) return { kind: 'error', code: 'delegant_unavailable', message };
      return { kind: 'error', code: 'unexpected', message };
  }
}

function logInvoke(fields: {
  toolName: string; connectionId: string; customerLabel: string;
  sessionId: string; requestId: string; durationMs: number; result: DelegantInvokeResult;
}): void {
  const base = {
    msg: 'delegant_invoke', toolName: fields.toolName, connectionId: fields.connectionId,
    customerLabel: fields.customerLabel, sessionId: fields.sessionId,
    requestId: fields.requestId, durationMs: fields.durationMs, kind: fields.result.kind,
  };
  if (fields.result.kind === 'error') {
    console.error(JSON.stringify({ ...base, code: fields.result.code, error: fields.result.message.slice(0, 200) }));
  } else {
    console.log(JSON.stringify(base));
  }
}
