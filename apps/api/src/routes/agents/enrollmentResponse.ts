import type { ManifestKeyDelegation, ManifestTrustKey } from '../../services/manifestSigning';

/**
 * The enrollment response body (POST /agents/enroll), built in one place so a
 * pre-assignment (deploy-key) enrollment can omit what a parked device must not
 * receive.
 */
export type EnrollmentResponseFields = {
  agentId: string;
  deviceId: string;
  authToken: string;
  watchdogAuthToken: string;
  helperAuthToken: string;
  orgId: string;
  siteId: string;
  backupServerUrl: string | undefined;
  config: { heartbeatIntervalSeconds: number; metricsCollectionIntervalSeconds: number };
  mtls: { certificate: string; privateKey: string; expiresAt: string; serialNumber: string } | null;
  manifestTrustKeys: ManifestTrustKey[];
  manifestKeyDelegations: ManifestKeyDelegation[];
};

export type EnrollmentResponseBody =
  | EnrollmentResponseFields
  | Omit<EnrollmentResponseFields, 'backupServerUrl' | 'manifestTrustKeys' | 'manifestKeyDelegations'>;

/**
 * `preAssignment: true` (a device admitted into its partner's holding org)
 * keeps identity and credentials — agent/device ids, the three tokens, org and
 * site, the base config and the mTLS certificate — and drops the backup
 * control-plane URL and the manifest trust material. Everything else is
 * returned exactly as the regular enrollment always has.
 */
export function buildEnrollmentResponseBody(
  fields: EnrollmentResponseFields,
  options: { preAssignment: boolean },
): EnrollmentResponseBody {
  if (!options.preAssignment) {
    return {
      agentId: fields.agentId,
      deviceId: fields.deviceId,
      authToken: fields.authToken,
      watchdogAuthToken: fields.watchdogAuthToken,
      helperAuthToken: fields.helperAuthToken,
      orgId: fields.orgId,
      siteId: fields.siteId,
      backupServerUrl: fields.backupServerUrl,
      config: fields.config,
      mtls: fields.mtls,
      manifestTrustKeys: fields.manifestTrustKeys,
      manifestKeyDelegations: fields.manifestKeyDelegations,
    };
  }
  return {
    agentId: fields.agentId,
    deviceId: fields.deviceId,
    authToken: fields.authToken,
    watchdogAuthToken: fields.watchdogAuthToken,
    helperAuthToken: fields.helperAuthToken,
    orgId: fields.orgId,
    siteId: fields.siteId,
    config: fields.config,
    mtls: fields.mtls,
  };
}
