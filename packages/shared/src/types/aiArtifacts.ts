/**
 * AI run artifacts (execution-plane spec 2026-09-13 §5.2 / §6.1). An artifact
 * is bytes a tool or a workspace step produced, stored out of the model's
 * context and referenced by an opaque handle (`id`). The wire shape is what the
 * run page (W05) renders and what `GET /ai/agents/runs/:runId/artifacts`
 * returns; the API never exposes the blob key.
 */
export const AI_ARTIFACT_KINDS = ['input_capture', 'step_script', 'step_stdout', 'output', 'report'] as const;
export type AiArtifactKind = (typeof AI_ARTIFACT_KINDS)[number];

export interface AiRunArtifactDto {
  id: string;
  runId: string | null;
  sessionId: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** First ≤ 2048 bytes of the RAW content, UTF-8 decoded, secret-redacted. Text-escape before rendering. */
  headPreview: string;
  /** Last ≤ 2048 bytes, same treatment. */
  tailPreview: string;
  sourceDeviceId: string | null;
  createdByTool: string;
  expiresAt: string;
  createdAt: string;
  /** `/api/v1/ai/artifacts/<id>` — always served as an attachment. */
  downloadPath: string;
}
