// Display helpers for output captured from a device-side process (installer,
// pre/post-install script, vendor CLI). Vendor tools such as ctrld colour their
// log lines with ANSI escapes, which read as garbage outside a terminal
// (#10307). These helpers return plain text only; callers must still render it
// as text (a React text node, never innerHTML).

// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Any other two-byte escape (ESC followed by one final byte), e.g. ESC c, ESC =.
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE = /\u001b[@-Z\\-_]/g;
// SGR written out in caret notation by a terminal capture ("^[[31m").
const CARET_SGR = /\^\[\[[0-9;]*m/g;
// C0/C1 controls other than \t and \n (\r is folded first).
// eslint-disable-next-line no-control-regex
const STRAY_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Input bound for stripAnsi, in UTF-16 code units: 256 KiB, 8x the agent's
 * 32 KiB installer-output cap (agent result_limits.go
 * maxInstallerOutputBytes), so real output is never cut. Longer input keeps
 * its TAIL, where a failing tool prints its reason. The bound caps the work
 * done on device-controlled text; every pattern below is also linear.
 */
export const STRIP_ANSI_MAX_INPUT_CHARS = 256 * 1024;

/** The final frame of a line a terminal redrew with bare \r (spinners). Linear. */
function lastCarriageReturnFrame(line: string): string {
  // A trailing \r overwrites nothing; skip it without a /\r+$/ regex, which
  // backtracks quadratically on a long \r run that is not at the end.
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 13) end--;
  const start = line.lastIndexOf('\r', end - 1) + 1;
  return line.slice(start, end);
}

/** Remove ANSI/VT escape sequences and stray control characters. */
export function stripAnsi(text: string): string {
  const bounded =
    text.length > STRIP_ANSI_MAX_INPUT_CHARS ? text.slice(text.length - STRIP_ANSI_MAX_INPUT_CHARS) : text;
  return bounded
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(OTHER_ESCAPE, '')
    .replace(CARET_SGR, '')
    .replace(/\r\n/g, '\n')
    // A bare \r is a terminal overwrite (progress spinner): keep the frame
    // that was left on screen, not every frame as its own line.
    .split('\n')
    .map(lastCarriageReturnFrame)
    .join('\n')
    .replace(STRAY_CONTROLS, '');
}

export interface CommandOutputExcerpt {
  text: string;
  /** True when lines or characters were dropped to fit the bounds. */
  truncated: boolean;
}

export const COMMAND_OUTPUT_EXCERPT_MAX_LINES = 8;
export const COMMAND_OUTPUT_EXCERPT_MAX_CHARS = 600;

/**
 * The tail of a process's output, ANSI-stripped and bounded, for showing
 * beside an exit code. The tail because vendor tools print the failure reason
 * last. Returns null when nothing printable remains.
 */
export function commandOutputExcerpt(
  output: string | null | undefined,
  opts: { maxLines?: number; maxChars?: number } = {},
): CommandOutputExcerpt | null {
  if (!output) return null;
  const maxLines = Math.max(1, opts.maxLines ?? COMMAND_OUTPUT_EXCERPT_MAX_LINES);
  const maxChars = Math.max(2, opts.maxChars ?? COMMAND_OUTPUT_EXCERPT_MAX_CHARS);

  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;

  let truncated = lines.length > maxLines;
  let text = lines.slice(-maxLines).join('\n');
  if (text.length > maxChars) {
    truncated = true;
    let tail = text.slice(text.length - (maxChars - 1));
    // Do not start on the low half of a surrogate pair.
    const first = tail.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
    text = `…${tail}`;
  }
  return { text, truncated };
}
