/**
 * `manage_fleet_designs` (full-control W16 PR B, #6786): chat's door to a Fleet
 * Design, over the same services as routes/fleetDesign.ts (W07-D2).
 *
 * Classes (aiGuardrails.ts, W16 plan class review):
 *  - `preview` and `applied` are tier 1: they write nothing. `preview` still needs
 *    `devices:write` and MFA, as its route does, and takes a short row lock.
 *  - `run` and `document` are supervised. `run` is a recorded exception to the class
 *    rule (Decision 1): it uses credits and notifies people, but what it produces is
 *    findings.
 *  - `apply` and `rollback` are four-eyes with a mandatory effect digest (Decision 5).
 *    Apply bills through role corrections and reaches every device the design names;
 *    rollback removes monitoring and reverses those roles.
 *
 * THE LOCK. Both release paths verify the digest in an earlier transaction than the
 * one that writes (Fact 8). So `apply` and `rollback` run only as a release carrying
 * `verifiedFleetDesignBinding`, and take the report-run lock before re-deriving the
 * digest. A change committed in between refuses with `CONTENT_CHANGED` and writes
 * nothing. The re-derivation reads system-scoped on a short second connection, exactly
 * as the resolver did: a partner-wide row an org session sees differently cannot turn
 * a real match into a refusal, and it reads committed state, which is all there is
 * before this handler's first write. The lock serializes same-report operations only:
 * an independent policy or group edit after this re-check is an ordinary concurrent
 * edit, and the ledger records what landed.
 *
 * Gates beyond the shared services: a site- or device-restricted session is refused on
 * every action (Decision 6, stricter than REST for `run`, `applied` and `document`), an
 * `ai_agent` principal is refused beside `AGENT_HUMAN_ONLY_TOOLS` (Decision 7),
 * `scripts:write` is needed when `automation` is non-empty (preview, apply), and
 * `document` passes `linkDeliverableEvidence` explicitly because omitting it links.
 *
 * A business failure is an `error` envelope (no `success`, `data` or `configured` key),
 * so a release records a refused, blocked or partial write as failed.
 */
import { randomUUID } from 'node:crypto';
import type { FleetDesignApproval } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { requestLikeFromSnapshot } from './auditEvents';
import { aiCallerPermissions } from './aiToolCallerPermissions';
import { mfaGatedToolError } from './aiToolMfaGate';
import { FLEET_DESIGN_ACTIONS, fleetDesignToolSchemas } from './aiToolSchemasFleetDesigns';
import { auditToolWrite, bounded, json, jsonError, notFound, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { orgAdminInputSchema, parseInput, restrictedSessionDenied } from './aiToolsOrgAdminShared';
import { hasPermission, PERMISSIONS } from './permissions';
import { captureException } from './sentry';
import type { ToolExecutionContext } from './toolExecutionContext';

const TOOL = 'manage_fleet_designs';
const WHAT = 'A Fleet Design';

type Action = (typeof FLEET_DESIGN_ACTIONS)[number];

/** Which fields each action takes; any other present field is refused rather than ignored. */
const ACTION_FIELDS: Readonly<Record<Action, { required: readonly string[]; optional: readonly string[] }>> = {
  run: { required: ['orgId'], optional: ['siteId'] },
  preview: { required: ['reportRunId', 'approval'], optional: [] },
  applied: { required: ['reportRunId'], optional: [] },
  apply: { required: ['reportRunId', 'approval'], optional: [] },
  rollback: { required: ['reportRunId'], optional: [] },
  document: { required: ['reportRunId'], optional: [] },
};

function fieldError(action: Action, input: Record<string, unknown>): string | null {
  const { required, optional } = ACTION_FIELDS[action];
  for (const key of required) {
    if (input[key] === undefined) return jsonError(`${action} needs ${key}`, 'VALIDATION_ERROR');
  }
  for (const key of ['orgId', 'siteId', 'reportRunId', 'approval']) {
    if (input[key] !== undefined && !required.includes(key) && !optional.includes(key)) {
      return jsonError(`${action} takes no ${key}`, 'VALIDATION_ERROR');
    }
  }
  return null;
}

async function can(auth: AuthContext, grant: { resource: string; action: string }): Promise<boolean> {
  const permissions = await aiCallerPermissions(auth);
  return Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));
}

