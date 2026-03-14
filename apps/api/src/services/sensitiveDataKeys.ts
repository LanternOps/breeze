import { createHash } from 'crypto';

export type SensitiveDataKeySelection = {
  provider: 'keyring';
  keyRef: string;
  keyVersion: string;
  keyFingerprint: string;
};

type KeyringShape = Record<string, Record<string, string>>;

function parseKeyringJson(raw: string | undefined): KeyringShape {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: KeyringShape = {};
    for (const [ref, versions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!versions || typeof versions !== 'object' || Array.isArray(versions)) continue;
      const normalizedRef = ref.trim();
      if (!normalizedRef) continue;
      const byVersion: Record<string, string> = {};
      for (const [version, keyValue] of Object.entries(versions as Record<string, unknown>)) {
        if (typeof keyValue !== 'string' || keyValue.trim() === '') continue;
        const normalizedVersion = version.trim();
        if (!normalizedVersion) continue;
        byVersion[normalizedVersion] = keyValue.trim();
      }
      if (Object.keys(byVersion).length > 0) {
        out[normalizedRef] = byVersion;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function fingerprint(base64Value: string): string {
  return createHash('sha256').update(base64Value).digest('hex').slice(0, 16);
}

function resolveDefaultSelection(keyring: KeyringShape): { keyRef: string; keyVersion: string } | null {
  const preferredRef = process.env.SENSITIVE_DATA_ENCRYPTION_KEY_REF?.trim();
  const preferredVersion = process.env.SENSITIVE_DATA_ENCRYPTION_KEY_VERSION?.trim();

  if (preferredRef && preferredVersion && keyring[preferredRef]?.[preferredVersion]) {
    return { keyRef: preferredRef, keyVersion: preferredVersion };
  }

  if (preferredRef && keyring[preferredRef]) {
    const versions = Object.keys(keyring[preferredRef] ?? {}).sort();
    if (versions.length > 0) {
      return { keyRef: preferredRef, keyVersion: versions[versions.length - 1]! };
    }
  }

  const refs = Object.keys(keyring).sort();
  for (const ref of refs) {
    const versions = Object.keys(keyring[ref] ?? {}).sort();
    if (versions.length > 0) {
      return { keyRef: ref, keyVersion: versions[versions.length - 1]! };
    }
  }

  return null;
}

export function resolveSensitiveDataKeySelection(input?: {
  requestedKeyRef?: string;
  requestedKeyVersion?: string;
}): SensitiveDataKeySelection {
  const keyring = parseKeyringJson(process.env.SENSITIVE_DATA_KEYRING_JSON);
  const fallbackSingle = process.env.SENSITIVE_DATA_ENCRYPTION_KEY_B64?.trim();

  if (Object.keys(keyring).length === 0) {
    if (!fallbackSingle) {
      throw new Error('No sensitive-data keyring configured');
    }
    const keyRef = input?.requestedKeyRef?.trim() || process.env.SENSITIVE_DATA_ENCRYPTION_KEY_REF?.trim() || 'default';
    const keyVersion = input?.requestedKeyVersion?.trim() || process.env.SENSITIVE_DATA_ENCRYPTION_KEY_VERSION?.trim() || 'v1';
    return {
      provider: 'keyring',
      keyRef,
      keyVersion,
      keyFingerprint: fingerprint(fallbackSingle)
    };
  }

  const requestedRef = input?.requestedKeyRef?.trim();
  const requestedVersion = input?.requestedKeyVersion?.trim();
  if (requestedRef && requestedVersion) {
    const value = keyring[requestedRef]?.[requestedVersion];
    if (!value) {
      throw new Error(`Unknown key selection ${requestedRef}/${requestedVersion}`);
    }
    return {
      provider: 'keyring',
      keyRef: requestedRef,
      keyVersion: requestedVersion,
      keyFingerprint: fingerprint(value)
    };
  }

  if (requestedRef) {
    const versions = Object.keys(keyring[requestedRef] ?? {}).sort();
    if (versions.length === 0) {
      throw new Error(`Unknown key reference ${requestedRef}`);
    }
    const selectedVersion = versions[versions.length - 1]!;
    return {
      provider: 'keyring',
      keyRef: requestedRef,
      keyVersion: selectedVersion,
      keyFingerprint: fingerprint(keyring[requestedRef]![selectedVersion]!)
    };
  }

  const selection = resolveDefaultSelection(keyring);
  if (!selection) {
    throw new Error('No usable sensitive-data key version found');
  }

  const value = keyring[selection.keyRef]![selection.keyVersion]!;
  return {
    provider: 'keyring',
    keyRef: selection.keyRef,
    keyVersion: selection.keyVersion,
    keyFingerprint: fingerprint(value)
  };
}

