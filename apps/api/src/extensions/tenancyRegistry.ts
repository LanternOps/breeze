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

export type ExtensionOrgExportColumnPolicy = Readonly<{
  include: readonly string[];
  exclude: readonly string[];
}>;

function assertUniqueExportColumns(
  table: string,
  policy: ExtensionOrgExportColumnPolicy,
): void {
  const include = new Set(policy.include);
  const exclude = new Set(policy.exclude);
  if (include.size !== policy.include.length) {
    throw new Error(
      `[tenantExport] extension table "${table}" has duplicate include columns`,
    );
  }
  if (exclude.size !== policy.exclude.length) {
    throw new Error(
      `[tenantExport] extension table "${table}" has duplicate exclude columns`,
    );
  }
  const overlap = policy.include.filter((column) => exclude.has(column));
  if (overlap.length > 0) {
    throw new Error(
      `[tenantExport] extension table "${table}" has include/exclude overlap: `
        + overlap.join(', '),
    );
  }
}

function equivalentExportPolicy(
  left: ExtensionOrgExportColumnPolicy,
  right: ExtensionOrgExportColumnPolicy,
): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(sorted(left.include)) === JSON.stringify(sorted(right.include))
    && JSON.stringify(sorted(left.exclude)) === JSON.stringify(sorted(right.exclude));
}

/**
 * Return the fail-closed union of extension org-export classifications.
 *
 * Runtime extension declarations are intentionally read on every call so an
 * extension registered after process boot participates in the next export.
 */
export function getExtensionOrgExportColumns(): Readonly<
  Record<string, ExtensionOrgExportColumnPolicy>
> {
  const merged: Record<string, ExtensionOrgExportColumnPolicy> = {};
  for (const declaration of getExtensionTenancy()) {
    const exportColumns = declaration.orgExportColumns ?? {};
    for (const table of declaration.orgCascadeDeleteTables) {
      const policy = exportColumns[table];
      if (!policy) {
        throw new Error(
          `[tenantExport] extension table "${table}" is missing an export classification`,
        );
      }
      assertUniqueExportColumns(table, policy);
      const existing = merged[table];
      if (existing && !equivalentExportPolicy(existing, policy)) {
        throw new Error(
          `[tenantExport] extension table "${table}" has inconsistent export classifications`,
        );
      }
      merged[table] ??= policy;
    }
  }
  return merged;
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
