import type { HealthSource } from '../types';
import { accountingSource } from './accounting';
import { backupProviderSource } from './backupProvider';
import { dnsFilterSource } from './dnsFilter';
import { edrSource } from './edr';
import { huntressSource } from './huntress';
import { m365ConnectionSource } from './m365Connection';
import { m365SyncSource } from './m365Sync';
import { oauthGrantSource } from './oauthGrant';
import { pax8Source } from './pax8';
import { sentinelOneSource } from './sentinelOne';
import { ticketMailboxSource } from './ticketMailbox';
import { unifiSource } from './unifi';
import { webhookSource } from './webhook';

/**
 * Every connection kind the reconciler observes. A new integration registers
 * here (spec §1.1); coverage.contract.test.ts fails on any *_integrations /
 * *_connections table with neither a source nor an exemption below.
 */
export const HEALTH_SOURCES: readonly HealthSource[] = [
  oauthGrantSource,
  huntressSource,
  sentinelOneSource,
  pax8Source,
  unifiSource,
  backupProviderSource,
  edrSource,
  accountingSource,
  dnsFilterSource,
  m365ConnectionSource,
  m365SyncSource,
  ticketMailboxSource,
  webhookSource,
];

/** Connection tables deliberately without a health source, and why. */
export const SOURCE_COVERAGE_EXEMPTIONS: Readonly<Record<string, string>> = {
  psa_connections: 'No worker writes its sync status or error columns today (dormant).',
  partner_ai_connections: 'AI gateway connection; failures surface in AI chat. Candidate for W4.',
  td_synnex_ec_express_integrations: 'Catalog price feed with a manual connection test only. Candidate for W4 staleness.',
  td_synnex_digital_bridge_integrations: 'Catalog price feed with a manual connection test only. Candidate for W4 staleness.',
  td_synnex_sftp_integrations: 'Catalog price-file feed. Candidate for W4 staleness.',
  google_workspace_connections: 'No failure column; health needs the W4 verification probe.',
  delegant_m365_connections: 'No failure column; status is only ever active.',
  c2c_connections: 'No failure column; revoked is a deliberate disconnect.',
  device_connections: 'Per-device network sockets, not an integration.',
};
