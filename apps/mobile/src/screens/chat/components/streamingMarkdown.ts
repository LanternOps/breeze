/**
 * Sanitizes an in-flight (still-streaming) assistant message buffer for
 * `MarkdownBody` (#5170).
 *
 * `react-native-markdown-display` renders an unclosed inline marker
 * literally: while a reply is streaming, a partial buffer like
 * `Fetching **IPFSVCHOST /` prints the `**` as text because the closing
 * marker hasn't arrived yet. The final buffer is always well-formed, so this
 * must only be applied to the in-flight frame, never to a completed message.
 *
 * Approach: for each inline marker (`**`, `__`, `*`, `_`, a single
 * backtick), count its occurrences in the buffer. Content before the
 * currently-streaming token was already valid markdown in an earlier frame,
 * so an odd count means exactly one dangling opener — the last occurrence —
 * and it's safe to drop just that one. Fenced code blocks are left alone
 * entirely: an open fence renders as code, which is an acceptable in-flight
 * look, and stripping markers out of code content would be wrong anyway.
 */
export function sanitizeStreamingMarkdown(buffer: string): string {
  if (!buffer) return buffer;

  const fenceCount = (buffer.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) {
    // Inside an unterminated fenced code block — leave the whole buffer
    // untouched, including any backticks/asterisks the code happens to contain.
    return buffer;
  }

  // Protect *completed* fenced blocks from marker scanning too: only the
  // text outside them can contain a dangling marker from the current turn.
  const fenceRegex = /```[\s\S]*?```/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(buffer))) {
    result += stripDanglingInlineMarkers(buffer.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  result += stripDanglingInlineMarkers(buffer.slice(lastIndex));
  return result;
}

function stripDanglingInlineMarkers(text: string): string {
  let result = text;
  result = stripIfOddCount(result, '**');
  result = stripIfOddCount(result, '__');
  result = stripDanglingSingleMarker(result, '*');
  result = stripDanglingSingleMarker(result, '_');
  result = stripIfOddCount(result, '`');
  return result;
}

/** Non-overlapping occurrence count of `marker` in `text`. */
function countOccurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Drops the LAST occurrence of `marker` when the buffer has an odd count of it. */
function stripIfOddCount(text: string, marker: string): string {
  const count = countOccurrences(text, marker);
  if (count === 0 || count % 2 === 0) return text;
  const lastIndex = text.lastIndexOf(marker);
  return text.slice(0, lastIndex) + text.slice(lastIndex + marker.length);
}

/**
 * Same idea as `stripIfOddCount`, but for a single-character marker (`*` or
 * `_`) that also has to dodge two things `**`/`__` counting doesn't:
 *  - a character that's part of a doubled run (already handled above), and
 *  - a `*` shaped like a (possibly in-progress) list-item bullet — `* ` at
 *    the start of a line, or just `*` at the very end of the buffer on its
 *    own line while streaming hasn't delivered the trailing space yet. That
 *    is a list marker, not an emphasis opener, and must not be stripped.
 */
function stripDanglingSingleMarker(text: string, marker: '*' | '_'): string {
  const indices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== marker) continue;
    if (text[i - 1] === marker || text[i + 1] === marker) continue;

    if (marker === '*') {
      const atLineStart = i === 0 || text[i - 1] === '\n';
      const next = text[i + 1];
      const isBulletShape = atLineStart && (next === undefined || /\s/.test(next));
      if (isBulletShape) continue;
    }

    indices.push(i);
  }

  if (indices.length === 0 || indices.length % 2 === 0) return text;
  const last = indices[indices.length - 1];
  return text.slice(0, last) + text.slice(last + 1);
}
