/**
 * Operator-facing failure messages for outbound HTTP calls.
 *
 * Several senders (webhook, Pushover, PagerDuty) and the webhook-delivery
 * worker compose their failure string by splicing the destination's raw
 * response body straight into `HTTP <status>: <body>`. When the destination
 * answers with an HTML error page — which is what a misconfigured URL usually
 * returns — the operator-facing string becomes 500 characters of markup, and
 * the one token that matters (`HTTP 405`) is buried in the first ten (#3992).
 *
 * That string is not developer log output: it is persisted into
 * `notification_channels.last_test_error` and rendered in the channel card, and
 * it is echoed back in the channel-test response where it becomes a toast. Both
 * surfaces need a short, readable sentence.
 *
 * The unshortened body is not lost anywhere this is used:
 *
 * - `webhookSender` — in its `console.error` line, via `formatHttpFailureDetail`.
 * - `workers/webhookDelivery` — in the delivery record's own `responseBody`
 *   field, which already stored 1000 characters independently of the error.
 * - `pushoverSender` / `pagerDutySender` — in a `console.error` added alongside
 *   this change. Neither logged anything before and neither holds a second copy
 *   of the body, so shortening their `error` string would have been the end of
 *   it — and that string is not a toast: the dispatcher persists it into
 *   `alert_notifications.error_message` on the LIVE alert path, so an on-call
 *   engineer debugging a PagerDuty outage would have been left with 160
 *   characters and nothing else. The log line is not a new secrets surface;
 *   the dispatcher's own `console.error` already carried the unshortened body.
 */

/**
 * Cap for the composed operator-facing message.
 *
 * ~160 characters is room for `HTTP 405` plus a real sentence from the
 * destination, and not enough for a markup dump to bury it. It is a judgement
 * call, not a measurement: the card clamps to two lines and keeps the full
 * string on `title`, so a message slightly over two lines still degrades
 * gracefully — the failure mode this guards against is 500 characters, not 170.
 * Deliberately far below `MAX_CHANNEL_TEST_ERROR_LENGTH` (500), which stays the
 * storage-side backstop for messages that never pass through here (a thrown
 * `Error.message`, a provider SDK string).
 */
export const MAX_OPERATOR_ERROR_LENGTH = 160;

/**
 * How much of the raw body is worth keeping for logs / delivery records.
 * Unchanged from the pre-#3992 splice so debugging loses nothing.
 */
export const MAX_LOGGED_RESPONSE_BODY_LENGTH = 500;

/**
 * How much of the body the normaliser is allowed to look at.
 *
 * `safeFetch` accepts a `maxBytes` ceiling but the senders do not pass one, so
 * a hostile destination can answer with a multi-megabyte body — and
 * `SCRIPT_OR_STYLE_BLOCK` is a lazy scan with a backreference, which degrades
 * to O(opens × length) on a body full of unclosed `<script` tags. Measured: a
 * 1 MB body of 60k unclosed opens took 45 seconds unbounded, under 1 ms
 * bounded. The old code was immune only because it did nothing but
 * `slice(0, 500)`.
 *
 * 8 KB is far more than any error page needs to get its readable sentence out
 * (a `<title>` is in the first few hundred bytes); the cost is that a body whose
 * only prose sits past 8 KB summarises to nothing and the caller falls back to a
 * bare `HTTP <status>`, which is the same outcome as a body of pure markup.
 */
const MAX_SUMMARY_INPUT_LENGTH = 8192;

/**
 * A real HTML tag: a name, then either `>` straight away or whitespace before
 * the attributes. The whitespace requirement is what keeps `<bad@example.com>`
 * — an ordinary shape in an SMTP or validation error — from being mistaken for
 * markup and deleted.
 */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

/** `<script>`/`<style>` are stripped WITH their contents; otherwise a stripped
 * page leaves its CSS behind and the summary reads `body{background:#eee;...}`,
 * which is exactly the noise this is here to remove. */
const SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Same, for a body truncated mid-block by the sender's own cap. */
const UNTERMINATED_SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*$/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#')) {
      const codePoint = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      // Control characters would just become whitespace noise; anything out of
      // range is left as the literal entity. `Infinity` from an absurdly long
      // digit run fails the upper bound and `NaN` fails `isFinite`, so this
      // guard is what actually keeps `fromCodePoint` from throwing — the catch
      // below is belt-and-braces and is unreachable by construction today.
      if (!Number.isFinite(codePoint) || codePoint < 0x20 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/**
 * Truncate at whitespace, or not at all.
 *
 * Readability is only half the reason. `scrubChannelTestError` removes the
 * channel's own credentials by *literal substring* replacement, so a secret cut
 * in half no longer matches and its prefix reaches the channel card and the
 * test toast. A credential is a single unbroken token, so cutting only at
 * whitespace present in the destination's own text means an echoed secret is
 * either wholly kept (and therefore scrubbable) or wholly gone.
 *
 * A window with no whitespace is one opaque blob — the shape a credential has —
 * and is dropped entirely; the caller falls back to a bare `HTTP <status>`.
 * That costs less than it looks: truncation only engages above ~150 characters,
 * so a short minified body (`{"error":"invalid_grant"}`) is returned whole and
 * never reaches this function. What is given up is a partial view of a
 * whitespace-free body longer than the cap — and the unshortened body is still
 * in a log line or a delivery record on every path (see the module header).
 *
 * Four rules were tried before this one, each leaking where the last did not.
 * Recording them because each looked obviously safe until it was executed:
 *
 * 1. Word boundary, honoured only past 60% of the budget. A 77-character
 *    webhook URL at the end of a sentence pushes the last space before that
 *    mark → forced hard cut → 17 characters of the token published.
 * 2. Word boundary wherever it falls, hard cut when there is none. A
 *    destination answering with only `req.originalUrl` has no whitespace at
 *    all → 38 characters of a 151-character URL's token published.
 * 3. Whitespace and structural punctuation as one boundary set. Entity decoding
 *    runs BEFORE this, so a body echoing `TOKEN&quot;PART` puts a `"` INSIDE
 *    the secret → cut landed there → `TOKENPART1` published.
 * 4. Whitespace first, punctuation only as a fallback. Survived every shape
 *    with whitespace in it, but the fallback still cut inside a secret in a
 *    whitespace-free body — and the claim that no credential format allows
 *    those characters was simply wrong: `secretKeysForType('webhook')` covers
 *    `authToken`, `authPassword` and `apiKeyValue`, which are admin-typed with
 *    no charset restriction (`config: z.record(z.string(), z.unknown())`, and
 *    `validateOutboundHeader` constrains header NAMES, not values). A body of
 *    `error=…;description=…(KEY|MORE)…` leaked a 44-character prefix.
 *
 * Residual, stated plainly rather than argued away: a secret that itself
 * contains whitespace could still be split. Nothing here can prevent that —
 * only the scrubber can, and it needs the whole secret to match. Truncation's
 * job is to avoid making the scrubber's job impossible, not to replace it.
 */
function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;

  const budget = maxLength - 1; // room for the ellipsis
  const cut = text.slice(0, budget).lastIndexOf(' ');
  if (cut <= 0) return '';

  const kept = text.slice(0, cut).trimEnd();
  return kept.length === 0 ? '' : `${kept}…`;
}

/** Same placeholder `scrubChannelTestError` uses, so a message that passes
 *  through both reads consistently whichever half caught the secret. */
const MASKED_SECRET = '********';

/**
 * Remove the caller's own credentials from a raw body BEFORE anything rewrites
 * it.
 *
 * This is the load-bearing half of the fix for #3992, and the ordering is the
 * whole point. `scrubChannelTestError` matches secrets by literal substring; a
 * message that has already been entity-decoded, tag-stripped, whitespace-
 * collapsed and truncated is no longer guaranteed to contain the configured
 * string, so scrubbing only afterwards silently publishes the credential.
 *
 * Matching the transformed secret instead of redacting first was considered and
 * is unsound — normalisation is not substring-preserving. A configured
 * `abcd&amp` echoed inside `rejected abcd&amp;` decodes to `rejected abcd&`
 * because the terminating `;` came from OUTSIDE the secret: neither the raw nor
 * the normalised form of the secret appears in the result. Tag stripping splits
 * a secret the same way (`alpha<b>beta` → `alpha beta`), and truncation can cut
 * a whitespace-containing secret in half, leaving a prefix no complete variant
 * can match. Redacting first is immune to all three, because the secret is gone
 * before any of them run.
 */
