import { createHash } from 'node:crypto';

export const SOFTWARE_DEPENDENCY_CHANGED =
  'Software dependency changed after deployment approval; create a new deployment';
export const SOFTWARE_DEPENDENCY_UNPINNED =
  'Software deployment predates dependency pinning; recreate it before dispatch';

type CatalogIdentity = {
  integrationProvider: string | null;
};

type VersionIdentity = {
  id: string;
  catalogId: string;
  downloadUrl: string | null;
  s3Key: string | null;
  checksum: string | null;
  originalFileName: string | null;
  fileType: string | null;
  silentInstallArgs: string | null;
  version: string;
  detectionRules?: unknown;
};

type InstallMethodIdentity = {
  id: string;
  catalogId: string;
  platform: string;
  kind: string;
  packageId: string;
};

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(identity: unknown): string {
  return createHash('sha256').update(canonicalize(identity), 'utf8').digest('hex');
}

export function fingerprintSoftwareVersionDependency(
  version: VersionIdentity,
  catalog: CatalogIdentity,
): string {
  return fingerprint({
    schema: 1,
    kind: 'version',
    version: {
      id: version.id,
      catalogId: version.catalogId,
      downloadUrl: version.downloadUrl,
      s3Key: version.s3Key,
      checksum: version.checksum,
      originalFileName: version.originalFileName,
      fileType: version.fileType,
      silentInstallArgs: version.silentInstallArgs,
      version: version.version,
      detectionRules: version.detectionRules ?? null,
    },
    catalog: { integrationProvider: catalog.integrationProvider },
  });
}

export function fingerprintSoftwareInstallMethodDependency(
  method: InstallMethodIdentity,
  catalog: CatalogIdentity,
): string {
  return fingerprint({
    schema: 1,
    kind: 'installMethod',
    method: {
      id: method.id,
      catalogId: method.catalogId,
      platform: method.platform,
      kind: method.kind,
      packageId: method.packageId,
    },
    catalog: { integrationProvider: catalog.integrationProvider },
  });
}

export function dependencyFingerprintError(
  approvedFingerprint: string | null | undefined,
  currentFingerprint: string,
): string | null {
  if (!approvedFingerprint) return SOFTWARE_DEPENDENCY_UNPINNED;
  return approvedFingerprint === currentFingerprint ? null : SOFTWARE_DEPENDENCY_CHANGED;
}
