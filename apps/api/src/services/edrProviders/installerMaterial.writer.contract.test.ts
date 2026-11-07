import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// EDR W06.1 (#8170): installer material has ONE door.
//
// A per-company installer link is a secret, and credential rotation depends on
// every copy being cleared. So exactly one module may name the column, whether
// to write it, clear it or read the ciphertext. Dispatch and readiness read it
// through installerMaterial.ts's own projection.
// ============================================================================

const API_SRC = path.resolve(__dirname, '../..');
const DOOR = 'services/edrProviders/installerMaterial.ts';

/** Declares or describes the column; none can write it. */
const NOT_WRITERS = new Set([
  'db/schema/edrProviders.ts',
  'services/encryptedColumnRegistry.ts',
  'services/tenantExportPolicyRegistry.ts',
  // SPEC_COLUMNS maps the secret name to the column for AAD derivation.
  'services/edrProviders/credentials.ts',
  // The public tenant projection: a computed boolean, never the value.
  'routes/edr/access.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(API_SRC).map((f) => path.relative(API_SRC, f).split(path.sep).join('/'));
const NAMES_COLUMN = /installerSecretEncrypted|installer_secret_encrypted/;
const read = (f: string) => readFileSync(path.join(API_SRC, f), 'utf8');

describe('installer material door', () => {
  it('scans a real file set, and the door matches the pattern', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(NAMES_COLUMN.test(read(DOOR))).toBe(true);
  });

  it('only installerMaterial.ts names the installer secret column', () => {
    expect(FILES.filter((f) => f !== DOOR && !NOT_WRITERS.has(f) && NAMES_COLUMN.test(read(f)))).toEqual([]);
  });

  it('the public tenant projection exposes only the boolean', () => {
    expect(read('routes/edr/access.ts')).toMatch(/hasInstallerSecret: sql<boolean>/);
    expect(read('routes/edr/access.ts')).not.toMatch(/:\s*edrTenants\.installerSecretEncrypted\s*,/);
  });
});
