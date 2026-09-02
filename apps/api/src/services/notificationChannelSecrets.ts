import { decryptForColumn, encryptSecret } from './secretCrypto';
import { redactSecretsFromOutput } from './secretRedaction';

const MASKED_SECRET = '********';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMaskedSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^\*+$/.test(value.trim());
  }
  return isRecord(value) && (value.redacted === true || value.hasSecret === true || value.masked === MASKED_SECRET);
}

function secretMarker(value: unknown) {
  return {
    redacted: true,
    hasSecret: value !== null && value !== undefined && value !== '',
    masked: MASKED_SECRET,
  };
}

function encryptValue(value: unknown, existing: unknown): unknown {
  if (isMaskedSecret(value)) return existing;
  if (typeof value !== 'string' || value.length === 0) return value;
  return encryptSecret(value);
}

// Channel configs live in notification_channels.config (JSON); webhook headers
// live in webhooks.headers (JSON). Pass the column-level AAD so AAD-bound
// ciphertext written by the registry walker decrypts under the matching tag.
function decryptValueFor(aadColumn: 'notification_channels.config' | 'webhooks.headers') {
  const [table, column] = aadColumn.split('.') as [string, string];
  return (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    return decryptForColumn(table, column, value);
  };
}

function redactValue(value: unknown): unknown {
  return secretMarker(value);
}

function transformHeaderValues(
  headers: unknown,
  existing: unknown,
  transform: (value: unknown, existing: unknown) => unknown,
): unknown {
  if (Array.isArray(headers)) {
    const existingHeaders = Array.isArray(existing) ? existing : [];
    return headers.map((entry, index) => {
      if (!isRecord(entry)) return entry;
      const existingEntryByKey = existingHeaders.find((candidate) =>
        isRecord(candidate) && candidate.key === entry.key
      );
      const existingEntry = isRecord(existingEntryByKey)
        ? existingEntryByKey
        : isRecord(existingHeaders[index])
          ? existingHeaders[index]
          : {};
      return {
        ...entry,
        value: transform(entry.value, existingEntry.value),
      };
    });
  }

  if (isRecord(headers)) {
    const existingRecord = isRecord(existing) ? existing : {};
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, transform(value, existingRecord[key])])
    );
  }

  return headers;
}

function transformSecretKeys(
  config: unknown,
  existing: unknown,
  keys: string[],
  transform: (value: unknown, existing: unknown) => unknown,
): unknown {
  if (!isRecord(config)) return config;
  const existingRecord = isRecord(existing) ? existing : {};
  const output: JsonRecord = { ...config };

  for (const key of keys) {
    if (key in output) {
      output[key] = transform(output[key], existingRecord[key]);
    } else if (key in existingRecord) {
      output[key] = existingRecord[key];
    }
  }

  if ('headers' in output) {
    output.headers = transformHeaderValues(output.headers, existingRecord.headers, transform);
  } else if ('headers' in existingRecord) {
    output.headers = existingRecord.headers;
  }

  return output;
}

function secretKeysForType(type: string): string[] {
  switch (type) {
    case 'slack':
    case 'teams':
      return ['webhookUrl'];
    case 'pagerduty':
      return ['routingKey', 'integrationKey'];
    case 'pushover':
      return ['token', 'user'];
    case 'webhook':
      return ['url', 'authToken', 'authPassword', 'apiKeyValue'];
    default:
      return [];
  }
}

export function encryptNotificationChannelConfig(type: string, config: unknown, existing?: unknown): unknown {
  return transformSecretKeys(config, existing, secretKeysForType(type), encryptValue);
}

export function decryptNotificationChannelConfig(type: string, config: unknown): unknown {
  const decrypt = decryptValueFor('notification_channels.config');
  return transformSecretKeys(config, undefined, secretKeysForType(type), (value) => decrypt(value));
}

export function redactNotificationChannelConfig(type: string, config: unknown): unknown {
  return transformSecretKeys(config, undefined, secretKeysForType(type), (value) => redactValue(value));
}

export function decryptWebhookHeaders(headers: unknown): unknown {
  const decrypt = decryptValueFor('webhooks.headers');
  return transformHeaderValues(headers, undefined, (value) => decrypt(value));
}

export function encryptWebhookHeaders(headers: unknown, existing?: unknown): unknown {
  return transformHeaderValues(headers, existing, encryptValue);
}

export function redactWebhookHeaders(headers: unknown): unknown {
  return transformHeaderValues(headers, undefined, (value) => redactValue(value));
}

export function isMaskedIntegrationSecret(value: unknown): boolean {
  return isMaskedSecret(value);
}

