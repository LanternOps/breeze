import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const caddyfile = readFileSync(path.join(REPO_ROOT, 'docker/Caddyfile.prod'), 'utf8')
  .replace(/#[^\n]*/g, '');

/** Returns the body of the first `<opener> {` block at or after `from`, brace-matched. */
function blockBody(source: string, opener: RegExp, from = 0): string | undefined {
  const match = opener.exec(source.slice(from));
  if (!match) return undefined;
  const start = from + match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i);
  }
  return undefined;
}

// Go's http server canonicalizes header names (textproto.CanonicalMIMEHeaderKey)
// before Caddy logs them, and Caddy's filter field paths match case-sensitively.
// A non-canonical spelling here (e.g. `X-API-Key`) would silently redact nothing.
function canonicalHeader(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('-');
}

// Credential-bearing request headers the API accepts. Caddy itself already
// redacts Authorization, Proxy-Authorization, Cookie and Set-Cookie.
const REQUEST_CREDENTIAL_HEADERS = [
  'X-Api-Key',
  'X-Agent-Enrollment-Secret',
  'X-Agent-Reenrollment-Token',
  'X-Breeze-Bootstrap-Token',
  'X-Breeze-Native-Auth-Binding',
  'X-Breeze-Storage-Session',
  'X-Recovery-Token',
  'X-Automation-Secret',
  'X-Webhook-Secret',
  'X-Breeze-Signature',
  'X-Signature',
  'X-Huntress-Signature',
  'X-Xero-Signature',
  'Stripe-Signature',
  'Svix-Signature',
  'Intuit-Signature',
  'Mcp-Session-Id',
  'Cf-Access-Jwt-Assertion',
];
const RESPONSE_CREDENTIAL_HEADERS = ['X-Breeze-Native-Auth-Binding'];

// Credential-bearing URL query parameters (WS/SSE/tunnel tickets, emailed
// reset/verify/invite tokens, OAuth callback code/state, legacy webhook secret).
const QUERY_CREDENTIAL_PARAMS = ['ticket', '__bzt', 't', 'token', 'access_token', 'code', 'state', 'secret'];

// The global options block is the first top-level `{` in the file.
const globalOptions = blockBody(caddyfile, /^\{/m) ?? '';
const defaultLog = blockBody(globalOptions, /^\s*log\s+default\s*\{/m) ?? '';
const filterFormat = blockBody(defaultLog, /^\s*format\s+filter\s*\{/m) ?? '';
const uriQueryFilter = blockBody(filterFormat, /^\s*request>uri\s+query\s*\{/m) ?? '';

// docs/operations/TLS_SETUP.md ships a sample Caddyfile for host-installed
// Caddy; its redaction stanza must stay identical to the canonical one.
const tlsSetupDoc = readFileSync(path.join(REPO_ROOT, 'docs/operations/TLS_SETUP.md'), 'utf8');
const docSample = /```caddyfile\n([\s\S]*?)```/.exec(tlsSetupDoc)?.[1]?.replace(/#[^\n]*/g, '') ?? '';
const docDefaultLog = blockBody(blockBody(docSample, /^\{/m) ?? '', /^\s*log\s+default\s*\{/m) ?? '';
const normalizeLines = (block: string) => block.split('\n').map(line => line.trim()).filter(Boolean);

describe('Caddy log credential redaction', () => {
  it('configures the default logger (covers error and reverse_proxy loggers, not just access logs)', () => {
    expect(globalOptions).not.toBe('');
    expect(defaultLog, 'global options need a `log default { ... }` block').not.toBe('');
    expect(filterFormat, '`log default` must use `format filter { ... }`').not.toBe('');
    expect(filterFormat).toMatch(/^\s*wrap\s+json\s*$/m);
  });

  it.each(REQUEST_CREDENTIAL_HEADERS)('redacts request header %s', header => {
    expect(filterFormat).toMatch(new RegExp(`^\\s*request>headers>${header}\\s+replace\\s+REDACTED\\s*$`, 'm'));
  });

  it.each(RESPONSE_CREDENTIAL_HEADERS)('redacts response header %s', header => {
    expect(filterFormat).toMatch(new RegExp(`^\\s*resp_headers>${header}\\s+replace\\s+REDACTED\\s*$`, 'm'));
  });

  it('has a request>uri query filter block', () => {
    expect(uriQueryFilter, '`format filter` needs a `request>uri query { ... }` block').not.toBe('');
  });

  it.each(QUERY_CREDENTIAL_PARAMS)('redacts query parameter %s in request>uri', param => {
    expect(uriQueryFilter).toMatch(new RegExp(`^\\s*replace\\s+${param}\\s+REDACTED\\s*$`, 'm'));
  });

  it('keeps the TLS_SETUP.md sample Caddyfile redaction identical to docker/Caddyfile.prod', () => {
    expect(docDefaultLog, 'TLS_SETUP.md sample needs a global `log default { ... }` block').not.toBe('');
    expect(normalizeLines(docDefaultLog)).toEqual(normalizeLines(defaultLog));
  });

  it('spells every redacted header in Go canonical form', () => {
    const names = [...filterFormat.matchAll(/(?:request>headers|resp_headers)>([A-Za-z0-9-]+)/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toBe(canonicalHeader(name));
  });
});
