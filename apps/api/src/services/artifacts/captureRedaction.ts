import { scrubErrorFieldsDeep } from '../aiToolErrors';
import { redactAiToolOutputText } from '../aiToolOutput';
import { redactToolOutputFields } from '../logRedaction';

/**
 * A-W05 (D13b / Q5) — redact-then-capture.
 *
 * DEVIATION FROM PLAN: the plan text places `redactForCapture` in
 * `aiToolOutput.ts`. That file is owned by another A-W05 agent working
 * concurrently in this worktree (pagination hints / `_chat.nextStep` /
 * `readCaptureHandle`), so this function lives in its own file instead —
 * `toolResultCapture.ts` imports it from here. Behaviourally identical to
 * what the plan specifies; only the file it lives in differs.
 *
 * What the artifact store receives: the FULL payload, secrets already wiped,
 * nothing compacted or truncated. The org-downloadable artifact store must
 * never hold credential material, even though the model's own view of the
 * result (`compacted`) is unaffected — it was already redacted before this
 * wave, by the existing `compactToolResultForChat` path.
 */
function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'Failed to serialize captured tool output' });
  }
}

/**
 * Redact a raw (pre-compaction) tool-result string for storage in the
 * artifact blob store. Non-JSON text is redacted as text; JSON is walked
 * field-by-field (key-name denylist) and error-shaped subtrees are scrubbed
 * the same way the chat compaction path already does, so a captured result
 * carries exactly the same redaction guarantee as the in-context one.
 */
export function redactForCapture(raw: string): string {
  const parsed = tryParseJson(raw);
  if (parsed === null) return redactAiToolOutputText(raw);
  return safeStringify(redactToolOutputFields(scrubErrorFieldsDeep(parsed), redactAiToolOutputText));
}
