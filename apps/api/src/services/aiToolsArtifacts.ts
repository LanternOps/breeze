/**
 * `read_artifact` (A-W05 D13a/D13b, spec execution-plane §5.2, §9) — the
 * model's own way back into a large tool result it just staged.
 *
 * Every oversized tool result is captured as an `input_capture` artifact
 * (`artifacts/toolResultCapture.ts`) whose store copy is REDACTED, never raw
 * (D13b). This tool pages that stored copy back by BYTE OFFSET through
 * `readArtifactWindow` — a whole-object read per page would be O(n^2) egress
 * on a 64 MiB artifact.
 *
 * SCOPE IS STRICTER THAN THE REST DOWNLOAD (`GET /ai/artifacts/:id`, org-wide
 * for anyone with `ai_agents:read`). `read_artifact` requires the artifact be
 * anchored to THIS call's own agent run or THIS call's own current chat
 * session — never "any session belonging to this user" (Q4). The anchor is
 * not derived here: `executeTool` computes it once, with the exact same
 * `captureContextFrom` capture writes use, and threads it through
 * `ToolExecutionContext.captureAnchor` (see `aiTools.ts`). A call with no
 * anchor (no attributable org/run/session) refuses rather than reading
 * unscoped.
 *
 * captureExempt: the result already IS a handle/window; running the capture
 * wrapper over it would store a copy of a pointer.
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';
import { aiWorkspaceEnabled } from '../config/env';
import { ARTIFACT_READ_MAX_CHARS, artifactDownloadContentType, findArtifactForCaller, readArtifactWindow } from './artifacts/artifactService';
import { sanitizeThrownToolError } from './aiToolErrors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NOT_FOUND = JSON.stringify({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });

const DEFAULT_MAX_CHARS = 4_000;

function noAnchor(): string {
  return JSON.stringify({
    error: 'no_capture_anchor',
    message: 'This call has no agent run or chat session to scope the read by; narrow the original query instead.',
  });
}

function storeUnavailable(): string {
  return JSON.stringify({
    error: 'artifact_store_unavailable',
    message: 'Artifact capture is not enabled on this deployment; narrow the original query instead.',
  });
}

export function registerArtifactTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('read_artifact', {
    tier: 1,
    domain: 'ai',
    searchHint: 'stored tool-result artifacts by handle, paging through oversized output',
    captureExempt: true,
    deviceArgs: [],
    definition: {
      name: 'read_artifact',
      description:
        'Read a window of a stored large tool result by its artifact handle (artifact.handle in an earlier result). Returns text from a byte offset with nextOffset and hasMore. Only artifacts from your own session or run.',
      input_schema: {
        type: 'object' as const,
        properties: {
          handle: { type: 'string', description: 'Artifact handle (UUID) from artifact.handle' },
          offset: { type: 'number', description: 'Byte offset to start from; pass nextOffset to continue (default 0)' },
          maxChars: { type: 'number', description: `Max characters to return (default ${DEFAULT_MAX_CHARS}, max ${ARTIFACT_READ_MAX_CHARS})` },
        },
        required: ['handle'],
      },
    },
    handler: async (input: Record<string, unknown>, _auth: AuthContext, context?: ToolExecutionContext) => {
      if (!aiWorkspaceEnabled()) return storeUnavailable();

      const handle = typeof input.handle === 'string' ? input.handle : '';
      if (!UUID_RE.test(handle)) return NOT_FOUND;

      // Q4: the anchor threaded by executeTool — the SAME one capture would
      // write with. No anchor means no attributable run/session, which must
      // refuse rather than fall back to an unscoped (or guessed) lookup.
      const anchor = context?.captureAnchor;
      if (!anchor) return noAnchor();

      try {
        const record = await findArtifactForCaller(handle, anchor);
        if (!record) return NOT_FOUND;

        const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
        const requested = Math.trunc(Number(input.maxChars)) || DEFAULT_MAX_CHARS;
        const maxChars = Math.min(Math.max(1, requested), ARTIFACT_READ_MAX_CHARS);
        const window = await readArtifactWindow(record, offset, maxChars);

        return JSON.stringify({
          handle: record.id,
          name: record.name,
          contentType: artifactDownloadContentType(record.contentType),
          bytes: record.bytes,
          offset,
          nextOffset: window.nextOffset,
          hasMore: window.hasMore,
          text: window.text,
        });
      } catch (err) {
        return JSON.stringify({ error: 'read_artifact_failed', message: sanitizeThrownToolError('read_artifact', err) });
      }
    },
  });
}
