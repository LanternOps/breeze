/**
 * Contract: every AI tool input that names a device filesystem path goes
 * through the default AI path restriction (`safePath` / `aiPathRefusal` in
 * aiToolSchemas.ts), or is listed below with the reason it does not.
 *
 * `validateToolInput` (called by `executeTool`, the single dispatch point for
 * chat, agents, MCP and the helper) is where the restriction is enforced, so
 * this suite walks the real `toolInputSchemas` table and classifies every
 * string field whose key reads as a path (`path`, `newPath`, `quarantineDir`,
 * `selectedPaths`, …). A new path-taking field fails here until it is either
 * typed as `safePath` or given an exemption with a reason, so the restriction
 * cannot be skipped by adding a second tool that forgets it.
 *
 * NOTE: no vi.mock. The suite needs the real schema table.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { safePath, toolInputSchemas, validateToolInput } from './aiToolSchemas';

const PATH_KEY = /(path|paths|dir|dirs|directory|directories|folder|folders)$/i;

type Classification =
  | { kind: 'safePath' }
  | { kind: 'checkedByToolSchema'; why: string }
  | { kind: 'exempt'; why: string };

const SAFE: Classification = { kind: 'safePath' };

/** `tool.field.path` → how the field meets the restriction. */
const PATH_FIELDS: Record<string, Classification> = {
  'file_operations.path': SAFE,
  'file_operations.newPath': SAFE,
  'analyze_disk_usage.path': SAFE,
  'disk_cleanup.path': SAFE,
  'remediate_sensitive_data.quarantineDir': SAFE,

  'execute_command.payload.path': {
    kind: 'checkedByToolSchema',
    why: 'Only file_list/file_read read it; the execute_command schema applies aiPathRefusal to it for those two command types (and requires it).',
  },

  'request_diagnostic_access.paths.path': {
    kind: 'exempt',
    why: 'Requests an administrator-approved read-only exception to the default restriction, so it cannot be refused by it. services/diagnosticAccess/grants.ts enforces path form (diagnosticPathFormError: absolute, no traversal, UNC, stream or trailing-dot names), sensitive-store classes and a minimum depth (MIN_DIAGNOSTIC_SCOPE_DEPTH) when the request is created; nothing is read until an approver grants it.',
  },
  'diagnostic_list_directory.path': {
    kind: 'exempt',
    why: 'Reads only under an approved diagnostic grant: the server checks grant coverage and sensitive classes, signs a per-command authorization, and the agent re-checks containment on the opened handle.',
  },
  'diagnostic_read_file.path': {
    kind: 'exempt',
    why: 'Reads only under an approved diagnostic grant: the server checks grant coverage and sensitive classes, signs a per-command authorization, and the agent re-checks containment on the opened handle.',
  },
  'disk_cleanup.paths': {
    kind: 'exempt',
    why: 'Execute-only selection; each entry must be a candidate of the pinned preview run (filesystemCleanupExecution), anything else is rejected and never dispatched.',
  },
  'restore_snapshot.targetPath': {
    kind: 'exempt',
    why: 'Restore destination for data from the device\'s own backup; approval-gated (tier 3). The restored copy keeps its source layout under this folder, where file tools can then read it: which snapshot entries an AI may restore is a separate decision, not a path-spelling check.',
  },
  'restore_snapshot.selectedPaths': {
    kind: 'exempt',
    why: 'Entries inside the snapshot being restored, not live device paths the tool opens or lists.',
  },
  'restore_as_vm.outputPath': {
    kind: 'exempt',
    why: 'Output .vhdx on the rebuild host, validated by isAbsoluteRebuildPath; the engine writes an image there and returns no file content.',
  },
  'configure_vault.vaultPath': {
    kind: 'exempt',
    why: 'Backup vault destination (local/SMB/USB) the backup engine writes to; nothing is read back to the model.',
  },
  'propose_script.verification.path': {
    kind: 'exempt',
    why: 'file_exists verification claim: the verifier reports only whether the path exists after the approved script ran; no listing or content.',
  },
  'manage_backup_profiles.selections.file.paths': {
    kind: 'exempt',
    why: 'Backup selection: which device paths the backup engine includes; the data goes to the backup store, never to the model.',
  },
  'workspace_collect.paths': {
    kind: 'exempt',
    why: 'Paths inside the server-side AI workspace sandbox, not a device filesystem.',
  },
  'manage_startup_items.itemPath': {
    kind: 'exempt',
    why: 'Disambiguates a startup item by its registered command path; matched against inventory, never opened or listed.',
  },
  'registry_operations.keyPath': {
    kind: 'exempt',
    why: 'A registry key, not a filesystem path; the registry deny-list (isDeniedRegistryTarget) applies instead.',
  },
};

type Found = { field: string; guarded: boolean };

