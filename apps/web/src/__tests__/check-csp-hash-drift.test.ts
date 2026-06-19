import { describe, expect, it } from 'vitest';
import {
  extractDirective,
  handPinnedScriptHashes,
  inlineScriptBodies,
  sha256Base64,
} from '../../scripts/check-csp-hash-drift';

// Unit coverage for the pure parsing/hashing helpers that back the partial CSP
// hash drift guard (#1232). The full build-and-boot guard runs in CI
// (`pnpm --filter @breeze/web run check:csp`); these tests pin the logic that
// decides which scripts get hashed, how a served script-src is parsed, and how
// the hand-pinned hashes are read back out of astro.config.mjs for the
// verified/unverified cross-check. NOTE: the guard only covers inline scripts in
// the *initial* SSR HTML — it cannot exercise the <ClientRouter> runtime swap
// script, so the two runtime hand-pins are reported UNVERIFIED, not asserted.

describe('inlineScriptBodies', () => {
  it('collects bodies of inline scripts that have no src', () => {
    const html = `
      <html><head>
        <script type="module" src="/_astro/ClientRouter.x.js"></script>
        <script>console.log('a');</script>
        <script type="module">console.log('b');</script>
      </head></html>`;
    expect(inlineScriptBodies(html)).toEqual(["console.log('a');", "console.log('b');"]);
  });

  it('ignores external scripts even when they have a body-like attribute', () => {
    const html = `<script src="/x.js" data-onload="init()"></script>`;
    expect(inlineScriptBodies(html)).toEqual([]);
  });

  it('ignores empty and whitespace-only inline scripts', () => {
    const html = `<script></script><script>   \n  </script><script>real();</script>`;
    expect(inlineScriptBodies(html)).toEqual(['real();']);
  });

  it('preserves the exact bytes so the hash matches what the browser sees', () => {
    // The hash is over the verbatim text content, including leading/trailing
    // whitespace inside the tag — must not be trimmed.
    const body = '  let x = 1;  ';
    const html = `<script>${body}</script>`;
    expect(inlineScriptBodies(html)).toEqual([body]);
  });

  it('matches closing tags with whitespace and does not run past them', () => {
    // `</script >` / `</script\n>` are valid closes. A regex that only matched
    // `</script>` would skip the first close and capture everything up to the
    // next one — a wrong body, a wrong hash, and a false-positive drift failure.
    const html = `<script>first();</script >\n<script>second();</script\n>`;
    expect(inlineScriptBodies(html)).toEqual(['first();', 'second();']);
  });
});

describe('extractDirective', () => {
  const csp =
    "default-src 'self'; script-src 'self' 'sha256-AAA=' https://cdn.example.com; style-src 'self'";

  it('returns the token list of the named directive', () => {
    expect(extractDirective(csp, 'script-src')).toBe(
      "'self' 'sha256-AAA=' https://cdn.example.com"
    );
  });

  it('is case-insensitive on the directive name', () => {
    expect(extractDirective(csp, 'Script-Src')).toBe(
      "'self' 'sha256-AAA=' https://cdn.example.com"
    );
  });

  it('returns an empty string for an absent directive', () => {
    expect(extractDirective(csp, 'connect-src')).toBe('');
  });

  it('does not confuse a prefix directive with a granular one', () => {
    const withGranular = "script-src 'self'; script-src-attr 'none'";
    expect(extractDirective(withGranular, 'script-src')).toBe("'self'");
    expect(extractDirective(withGranular, 'script-src-attr')).toBe("'none'");
  });
});

describe('handPinnedScriptHashes', () => {
  // A trimmed shape of astro.config.mjs scriptDirective/styleDirective.
  const config = `
    security: {
      csp: {
        scriptDirective: {
          resources: [
            "'self'",
            'https://static.cloudflareinsights.com',
            "'sha256-dr7co1YqmJP1+caEJBfXkM/oHRwOVAknT+gDygo8nD0='",
            "'sha256-6wgjuQN80bYuvy8C2/v+mFX1HAEgrfvSs+beElRyx+8='"
          ]
        },
        styleDirective: {
          resources: ["'self'", "'sha256-STYLEHASHdoNotPickThis0000000000000000000='"]
        }
      }
    }`;

  it('extracts only the sha256 hashes inside scriptDirective.resources', () => {
    expect(handPinnedScriptHashes(config)).toEqual([
      'sha256-dr7co1YqmJP1+caEJBfXkM/oHRwOVAknT+gDygo8nD0=',
      'sha256-6wgjuQN80bYuvy8C2/v+mFX1HAEgrfvSs+beElRyx+8=',
    ]);
  });

  it('does not pick up hashes from a later styleDirective', () => {
    expect(handPinnedScriptHashes(config)).not.toContain(
      'sha256-STYLEHASHdoNotPickThis0000000000000000000='
    );
  });

  it('returns an empty list when there are no hand-pinned hashes', () => {
    const noHashes = `scriptDirective: { resources: ["'self'", 'https://cdn.example.com'] }`;
    expect(handPinnedScriptHashes(noHashes)).toEqual([]);
  });

  it('de-duplicates a hash pinned more than once', () => {
    const dupe = `scriptDirective: { resources: [
      "'sha256-AAAA='", "'sha256-AAAA='"
    ] }`;
    expect(handPinnedScriptHashes(dupe)).toEqual(['sha256-AAAA=']);
  });
});

describe('sha256Base64', () => {
  it('produces the CSP sha256-<base64> form the browser computes', () => {
    // Empty-string sha256 is a known vector; this is the value Chrome reports.
    expect(sha256Base64('')).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('round-trips: a script hashed here is found in a script-src containing it', () => {
    const body = "(()=>{console.log('hydrate')})()";
    const hash = sha256Base64(body);
    const scriptSrc = `'self' '${hash}'`;
    expect(scriptSrc.includes(`'${hash}'`)).toBe(true);
  });
});
