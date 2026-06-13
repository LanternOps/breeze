import { describe, expect, it } from 'vitest';
import {
  extractDirective,
  inlineScriptBodies,
  sha256Base64,
} from '../../scripts/check-csp-hash-drift';

// Unit coverage for the pure parsing/hashing helpers that back the CSP hash
// drift guard (#1232). The full build-and-boot guard runs in CI
// (`pnpm --filter @breeze/web run check:csp`); these tests pin the logic that
// decides which scripts get hashed and how a served script-src is parsed.

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
