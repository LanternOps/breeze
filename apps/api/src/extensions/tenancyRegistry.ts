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

/** Extension device-cascade tables run FIRST (extension rows may FK core rows, never vice versa). */
export function withExtensionDeviceCascade(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.deviceCascadeDeleteTables);
  return [...extra, ...core];
}

export function withExtensionDeviceOrgDenormalized(core: readonly string[]): string[] {
  const extra = getExtensionTenancy().flatMap((t) => t.deviceOrgDenormalizedTables);
  return [...core, ...extra];
}
