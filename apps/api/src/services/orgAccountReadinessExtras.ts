/**
 * W03 sections of GET /orgs/account-readiness, gated by capability so a
 * withheld section is never queried (spec: "Section omitted from the API
 * response and from capabilities"). The route keeps owning shaping; this
 * module only decides what to load and hands back per-org fields.
 */
import { loadIntegrationReadiness, type Connector, type IntegrationGrants, type OrgIntegration } from './orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness, type BackupReadiness } from './orgAccountReadinessCommercial';

export interface AccountReadinessExtras {
  /** null = withheld (no connected_apps:read). */
  connectors: Connector[] | null;
  integrationsByOrg: Map<string, OrgIntegration[]> | null;
  /** null = withheld (no contracts:read, or not native mode). */
  activeContracts: Map<string, number> | null;
  /** null = withheld (no backup:read). */
  backup: BackupReadiness | null;
}

export const EMPTY_EXTRAS: AccountReadinessExtras = {
  connectors: null,
  integrationsByOrg: null,
  activeContracts: null,
  backup: null,
};

export interface ExtrasCapabilities {
  integrations: boolean;
  contracts: boolean;
  backup: boolean;
}

/**
 * Runs inside the caller's request transaction (single connection):
 * Promise.all is orchestration only, not parallelism.
 */
export async function computeAccountReadinessExtras(input: {
  partnerId: string;
  orgIds: readonly string[];
  capabilities: ExtrasCapabilities;
  grants: IntegrationGrants;
  now: Date;
}): Promise<AccountReadinessExtras> {
  const { partnerId, orgIds, capabilities, grants, now } = input;
  const [integrations, activeContracts, backup] = await Promise.all([
    capabilities.integrations ? loadIntegrationReadiness({ partnerId, orgIds, grants, now }) : null,
    capabilities.contracts ? loadActiveContractCounts(orgIds) : null,
    capabilities.backup ? loadBackupReadiness(partnerId, orgIds) : null,
  ]);
  return {
    connectors: integrations ? integrations.connectors : null,
    integrationsByOrg: integrations ? integrations.byOrg : null,
    activeContracts,
    backup,
  };
}

export interface OrgExtraFields {
  integrations?: OrgIntegration[];
  activeContracts?: number;
  backupApplicable?: boolean;
  backupConfigured?: boolean;
}

/** The W03 fields for one org — absent when the section was withheld, defaulted when the org simply has none. */
export function extrasForOrg(orgId: string, extras: AccountReadinessExtras): OrgExtraFields {
  const fields: OrgExtraFields = {};
  if (extras.integrationsByOrg) fields.integrations = extras.integrationsByOrg.get(orgId) ?? [];
  if (extras.activeContracts) fields.activeContracts = extras.activeContracts.get(orgId) ?? 0;
  if (extras.backup) {
    fields.backupApplicable = extras.backup.applicable;
    fields.backupConfigured = extras.backup.configuredOrgIds.has(orgId);
  }
  return fields;
}