// --- Persisting a channel-test failure reason (#3697) ------------------------
//
// The test route stores the provider's error message so the card can say WHY a
// test failed after a reload, not just that it did. That message comes from a
// third party and routinely quotes the destination back at us. For slack,
// teams and webhook channels the destination URL *is* the credential — it is
// in `secretKeysForType` above precisely because anyone holding it can post as
// the channel. Persisting an unscrubbed message would hand that URL to every
// user with alerts:read, and the export/erasure path would then carry it too.
//
// So the message is scrubbed before it is written, in two complementary
// passes. This lives here rather than in the route because this module is the
// single source of truth for which config keys are secret — a new secret key
// added to `secretKeysForType` is scrubbed automatically.
//
//   1. Literal scrub against the channel's OWN decrypted secret values. This is
//      the pass that matters for slack/teams/webhook, and no pattern-matcher
//      can do it: a Slack incoming-webhook URL is an ordinary-looking
//      `https://hooks.slack.com/services/...` with nothing to key off. Knowing
//      the value is the only reliable way to remove it.
//   2. `redactSecretsFromOutput`, the repo's existing free-text scrubber for
//      persisted `lastError`-style columns. Webhook, PagerDuty and Pushover all
//      echo up to 500 characters of the DESTINATION's response body into the
//      error (`webhookSender.ts`, `pagerDutySender.ts`, `pushoverSender.ts`) —
//      untrusted, third-party-controlled text that can carry a bearer token, a
//      JWT or a `token=` pair the channel config never contained.
//
// Pass 1 runs first: pass 2 rewrites spans of the string, which would break a
// literal match that straddled one.
//
// NOT stripped: the SMS recipient number, which `smsSender.ts` concatenates
// into every failed-send message. It is not secret here — `secretKeysForType`
// does not list `phoneNumbers`, so the channel's recipient list is already
// returned verbatim to every `alerts:read` caller — and "+1555...: not a mobile
// number" is precisely the reason an operator needs to see.

// Below this length a "secret" is too short to substring-match safely: a
// 3-character Pushover user would blank unrelated text throughout the message.
const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

// Provider errors that echo a whole response body are unbounded. The card
// shows a reason, not a payload dump.
export const MAX_CHANNEL_TEST_ERROR_LENGTH = 500;

/**
 * The channel's own credential strings, longest first.
 *
 * Exported because the senders need it BEFORE they compose an operator-facing
 * message. `scrubChannelTestError` runs at the route, on text the sender has
 * already stripped of markup, decoded entities in, and collapsed whitespace in
 * — and it matches by literal substring, so any of those transforms can rewrite
 * a configured secret into something that no longer matches itself. Redaction
 * therefore has to happen on the RAW body, before the first lossy step; the
 * route scrub stays as the second half of the bracket (#3992).
 */
export function collectChannelSecretStrings(type: string, config: unknown): string[] {
  return collectSecretStrings(type, config);
}

function collectSecretStrings(type: string, config: unknown): string[] {
  if (!isRecord(config)) return [];
  const found: string[] = [];

  const consider = (value: unknown) => {
    if (typeof value === 'string' && value.trim().length >= MIN_SCRUBBABLE_SECRET_LENGTH) {
      found.push(value.trim());
    }
  };

  for (const key of secretKeysForType(type)) consider(config[key]);

  // Webhook auth material also rides in headers, whose values are encrypted by
  // `transformHeaderValues` above and are just as secret as the named keys.
  const headers = config.headers;
  if (Array.isArray(headers)) {
    for (const entry of headers) if (isRecord(entry)) consider(entry.value);
  } else if (isRecord(headers)) {
    for (const value of Object.values(headers)) consider(value);
  }

  // Longest first: a URL and its origin can both be secrets, and replacing the
  // longer one first stops a shorter prefix from carving it into fragments.
  return found.sort((a, b) => b.length - a.length);
}

/**
 * Redact a channel's own secret values out of a provider error message and cap
 * its length, producing a string that is safe to persist and show on the card.
 *
 * `config` must be the DECRYPTED config — the ciphertext in the column never
 * appears in a provider message, so scrubbing against it would be a no-op.
 * Returns null for a message that is empty or becomes empty after scrubbing,
 * so callers store NULL rather than an empty string.
 */
export function scrubChannelTestError(type: string, config: unknown, message: unknown): string | null {
  if (typeof message !== 'string') return null;

  let scrubbed = message;

  // Pass 1 — the channel's own secret values.
  for (const secret of collectSecretStrings(type, config)) {
    // split/join, not RegExp: secrets contain regex metacharacters (`?`, `.`,
    // `+` are all ordinary in a URL) and escaping them is a bug waiting to
    // happen. Literal substring replacement cannot be fooled.
    scrubbed = scrubbed.split(secret).join(MASKED_SECRET);
  }

  // Belt and braces for a destination the sender normalised (a trailing slash,
  // a re-encoded query) so it no longer matches the configured string
  // byte-for-byte: strip URL userinfo wherever it appears.
  scrubbed = scrubbed.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASKED_SECRET}@`);

  // Pass 2 — well-known secret shapes in the echoed third-party response body.
  scrubbed = redactSecretsFromOutput(scrubbed);

  scrubbed = scrubbed.trim();
  if (scrubbed.length === 0) return null;

  return scrubbed.length > MAX_CHANNEL_TEST_ERROR_LENGTH
    ? `${scrubbed.slice(0, MAX_CHANNEL_TEST_ERROR_LENGTH - 1)}…`
    : scrubbed;
}