function scriptsWriteRefusal(): string {
  return jsonError('This approval creates scripts, which needs the scripts:write permission', 'SCRIPTS_WRITE_REQUIRED');
}

const REPORT_NOT_FOUND = () => notFound('Fleet Design');

/**
 * The refs one error envelope carries. The worker stores at most 64 KiB and records an
 * error body it had to truncate as a COMPLETED release, and an approval can name
 * thousands of refs. Counts stay whole; the ledger (`applied`) has every row.
 */
const ERROR_REF_CAP = 100;
const firstRefs = <T>(refs: readonly T[] | undefined): T[] => (refs ?? []).slice(0, ERROR_REF_CAP);

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runDesign(auth: AuthContext, orgId: string, siteId: string | undefined, context?: ToolExecutionContext): Promise<string> {
  const { launchFleetDesignRun } = await import('./fleetDesign/runLaunch');
  const intentId = context?.actionIntentId;
  const audit = (resourceId: string | undefined, details: Record<string, unknown>, ok: boolean) => auditToolWrite(auth, {
    orgId: auth.canAccessOrg(orgId) ? orgId : auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
    action: 'ai_fleet_design.run.manual_trigger',
    resourceType: 'ai_agent',
    ...(resourceId ? { resourceId } : {}),
    details: { via: 'ai_tool', siteId: siteId ?? null, ...details },
    result: ok ? 'success' : 'failure',
  });
  let result: Awaited<ReturnType<typeof launchFleetDesignRun>>;
  try {
    // A retried release of one intent is one run; a second approved card is a second run.
    result = await launchFleetDesignRun(
      auth,
      { orgId, ...(siteId ? { siteId } : {}) },
      `design-ai-tool-${intentId ?? randomUUID()}`,
      { replay: Boolean(intentId) },
    );
  } catch (error) {
    audit(undefined, { refused: 'THROWN', requestedOrgId: orgId }, false);
    throw error;
  }
  const queued = result.ok && !result.enqueueFailed;
  const skipped = result.ok ? (result.enqueueFailed ? 'enqueue_failed' : undefined) : result.code === 'SKIPPED' ? result.skipped : undefined;
  audit('agentId' in result ? result.agentId : undefined, {
    ...(result.ok ? { runId: result.runId, ...(result.replayed ? { replayed: true } : {}) } : {}),
    ...(skipped ? { skipped } : {}),
    ...(!result.ok && result.code !== 'SKIPPED' ? { refused: result.code, requestedOrgId: orgId } : {}),
  }, queued);
  if (!result.ok && result.code === 'NOT_FOUND') return notFound('Organization or site');
  if (!result.ok && result.code === 'NO_DESIGNER_AGENT') {
    return jsonError('This organization has no designer agent. Enable it on the Fleet Design page.', 'NO_DESIGNER_AGENT');
  }
  if (!result.ok || result.enqueueFailed) return JSON.stringify({ error: 'The Fleet Design run was not started', code: 'RUN_SKIPPED', skipped });
  return json({ queued: true, runId: result.runId, ...(result.replayed ? { replayed: true } : {}) });
}

// ---------------------------------------------------------------------------
// apply / rollback: the release gate
// ---------------------------------------------------------------------------

type HeldReport = { orgId: string };

/**
 * Takes the report-run lock, then proves the state under it is the state the approval
 * was verified against. Returns the locked report, or the refusal to return as it is.
 */
async function lockAndReverify(
  auth: AuthContext,
  action: 'apply' | 'rollback',
  input: Record<string, unknown>,
  reportRunId: string,
  binding: { digest: string },
): Promise<{ report: HeldReport } | { refusal: string }> {
  const { lockReportRun } = await import('./fleetDesign/ledger');
  const report = await lockReportRun(reportRunId, (col) => auth.orgCondition(col));
  if (!report) return { refusal: REPORT_NOT_FOUND() };

  const { computeEffectDigestForRelease } = await import('./actionIntents/effectDigest');
  const recomputed = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => computeEffectDigestForRelease(TOOL, input, db, { intentOrgId: report.orgId })));
  if (recomputed.digest !== binding.digest) {
    auditToolWrite(auth, {
      orgId: report.orgId,
      action: `fleet_design.${action}`,
      resourceType: 'report_run',
      resourceId: reportRunId,
      details: { via: 'ai_tool', reportRunId, refused: 'CONTENT_CHANGED' },
      result: 'failure',
    });
    return { refusal: jsonError('This Fleet Design or the devices and policies it touches changed after approval; nothing was changed. Preview it again and ask for a new approval.', 'CONTENT_CHANGED') };
  }
  return { report };
}

