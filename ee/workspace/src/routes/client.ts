// End-user client surface (W4): the three calls the Outlook add-in pane's
// filing card makes, mounted by the host under /client/*.
//
// Boundary: core's generic client proxy authenticates the pane user through
// the client-ai Entra exchange and hands this extension an organization-scoped
// auth context; `clientGate` (below, applied to every route in this tree)
// accepts only that shape. Nothing here reads an org from the request.
//
// Governance, applied uniformly and non-negotiably:
//  - org-settings content gate, default-deny (no settings row → DISABLED), so
//    an org that has not turned the content preview on has no client surface
//    at all — 404 `content_disabled`, never a 403/500 that leaks existence;
//  - every query that returns file data passes groupIds `[]` into the single
//    visibility predicate (services/visibility.ts): ungrouped sources only,
//    the same fail-closed stance the helper surface takes, because an Entra
//    session carries no Workspace group claims yet;
//  - every mutating call is audited with the END USER as actor and
//    `via: 'client'`, so a client-filed email is distinguishable from the
//    device/helper path in the audit trail.
import type { ExtensionAuditEvent, ExtensionLog, WorkspaceAudit } from '../hostTypes';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EmailMatchService } from '../services/emailMatchService';
import type { FilingRecord, FilingService } from '../services/filingService';
import { clientGate } from './clientGate';
import type { WorkspaceRouteEnv } from './adminGate';

/**
 * PUBLISHED CONTRACT for Tasks 8/9 (the add-in pane and the beat script).
 *
 * `filing` is deliberately `FilingRecord | null`, a documented widening of the
 * brief's `FilingRecord`: a match can be a file the caller may SEE but cannot
 * FILE — already filed under a project path, or tombstoned — and there is no
 * honest filing record for it. Suppressing the match would be worse (the pane
 * would claim it found nothing about a message it demonstrably located), and
 * synthesizing an empty record would be a lie. So: `match !== null` means "we
 * know which .eml this is"; `match.filing !== null` means "and you may file
 * it". The pane MUST treat `filing: null` as a read-only identification —
 * `POST /filing/:id/assign` will answer 404 for that id.
 */
export interface ClientMatchResponse {
  match: {
    fileIndexId: string;
    tier: 1 | 2 | 3;
    filing: FilingRecord | null;
  } | null;
}

/** `POST /client/filing/:fileIndexId/assign` → 200. */
export interface ClientAssignResponse {
  filing: FilingRecord;
}

/** `GET /client/content/projects` → 200. */
export interface ClientProjectsResponse {
  projects: Array<{ key: string; label: string }>;
}

export interface ClientRouteDeps {
  emailMatchService: Pick<EmailMatchService, 'match'>;
  filingService: Pick<FilingService, 'get' | 'classify' | 'assign' | 'projects'>;
  /** Per-org content flag; no settings row means disabled (default-deny). */
  getSettings: (orgId: string) => Promise<{ contentEnabled: boolean }>;
  audit: WorkspaceAudit;
  log: ExtensionLog;
}

/** Entra sessions carry no Workspace visibility-group claims yet: every read
 * on this surface fails closed to ungrouped sources. One constant so the
 * stance is visible, and changing it is a deliberate single edit. */
const CLIENT_GROUP_IDS: string[] = [];

const matchQuerySchema = z.strictObject({
  subject: z.string().min(1).max(500),
  sender: z.string().min(1).max(320).optional(),
  date: z.iso.datetime().optional(),
  internetMessageId: z.string().min(1).max(998).optional(),
});

