import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
import { discoverExtensions } from './discovery';

let cache: ExtensionTenancyDeclaration[] | null = null;

/**
 * Tenancy declarations published by the runtime reconciler for SIGNED bundle
 * extensions (which are NOT on disk under `discoverExtensions()`). The reconciler
 * publishes an extension's declarations the moment its migrations succeed —
 * BEFORE staging/activation — so the cascade / device-move lists survive even if
 * the extension's code later fails validation or is disabled. Already-migrated
 * tenant tables must keep getting purged on org/device delete regardless of
 * whether the contribution code is live.
 */
const runtimeTenancy: ExtensionTenancyDeclaration[] = [];

export function getExtensionTenancy(): ExtensionTenancyDeclaration[] {
  if (cache === null) cache = discoverExtensions().map((e) => e.manifest.tenancy);
  return [...cache, ...runtimeTenancy];
}

/**
 * Register a signed-bundle extension's tenancy declaration so the cascade/denorm
 * helpers include its tables. Idempotent per declaration object; safe to call
 * again for the same extension (the RLS helpers dedupe by table name).
 */
export function registerRuntimeExtensionTenancy(
  declaration: ExtensionTenancyDeclaration,
): void {
  runtimeTenancy.push(declaration);
}

export function resetExtensionTenancyCacheForTests(): void {
  cache = null;
  runtimeTenancy.length = 0;
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
