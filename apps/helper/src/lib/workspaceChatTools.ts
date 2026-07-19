// Workspace chat tools: the two client-declared tools the helper exposes to the
// chat model, plus their client-side executors. The declarations are sent to
// core at session creation (chatStore); execution happens here against the
// Workspace extension's authenticated `/helper/*` endpoints — the same
// URL-builder + helperRequest path workspaceStore uses, so device mTLS, org
// scoping, visibility, and DLP-redacted content all apply by construction.
//
// Executor failures degrade to `{ error: string }` and NEVER throw: the model
// must see a readable, degradable string (the client-ai convention), not a
// rejected tool call.

import { helperRequest } from './helperFetch';
import { workspaceUrl } from './workspaceUrl';
import { useChatStore } from '../stores/chatStore';

/** Wire shape accepted by core's `clientTools` (generic, workspace-agnostic). */
export interface ClientToolDeclaration {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const FILE_LIMIT = 8;
const PASSAGE_LIMIT = 6;
const SNIPPET_MAX = 700;

export const WORKSPACE_CHAT_TOOLS: ClientToolDeclaration[] = [
  {
    name: 'search_workspace_files',
    description:
      "Find files in the user's workspace by keyword. Returns up to 8 matching " +
      'files, each with its file id, relative path, inferred project and document ' +
      'type, and an openable path. Use this to locate documents before reading them.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Keywords to search filenames and content for.' },
        project: { type: 'string', description: 'Optional project label to narrow results.' },
        docType: { type: 'string', description: 'Optional document type to narrow results.' },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_passages',
    description:
      'Retrieve up to 6 relevant text passages from workspace file content to answer ' +
      'a content question. Pass the optional fileIndexId to read passages from one ' +
      'specific file. ALWAYS cite every passage you rely on in your answer using the ' +
      'exact form [file:<fileIndexId>|<relPath>] so the user can open the source file.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'The question or keywords to retrieve passages for.' },
        fileIndexId: {
          type: 'string',
          description: 'Optional file id to restrict passages to a single file.',
        },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
];

// The extension's /search returns FinderFile rows; we surface only the summary
// fields the model needs to cite and open a result.
interface SearchResultFile {
  id: string;
  relPath: string;
  openPath: string | null;
  inferredProjectLabel?: string | null;
  declaredProjectLabel?: string | null;
  inferredDocType?: string | null;
}

interface PassageRow {
  fileIndexId: string;
  relPath: string;
  sourceId: string;
  openPath: string | null;
  snippet: string;
  score: number;
}

function errorString(body: string, fallback: string): string {
  try {
    const data = JSON.parse(body) as { error?: unknown };
    return typeof data.error === 'string' && data.error ? data.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Execute one client-declared workspace tool by name. Returns the tool output
 * (plain JSON the model reads) or a degradable `{ error: string }` — never
 * throws, never surfaces a raw exception to the model.
 */
export async function executeWorkspaceChatTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try {
    const config = useChatStore.getState().agentConfig;
    if (!config) return { error: 'Workspace is not connected.' };

    if (name === 'search_workspace_files') {
      const params = new URLSearchParams({ q: typeof input.q === 'string' ? input.q : '' });
      if (typeof input.project === 'string' && input.project) params.set('project', input.project);
      if (typeof input.docType === 'string' && input.docType) params.set('docType', input.docType);

      const res = await helperRequest(config, workspaceUrl(config, '/search', params), {
        method: 'GET',
      });
      if (!res.ok) return { error: errorString(res.body, 'File search is unavailable right now.') };

      const data = JSON.parse(res.body) as { results?: SearchResultFile[] };
      const files = (data.results ?? []).slice(0, FILE_LIMIT).map((f) => ({
        fileIndexId: f.id,
        relPath: f.relPath,
        project: f.inferredProjectLabel ?? f.declaredProjectLabel ?? null,
        docType: f.inferredDocType ?? null,
        openPath: f.openPath ?? null,
      }));
      return { files };
    }

    if (name === 'get_file_passages') {
      const params = new URLSearchParams({ q: typeof input.q === 'string' ? input.q : '' });
      if (typeof input.fileIndexId === 'string' && input.fileIndexId) {
        params.set('fileIndexId', input.fileIndexId);
      }
      params.set('limit', String(PASSAGE_LIMIT));

      const res = await helperRequest(config, workspaceUrl(config, '/content/passages', params), {
        method: 'GET',
      });
      if (!res.ok) {
        return { error: errorString(res.body, 'Passage retrieval is unavailable right now.') };
      }

      const data = JSON.parse(res.body) as { passages?: PassageRow[] };
      const passages = (data.passages ?? []).slice(0, PASSAGE_LIMIT).map((p) => ({
        fileIndexId: p.fileIndexId,
        relPath: p.relPath,
        sourceId: p.sourceId,
        openPath: p.openPath ?? null,
        snippet: typeof p.snippet === 'string' ? p.snippet.slice(0, SNIPPET_MAX) : '',
        score: p.score,
      }));
      return { passages };
    }

    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
