/**
 * What the create and rotate forms need to know about each backup provider.
 * Adding an adapter should be a new entry here, not a new branch in the forms.
 */

export type BackupCredentialField = {
  /** Key in the posted `credentials` object. */
  key: string;
  labelKey: string;
  /** Rendered as `backup-add-${suffix}` on create and `backup-connection-${suffix}` on rotate. */
  testIdSuffix: string;
  input: "text" | "secret" | "revealable_secret";
  trim: boolean;
  requiredOnCreate: boolean;
  autoComplete?: "off";
};

export type BackupProviderForm = {
  provider: "cove" | "dropsuite" | "axcient";
  labelKey: string;
  namePlaceholderKey: string;
  inventory: "endpoint" | "saas";
  fields: BackupCredentialField[];
  /** Non-null means the create form requires and posts a base URL. */
  baseUrl: { placeholder: string; helpKey: string } | null;
  helpKey: string;
  reentryHelpKey: string | null;
  rotation: { requires: string[]; partialIsIncomplete: boolean };
};

const COVE_FORM: BackupProviderForm = {
  provider: "cove",
  labelKey: "backupProviders.cove",
  namePlaceholderKey: "backupProviders.namePlaceholder",
  inventory: "endpoint",
  fields: [
    { key: "partnerName", labelKey: "backupProviders.partnerNameLabel", testIdSuffix: "partner-name", input: "text", trim: true, requiredOnCreate: true },
    { key: "username", labelKey: "backupProviders.usernameLabel", testIdSuffix: "username", input: "text", trim: true, requiredOnCreate: true, autoComplete: "off" },
    // Never trimmed: a Cove token may legitimately end in whitespace, and the
    // API schema keeps it verbatim for the same reason.
    { key: "password", labelKey: "backupProviders.passwordLabel", testIdSuffix: "password", input: "revealable_secret", trim: false, requiredOnCreate: true },
  ],
  baseUrl: null,
  helpKey: "backupProviders.credentialsHelp",
  reentryHelpKey: null,
  // Mirrors coveCredentialsSchema: the API replaces the whole set, so a partial
  // rotation is blocked rather than silently dropped.
  rotation: { requires: ["partnerName", "username", "password"], partialIsIncomplete: true },
};

const DROPSUITE_FORM: BackupProviderForm = {
  provider: "dropsuite",
  labelKey: "backupProviders.dropsuite",
  namePlaceholderKey: "backupProviders.namePlaceholderDropsuite",
  inventory: "saas",
  fields: [
    { key: "resellerToken", labelKey: "backupProviders.resellerTokenLabel", testIdSuffix: "reseller-token", input: "secret", trim: true, requiredOnCreate: true },
    { key: "authToken", labelKey: "backupProviders.authTokenLabel", testIdSuffix: "auth-token", input: "secret", trim: true, requiredOnCreate: true },
  ],
  baseUrl: { placeholder: "https://dropsuite.us/api/", helpKey: "backupProviders.baseUrlHelp" },
  helpKey: "backupProviders.dropsuiteCredentialsHelp",
  reentryHelpKey: "backupProviders.dropsuiteReentryHelp",
  rotation: { requires: ["resellerToken", "authToken"], partialIsIncomplete: true },
};

const AXCIENT_FORM: BackupProviderForm = {
  provider: "axcient",
  labelKey: "backupProviders.axcient",
  namePlaceholderKey: "backupProviders.namePlaceholderAxcient",
  inventory: "endpoint",
  fields: [
    { key: "apiKey", labelKey: "backupProviders.apiKeyLabel", testIdSuffix: "api-key", input: "secret", trim: true, requiredOnCreate: true },
  ],
  baseUrl: null,
  helpKey: "backupProviders.axcientCredentialsHelp",
  reentryHelpKey: "backupProviders.axcientReentryHelp",
  rotation: { requires: ["apiKey"], partialIsIncomplete: false },
};

export const BACKUP_PROVIDER_FORMS: readonly BackupProviderForm[] = [COVE_FORM, DROPSUITE_FORM, AXCIENT_FORM];

/** An unknown provider gets the Cove form, as the old non-Dropsuite branches did. */
export function getBackupProviderForm(provider: string): BackupProviderForm {
  return BACKUP_PROVIDER_FORMS.find((form) => form.provider === provider) ?? COVE_FORM;
}

function fieldValue(field: BackupCredentialField, values: Record<string, string>): string {
  const value = values[field.key] ?? "";
  return field.trim ? value.trim() : value;
}

/**
 * Reads only the provider's own fields, in descriptor order, so a value left in
 * state by another provider can never reach the posted body.
 */
export function createCredentials(form: BackupProviderForm, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(form.fields.map((field) => [field.key, fieldValue(field, values)]));
}

/** Credential fields only. The caller still gates on the name and any base URL. */
export function canSubmitCreate(form: BackupProviderForm, values: Record<string, string>): boolean {
  // Blankness is judged on the trimmed value: the API rejects a whitespace-only
  // secret even for fields it keeps verbatim (`trim: false`).
  return form.fields.every((field) => !field.requiredOnCreate || (values[field.key] ?? "").trim() !== "");
}

/**
 * What a rotate-form save should send: `credentials` to replace the stored set,
 * `incomplete` to block the save, or `null` to keep what is stored.
 *
 * Blankness is always judged on the trimmed value, whatever the field's `trim`
 * flag; `trim` only decides what is posted.
 */
export function rotationCredentials(
  form: BackupProviderForm,
  values: Record<string, string>,
): { credentials: Record<string, string> } | { incomplete: true } | null {
  const filled = form.rotation.requires.filter((key) => (values[key] ?? "").trim() !== "").length;
  if (filled === form.rotation.requires.length) return { credentials: createCredentials(form, values) };
  return filled > 0 && form.rotation.partialIsIncomplete ? { incomplete: true } : null;
}

/** State to keep after a successful rotation: secrets go, plain text stays. */
export function valuesAfterRotation(form: BackupProviderForm, values: Record<string, string>): Record<string, string> {
  const plainText = form.fields.filter((field) => field.input === "text").map((field) => field.key);
  return Object.fromEntries(Object.entries(values).filter(([key]) => plainText.includes(key)));
}