async function applyDesign(auth: AuthContext, input: Record<string, unknown>, reportRunId: string, approval: FleetDesignApproval, binding: { digest: string }): Promise<string> {
  const held = await lockAndReverify(auth, 'apply', input, reportRunId, binding);
  if ('refusal' in held) return held.refusal;
  const { orgId } = held.report;
  const audit = (details: Record<string, unknown>, ok: boolean) => auditToolWrite(auth, {
    orgId,
    action: 'fleet_design.apply',
    resourceType: 'report_run',
    resourceId: reportRunId,
    details: { via: 'ai_tool', reportRunId, ...details },
    result: ok ? 'success' : 'failure',
  });

  const [{ applyFleetDesign }, { FleetDesignApplyError }] = await Promise.all([import('./fleetDesign/apply'), import('./fleetDesign/preview')]);
  try {
    const result = await applyFleetDesign(auth, reportRunId, approval, requestLikeFromSnapshot({}));
    audit({ applied: result.applied.length, skipped: result.skipped.length, partial: result.partial }, !result.partial);
    if (result.partial) {
      // What landed stays landed and is in the ledger. The step's raw reason stays in
      // the audit row: it is a driver message, not something to hand the model.
      return JSON.stringify({
        error: `The apply stopped at step ${result.partial.failedStep}. What it applied before that stays applied; use rollback to undo it.`,
        code: 'FLEET_DESIGN_PARTIAL',
        applied: firstRefs(result.applied),
        skipped: firstRefs(result.skipped),
        counts: { applied: result.applied.length, skipped: result.skipped.length },
        failedStep: result.partial.failedStep,
        rollbackAvailable: result.rollbackAvailable,
      });
    }
    return json({ applied: result.applied, skipped: result.skipped, rollbackAvailable: result.rollbackAvailable });
  } catch (error) {
    if (error instanceof FleetDesignApplyError && error.code === 'blocked') {
      audit({ applied: 0, blocked: true }, false);
      const blockers = (error.payload?.blockers ?? []) as unknown[];
      const unaccepted = (error.payload?.unaccepted ?? []) as unknown[];
      return JSON.stringify({
        error: 'This approval is blocked; nothing was changed. Resolve the blockers and ask for a new approval.',
        code: 'BLOCKED',
        blockers: firstRefs(blockers),
        unaccepted: firstRefs(unaccepted),
        counts: { blockers: blockers.length, unaccepted: unaccepted.length },
      });
    }
    if (error instanceof FleetDesignApplyError && (error.code === 'not_found' || error.code === 'no_outcome')) {
      audit({ refused: 'NOT_FOUND' }, false);
      return REPORT_NOT_FOUND();
    }
    audit({ refused: 'THROWN' }, false);
    throw error;
  }
}

async function rollbackDesign(auth: AuthContext, input: Record<string, unknown>, reportRunId: string, binding: { digest: string }): Promise<string> {
  const held = await lockAndReverify(auth, 'rollback', input, reportRunId, binding);
  if ('refusal' in held) return held.refusal;
  const { rollbackFleetDesign } = await import('./fleetDesign/rollback');
  // Without scripts:write everything else still rolls back; the service refuses only the script rows.
  const canWriteScripts = await can(auth, PERMISSIONS.SCRIPTS_WRITE);
  const audit = (details: Record<string, unknown>, ok: boolean) => auditToolWrite(auth, {
    orgId: held.report.orgId,
    action: 'fleet_design.rollback',
    resourceType: 'report_run',
    resourceId: reportRunId,
    details: { via: 'ai_tool', reportRunId, ...details },
    result: ok ? 'success' : 'failure',
  });
  let result: Awaited<ReturnType<typeof rollbackFleetDesign>>;
  try {
    result = await rollbackFleetDesign(auth, reportRunId, requestLikeFromSnapshot({}), { canWriteScripts });
  } catch (error) {
    audit({ refused: 'THROWN' }, false);
    throw error;
  }
  audit({
    rolledBack: result.rolledBack.length,
    refused: result.refused.length,
    ...(result.refused.length > 0 ? { refusedItems: firstRefs(result.refused) } : {}),
  }, result.refused.length === 0);
  if (result.refused.length > 0) {
    // Not "because they changed": the service reports any failure on a row as modified_since_apply.
    return JSON.stringify({
      error: 'Some items were not rolled back and stay as they are. Each refusal gives its reason.',
      code: 'ROLLBACK_PARTIAL',
      rolledBack: firstRefs(result.rolledBack),
      refused: firstRefs(result.refused),
      counts: { rolledBack: result.rolledBack.length, refused: result.refused.length },
    });
  }
  return json({ rolledBack: result.rolledBack });
}

