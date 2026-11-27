/**
 * Keep a value that came from outside the process on one log line.
 *
 * The API logs plain text through `console.*`, and each line becomes its own
 * entry downstream (Docker json-file → promtail → Loki). A value that carries
 * CR/LF — an error body from a tenant-configured webhook, IdP or model
 * endpoint — could otherwise start a new, genuine-looking log entry. These
 * helpers escape line breaks and other control characters; they do not
 * redact (use `logRedaction.ts` for secrets).
 */

// C0 controls, DEL, C1 controls (incl. NEL U+0085), and the Unicode line and
// paragraph separators.
// eslint-disable-next-line no-control-regex
const LOG_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeChar(char: string): string {
  return NAMED_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** `String(value)` with line breaks and control characters escaped. */
export function logLine(value: unknown): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.replace(LOG_UNSAFE, escapeChar);
}

const MAX_CAUSE_DEPTH = 3;
const STACK_FRAME = /^\s+at /;

function errorHeadline(error: Error, depth: number): string {
  let head = `${logLine(error.name || 'Error')}: ${logLine(error.message)}`;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    head += ` [cause: ${cause instanceof Error ? errorHeadline(cause, depth + 1) : logLine(cause)}]`;
  }
  return head;
}

/**
 * An error for logging: the name and message (and cause chain) escaped onto
 * one line, followed by the original stack frames. Frames come from our own
 * code paths, so they keep their line breaks; only the `at …` lines that
 * follow the original message are kept, so a forged frame inside the message
 * cannot survive as a separate line.
 */
export function logError(error: unknown): string {
  if (!(error instanceof Error)) return logLine(error);
  const headline = errorHeadline(error, 0);
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const rawHeader = `${error.name || 'Error'}: ${error.message}`;
  if (!stack.startsWith(rawHeader)) return headline;
  const frames = stack
    .slice(rawHeader.length)
    .split('\n')
    .filter((line) => STACK_FRAME.test(line));
  return frames.length > 0 ? `${headline}\n${frames.join('\n')}` : headline;
}
