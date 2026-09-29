import '@/lib/i18n';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { unconvertibleReasonKeys } from './conversionApi';

/**
 * Every `unconvertible:<code>` reason the API can put in a conversion preview
 * must have its own text under `monitoring:conversion.retirement.reasons`.
 * Without one the dialog falls back to "conversion was refused; review the
 * source" next to the raw code (it showed `unconvertible:no_active_rules` for a
 * network check with no active alert rule), so the codes are read straight
 * from the API source rather than from a hand-kept list that drifts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const monitorsSrc = resolve(here, '../../../../../api/src/services/monitors');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function apiReasonCodes(): string[] {
  const codes = new Set<string>();
  for (const file of sourceFiles(monitorsSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/unconvertible:([a-z][a-z0-9_]*)/g)) codes.add(match[1]!);
    // mapping.ts builds `unconvertible:${code}` from its UNCONVERTIBLE map.
    const map = text.match(/export const UNCONVERTIBLE = \{([\s\S]*?)\} as const;/);
    if (map) for (const value of map[1]!.matchAll(/:\s*'([a-z][a-z0-9_]*)'/g)) codes.add(value[1]!);
  }
  return [...codes].sort();
}

describe('unconvertible reason coverage', () => {
  it('finds the API reason codes (guards against a moved source tree making this vacuous)', () => {
    const codes = apiReasonCodes();
    expect(codes).toEqual(expect.arrayContaining(['no_active_rules', 'multiple_network_rules', 'custom_condition', 'built_in']));
    expect(codes.length).toBeGreaterThan(20);
  });

  it('has English text for every reason the API can return', () => {
    const missing = apiReasonCodes().filter((code) => !i18n.exists(`monitoring:conversion.retirement.reasons.${code}`, { lng: 'en' }));
    expect(missing).toEqual([]);
  });

  it('renders a network check with no active alert rule as text, not the refused fallback', () => {
    const text = i18n.t(unconvertibleReasonKeys('unconvertible:no_active_rules'));
    expect(text).not.toBe(i18n.t('monitoring:conversion.retirement.reasons.unknown'));
    expect(text).not.toContain('unconvertible:');
  });
});
