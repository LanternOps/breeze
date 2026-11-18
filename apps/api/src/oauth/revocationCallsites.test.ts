import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');
const ALLOWED_RAW_MARKER_FILES = new Set([
  'oauth/revocationCache.ts',
  'oauth/revocationRetry.ts',
]);

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (
      !entry.isFile()
      || !entry.name.endsWith('.ts')
      || entry.name.endsWith('.test.ts')
      || entry.name.endsWith('.integration.test.ts')
    ) {
      return [];
    }
    return [absolute];
  });
}

describe('OAuth revocation marker call-site contract', () => {
  it('allows raw Redis marker primitives only in the cache and durable dispatcher', () => {
    const violations = productionTypeScriptFiles(SRC_DIR).flatMap((absolute) => {
      const file = relative(SRC_DIR, absolute);
      if (ALLOWED_RAW_MARKER_FILES.has(file)) return [];

      const source = readFileSync(absolute, 'utf8');
      const importsRawMarker = /import[\s\S]*?\b(?:revokeGrant|revokeJti)\b[\s\S]*?from\s+['"][^'"]*revocationCache['"]/.test(source);
      // Wisp W02: `revokeGrant` is also the Wisp delegation-grant service's
      // contract name (services/wisp/grants.ts, w00). A file that defines it
      // there, or imports it from there, and does NOT touch revocationCache is
      // calling the Wisp service, not the OAuth marker.
      const wispRevokeGrant = !importsRawMarker
        && !/\brevokeJti\s*\(/.test(source)
        && (file === 'services/wisp/grants.ts'
          || /import[\s\S]*?\brevokeGrant\b[\s\S]*?from\s+['"][^'"]*wisp\/grants['"]/.test(source));
      const callsRawMarker = !wispRevokeGrant && /\b(?:revokeGrant|revokeJti)\s*\(/.test(source);
      return importsRawMarker || callsRawMarker ? [file] : [];
    });

    expect(violations).toEqual([]);
    // Repo-wide source scan is IO-bound; widen timeout so it doesn't flake under load or cold FS cache.
  }, 30000);
});
