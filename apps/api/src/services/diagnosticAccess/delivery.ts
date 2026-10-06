/**
 * Delivery-time authorization for diag_file_list / diag_file_read.
 *
 * The queued command stores { grantId, path, offset, maxBytes | limit,
 * encoding, resultPublicKey } — never an authorization. When the command is
 * claimed for delivery (heartbeat or WebSocket push), this refresher re-reads
 * the grant, re-checks every condition against the live device row, and mints
 * a signed authorization bound to THIS command id and these exact arguments.
 * Anything wrong refuses delivery outright (CommandDeliveryRefusedError), so a
 * grant revoked or expired while a command sat in the queue stops it.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { CommandDeliveryRefusedError, type DeliveryRefreshContext } from '../commandDeliveryRefusal';
import { createAuditLog } from '../auditService';
import { DIAGNOSTIC_AUTHORIZATION_PAYLOAD_KEY, signDiagnosticAuthorization } from './authorization';
import { evaluateGrantCoverage, loadGrant, type DiagnosticOperation } from './grants';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export async function prepareDiagnosticDelivery(
  operation: DiagnosticOperation,
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<Record<string, unknown>> {
  if (payload[DIAGNOSTIC_AUTHORIZATION_PAYLOAD_KEY] !== undefined) {
    // The stored payload must never carry an authorization: one arriving here
    // was not minted by this refresher.
    throw new CommandDeliveryRefusedError('diagnostic command payload already carries an authorization');
  }
  const grantId = str(payload.grantId);
  const path = str(payload.path);
  const resultPublicKey = str(payload.resultPublicKey);
  const offset = nonNegInt(payload.offset);
  if (!grantId || !path || !resultPublicKey || offset === null) {
    throw new CommandDeliveryRefusedError('diagnostic command payload is incomplete');
  }
  const maxBytes = operation === 'read' ? nonNegInt(payload.maxBytes) : 0;
  const limit = operation === 'list' ? nonNegInt(payload.limit) : 0;
  const encoding = operation === 'read' ? str(payload.encoding) : '';
  if (maxBytes === null || limit === null || encoding === null) {
    throw new CommandDeliveryRefusedError('diagnostic command payload is incomplete');
  }

  const grant = await loadGrant(grantId);
  if (!grant) throw new CommandDeliveryRefusedError('diagnostic access grant no longer exists');
  const [device] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
        .from(devices)
        .where(eq(devices.id, ctx.deviceId))
        .limit(1),
    ),
  );
  if (!device) throw new CommandDeliveryRefusedError('device no longer exists');
  // The command must have been queued by the grant's requesting USER.
  // runDiagnosticCommand is the only queuer and already checks the exact
  // principal (findCoveringGrant: same user session, API key or OAuth grant);
  // device_commands records only the user, so this second check is at user
  // granularity and cannot tell two keys of the same user apart.
  const [cmd] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ createdBy: deviceCommands.createdBy })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, ctx.commandId))
        .limit(1),
    ),
  );
  if (!cmd || cmd.createdBy !== grant.requestedByUserId) {
    throw new CommandDeliveryRefusedError('diagnostic command was not queued by the grant\'s requesting user');
  }
  const now = new Date();
  const coverage = evaluateGrantCoverage(grant, device, path, operation, now);
  if (!coverage.ok) {
    throw new CommandDeliveryRefusedError(`diagnostic access ${coverage.reason}: ${coverage.detail}`);
  }
  if (!grant.approvedByUserId || !grant.expiresAt) {
    throw new CommandDeliveryRefusedError('diagnostic access grant has no recorded approval');
  }
  const authorization = await signDiagnosticAuthorization({
    commandId: ctx.commandId,
    grantId: grant.id,
    deviceId: device.id,
    orgId: device.orgId,
    operation,
    requestPath: path,
    offset,
    maxBytes,
    limit,
    encoding,
    resultPublicKey,
    roots: grant.scopes.map((s) => ({ path: s.path, recursive: s.recursive })),
    sensitiveClasses: grant.sensitiveClasses,
    approvedBy: grant.approvedByUserId,
    grantExpiresAt: grant.expiresAt,
    now,
  });
  // Durable record BEFORE the agent can read anything: this is written even if
  // the API never sees the result (timeout, crash). The tool writes a second
  // record with the outcome and resolved target when the answer arrives.
  // No audit, no delivery.
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        createAuditLog({
          orgId: device.orgId,
          // The principal the command runs for (its grant's beneficiary).
          actorType: grant.beneficiaryKind === 'api_key' ? 'api_key' : 'user',
          actorId: grant.beneficiaryKind === 'api_key' ? grant.beneficiaryId : grant.requestedByUserId,
          action: operation === 'read' ? 'diagnostic_access.file_read_authorized' : 'diagnostic_access.directory_list_authorized',
          resourceType: 'device',
          resourceId: device.id,
          details: {
            grantId: grant.id,
            approvedBy: grant.approvedByUserId,
            beneficiaryKind: grant.beneficiaryKind,
            beneficiaryId: grant.beneficiaryId,
            commandId: ctx.commandId,
            authorizationId: authorization.authorizationId,
            path,
            offset,
            maxBytes: operation === 'read' ? maxBytes : null,
            limit: operation === 'list' ? limit : null,
            expiresAt: authorization.expiresAt,
          },
          result: 'success',
        }),
      ),
    );
  } catch (err) {
    throw new CommandDeliveryRefusedError(`diagnostic access audit could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Last look after signing and auditing: a revocation (or expiry, or org
  // change) that committed while this delivery was in flight wins, and the
  // just-minted authorization is never handed over.
  const latest = await loadGrant(grant.id);
  const still = latest ? evaluateGrantCoverage(latest, device, path, operation, new Date()) : null;
  if (!still?.ok) {
    throw new CommandDeliveryRefusedError(`diagnostic access ${still ? still.reason : 'no_grant'}: grant changed during delivery`);
  }
  return { ...payload, [DIAGNOSTIC_AUTHORIZATION_PAYLOAD_KEY]: authorization };
}
