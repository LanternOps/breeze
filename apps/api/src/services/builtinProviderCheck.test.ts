import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDR_INSTALLER_PROVIDER_KEYS, EDR_PROVIDER_KEYS } from './edrProviders/providerKeys';

// The CHECK on software_catalog.integration_provider has to admit every EDR
// provider key, or the first catalog row for a new vendor dies with 23514.
// Admission does not imply an installer: that is `capabilities.installer`.
const MIGRATIONS = join(__dirname, '../../migrations');
const LEGACY = ['huntress', 'sentinelone'];

function latestCheckValues(): string[] {
  const addsCheck = /ADD\s+CONSTRAINT\s+software_catalog_integration_provider_chk\s+CHECK\s*\([^)]*IN\s*\(([^)]*)\)/i;
  let values: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const match = addsCheck.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    if (match) values = match[1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  }
  if (!values) throw new Error('no migration adds software_catalog_integration_provider_chk');
  return values;
}

describe('software_catalog_integration_provider_chk', () => {
  it('admits the legacy providers and every EDR provider key', () => {
    expect(latestCheckValues().sort()).toEqual([...LEGACY, ...EDR_PROVIDER_KEYS].sort());
  });

  it('every installer-capable provider is a registered EDR provider', () => {
    for (const key of EDR_INSTALLER_PROVIDER_KEYS) {
      expect(EDR_PROVIDER_KEYS as readonly string[]).toContain(key);
    }
  });
});
