import { isEdrInstallerProviderKey } from './edrProviders/providerKeys';

/**
 * A framework provider's installer link and file name are per-company secrets:
 * GravityZone's downloader carries its configuration in its file name [U], and an
 * agent's exec error echoes that name. Scrubbed on the server where results are
 * stored, so no agent release is needed (W06 Decision 7).
 */
export interface InstallerSecrets {
  fileName?: string | null;
  downloadUrl?: string | null;
}

const REPLACEMENT = '[installer]';
/** A shorter stem ("setup") is ordinary installer output, not a secret. */
const MIN_STEM_LENGTH = 8;

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function urlForms(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const encodedName = url.pathname.split('/').pop() ?? '';
  return [raw, `${url.origin}${url.pathname}`, encodedName, withoutExtension(encodedName)];
}

/** Pure. Replaces every form the secret can take in agent output, longest first, ignoring case. */
export function scrubInstallerSecrets(text: string, secrets: InstallerSecrets): string {
  const fileName = secrets.fileName || null;
  const forms = [
    ...(fileName ? [fileName, withoutExtension(fileName)] : []),
    ...(secrets.downloadUrl ? urlForms(secrets.downloadUrl) : []),
  ];
  const keep = (form: string) => form === fileName || form.length >= MIN_STEM_LENGTH;
  const unique = [...new Set(forms.filter((form) => form && keep(form)))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return text;
  const pattern = unique.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.replace(new RegExp(pattern, 'gi'), REPLACEMENT);
}

/**
 * The secrets to scrub for a command, read from its own persisted payload. Dispatch
 * marks only framework-provider installs, so every other result is stored unchanged.
 */
export function installerSecretsFromPayload(payload: unknown): InstallerSecrets | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { integrationProvider, fileName, downloadUrl } = payload as Record<string, unknown>;
  if (typeof integrationProvider !== 'string' || !isEdrInstallerProviderKey(integrationProvider)) return null;
  return {
    fileName: typeof fileName === 'string' ? fileName : null,
    downloadUrl: typeof downloadUrl === 'string' ? downloadUrl : null,
  };
}