const assignSchema = z.strictObject({
  projectKey: z.string().min(1).max(40),
});

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClientRoutes(deps: ClientRouteDeps): Hono<WorkspaceRouteEnv> {
  const app = new Hono<WorkspaceRouteEnv>();

  async function guardedAudit(event: ExtensionAuditEvent, context: string): Promise<void> {
    try {
      await deps.audit(event);
    } catch (error) {
      deps.log('error', `workspace client audit write failed (${context}): ${errorDetail(error)}`);
    }
  }

  // Auth boundary first, then the per-org content gate — an unauthorized
  // caller must never be able to probe whether an org has content enabled.
  app.use('*', clientGate);
  app.use('*', async (c, next) => {
    const settings = await deps.getSettings(c.get('workspaceOrgId'));
    if (!settings.contentEnabled) return c.json({ error: 'content_disabled' }, 404);
    await next();
  });

  /**
   * Which crawled .eml is the message currently open in Outlook, and what do
   * we suggest filing it under?
   *
   * Classify-on-demand: the pane opens on mail that has usually never been
   * looked at by the filing pipeline, so a matched email with no filing row is
   * classified right here (filingService.classify never overwrites a human
   * decision, so this is safe to call repeatedly). A matched file that is not
   * a fileable email in the caller's view — already filed under a project
   * path, tombstoned, or in a hidden source — is reported as a match with a
   * null filing rather than being hidden or synthesized.
   */
  app.get('/filing/match', async (c) => {
    const parsed = matchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const orgId = c.get('workspaceOrgId');

    const match = await deps.emailMatchService.match(orgId, {
      subject: parsed.data.subject,
      ...(parsed.data.sender !== undefined ? { sender: parsed.data.sender } : {}),
      ...(parsed.data.date !== undefined ? { dateISO: parsed.data.date } : {}),
      ...(parsed.data.internetMessageId !== undefined
        ? { internetMessageId: parsed.data.internetMessageId }
        : {}),
    }, CLIENT_GROUP_IDS);
    if (!match) return c.json({ match: null } satisfies ClientMatchResponse);

    const fileable = await deps.filingService.get(orgId, match.fileIndexId, CLIENT_GROUP_IDS);
    let filing: FilingRecord | null = fileable;
    if (fileable && fileable.status === null) {
      filing = await deps.filingService.classify(orgId, match.fileIndexId, CLIENT_GROUP_IDS);
      if (filing) {
        const auth = c.get('auth');
        await guardedAudit({
          orgId,
          actorType: 'user',
          actorId: auth.user.id,
          action: 'workspace.filing.classify',
          resourceType: 'workspace_file',
          resourceId: match.fileIndexId,
          details: {
            suggestedProjectKey: filing.suggestedProjectKey,
            confidence: filing.confidence,
            tier: match.tier,
            via: 'client',
          },
          result: 'success',
        }, `filing classify file=${match.fileIndexId}`);
      }
    }

    return c.json({
      match: { fileIndexId: match.fileIndexId, tier: match.tier, filing },
    } satisfies ClientMatchResponse);
  });

  /**
   * One-click file. Idempotent with the device/helper path by construction:
   * both call the same `filingService.assign`, whose UPDATE is keyed on the
   * (unique) file_index_id, so the same file + project through either path
   * converges to one row with the same status.
   *
   * A malformed id is the contract 404 (unknown-or-hidden file), never a 500 —
   * same 22P02 guard as the helper route.
   */
  app.post('/filing/:fileIndexId/assign', async (c) => {
    const fileIndexId = c.req.param('fileIndexId');
    if (!z.uuid().safeParse(fileIndexId).success) return c.json({ error: 'not found' }, 404);
    const parsed = assignSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
    const orgId = c.get('workspaceOrgId');
    const auth = c.get('auth');
    // decided_label is display text for "who filed it" — the end user's name,
    // falling back to their address. It is never authorization.
    const decidedLabel = auth.user.name ?? auth.user.email ?? null;

    const filing = await deps.filingService.assign(
      orgId, fileIndexId, parsed.data.projectKey, decidedLabel, CLIENT_GROUP_IDS,
    );
    if (!filing) return c.json({ error: 'not found' }, 404);
    await guardedAudit({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      action: 'workspace.filing.assign',
      resourceType: 'workspace_file',
      resourceId: fileIndexId,
      details: { projectKey: parsed.data.projectKey, via: 'client' },
      result: 'success',
    }, `filing assign file=${fileIndexId}`);
    return c.json({ filing } satisfies ClientAssignResponse);
  });

  /** Project picker contents for the card's reassign control. */
  app.get('/content/projects', async (c) => {
    return c.json({
      projects: await deps.filingService.projects(c.get('workspaceOrgId')),
    } satisfies ClientProjectsResponse);
  });

  return app;
}
