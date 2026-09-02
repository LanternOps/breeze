/**
 * Build-time enforcement that a release build's API base URL is reachable from
 * a phone.
 *
 * WHY THIS EXISTS
 * ---------------
 * `EXPO_PUBLIC_API_URL` is the base URL every service module falls back to
 * before the user has picked a server (`getServerUrl()` in
 * `src/services/serverConfig.ts` returns null) — see the same
 * `FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ||
 * 'http://localhost:3001'` fallback at the top of `services/api.ts`,
 * `services/aiChat.ts`, `services/approvals.ts` and six more (exported from
 * `api.ts`, module-private in the other eight).
 *
 * Ship a build where that value is unset or points at `localhost` and the
 * literal string `http://localhost:3001` is compiled into the IPA. On a phone
 * that resolves to the phone itself, so every request fails with a transport
 * error and no server ever sees it. Nothing throws at build time, nothing looks
 * wrong in review, and there is no console to read in TestFlight — the same
 * shape of silent failure as the missing Sentry DSN next door (#3910), which
 * cost this app 90 days of zero telemetry.
 *
 * It is not only the first-run path. `getServerUrl()` also returns null when
 * the SecureStore read THROWS (issue #4002), so a keychain hiccup on a device
 * that had a server configured drops it onto this same fallback. And
 * `SettingsSheet.tsx` hands `FALLBACK_API_BASE_URL` to
 * `getAccountDeletionUrl()`, so a localhost fallback also breaks the account
 * deletion route Apple requires.
 *
 * WHY THIS IS A BUILD FAILURE AND NOT A RUNTIME ONE
 * ------------------------------------------------
 * `EXPO_PUBLIC_*` values are inlined into the bundle by the Metro transform,
 * so this is a compile-time constant: by the time any runtime check could fire,
 * the wrong value is already inside a binary that takes an App Store review
 * cycle to replace. A build that never ships is strictly better than a shipped
 * build that complains. `app.config.js` is the one hook that cannot be skipped
 * — `expo-constants` runs it from an Xcode script build phase on every build
 * (⌘B, Run and Archive alike) and `expo export:embed` runs it on the Android
 * release bundle — which is exactly why the DSN guard lives there too. The
 * pre-existing check in `scripts/preflight.mjs` was never wrong; it was just
 * never run, because nothing invokes it.
 *
 * WHY THE RULES ARE SHAPED THE WAY THEY ARE
 * -----------------------------------------
 * Breeze is self-hostable, so this cannot simply demand a `2breeze.app` host.
 * Loopback is unconditionally fatal: no phone can reach the build machine's
 * loopback, so there is no build where it is right (a Release-configuration
 * simulator run is what `BREEZE_MOBILE_DEV=1` is for). A private-network
 * address IS legitimate for an MSP building an internal-distribution app for a
 * LAN-hosted Breeze, so that one gets a named opt-in rather than a veto —
 * `BREEZE_MOBILE_ALLOW_PRIVATE_API_URL=1`, which is deliberately narrower than
 * `BREEZE_MOBILE_DEV=1` so it does not also switch off the Sentry guard. Like
 * the Sentry guard's `BREEZE_MOBILE_ALLOW_NO_SENTRY`, it WARNS on every build
 * where it rescued a value that would otherwise have failed: an escape hatch
 * nobody can see is the failure mode this file exists to stop.
 *
 * Plain CommonJS on purpose: Expo transpiles `app.config.js` but NOT the
 * modules it requires, so a `.ts` file here fails `expo config` with
 * "Cannot find module".
 */

const {
  easEnvironmentFor,
  isSuppressed,
  releaseBuildReason,
  warnFn,
} = require('./releaseBuild');

/** The public (bundle-inlined) API base URL. Not a secret; see .env.example. */
const API_URL_VAR = 'EXPO_PUBLIC_API_URL';

/** Opt-in for a LAN/self-hosted release build that really does target a private host. */
const ALLOW_PRIVATE_API_URL_VAR = 'BREEZE_MOBILE_ALLOW_PRIVATE_API_URL';

/**
 * Domains reserved by RFC 2606 / RFC 6761 for documentation and examples.
 *
 * Matched as an exact host or a suffix — NOT as a substring, which would
 * reject the real domain `forexample.com` for containing `example.com`.
 */
const RESERVED_EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net', 'example'];

