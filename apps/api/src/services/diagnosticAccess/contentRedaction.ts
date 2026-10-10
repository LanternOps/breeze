/**
 * Secret redaction for file content returned by a diagnostic read, applied
 * before the content reaches the AI assistant (aiToolsDiagnosticAccess.ts).
 *
 * Credential stores themselves are never readable through a grant
 * (./classification.ts), but an ordinary log or config file can still carry a
 * password assignment, a bearer token or a pasted private key. This reuses the
 * two existing redactors rather than adding a third rule set:
 *   - `redactSecretsFromOutput` (../secretRedaction.ts): PEM private-key
 *     blocks, AWS key ids, bearer tokens, JWTs, connection strings and
 *     `secret=`-style pairs — the rules the agent applies to script output;
 *   - `redactAiToolOutputText` (../aiToolOutput.ts): the assignment rules and
 *     bare vendor-token shapes every AI tool result already passes through.
 *
 * Base64 content is decoded byte-for-byte (latin1), redacted and re-encoded
 * only when something was actually redacted, so binary content without a
 * match is returned unchanged.
 */
import { redactAiToolOutputText } from '../aiToolOutput';
import { redactSecretsFromOutput } from '../secretRedaction';

function redactText(text: string): string {
  return redactAiToolOutputText(redactSecretsFromOutput(text));
}

export function redactDiagnosticContent(
  content: string,
  encoding: 'text' | 'base64',
): { content: string; redacted: boolean } {
  // Content that does not round-trip as base64 is redacted as text, so a
  // mislabelled answer can never skip redaction.
  if (encoding === 'base64' && Buffer.from(content, 'base64').toString('base64') === content) {
    const bytes = Buffer.from(content, 'base64').toString('latin1');
    const redacted = redactText(bytes);
    if (redacted === bytes) return { content, redacted: false };
    return { content: Buffer.from(redacted, 'latin1').toString('base64'), redacted: true };
  }
  const redacted = redactText(content);
  return { content: redacted, redacted: redacted !== content };
}
