/**
 * Associated Domains resolution for self-hosted builds.
 *
 * `app.json` pins `ios.associatedDomains` to the two hosted regions, which is
 * right for the published App Store build but leaves self-hosters with no
 * domain-to-app association. Without it a saved password-manager entry does not
 * match the app, so the TOTP code is never suggested and has to be copied by
 * hand on every sign-in — painful against a 15-minute access token.
 *
 * Apple binds Associated Domains into the signed entitlement, so this cannot be
 * a runtime setting. It is resolved when the app is built: `BREEZE_ASSOCIATED_DOMAINS`
 * is merged into the static list so someone building from source can cover
 * their own server.
 *
 * Two deliberate restrictions, because the output lands in a SIGNED entitlement:
 *
 *  - Only `webcredentials:` is emitted. Accepting arbitrary service prefixes
 *    would let a build-time env var widen the entitlement into `applinks:`
 *    (which changes universal-link routing) for no benefit to this feature.
 *  - Input is validated and a bad entry THROWS. Silently skipping junk is worse
 *    than failing: the build succeeds, the entitlement is missing the domain,
 *    and the operator has no idea until autofill quietly does not work.
 *
 * Deliberately plain CommonJS, not TypeScript: `app.config.js` is loaded by
 * Expo through a bare `require`, and while Expo transpiles the config file
 * itself it does NOT transpile modules the config imports. A `.ts` module here
 * fails at `expo config`/`expo prebuild` time with "Cannot find module".
 */

/** Apple's service prefix for password-manager association. */
const WEBCREDENTIALS_PREFIX = 'webcredentials:';

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** A single DNS label: alphanumeric, inner hyphens allowed. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Extract a hostname from either a bare host or a pasted URL.
 *
 * Operators paste the URL they type into the app rather than a bare host, so
 * both are accepted. URLs go through the real parser instead of string
 * splitting, which gets IPv6 literals and credentials right.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractHostname(raw) {
  const value = raw.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`BREEZE_ASSOCIATED_DOMAINS: "${raw}" is not a valid URL.`);
    }
    return url.hostname;
  }

  // Reject URL punctuation on what is meant to be a bare hostname rather than
  // silently trimming it. In particular Apple's `?mode=developer` suffix is
  // NOT supported here, and dropping it quietly would change behaviour.
  if (/[/?#@:]/.test(value)) {
    throw new Error(
      `BREEZE_ASSOCIATED_DOMAINS: "${raw}" must be a bare hostname or a full URL. ` +
        `Ports, paths and query suffixes such as "?mode=developer" are not ` +
        `supported on a bare host; edit app.json directly if you need one.`
    );
  }

  // Route bare hosts through the URL parser too, so an internationalised
  // domain is punycoded the same way it would be from the URL form. Doing it
  // by hand here would make `bücher.example.com` fail while
  // `https://bücher.example.com` succeeded, for no reason the operator could see.
  try {
    return new URL(`https://${value}`).hostname;
  } catch {
    throw new Error(`BREEZE_ASSOCIATED_DOMAINS: "${raw}" is not a valid hostname.`);
  }
}

/**
 * Validate and canonicalise a hostname for use in an entitlement.
 *
 * @param {string} hostname
 * @param {string} original
 * @returns {string}
 */
function validateHostname(hostname, original) {
  const fail = (why) => {
    throw new Error(`BREEZE_ASSOCIATED_DOMAINS: "${original}" ${why}.`);
  };

  let host = hostname.trim().toLowerCase();
  // A trailing dot is a valid FQDN spelling but never matches an entitlement.
  if (host.endsWith('.')) host = host.slice(0, -1);

  if (!host) fail('is empty');
  if (host.startsWith('[') || host.includes(':')) fail('must not be an IP literal');
  if (host.includes('*')) fail('must not use a wildcard');
  if (host.length > MAX_HOSTNAME_LENGTH) fail(`exceeds ${MAX_HOSTNAME_LENGTH} characters`);

  const labels = host.split('.');
  if (labels.length < 2) fail('must be a fully qualified domain name');
  for (const label of labels) {
    if (!label) fail('has an empty label');
    if (label.length > MAX_LABEL_LENGTH) fail(`has a label longer than ${MAX_LABEL_LENGTH} characters`);
    if (!LABEL.test(label)) fail(`has an invalid label "${label}"`);
  }
  // All-numeric final label means this is an IPv4 address, not a domain.
  if (/^\d+$/.test(labels[labels.length - 1])) fail('must be a domain name, not an IP address');

  return host;
}

/**
 * Merge extra associated domains into the static list.
 *
 * With no configured value the base list is returned verbatim, so the published
 * App Store build cannot be affected by this code path at all.
 *
 * Accepts comma or whitespace separated values. Semicolon is deliberately NOT
 * a separator: it is legal inside a URL path and splitting on it would reject a
 * valid pasted URL.
 *
 * @param {readonly string[] | undefined} base
 * @param {string | null | undefined} raw
 * @returns {string[]}
 * @throws {Error} when a configured entry is not a usable hostname
 */
function resolveAssociatedDomains(base, raw) {
  const out = base ? base.slice() : [];
  if (!raw || !String(raw).trim()) return out;

  const seen = new Set(out.map((e) => e.trim().toLowerCase()));

  for (const piece of String(raw).split(/[\s,]+/)) {
    if (!piece) continue;
    const host = validateHostname(extractHostname(piece), piece);
    const entry = WEBCREDENTIALS_PREFIX + host;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out;
}

module.exports = { resolveAssociatedDomains, WEBCREDENTIALS_PREFIX };
