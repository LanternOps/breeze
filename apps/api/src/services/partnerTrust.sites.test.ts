import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLifecycleCommand } from './partnerTrust';

const intentionallyUngatedSystemSites = [
  '../routes/agents/helpers.ts',
  './tenantOffboarding.ts',
  './desktopSessionStop.ts',
  './wakeOnLan.ts',
  './deviceUninstallDrain.ts',
  '../routes/admin/abuse.ts',
] as const;

function literalCommandTypes(source: string): string[] {
  const types: string[] = [];
  const insertPattern = /\.insert\(deviceCommands\)/g;
  for (const match of source.matchAll(insertPattern)) {
    const statement = source.slice(match.index, source.indexOf(';', match.index));
    for (const typeMatch of statement.matchAll(/\btype:\s*'([^']+)'/g)) {
      types.push(typeMatch[1]!);
    }
  }
  return types;
}

describe('intentionally ungated system device-command sites', () => {
  it.each(intentionallyUngatedSystemSites)('%s uses only lifecycle command literals', (relativePath) => {
    const path = resolve(import.meta.dirname, relativePath);
    const source = readFileSync(path, 'utf8');
    for (const type of literalCommandTypes(source)) {
      expect(isLifecycleCommand(type), `${relativePath} inserts non-lifecycle command ${type}`).toBe(true);
    }
  });

  it('covers at least one literal device command', () => {
    const types = intentionallyUngatedSystemSites.flatMap((relativePath) =>
      literalCommandTypes(readFileSync(resolve(import.meta.dirname, relativePath), 'utf8')),
    );
    expect(types.length).toBeGreaterThan(0);
  });
});