// ---------------------------------------------------------------------------
// Reads and document
// ---------------------------------------------------------------------------

async function previewDesign(auth: AuthContext, reportRunId: string, approval: FleetDesignApproval): Promise<string> {
  const [{ previewFleetDesignApply, FleetDesignApplyError }] = await Promise.all([import('./fleetDesign/preview')]);
  try {
    return bounded(await previewFleetDesignApply(auth, reportRunId, approval));
  } catch (error) {
    if (error instanceof FleetDesignApplyError && (error.code === 'not_found' || error.code === 'no_outcome')) return REPORT_NOT_FOUND();
    throw error;
  }
}

async function appliedItems(auth: AuthContext, reportRunId: string): Promise<string> {
  const [{ loadFleetDesignReport }, { loadLedger, toLedgerItem }] = await Promise.all([
    import('./aiAgents/fleetDesignReport'),
    import('./fleetDesign/ledger'),
  ]);
  const report = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
  if (!report) return REPORT_NOT_FOUND();
  const rows = await loadLedger(reportRunId, report.orgId);
  // Not `createdRefs`: those carry whole monitor snapshots, and rollback reads them, not the model.
  return bounded({
    items: rows.map(toLedgerItem).map(({ itemRef, itemKind, status, step, error, appliedAt, rolledBackAt }) => ({
      itemRef, itemKind, status, step, error, appliedAt, rolledBackAt,
    })),
  });
}

/** Why a caller who holds contracts:write still links no evidence (#11433); absent when the role alone decided. */
type EvidenceSkip = 'wisp_ceiling' | 'wisp_grant_inactive';

/**
 * Whether `document` may attach the design as deliverable evidence: a contracts:write effect, decided on the caller's
 * live role as on REST. #11433: under a Wisp grant (`document` is delegable) the chat ceiling checked documents:write
 * only, so the link must also sit inside the grant's ceiling for the report's org. A ceiling without it, or a grant
 * that no longer resolves, links nothing and says why (the document is still filed: documents:write passed the
 * gate). A corrupt pin is captured and, like a DB error, propagates, so nothing is filed.
 */
async function deliverableEvidenceDecision(auth: AuthContext, orgId: string): Promise<{ link: boolean; skipped?: EvidenceSkip }> {
  if (!(await can(auth, PERMISSIONS.CONTRACTS_WRITE))) return { link: false };
  const grant = auth.wispGrant;
  if (!grant) return { link: true };
  // Lazy, as the chat gate loads it: an ordinary session never loads the Wisp graph.
  const { CeilingViolationError, GrantInactiveError, assertWithinCeiling, resolveGrantCeiling } = await import('./wisp/grantAuthority');
  try {
    const ceiling = await resolveGrantCeiling(grant.grantId, grant.grantRevisionId);
    assertWithinCeiling(ceiling, { orgId, permission: `${PERMISSIONS.CONTRACTS_WRITE.resource}:${PERMISSIONS.CONTRACTS_WRITE.action}` });
    return { link: true };
  } catch (err) {
    // A paused grant surfaces as CeilingViolationError('inactive') from assertWithinCeiling or as GrantInactiveError.
    if (err instanceof CeilingViolationError) return { link: false, skipped: err.code === 'inactive' ? 'wisp_grant_inactive' : 'wisp_ceiling' };
    if (err instanceof GrantInactiveError && err.kind !== 'corrupt') return { link: false, skipped: 'wisp_grant_inactive' };
    if (err instanceof GrantInactiveError) captureException(err, undefined, { grantId: grant.grantId, op: 'fleet_design.document' });
    throw err;
  }
}

