import type { ExtensionCapability, ExtensionManifestV1 } from '@breeze/extension-sdk';
import { satisfies } from 'semver';

export interface ExtensionHostDescriptor {
  apiVersions: readonly string[];
  breezeVersion: string;
  serverSdkVersion: string;
  webSdkVersion?: string;
  capabilities: readonly ExtensionCapability[];
  slots: Readonly<Record<string, readonly number[]>>;
}

export type CompatibilityResult =
  | { compatible: true; reasons: [] }
  | { compatible: false; reasons: string[] };

export function checkExtensionCompatibility(
  manifest: ExtensionManifestV1,
  host: ExtensionHostDescriptor,
): CompatibilityResult {
  const reasons: string[] = [];

  if (!host.apiVersions.includes(manifest.apiVersion)) {
    reasons.push(`unsupported manifest API ${manifest.apiVersion}`);
  }
  if (!satisfies(host.breezeVersion, manifest.requires.breeze)) {
    reasons.push(`unsupported Breeze range ${manifest.requires.breeze}`);
  }
  if (!satisfies(host.serverSdkVersion, manifest.requires.serverSdk)) {
    reasons.push(`unsupported server SDK range ${manifest.requires.serverSdk}`);
  }
  if (manifest.requires.webSdk !== undefined && (
    host.webSdkVersion === undefined
    || !satisfies(host.webSdkVersion, manifest.requires.webSdk)
  )) {
    reasons.push(`unsupported web SDK range ${manifest.requires.webSdk}`);
  }

  const hostCapabilities = new Set(host.capabilities);
  for (const capability of manifest.requires.capabilities) {
    if (!hostCapabilities.has(capability)) {
      reasons.push(`missing capability ${capability}`);
    }
  }

  for (const contribution of manifest.web?.slots ?? []) {
    if (!host.slots[contribution.slot]?.includes(contribution.contractVersion)) {
      reasons.push(`unsupported slot ${contribution.slot}@${contribution.contractVersion}`);
    }
  }

  return reasons.length === 0
    ? { compatible: true, reasons: [] }
    : { compatible: false, reasons };
}
