import { formatRemaining } from './countdown';

/**
 * The two renderer-owned placeholders in agent-rendered prompt copy (spec
 * section 3.1 "copy"): `{remaining}` (live `M:SS` countdown) and
 * `{time:<unixMs>}` (local wall-clock time, with the date when it is not
 * today). Everything else is literal text: operator `{{countdown}}`, unknown
 * `{{x}}`, `{remainder}`, a bare `{`. A token wrapped in another brace (the
 * operator double-brace syntax) is not a token. Substituted text is never
 * rescanned. The result is rendered as React text, never markup.
 *
 * A hand-written scanner rather than a regex with lookbehind, which older
 * macOS WebKit builds cannot parse.
 */

const REMAINING = '{remaining}';
const TIME_PREFIX = '{time:';
/** Largest value `Date` accepts (ms since the epoch). */
const MAX_DATE_MS = 8.64e15;

function formatTime(ms: number, nowMs: number, locale: string): string {
  const date = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', options).format(date);
  }
}

/** The token starting at `i` (which holds `{`), as [replacement, length], or null. */
function tokenAt(
  text: string,
  i: number,
  nowMs: number,
  locale: string,
  deadlineMs: number | null | undefined,
): [string, number] | null {
  // Part of `{{...}}`: operator syntax, not ours.
  if (i > 0 && text[i - 1] === '{') return null;
  let token: string | null = null;
  let replacement: string | null = null;
  if (text.startsWith(REMAINING, i)) {
    token = REMAINING;
    if (deadlineMs != null && Number.isFinite(deadlineMs)) replacement = formatRemaining(deadlineMs, nowMs);
  } else if (text.startsWith(TIME_PREFIX, i)) {
    const close = text.indexOf('}', i + TIME_PREFIX.length);
    if (close < 0) return null;
    const digits = text.slice(i + TIME_PREFIX.length, close);
    if (!/^\d{1,16}$/.test(digits)) return null;
    const ms = Number(digits);
    if (ms > MAX_DATE_MS) return null;
    token = text.slice(i, close + 1);
    replacement = formatTime(ms, nowMs, locale);
  }
  if (token === null || replacement === null) return null;
  // Followed by another `}`: the closing half of `{{...}}`.
  if (text[i + token.length] === '}') return null;
  return [replacement, token.length];
}

export function applyPlaceholders(
  text: string,
  nowMs: number,
  locale: string,
  deadlineMs?: number | null,
): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, brace);
    const hit = tokenAt(text, brace, nowMs, locale, deadlineMs);
    if (hit) {
      out += hit[0];
      i = brace + hit[1];
    } else {
      out += '{';
      i = brace + 1;
    }
  }
  return out;
}