/**
 * Hostname LABELS that mean "somebody left the example value in place".
 *
 * Compared label-by-label rather than as substrings, because a substring match
 * rejects real hosts: `changemedia.com` contains `changeme`. `CHANGEME.acme.com`
 * has `changeme` as a whole label and is caught; `changemedia.com` is not.
 *
 * Angle-bracketed placeholders (`https://<your-host>`) never reach here — `<`
 * and `>` are forbidden host characters, so the URL parse fails first.
 */
const PLACEHOLDER_HOST_LABELS = [
  'changeme',
  'change-me',
  'replaceme',
  'replace-me',
  'your-domain',
  'yourdomain',
  'your-host',
  'yourhost',
  'placeholder',
];

/**
 * @param {string} host already normalized
 * @returns {boolean}
 */
function isPlaceholderHost(host) {
  for (const domain of RESERVED_EXAMPLE_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return host.split('.').some((label) => PLACEHOLDER_HOST_LABELS.includes(label));
}

/**
 * Fold an IPv4-mapped IPv6 literal back to its dotted quad.
 *
 * `new URL('https://[::ffff:127.0.0.1]')` normalises the host to
 * `[::ffff:7f00:1]`, so without this the dotted-quad rules below would miss a
 * loopback address written that way and wave the build through.
 *
 * @param {string} host bracket-stripped, lowercased
 * @returns {string}
 */
function unmapIpv4(host) {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;

  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Strip the brackets the WHATWG URL parser keeps around an IPv6 literal
 * (`new URL('http://[::1]:3001').hostname === '[::1]'`), lowercase, and undo
 * IPv4 mapping so one set of rules covers every spelling.
 *
 * Obfuscated IPv4 forms need no handling here: the URL parser already
 * normalises them, so `https://0177.0.0.1` and `https://2130706433` both arrive
 * as `127.0.0.1`.
 *
 * @param {string} hostname
 * @returns {string}
 */
function normalizeHost(hostname) {
  const bare = String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  return unmapIpv4(bare);
}

/**
 * Parse a dotted-quad IPv4 literal, or null when the host is a name.
 *
 * @param {string} host
 * @returns {number[] | null}
 */
function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Addresses that resolve to the device itself, or to nothing at all.
 *
 * `0.0.0.0` — and the rest of the `0.0.0.0/8` block, which the octet test below
 * also covers — is here rather than under "private" because it is the
 * unspecified address, a bind address someone pasted out of a server config and
 * never a client destination. No opt-in should make it acceptable.
 *
 * @param {string} host already normalized
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true;
  const octets = parseIpv4(host);
  if (!octets) return false;
  return octets[0] === 127 || octets[0] === 0;
}

/**
 * Addresses only reachable from inside somebody's network.
 *
 * Legitimate for an internal-distribution build against a LAN-hosted Breeze,
 * which is why this is opt-in-able rather than fatal. CGNAT space (100.64/10)
 * is included because that is where Tailscale hands out addresses, and a
 * tailnet address in a store build reaches nobody.
 *
 * @param {string} host already normalized
 * @returns {boolean}
 */
function isPrivateHost(host) {
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // IPv6 link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // IPv6 unique local fc00::/7

  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / APIPA
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, incl. Tailscale
  return false;
}

/**
 * Describe what is wrong with an API base URL, or null when it is usable.
 *
 * Checks stay deliberately narrow — no allowlist of known hosts, no reachability
 * probe — because a false rejection breaks the release build of every
 * self-hoster, and the failure being defended against is "unset" and "still
 * pointing at my laptop", not "subtly misconfigured".
 *
 * @param {string | undefined | null} value
 * @param {{ allowPrivate?: boolean }} [options]
 * @returns {string | null}
 */
function describeApiUrlProblem(value, options) {
  if (typeof value !== 'string' || !value.trim()) return 'is not set';

  const raw = value.trim();
  const quoted = JSON.stringify(raw);
  const invalid = `is not a valid URL (${quoted}); expected https://<host>`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return invalid;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid;

  const host = normalizeHost(url.hostname);
  if (!host) return invalid;

  if (isPlaceholderHost(host)) return `still holds a placeholder value (${quoted})`;

  if (isLoopbackHost(host)) {
    return `points at ${quoted}, which on a phone is the phone itself — every request will fail`;
  }

  const allowPrivate = Boolean(options && options.allowPrivate);

  if (isPrivateHost(host)) {
    if (!allowPrivate) {
      return `points at the private-network address ${quoted}, which no device outside that network can reach`;
    }
    // An opted-in LAN deployment is also the one place plaintext is defensible
    // (a box on someone's network often has no publicly-issued certificate), so
    // stop here rather than falling through to the ATS check below.
    return null;
  }

  // Reached only for a PUBLIC host, because every private one returned above.
  // So this must NOT consult `allowPrivate`: that flag says "a private host is
  // fine", never "plaintext to the open internet is fine". Gating it here let a
  // build that had the flag set for LAN testing ship http:// to a public host —
  // ATS blocks that on the device, silently, which is the whole failure class
  // this module exists to stop.
  if (url.protocol === 'http:') {
    return `uses plaintext http (${quoted}); iOS App Transport Security blocks it, and credentials would cross the internet in the clear`;
  }

  return null;
}

/**
 * @param {string} problem
 * @param {string} reason
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function buildFailureMessage(problem, reason, env) {
  const easEnvironment = easEnvironmentFor(env);
  return [
    `${API_URL_VAR} ${problem} — refusing to build.`,
    '',
    `This is a release build (${reason}), and it would ship a binary that cannot`,
    'reach the API. Every service module falls back to this value until the user',
    'picks a server, so the app boots, passes review, and then fails every request',
    'with a transport error nobody can read from a TestFlight install.',
    '',
    'Set it in the place the build actually reads:',
    '',
    `  • Local Xcode build — put ${API_URL_VAR}=https://us.2breeze.app in`,
    '    apps/mobile/.env (copy .env.example). Xcode build phases do NOT inherit',
    '    your interactive shell, so exporting it in .zshrc and pressing Archive',
    '    will not work.',
    '',
    `  • EAS build — it is already in eas.json's "${easEnvironment}" profile; if you`,
    '    overrode it, fix it there or in the matching EAS environment:',
    `      eas env:create --environment ${easEnvironment} --name ${API_URL_VAR} --value https://<host>`,
    '',
    'Hosted regions are https://us.2breeze.app and https://eu.2breeze.app.',
    '',
    'If this build really does target a LAN or self-hosted server on a private',
    `address, set ${ALLOW_PRIVATE_API_URL_VAR}=1. That accepts a private-network`,
    'host, plaintext http included, and warns on every build that it did. It does',
    'NOT accept loopback, a placeholder, or plaintext to a public host.',
  ].join('\n');
}

/**
 * Fail a release build whose API base URL is missing or unreachable.
 *
 * Returns nothing: unlike the Sentry DSN, this value is not re-published on
 * `expo.extra`, because every runtime consumer already reads
 * `process.env.EXPO_PUBLIC_API_URL` directly and rewiring those nine modules is
 * the same code path issue #4002 is changing. This is purely a gate.
 *
 * Non-release builds are a silent no-op — local dev, `expo start`,
 * `expo prebuild` and CI all evaluate `app.config.js` with no API URL set, and
 * a guard that broke the dev loop would be reverted within the day.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ warn?: (message: string) => void }} [io]
 * @returns {void}
 * @throws {Error} on a release build with a missing or unreachable API URL
 */
function assertReleaseApiUrl(env, io) {
  const value = env[API_URL_VAR];

  // The STRICTEST reading first, before any opt-in is applied. Order matters
  // for the same reason it does in `releaseBuildReason`: a flag that turns a
  // real problem into a non-problem has to be able to say so, and it cannot if
  // the problem was never computed. Folding `allowPrivate` in here — as this
  // did originally — made the opt-in the one escape hatch in this file that
  // suppressed a guard in total silence, which is the failure shape the whole
  // module exists to prevent.
  const problem = describeApiUrlProblem(value);
  if (!problem) return;

  const reason = releaseBuildReason(env, io, {
    checkName: API_URL_VAR,
    consequence: 'it will ship unable to reach the API.',
  });
  if (!reason) return;

  if (
    isSuppressed(env[ALLOW_PRIVATE_API_URL_VAR]) &&
    !describeApiUrlProblem(value, { allowPrivate: true })
  ) {
    warnFn(io)(
      `[breeze] WARNING: ${API_URL_VAR} ${problem}, but ${ALLOW_PRIVATE_API_URL_VAR} is set. ` +
        `Building a release (${reason}) against an address only reachable from inside ` +
        'that network. Anyone installing this build from outside it will not be able ' +
        'to sign in.'
    );
    return;
  }

  throw new Error(buildFailureMessage(problem, reason, env));
}

module.exports = {
  assertReleaseApiUrl,
  describeApiUrlProblem,
  API_URL_VAR,
  ALLOW_PRIVATE_API_URL_VAR,
};
