/**
 * Allowlist for `credentialOriginBindingCoverage.test.ts`: every source file that defines or checks a masked-secret marker
 * (a `'********'`-shaped placeholder, or a name matching
 * `MASKED_*_SECRET`/`isRedactedSecret`/`isMaskedSecret`) must either import
 * `credentialOriginBinding` (`urlOriginChanged` or
 * `webhookOriginChangeWouldRetainAuthorization`) or have a reviewed, reasoned
 * entry here.
 *
 * This is a class that has recurred repeatedly across independently-discovered,
 * never-connected call sites — a masked/preserved credential silently
 * following a destination change to a new origin. Add an entry ONLY when the
 * file genuinely does not resolve a stored secret against a caller-influenced
 * destination; every entry needs a one-line reason a reviewer can check
 * against the file.
 *
 * Path is relative to `apps/api/src/`, exactly as the coverage test walks it.
 */
export interface CredentialOriginBindingAllowlistEntry {
  file: string;
  reason: string;
}

export const CREDENTIAL_ORIGIN_BINDING_ALLOWLIST: readonly CredentialOriginBindingAllowlistEntry[] = [
  {
    file: 'routes/automations.ts',
    reason:
      'The masked marker here guards a webhook TRIGGER secret (automations.trigger) — a value Breeze mints so a ' +
      'third party can sign an INBOUND request that starts the automation. There is no destination URL in this ' +
      'shape at all: the secret is never decrypted and sent anywhere, only compared against an incoming signature.',
  },
  {
    file: 'services/tdSynnexSftpSync.ts',
    reason:
      'Fixed-vendor destination: the SFTP host comes from REGION_HOSTS, not from partner input (see the file\'s ' +
      'own header comment) — a partner cannot repoint this connector at a caller-chosen server, so there is no ' +
      'origin to rebind the credential to.',
  },
  {
    file: 'services/tdSynnexEcExpress.ts',
    reason:
      'Fixed-vendor destination: REGION_ENDPOINTS is a hardcoded map to TD SYNNEX\'s own web service, not a ' +
      'partner-editable field.',
  },
  {
    file: 'services/notificationChannelSecrets.ts',
    reason:
      'Generic encrypt/decrypt/mask infrastructure shared by notification_channels and webhooks columns — it has ' +
      'no destination field of its own. The binding decision is made by its callers before they invoke it; ' +
      'routes/alerts/channels.ts and routes/webhooks.ts both import credentialOriginBinding directly.',
  },
  {
    file: 'services/integrationSettingsSecrets.ts',
    reason:
      'Generic seal/mask infrastructure for the integration-settings JSON blobs (no destination field of its ' +
      'own) — the one call site that resolves a masked secret against a caller-supplied URL ' +
      '(resolveMaskedMonitoringSecrets) lives in routes/integrations.ts, which imports credentialOriginBinding.',
  },
  {
    file: 'services/httpFailureMessage.ts',
    reason:
      'Redacts the caller\'s own already-known secret OUT of an echoed HTTP failure body before it is logged — ' +
      'never decrypts a stored secret and never sends anything anywhere.',
  },
  {
    file: 'routes/backup/configs.ts',
    reason:
      'Its S3 endpoint-change refusal calls `s3EndpointOriginChanged`/`preserveSecretFields` from ' +
      'services/backupProviderConfigSecrets.ts, which imports credentialOriginBinding directly and wraps ' +
      '`urlOriginChanged` for the S3-endpoint shape — the binding is applied, just one import hop away.',
  },
  {
    file: 'services/aiToolsPolicyPrereqs.ts',
    reason:
      'The manage_backup_configs update action applies the same S3 endpoint-change refusal as the REST route, ' +
      'via the same services/backupProviderConfigSecrets.ts helpers (which import credentialOriginBinding ' +
      'directly), instead of importing credentialOriginBinding a second time for an identical check.',
  },
] as const;