function maskSecrets(body: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return body;

  // Longest first, de-duplicated, sorted across ALL secrets rather than in the
  // order the caller supplied them: a shorter secret that is a prefix of a
  // longer one would otherwise replace its head and carve the longer one into
  // fragments that no longer match.
  const ordered = [...new Set(secrets)]
    .filter(secret => secret.length > 0)
    .sort((a, b) => b.length - a.length);

  let masked = body;
  // split/join, not RegExp — secrets are full of regex metacharacters (`?`,
  // `.`, `+` are ordinary in a URL) and escaping them is a bug waiting to
  // happen. Same reasoning as `scrubChannelTestError`.
  for (const secret of ordered) masked = masked.split(secret).join(MASKED_SECRET);
  return masked;
}

/**
 * Reduce an untrusted third-party response body to one short readable line:
 * markup removed, entities decoded, whitespace collapsed, length capped.
 *
 * Returns `''` when nothing readable is left (an empty body, or a page that was
 * pure markup) so the caller can drop the separator instead of rendering a
 * dangling `HTTP 405: `.
 */
export function summarizeResponseBody(
  body: string | null | undefined,
  maxLength: number = MAX_OPERATOR_ERROR_LENGTH,
  secrets: readonly string[] = []
): string {
  if (typeof body !== 'string' || body.length === 0) return '';

  // Mask across a window WIDER than the one we summarise, then narrow. A
  // secret that begins inside the summary window always ends within
  // `MAX_SUMMARY_INPUT_LENGTH + longest`, so widening by that much means no
  // occurrence is ever cut in half by the bound before it can be masked.
  // Narrowing afterwards is safe because the whole window was masked — every
  // prefix of it is masked too, including content that masking pulled forward.
  const longestSecret = secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
  const masked = maskSecrets(body.slice(0, MAX_SUMMARY_INPUT_LENGTH + longestSecret), secrets);

  let text = masked
    .slice(0, MAX_SUMMARY_INPUT_LENGTH)
    .replace(SCRIPT_OR_STYLE_BLOCK, ' ')
    .replace(UNTERMINATED_SCRIPT_OR_STYLE, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/, ' ')
    // Doctype and other `<!…>` declarations.
    .replace(/<![^>]*>/g, ' ')
    .replace(HTML_TAG, ' ')
    // Tags and declarations left dangling by a truncated body. The declaration
    // rule needs its own pattern: the tag rule requires a letter after the
    // optional `/`, so it never matches `<!doctype htm` and a body cut mid-
    // doctype used to publish that fragment into the card.
    .replace(/<![^<>]*$/, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?$/i, ' ');

  text = decodeEntities(text)
    // Collapse every run of whitespace — a raw body is full of newlines and
    // indentation that render as a single unreadable smear in a card anyway.
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(text, maxLength);
}

/**
 * Compose the operator-facing message for a non-2xx response.
 *
 * `HTTP 405: The method is not allowed for the requested URL.` — or bare
 * `HTTP 405` when the body carried nothing a human can read.
 */
export type HttpFailureOptions = {
  /**
   * The CALLER's own credential strings, removed from the raw body before any
   * transform runs. Every sender that holds a channel config should pass
   * `collectChannelSecretStrings(type, config)`; omitting it is what let a
   * configured secret survive into the channel card and the test toast (#3992).
   */
  secrets?: readonly string[];
  maxLength?: number;
};

export function formatHttpFailure(
  status: number | undefined,
  body: string | null | undefined,
  options: HttpFailureOptions = {}
): string {
  const { secrets = [], maxLength = MAX_OPERATOR_ERROR_LENGTH } = options;
  const prefix = status === undefined ? 'HTTP error' : `HTTP ${status}`;
  // `: ` is two characters the summary does not get to spend.
  const summary = summarizeResponseBody(body, maxLength - prefix.length - 2, secrets);
  return summary ? `${prefix}: ${summary}` : prefix;
}

/**
 * The unshortened, un-normalised form for logs and delivery records — bounded
 * only so a hostile destination cannot flood them.
 */
export function formatHttpFailureDetail(
  status: number | undefined,
  body: string | null | undefined,
  secrets: readonly string[] = []
): string {
  const prefix = status === undefined ? 'HTTP error' : `HTTP ${status}`;
  if (typeof body !== 'string' || body.length === 0) return prefix;
  // Masked too. This form is un-normalised on purpose so debugging loses
  // nothing, but "un-normalised" was never meant to include the channel's own
  // credentials — and unlike the operator string, nothing downstream scrubs it.
  const longestSecret = secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
  const window = body.slice(0, MAX_LOGGED_RESPONSE_BODY_LENGTH + longestSecret);
  return `${prefix}: ${maskSecrets(window, secrets).slice(0, MAX_LOGGED_RESPONSE_BODY_LENGTH)}`;
}
