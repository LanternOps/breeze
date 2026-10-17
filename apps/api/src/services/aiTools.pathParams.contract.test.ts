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
import { PATH_FIELDS } from './aiToolPathFields';

const PATH_KEY = /(path|paths|dir|dirs|directory|directories|folder|folders)$/i;

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
