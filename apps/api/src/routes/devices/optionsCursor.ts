import { createHash } from 'node:crypto';
import { UUID_REGEX } from '../../utils/uuid';

export type DeviceOptionsCursor = {
  v: 1;
  label: string;
  id: string;
  fingerprint: string;
};

export type DeviceOptionsFingerprintInput = {
  search?: string;
  status?: string;
  siteId?: string;
  osType?: string;
  orgId?: string;
  scope: 'organization' | 'partner' | 'system';
  accessibleOrgIds: string[] | null;
  allowedSiteIds?: string[];
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function sorted(values: readonly string[] | null | undefined): string[] | null {
  if (values === null) return null;
  return [...(values ?? [])].sort();
}

export function buildDeviceOptionsFingerprint(input: DeviceOptionsFingerprintInput): string {
  const canonical = JSON.stringify({
    v: 1,
    search: input.search?.trim().toLocaleLowerCase('en-US') || null,
    status: input.status ?? null,
    siteId: input.siteId ?? null,
    osType: input.osType ?? null,
    orgId: input.orgId ?? null,
    scope: input.scope,
    accessibleOrgIds: sorted(input.accessibleOrgIds),
    allowedSiteIds: input.allowedSiteIds === undefined ? null : sorted(input.allowedSiteIds),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function encodeDeviceOptionsCursor(cursor: DeviceOptionsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDeviceOptionsCursor(
  token: string | null | undefined,
  expectedFingerprint: string,
): DeviceOptionsCursor | null {
  if (!token || token.length > 2_048 || !TOKEN_PATTERN.test(token)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1) return null;
  if (typeof value.label !== 'string' || value.label.length > 255) return null;
  if (typeof value.id !== 'string' || !UUID_REGEX.test(value.id)) return null;
  if (typeof value.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint)) return null;
  if (value.fingerprint !== expectedFingerprint) return null;

  return {
    v: 1,
    label: value.label,
    id: value.id,
    fingerprint: value.fingerprint,
  };
}
