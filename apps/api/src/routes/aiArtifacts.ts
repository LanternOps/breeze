import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { captureException } from '../services/sentry';
import { safeContentDispositionFilename } from '../utils/httpHeaders';
import { artifactDownloadContentType, findArtifactForAuth, openArtifactStream } from '../services/artifacts/artifactService';
import { BlobNotFoundError } from '../services/artifacts/blobStorage';

/**
 * AI artifact DOWNLOAD (execution-plane spec §5.2, §8).
 *
 * The per-run LISTING is deliberately NOT here: it is
 * `GET /ai/agents/runs/:runId/artifacts`, and it is registered inside
 * `aiAgentsRoutes` (routes/aiAgents.ts) beside the run detail it shares a
 * prefix with. Mounting a second Hono app at `/ai/agents` would make the
 * precedence between the two depend on mount order in index.ts, invisible from
 * either router — the shape of #4189.
 *
 * RBAC is identical to `GET /ai/agents/runs/:runId`: the same scope set, the
 * same ai_agents:read permission, org scoping through `auth.orgCondition`, and
 * a BARE 404 on every miss. A handle is opaque, so "exists but not yours" must
 * be indistinguishable from "does not exist" — there is deliberately no 403
 * branch in this handler.
 *
 * RENDERING (§8): every response is `Content-Disposition: attachment` plus
 * `X-Content-Type-Options: nosniff`, and the content type comes from the fixed
 * map below — NEVER from the stored string. This is stricter than the ticket
 * attachment route, which serves images inline: an artifact is model- or
 * sandbox-produced content, and no artifact is ever rendered by a browser in a
 * Breeze origin. Bytes are streamed through the API rather than handed out as a
 * presigned redirect, because streaming is the only way to force these two
 * headers on every storage provider.
 */

export const aiArtifactRoutes = new Hono();
aiArtifactRoutes.use('*', authMiddleware);

const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const scopes = requireScope('organization', 'partner', 'system');

const UUID = z.string().guid();

// A-W05 (D13a): the safe-content-type map now lives in artifactService.ts so
// `aiToolsArtifacts.ts` (imported by the `aiTools.ts` hub) can reuse it
// without importing this route module. Re-exported here so this file's own
// callers and its test (`artifactDownloadContentType` from `./aiArtifacts`)
// are unaffected.
export { artifactDownloadContentType };

function notFound(c: { json: (b: unknown, s: 404) => Response }): Response {
  return c.json({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' }, 404);
}

// GET /ai/artifacts/:id — authenticated bytes, always an attachment.
aiArtifactRoutes.get('/:id', scopes, requireAiRead, async (c) => {
  // A non-uuid must never reach the query: Postgres raises 22P02 on the cast
  // and poisons the request transaction, turning a 404 into a 500 at COMMIT.
  const parsedId = UUID.safeParse(c.req.param('id'));
  if (!parsedId.success) return notFound(c);
  const id = parsedId.data;

  const auth = c.get('auth');
  const record = await findArtifactForAuth(id, auth);
  if (!record) return notFound(c);

  let stream: NodeJS.ReadableStream;
  try {
    stream = await openArtifactStream(record);
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      // The row outlived its object (a partially-completed sweep, or a
      // compensating delete that raced). A 404 is honest here.
      console.error('[ai-artifacts] object missing for row', { artifactId: record.id });
      return notFound(c);
    }
    // A transport/auth fault is 503, NEVER a silent 404 — masking it would make
    // a bucket outage look like mass data loss to the technician (#1807/#1808).
    captureException(err);
    return c.json(
      { error: 'Artifact storage is unavailable — try again shortly', code: 'ARTIFACT_STORAGE_UNAVAILABLE' },
      503,
    );
  }

  // Re-sanitised on the way OUT as well as in: a CR/LF or quote reaching this
  // header is response splitting, and the defence must not depend on every row
  // having been written by the current capture path.
  const filename = safeContentDispositionFilename(record.name).replace(/[^\x20-\x7e]/g, '_') || 'artifact';
  return c.body(Readable.toWeb(stream as Readable) as ReadableStream, 200, {
    'Content-Type': artifactDownloadContentType(record.contentType),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(record.bytes),
    'Cache-Control': 'private, no-store',
  });
});
