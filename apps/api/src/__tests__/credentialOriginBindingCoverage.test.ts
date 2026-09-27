/**
 * CONTRACT TEST — every source file that checks a masked-secret marker must
 * either bind the destination origin via `credentialOriginBinding`
 * (`urlOriginChanged` / `webhookOriginChangeWouldRetainAuthorization`) or
 * carry a documented allowlist exemption.
 *
 * Why this file exists: when a destination moves to a new HTTP origin, a
 * masked or omitted secret field must be re-entered for the new endpoint,
 * never carried forward from the stored row. Many integrations share this
 * shape (PSA/Pax8/webhooks/alert channels, tool sources, org event-log
 * forwarding, monitoring integrations, backup S3 config), and a mechanical
 * check keeps new call sites consistent, the same way the RLS coverage and
 * cascade contract tests do for tenancy.
 *
 * The rule, deliberately blunt: a file under `src/routes/**` or
 * `src/services/**` that defines or checks a masked-secret marker (a
 * `'********'`-shaped literal placeholder, or an identifier matching
 * `MASKED_*_SECRET` / `isRedactedSecret*` / `isMaskedSecret*`) must import
 * `credentialOriginBinding`, or have a reasoned entry in
 * `credentialOriginBindingAllowlist.ts`.
 *
 * The check is textual (does the file import the helper?), not semantic — it
 * cannot prove the binding is applied at the right call site, only that the
 * author was made to think about it before shipping a new one. Per-route
 * tests (see the sibling `*.test.ts` for each integration above) assert the
 * refusal actually fires.
 *
 * Plain unit test — reads the source tree only. No database, so it runs in
 * the `test-api` job where a stale base still fails.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { CREDENTIAL_ORIGIN_BINDING_ALLOWLIST } from '../services/credentialOriginBindingAllowlist';

const API_SRC = resolve(__dirname, '..');
const BINDING_MODULE_BASENAME = 'credentialOriginBinding';

// A literal masked-secret placeholder (the `'********'` shape shared across
// every sibling: INTEGRATION_MASKED_SECRET, MASKED_SECRET in backup/configs.ts,
// SFTP_MASKED_SECRET, EC_MASKED_SECRET, MASKED_SNMP_SECRET, …) OR an
// identifier that names one of these detection helpers.
const MASKED_SECRET_MARKER_RE = /\*{6,}|MASKED_\w*SECRET|isRedactedSecret\w*|isMaskedSecret\w*/;

function collectSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts')) continue;
      if (full.endsWith('.test.ts') || full.endsWith('.d.ts')) continue;
      // The binding module and its allowlist are the mechanism, not a call
      // site subject to it.
      if (full.endsWith(`${BINDING_MODULE_BASENAME}.ts`)) continue;
      if (full.endsWith('credentialOriginBindingAllowlist.ts')) continue;
      files.push(full);
    }
  };
  walk(join(API_SRC, 'routes'));
  walk(join(API_SRC, 'services'));
  return files.sort();
}

function importsBindingModule(source: string): boolean {
  return new RegExp(`from ['"][^'"]*${BINDING_MODULE_BASENAME}['"]`).test(source);
}

describe('credential-origin-binding coverage', () => {
  it('every allowlist entry names a real, existing file (no dead entries)', () => {
    for (const entry of CREDENTIAL_ORIGIN_BINDING_ALLOWLIST) {
      const full = join(API_SRC, entry.file);
      expect(() => statSync(full), `allowlist entry '${entry.file}' does not exist`).not.toThrow();
      expect(entry.reason.trim().length, `allowlist entry '${entry.file}' has no reason`).toBeGreaterThan(20);
    }
  });

  it('every file checking a masked-secret marker imports credentialOriginBinding or is allowlisted', () => {
    const allowlisted = new Set(CREDENTIAL_ORIGIN_BINDING_ALLOWLIST.map((e) => e.file));
    const files = collectSourceFiles();
    const uncovered: string[] = [];

    for (const file of files) {
      const rel = relative(API_SRC, file);
      const source = readFileSync(file, 'utf8');
      if (!MASKED_SECRET_MARKER_RE.test(source)) continue;
      if (importsBindingModule(source)) continue;
      if (allowlisted.has(rel)) continue;
      uncovered.push(rel);
    }

    expect(
      uncovered,
      uncovered.length > 0
        ? `These files check a masked-secret marker but do not import credentialOriginBinding and are not ` +
          `allowlisted — same recurring origin-binding gap this contract test exists to catch. Either wire the ` +
          `destination-origin check in, or add a reasoned entry to credentialOriginBindingAllowlist.ts:\n  ${uncovered.join('\n  ')}`
        : undefined,
    ).toEqual([]);
  });

  it('the allowlist has no stale entry for a file that now imports the binding module directly', () => {
    // Not an error, just drift worth catching: if a file was allowlisted and
    // later got the real fix, the exemption should be removed so this test
    // keeps checking the files that actually need it.
    const stale: string[] = [];
    for (const entry of CREDENTIAL_ORIGIN_BINDING_ALLOWLIST) {
      const full = join(API_SRC, entry.file);
      let source: string;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        continue; // caught by the "real, existing file" assertion above
      }
      if (importsBindingModule(source)) stale.push(entry.file);
    }
    expect(stale, `remove these from the allowlist — they already import credentialOriginBinding: ${stale.join(', ')}`).toEqual([]);
  });
});
