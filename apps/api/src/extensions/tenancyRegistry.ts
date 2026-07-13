import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
import { discoverExtensions } from './discovery';

let cache: ExtensionTenancyDeclaration[] | null = null;

export function getExtensionTenancy(): ExtensionTenancyDeclaration[] {
  if (cache === null) cache = discoverExtensions().map((e) => e.manifest.tenancy);
  return cache;
}

export function resetExtensionTenancyCacheForTests(): void {
  cache = null;
}

/** Alphabetised union with 'organizations' pinned last (contract-test invariant). */
export function withExtensionOrgCascade(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.orgCascadeDeleteTables);
  const combined = [...core, ...extra];
  const hasOrganizations = combined.includes('organizations');
  const set = new Set(combined.filter((t) => t !== 'organizations'));
  const sorted = [...set].sort((a, b) => a.localeCompare(b));
  return hasOrganizations ? [...sorted, 'organizations'] : sorted;
}

/**
 * Dedupe extension-declared tables WITHOUT disturbing core's ordering.
 *
 * A naive `[...new Set([...extra, ...core])]` keeps the FIRST occurrence, so a
 * table present in both lists gets silently HOISTED out of its core position to
 * the front. The core cascade lists are explicitly FK-ordered (children first),
 * so hoisting can put a parent ahead of rows that reference it — a `23503` mid
 * transaction. That trades a real invariant for a non-problem: double-deleting
 * an already-deleted row is a harmless no-op.
 *
 * So: drop the extension's entry when core already has the table, and let core
 * keep its position.
 */
function dedupeAgainstCore(extra: readonly string[], core: readonly string[]): string[] {
  const coreSet = new Set(core);
  return [...new Set(extra)].filter((t) => !coreSet.has(t));
}

/** Extension device-cascade tables run FIRST (extension rows may FK core rows, never vice versa). */
export function withExtensionDeviceCascade(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.deviceCascadeDeleteTables);
  return [...dedupeAgainstCore(extra, core), ...core];
}

export function withExtensionDeviceOrgMoveDelete(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.deviceOrgMoveDeleteTables ?? []);
  return [...dedupeAgainstCore(extra, core), ...core];
}

export function withExtensionDeviceOrgDenormalized(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.deviceOrgDenormalizedTables);
  return [...core, ...dedupeAgainstCore(extra, core)];
}
