/**
 * Backend dispatch for the caller-verification mailbox read (#6354 W03).
 *
 * Reads the target's mailbox resource (`id, userPrincipalName, mail,
 * proxyAddresses`) by pinned Entra object id, through exactly ONE backend:
 *   1. the org's legacy-direct Graph connection, else
 *   2. the customer-graph-read control plane, else
 *   3. the single active Delegant connection for the subject's tenant.
 * A selected backend's failure is final — never a fallback to another one —
 * and every failure throws (the gate turns it into `subject_mailboxes_unknown`
 * for email candidates only).
 *
 * Internal and gate-only: not an AI tool, and it never takes or fabricates an
 * AuthContext. It runs with no request context; each backend probe is a short,
 * org-filtered system read that closes before any outbound I/O. The acting
 * technician comes from `withMailboxReader` (mailboxReader.ts).
 *
 * Kept out of aiToolsM365.ts on purpose: the gate is loaded by global workers,
 * and the AI tool module graph reaches socket-local dispatch
 * (workerEntrypointClosure.contract.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema/m365';
import { delegantM365Connections } from '../../db/schema/delegant';
import {
  DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN, DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID,
} from '../../config/env';
import { hasDirectM365Connection, readMailboxesDirect } from '../m365DirectGraph';
import { executeM365MailboxReadByOrg } from '../m365ControlPlane/readActionService';
import { invokeDelegantTool } from '../delegantClient';
import { currentMailboxReader } from './mailboxReader';
import type { EntraSubject } from './types';

export async function fetchMailboxResourceByOrg(orgId: string, subject: EntraSubject): Promise<unknown> {
  const technicianUserId = currentMailboxReader();
  if (!technicianUserId) throw new Error('mailbox_reader_missing');

  if (await withSystemDbAccessContext(() => hasDirectM365Connection(orgId), 'callerVerification.mailboxes.directProbe')) {
    const result = await readMailboxesDirect(orgId, { userId: subject.entraOid, expectedTenantId: subject.entraTenantId });
    if (result.kind !== 'ok') throw new Error(`mailbox_read_failed:direct:${result.code}`);
    return result.data;
  }

  const [readConnection] = await withSystemDbAccessContext(() => db.select({ id: m365Connections.id }).from(m365Connections)
    .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'customer-graph-read'))).limit(1),
  'callerVerification.mailboxes.controlPlaneProbe');
  if (readConnection) {
    const result = await executeM365MailboxReadByOrg(orgId, subject, technicianUserId);
    if (!result.ok || result.kind !== 'resource') {
      throw new Error(`mailbox_read_failed:control_plane:${result.ok ? result.kind : result.code}`);
    }
    return result.resource;
  }

  const connections = await withSystemDbAccessContext(() => db.select().from(delegantM365Connections).where(and(
    eq(delegantM365Connections.orgId, orgId),
    eq(delegantM365Connections.status, 'active'),
    eq(delegantM365Connections.m365TenantId, subject.entraTenantId),
  )), 'callerVerification.mailboxes.delegantProbe');
  if (connections.length !== 1) throw new Error('mailbox_connection_ambiguous_or_missing');
  const connection = connections[0]!;
  if (connection.orgId !== orgId || connection.m365TenantId !== subject.entraTenantId) throw new Error('tenant_mismatch');
  const result = await invokeDelegantTool({
    connection,
    toolName: 'get_user_mailboxes',
    parameters: { userId: subject.entraOid, expectedTenantId: subject.entraTenantId },
    // Same static principal convention as aiToolsM365 `principals()`.
    actingUser: { breezeUserId: technicianUserId, delegantPrincipalId: process.env.DELEGANT_ACTING_USER_ID ?? '' },
    agent: { delegantPrincipalId: process.env.DELEGANT_AGENT_ID ?? '' },
    // Audit correlation for this internal read — not an interactive session.
    sessionId: `caller-verification:${randomUUID()}`,
  }, { env: { DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN, DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID } });
  if (result.kind !== 'ok') throw new Error(`mailbox_read_failed:delegant:${result.code}`);
  return result.data;
}