function defOf(node: z.ZodType): Record<string, unknown> & { type: string } {
  return (node as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
}

/** Collects every string-typed field (including string arrays) under a path-like key. */
function collectPathFields(tool: string, root: z.ZodType): Found[] {
  const found = new Map<string, Found>();
  // Ancestors only (guards z.lazy cycles); a shared leaf such as one path
  // validator reused by two fields must be visited under each key.
  const ancestors = new Set<z.ZodType>();

  function visit(node: z.ZodType, keyPath: string[]): void {
    const key = keyPath[keyPath.length - 1] ?? '';
    const field = [tool, ...keyPath].join('.');
    if (node === safePath) {
      // Guarded only if no other branch under the same field is a plain string.
      if (PATH_KEY.test(key)) found.set(field, { field, guarded: found.get(field)?.guarded ?? true });
      return;
    }
    if (ancestors.has(node)) return;
    ancestors.add(node);
    try {
      visitChildren(node, keyPath, key, field);
    } finally {
      ancestors.delete(node);
    }
  }

  function visitChildren(node: z.ZodType, keyPath: string[], key: string, field: string): void {
    const def = defOf(node);
    switch (def.type) {
      case 'object':
        for (const [k, child] of Object.entries(def.shape as Record<string, z.ZodType>)) visit(child, [...keyPath, k]);
        return;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
        visit(def.innerType as z.ZodType, keyPath);
        return;
      case 'array':
        visit(def.element as z.ZodType, keyPath);
        return;
      case 'pipe':
        visit(def.in as z.ZodType, keyPath);
        visit(def.out as z.ZodType, keyPath);
        return;
      case 'union':
        for (const option of def.options as z.ZodType[]) visit(option, keyPath);
        return;
      case 'intersection':
        visit(def.left as z.ZodType, keyPath);
        visit(def.right as z.ZodType, keyPath);
        return;
      case 'lazy':
        visit((def.getter as () => z.ZodType)(), keyPath);
        return;
      case 'string':
        if (PATH_KEY.test(key)) found.set(field, { field, guarded: false });
        return;
      default:
        return;
    }
  }

  visit(root, []);
  return [...found.values()];
}

const allFound = Object.entries(toolInputSchemas).flatMap(([tool, schema]) => collectPathFields(tool, schema));
const foundByField = new Map(allFound.map((f) => [f.field, f]));

describe('AI tool path parameters go through the default path restriction', () => {
  it('the walker sees the known path fields (vacuity control)', () => {
    expect(foundByField.get('file_operations.path')).toEqual({ field: 'file_operations.path', guarded: true });
    expect(foundByField.get('execute_command.payload.path')?.guarded).toBe(false);
    expect(foundByField.has('restore_snapshot.selectedPaths')).toBe(true);
  });

  it('a field is guarded only when every branch under it is safePath', async () => {
    const { z: zod } = await import('zod');
    const mixed = collectPathFields('fixture', zod.object({
      path: zod.union([zod.string(), safePath]),
      otherPath: zod.union([safePath, zod.string()]),
      newPath: safePath.optional(),
    }));
    expect(Object.fromEntries(mixed.map((f) => [f.field, f.guarded]))).toEqual({
      'fixture.path': false,
      'fixture.otherPath': false,
      'fixture.newPath': true,
    });
  });

  it('every path-like field is classified', () => {
    const unclassified = allFound.map((f) => f.field).filter((field) => !(field in PATH_FIELDS));
    expect(unclassified, 'type these as safePath, or add an exemption with a reason').toEqual([]);
  });

  it('no classification is stale', () => {
    const stale = Object.keys(PATH_FIELDS).filter((field) => !foundByField.has(field));
    expect(stale).toEqual([]);
  });

  it('fields classified as safePath are typed as safePath', () => {
    const notGuarded = Object.entries(PATH_FIELDS)
      .filter(([, c]) => c.kind === 'safePath')
      .map(([field]) => field)
      .filter((field) => foundByField.get(field)?.guarded !== true);
    expect(notGuarded).toEqual([]);
  });

  it('every exemption says why', () => {
    const short = Object.entries(PATH_FIELDS)
      .filter(([, c]) => c.kind !== 'safePath' && c.why.trim().length < 30)
      .map(([field]) => field);
    expect(short).toEqual([]);
  });

  it('execute_command applies the restriction to file_list / file_read paths', () => {
    const deviceId = '11111111-1111-1111-1111-111111111111';
    for (const commandType of ['file_list', 'file_read']) {
      for (const path of ['C:\\Users\\bob\\AppData', '/Users/bob/AppData', '']) {
        expect(validateToolInput('execute_command', { deviceId, commandType, payload: { path } }).success).toBe(false);
      }
      expect(validateToolInput('execute_command', { deviceId, commandType, payload: {} }).success).toBe(false);
    }
  });
});
