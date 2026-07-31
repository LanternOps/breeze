import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const featureTabsDir = dirname(fileURLToPath(import.meta.url));

const files = [
  'RemoteAccessTab.tsx',
  'HelperTab.tsx',
  'WarrantyTab.tsx',
  'PatchTab.tsx',
  'BackupTab.tsx',
  'BackupDestinationSection.tsx',
  'backupTabPresets.ts',
  // Added with the alert consolidation: AlertRuleTab had discriminated its
  // condition editors on `condition.type === i18n.t(...)`, which only worked
  // because the en catalog happened to store the machine value verbatim — every
  // translated locale silently rendered no condition fields at all.
  'AlertRuleTab.tsx',
  'MonitoringTab.tsx',
];

describe('configuration policy structural values', () => {
  it.each(files)('%s keeps machine values out of translations', (file) => {
    const source = readFileSync(join(featureTabsDir, file), 'utf8');

    expect(source).not.toMatch(/(?:update|result\.push)\(\s*i18n\.t\(/s);
    expect(source).not.toMatch(/e\.key\s*===\s*i18n\.t\(/s);
    // Any discriminator compared against a translated label rather than the
    // machine value it stores (e.g. `condition.type === i18n.t(...)`).
    expect(source).not.toMatch(/\.\w+\s*===\s*\n?\s*i18n\.t\(/s);
    expect(source).not.toMatch(/value:\s*i18n\.t\(/s);
    expect(source).not.toMatch(/setMode\(\s*i18n\.t\(/s);
    expect(source).not.toMatch(
      /setMode\(\s*mode\s*===\s*["']create["']\s*\?\s*i18n\.t\(/s,
    );
  });
});
