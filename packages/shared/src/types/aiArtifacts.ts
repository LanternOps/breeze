/**
 * AI run artifacts (execution-plane spec 2026-09-13 §5.2 / §6.1). An artifact
 * is bytes a tool or a workspace step produced, stored out of the model's
 * context and referenced by an opaque handle (`id`). The wire shape is what the
 * run page (W05) renders and what `GET /ai/agents/runs/:runId/artifacts`
 * returns; the API never exposes the blob key.
 */
export const AI_ARTIFACT_KINDS = ['input_capture', 'step_script', 'step_stdout', 'output', 'report'] as const;
export type AiArtifactKind = (typeof AI_ARTIFACT_KINDS)[number];

/** Preview text is escaped, never rendered as markup. Unknown/binary types have no preview. */
export function isTextArtifactContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mime?.startsWith('text/') === true || [
    'application/json', 'application/jsonl', 'application/x-ndjson',
    'application/xml', 'application/yaml', 'application/x-yaml',
  ].includes(mime ?? '');
}

export interface AiRunArtifactDto {
  id: string;
  runId: string | null;
  sessionId: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** First ≤ 2048 characters of RAW text, secret-redacted; empty for binary content. Text-escape before rendering. */
  headPreview: string;
  /** Last ≤ 2048 characters, same treatment. */
  tailPreview: string;
  sourceDeviceId: string | null;
  createdByTool: string;
  expiresAt: string;
  createdAt: string;
  /** `/api/v1/ai/artifacts/<id>` — always served as an attachment. */
  downloadPath: string;
}