async function fileDocument(auth: AuthContext, reportRunId: string): Promise<string> {
  const [{ loadFleetDesignReport }, { fileFleetDesignDocument }] = await Promise.all([
    import('./aiAgents/fleetDesignReport'),
    import('./fleetDesign/documents'),
  ]);
  const report = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
  if (!report) return REPORT_NOT_FOUND();
  try {
    const evidence = await deliverableEvidenceDecision(auth, report.orgId);
    const result = await fileFleetDesignDocument({
      orgId: report.orgId,
      reportRunId,
      actor: { userId: auth.user?.id ?? null, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds },
      // Explicit: omitting it links. Attaching can mark a contract deliverable delivered.
      linkDeliverableEvidence: evidence.link,
    });
    // `evidence: null` alone also means "no deliverable to attach to"; a grant-caused skip is said apart.
    const skipped = evidence.skipped ? { evidenceSkipped: evidence.skipped } : {};
    auditToolWrite(auth, {
      orgId: report.orgId,
      action: 'fleet_design.document.file',
      resourceType: 'org_document',
      resourceId: result.documentId,
      details: { via: 'ai_tool', reportRunId, alreadyFiled: result.alreadyFiled, evidence: result.evidence, ...skipped },
      result: 'success',
    });
    return json({ ...result, ...skipped });
  } catch (error) {
    // The document services carry their own structural status and code, as the route maps them.
    const known = error && typeof error === 'object' && 'status' in error && 'code' in error
      && typeof (error as { status: unknown }).status === 'number' && typeof (error as { code: unknown }).code === 'string'
      ? error as { status: number; code: string; message?: string }
      : null;
    auditToolWrite(auth, {
      orgId: report.orgId,
      action: 'fleet_design.document.file',
      resourceType: 'report_run',
      resourceId: reportRunId,
      details: { via: 'ai_tool', reportRunId, refused: known?.code ?? 'THROWN' },
      result: 'failure',
    });
    if (!known) throw error;
    if (known.status < 500) return jsonError(known.message ?? known.code, known.code);
    captureException(error);
    return jsonError('The document could not be filed', known.code);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFleetDesignTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'run a Fleet Design for an org, preview and apply it, undo it, or file it in the org documents',
    definition: {
      name: TOOL,
      description:
        'Act on a Fleet Design. run (uses AI credits); preview, then apply (two approvers; bills role changes and reaches devices); applied; rollback (two approvers); document. Find designs with list_fleet_designs.',
      input_schema: orgAdminInputSchema(fleetDesignToolSchemas.manage_fleet_designs),
    },
    // Declares `context` directly: a truncating wrapper would read it as undefined forever.
    handler: async (input, auth, context) => {
      const parsed = parseInput(fleetDesignToolSchemas.manage_fleet_designs, input);
      if (!parsed.ok) return parsed.error;
      const { action, orgId, siteId, reportRunId, approval } = parsed.value;
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const denied = restrictedSessionDenied(auth, WHAT) ?? fieldError(action, input) ?? mfaGatedToolError(TOOL, action, auth);
      if (denied) return denied;

      try {
        if (action === 'run') return await runDesign(auth, orgId!, siteId, context);
        if (action === 'applied') return await appliedItems(auth, reportRunId!);
        if (action === 'document') return await fileDocument(auth, reportRunId!);

        if (action === 'preview' || action === 'apply') {
          if (approval!.automation.length > 0 && !(await can(auth, PERMISSIONS.SCRIPTS_WRITE))) return scriptsWriteRefusal();
        }
        if (action === 'preview') return await previewDesign(auth, reportRunId!, approval!);

        // apply, rollback: only as the release of their own approved intent.
        const binding = context?.verifiedFleetDesignBinding;
        if (!binding || !context?.actionIntentId) {
          return jsonError(`${action} runs only as the release of its own approved request`, 'APPROVAL_REQUIRED');
        }
        return action === 'apply'
          ? await applyDesign(auth, input, reportRunId!, approval!, binding)
          : await rollbackDesign(auth, input, reportRunId!, binding);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
