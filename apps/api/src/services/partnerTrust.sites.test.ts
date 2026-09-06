import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

// Heartbeat-driven threshold scan: the agent, not an operator, triggers it and no
// operator content/target is involved. The operator-driven filesystem_analysis path
// (AI tool) dispatches through the gated commandQueue. Any other type appearing
// here must be lifecycle.
const SYSTEM_INITIATED_EXCEPTIONS: Record<string, readonly string[]> = {
  '../routes/agents/helpers.ts': ['filesystem_analysis'],
};

// `CommandTypes.NAME` references resolve through this map, built once from the
// real `export const CommandTypes = { ... } as const` object in commandQueue.ts
// so a renamed/added constant is picked up automatically.
function loadCommandTypesByName(): Map<string, string> {
  const commandQueuePath = resolve(import.meta.dirname, './commandQueue.ts');
  const source = readFileSync(commandQueuePath, 'utf8');
  const block = source.match(/export const CommandTypes\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!block) {
    throw new Error('CommandTypes constants object must remain discoverable in commandQueue.ts');
  }
  const byName = new Map<string, string>();
  for (const match of block[1]!.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/g)) {
    byName.set(match[1]!, match[2]!);
  }
  return byName;
}

const commandTypesByName = loadCommandTypesByName();

// Finds `import { ..., <identifier>, ... } from '<module>'` in `source` and
// returns the resolved absolute path of that module (as a .ts file), or null
// if `identifier` isn't named in any import.
function resolveImportedModulePath(identifier: string, source: string, fromFilePath: string): string | null {
  for (const importMatch of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = importMatch[1]!
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '').trim());
    if (names.includes(identifier)) {
      const specifier = importMatch[2]!;
      if (!specifier.startsWith('.')) return null; // not a local module we can inspect
      return resolve(dirname(fromFilePath), `${specifier}.ts`);
    }
  }
  return null;
}

// Resolves a bare identifier (e.g. `filesystemAnalysisCommandType`) to its
// literal command-type string by looking for `const <identifier> = '<literal>'`
// or `const <identifier> = CommandTypes.NAME` — first in `source` itself, then
// (one level) in whichever local module `source` imports it from.
function resolveIdentifierValue(identifier: string, source: string, filePath: string): string | null {
  const literalDecl = source.match(new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*'([^']+)'`));
  if (literalDecl) return literalDecl[1]!;

  const commandTypesDecl = source.match(new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*CommandTypes\\.([A-Za-z0-9_]+)`));
  if (commandTypesDecl) return commandTypesByName.get(commandTypesDecl[1]!) ?? null;

  const importedModulePath = resolveImportedModulePath(identifier, source, filePath);
  if (!importedModulePath) return null;

  const importedSource = readFileSync(importedModulePath, 'utf8');
  const importedLiteralDecl = importedSource.match(new RegExp(`\\bexport const\\s+${identifier}\\s*=\\s*'([^']+)'`));
  if (importedLiteralDecl) return importedLiteralDecl[1]!;

  const importedCommandTypesDecl = importedSource.match(
    new RegExp(`\\bexport const\\s+${identifier}\\s*=\\s*CommandTypes\\.([A-Za-z0-9_]+)`),
  );
  if (importedCommandTypesDecl) return commandTypesByName.get(importedCommandTypesDecl[1]!) ?? null;

  return null;
}

// Extracts the command type at each `deviceCommands` insert site in `source`,
// resolving string literals, `CommandTypes.NAME` references, and bare
// identifiers (imported or locally declared) back to their literal value.
function resolvedCommandTypes(source: string, filePath: string): string[] {
  const types: string[] = [];
  const insertPattern = /\.insert\(deviceCommands\)/g;
  for (const match of source.matchAll(insertPattern)) {
    const statement = source.slice(match.index, source.indexOf(';', match.index));
    for (const typeMatch of statement.matchAll(
      /\btype:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))/g,
    )) {
      const literal = typeMatch[1];
      if (literal) {
        types.push(literal);
        continue;
      }
      const expression = typeMatch[2]!;
      const [head, member] = expression.split('.');
      if (member) {
        if (head !== 'CommandTypes') {
          throw new Error(`${filePath}: cannot resolve command type expression '${expression}'`);
        }
        const resolved = commandTypesByName.get(member);
        if (!resolved) {
          throw new Error(`${filePath}: CommandTypes.${member} is not a known command type`);
        }
        types.push(resolved);
        continue;
      }
      const resolved = resolveIdentifierValue(head!, source, filePath);
      if (!resolved) {
        throw new Error(`${filePath}: could not resolve command type identifier '${head}'`);
      }
      types.push(resolved);
    }
  }
  return types;
}

describe('intentionally ungated system device-command sites', () => {
  it.each(intentionallyUngatedSystemSites)('%s uses only lifecycle command literals or approved exceptions', (relativePath) => {
    const path = resolve(import.meta.dirname, relativePath);
    const source = readFileSync(path, 'utf8');
    const types = resolvedCommandTypes(source, path);
    expect(types.length, `${relativePath} yielded zero resolved command types — the scanner can no longer see its deviceCommands inserts`).toBeGreaterThan(0);
    for (const type of types) {
      const isApproved = isLifecycleCommand(type) || SYSTEM_INITIATED_EXCEPTIONS[relativePath]?.includes(type);
      expect(isApproved, `${relativePath} inserts non-lifecycle command ${type} without an approved exception`).toBe(true);
    }
  });

  it('covers at least one literal device command', () => {
    const types = intentionallyUngatedSystemSites.flatMap((relativePath) => {
      const path = resolve(import.meta.dirname, relativePath);
      return resolvedCommandTypes(readFileSync(path, 'utf8'), path);
    });
    expect(types.length).toBeGreaterThan(0);
  });

  it('validates that all exception entries refer to scanned files and types that actually appear in them', () => {
    const scannedFiles = new Set<string>(intentionallyUngatedSystemSites);
    const scannedTypesByFile = new Map<string, Set<string>>();

    for (const relativePath of intentionallyUngatedSystemSites) {
      const path = resolve(import.meta.dirname, relativePath);
      const source = readFileSync(path, 'utf8');
      const types = resolvedCommandTypes(source, path);
      scannedTypesByFile.set(relativePath, new Set(types));
    }

    for (const [file, exceptions] of Object.entries(SYSTEM_INITIATED_EXCEPTIONS)) {
      expect(scannedFiles.has(file), `Exception entry references file ${file} which is not in the scanned list`).toBe(true);
      const typesInFile = scannedTypesByFile.get(file);
      expect(typesInFile, `Could not find scanned types for exception file ${file}`).toBeDefined();
      for (const exceptionType of exceptions) {
        expect(typesInFile!.has(exceptionType), `Exception type ${exceptionType} in ${file} was not found in that file`).toBe(true);
      }
    }
  });
});
