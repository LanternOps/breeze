import { describe, expect, it } from 'vitest';
import { validateRedirectUris } from './redirectUriPolicy';

/**
 * Real callback shapes emitted by MCP clients we intend to support.
 *
 * This is a COMPATIBILITY CONTRACT, not a convenience fixture. Every entry is a
 * client that will silently fail to connect — with no server-side error anyone
 * looks at — if the transport policy stops accepting its shape. Registration is
 * step 4 of the OAuth handshake; steps 1-3 keep returning 200, so the break
 * presents to the user as an inscrutable "not authenticated" and gets found
 * weeks later by hand.
 *
 * If a policy change turns one of these red, DO NOT relax the test to match the
 * code. Either keep the client working, or delete its entry deliberately and
 * say so in the PR body — dropping a client must be a decision, not a side
 * effect. Two outages came from exactly this being tracked in prose instead:
 * #2193 (IAT gate vs Claude Desktop) and the `localhost` rejection in #2377.
 *
 * Ports are ephemeral: native clients bind a random port at runtime, so the
 * specific number here is arbitrary but the shape is not.
 */
const REAL_CLIENT_CALLBACKS: ReadonlyArray<{ client: string; uri: string }> = [
  // Hosted web connector — HTTPS callback on Anthropic's domain.
  { client: 'claude.ai hosted connector', uri: 'https://claude.ai/api/mcp/auth_callback' },
  // Claude Code CLI native SDK auth — binds a local server, uses the
  // `localhost` HOSTNAME (not the IP literal). Rejecting this is what broke
  // MCP auth for CLI users between 2026-07-12 (#2377) and 2026-07-21.
  { client: 'claude-code CLI (native SDK auth)', uri: 'http://localhost:52765/callback' },
  // mcp-remote stdio bridge — uses the IPv4 loopback literal.
  { client: 'mcp-remote bridge', uri: 'http://127.0.0.1:49152/oauth/callback' },
  // IPv6-only hosts: same bridge, bracketed IPv6 loopback.
  { client: 'mcp-remote bridge (IPv6 host)', uri: 'http://[::1]:49152/oauth/callback' },
];

describe('validateRedirectUris — real MCP client compatibility', () => {
  it.each(REAL_CLIENT_CALLBACKS)(
    'accepts the callback registered by $client',
    ({ uri }) => {
      expect(validateRedirectUris([uri])).toEqual({ ok: true });
    },
  );

  it('accepts every real client callback registered together in one array', () => {
    expect(validateRedirectUris(REAL_CLIENT_CALLBACKS.map((c) => c.uri))).toEqual({ ok: true });
  });
});

describe('validateRedirectUris', () => {
  it('accepts a plain HTTPS callback', () => {
    expect(validateRedirectUris(['https://client.example/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTPS with a port and query', () => {
    expect(validateRedirectUris(['https://client.example:8443/cb?x=1'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv4 loopback with an ephemeral port', () => {
    expect(validateRedirectUris(['http://127.0.0.1:49152/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv4 loopback with no port', () => {
    expect(validateRedirectUris(['http://127.0.0.1/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv6 loopback with a port', () => {
    expect(validateRedirectUris(['http://[::1]:8080/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the localhost hostname with no port', () => {
    // RFC 8252 §7.3 prefers IP literals, but permitting `localhost` is a
    // deliberate compatibility choice — see the policy docblock. Real clients
    // hardcode it; see REAL_CLIENT_CALLBACKS above.
    expect(validateRedirectUris(['http://localhost/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the localhost hostname with an ephemeral port', () => {
    expect(validateRedirectUris(['http://localhost:52765/cb'])).toEqual({ ok: true });
  });

  it('rejects a hostname that merely starts with the localhost label', () => {
    // `localhost.evil.com` is an ordinary DNS name — the loopback allowance is
    // exact-match only, never a prefix/suffix test.
    expect(validateRedirectUris(['http://localhost.evil.com/cb']).ok).toBe(false);
  });

  it('rejects a private-network HTTP address', () => {
    expect(validateRedirectUris(['http://192.168.1.10/cb']).ok).toBe(false);
  });

  it('rejects a public HTTP host', () => {
    expect(validateRedirectUris(['http://example.com/cb']).ok).toBe(false);
  });

  it('rejects a URL carrying userinfo credentials', () => {
    expect(validateRedirectUris(['https://user:pw@x.com/cb']).ok).toBe(false);
  });

  // Regression matrix: these are all bypass tricks for the loopback/userinfo
  // checks above. The validator already rejects each correctly — these tests
  // lock that in against future regressions.
  it('rejects a hostname-prefix trick masquerading as the loopback IP', () => {
    // "127.0.0.1.evil.com" is a real DNS hostname (the loopback octets are
    // just a label prefix), not the literal loopback IP — must not pass the
    // http-loopback allowance.
    expect(validateRedirectUris(['http://127.0.0.1.evil.com/cb']).ok).toBe(false);
  });

  it('rejects userinfo credentials on an otherwise-valid loopback HTTP host', () => {
    expect(validateRedirectUris(['http://user:pw@127.0.0.1/cb']).ok).toBe(false);
  });

  it('rejects userinfo-confusion where "[::1]" is stuffed into userinfo and the real host is attacker-controlled', () => {
    // Per WHATWG URL parsing, "[::1]" here is the username, not a host — the
    // authoritative hostname is "evil.com". Must be rejected both for
    // userinfo credentials and for not being an HTTPS/loopback-HTTP host.
    expect(validateRedirectUris(['http://[::1]@evil.com/cb']).ok).toBe(false);
  });

  it('rejects a URL with a fragment', () => {
    expect(validateRedirectUris(['https://x.com/cb#frag']).ok).toBe(false);
  });

  it('rejects a protocol-relative URL', () => {
    expect(validateRedirectUris(['//x.com/cb']).ok).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(validateRedirectUris(['not a url']).ok).toBe(false);
  });

  it('rejects a custom-scheme URL', () => {
    expect(validateRedirectUris(['myapp://cb']).ok).toBe(false);
  });

  it('rejects the entire set when a single URI is invalid (mixed array)', () => {
    const result = validateRedirectUris(['https://client.example/cb', 'http://example.com/cb']);
    expect(result.ok).toBe(false);
  });

  it('accepts a set where every URI is individually valid', () => {
    expect(
      validateRedirectUris(['https://client.example/cb', 'http://127.0.0.1:49152/cb']),
    ).toEqual({ ok: true });
  });

  it('rejects a non-array input', () => {
    expect(validateRedirectUris('https://client.example/cb').ok).toBe(false);
  });

  it('rejects an empty array (no usable callback)', () => {
    expect(validateRedirectUris([]).ok).toBe(false);
  });

  it('rejects a non-string array element', () => {
    expect(validateRedirectUris([123]).ok).toBe(false);
  });

  it('returns a human-readable reason on rejection', () => {
    const result = validateRedirectUris(['http://example.com/cb']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe('string');
  });
});
