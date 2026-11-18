type Translate = (key: string) => string;

const METHOD_KEYS: Record<string, string> = {
  bitlocker: "securityEncryptionPage.bitlocker",
  filevault: "securityEncryptionPage.filevault",
  luks: "securityEncryptionPage.luks",
  none: "securityEncryptionPage.none",
  unknown: "securityEncryptionPage.unknown",
};

const STATUS_KEYS: Record<string, string> = {
  encrypted: "securityEncryptionPage.encrypted",
  partial: "securityEncryptionPage.partial",
  unencrypted: "securityEncryptionPage.unencrypted",
  fully_encrypted: "securityEncryptionPage.fullyEncrypted",
};

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function sentenceCase(raw: string): string {
  const spaced = raw.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Display label for an encryption method; proper nouns keep their casing. */
export function encryptionMethodLabel(
  method: string | null | undefined,
  t: Translate,
): string {
  if (!method) return t(/* i18n-dynamic */ METHOD_KEYS.unknown);
  const norm = normalize(method);
  const key = METHOD_KEYS[norm];
  if (key) return t(/* i18n-dynamic */ key);
  if (norm === "dm_crypt") return "dm-crypt";
  return method;
}

/** Humanized label for a device or volume encryption status enum. */
export function encryptionStatusLabel(
  status: string | null | undefined,
  t: Translate,
): string {
  if (!status) return "-";
  const key = STATUS_KEYS[normalize(status)];
  return key ? t(/* i18n-dynamic */ key) : sentenceCase(status);
}
