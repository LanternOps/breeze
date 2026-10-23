import { z } from 'zod';

/**
 * Install-fallback anchor (#8874, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-18-installer-unblockable-bootstrap-spec.md §3.2).
 *
 * The anchor rides on the onboarding-token response. It pins, by SHA-256, the
 * exact bytes a root/SYSTEM one-liner may install from a pre-agreed artifact
 * source when the control plane is unreachable at the transport level. Clients
 * never verify a signature themselves: the server builds this object only from
 * a release manifest it has already verified, and the client trusts nothing it
 * downloads except bytes whose hash matches an entry here.
 *
 * Every level is strict. An unknown key, a missing asset or a value that is not
 * exactly in wire form makes the whole anchor invalid, and an invalid anchor is
 * the same as no anchor: no fallback, commands byte-identical to today's.
 */

export const INSTALL_FALLBACK_SCHEMA_VERSION = 1 as const;

/** The assets the one-liners consume. All are required in schema 1 (Gate B #4). */
export const INSTALL_FALLBACK_ASSETS = [
  'install.sh',
  'breeze-agent-windows-amd64.exe',
  'breeze-agent-linux-amd64',
  'breeze-agent-linux-arm64',
  'breeze-backup-linux-amd64',
  'breeze-backup-linux-arm64',
  'breeze-agent-darwin-amd64.pkg',
  'breeze-agent-darwin-arm64.pkg',
] as const;

export type InstallFallbackAssetName = (typeof INSTALL_FALLBACK_ASSETS)[number];

export const INSTALL_FALLBACK_RELEASE_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** UTC, whole seconds, `Z` — so every client can compare it as a plain string (Gate B #11). */
export const INSTALL_FALLBACK_VALID_UNTIL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const MACOS_TEAM_ID_RE = /^[A-Z0-9]{10}$/;

// Standard base64 (RFC 4648 §4, padded), the encoding of today's
// X-Breeze-MacOS-Signing-Identity-Base64 header. The manifest caps the identity
// at 256 characters; 1024 leaves room for multi-byte UTF-8.
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SIGNING_IDENTITY_B64_LENGTH = 1024;

// The only characters a base URL may contain. The value is embedded inside a
// PowerShell single-quoted string and a bash double-quoted string, so quotes,
// backticks, `$`, `\`, whitespace, `%` escapes, `?`, `#` and `@` are all out.
const SAFE_BASE_URL_CHARS_RE = /^[A-Za-z0-9._~/:-]+$/;

/**
 * True when `url` may be used as an anchor `baseUrl`: `https://`, a host, no
 * userinfo, query or fragment, a trailing `/`, only `[A-Za-z0-9._~/:-]`, and
 * already in canonical form (the WHATWG serialization equals the input, which
 * rules out upper-case hosts, `.`/`..` segments and an explicit `:443`).
 * Never throws.
 */
export function isSafeInstallFallbackBaseUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  if (!url.startsWith('https://') || !url.endsWith('/')) return false;
  if (!SAFE_BASE_URL_CHARS_RE.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.href === url
  );
}

function isRealUtcInstant(value: string): boolean {
  const ms = Date.parse(value);
  // Date.parse normalizes impossible dates (e.g. Feb 30) in some engines and
  // rejects them in others; round-tripping pins "this exact instant exists".
  return Number.isFinite(ms) && new Date(ms).toISOString() === `${value.slice(0, -1)}.000Z`;
}

const sha256Schema = z.string().regex(SHA256_HEX_RE);

const assetsShape = Object.fromEntries(
  INSTALL_FALLBACK_ASSETS.map((name) => [name, sha256Schema]),
) as { [K in InstallFallbackAssetName]: typeof sha256Schema };

export const installFallbackSchema = z
  .object({
    schema: z.literal(INSTALL_FALLBACK_SCHEMA_VERSION),
    release: z.string().regex(INSTALL_FALLBACK_RELEASE_RE),
    baseUrl: z.string().refine(isSafeInstallFallbackBaseUrl, 'unsafe install-fallback baseUrl'),
    validUntil: z
      .string()
      .regex(INSTALL_FALLBACK_VALID_UNTIL_RE)
      .refine(isRealUtcInstant, 'validUntil is not a real UTC instant'),
    assets: z.object(assetsShape).strict(),
    macosPkgPublisher: z
      .object({
        teamId: z.string().regex(MACOS_TEAM_ID_RE),
        signingIdentityB64: z
          .string()
          .min(4)
          .max(MAX_SIGNING_IDENTITY_B64_LENGTH)
          .regex(STANDARD_BASE64_RE),
      })
      .strict(),
  })
  .strict();

export type InstallFallback = z.infer<typeof installFallbackSchema>;

/** Returns the anchor when it is valid schema-1 wire form, otherwise null. Never throws. */
export function parseInstallFallback(value: unknown): InstallFallback | null {
  if (value === null || value === undefined) return null;
  try {
    const result = installFallbackSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
