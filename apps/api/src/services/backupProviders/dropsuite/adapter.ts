import { z } from 'zod';
import { EXTERNAL_BACKUP_STATUS_SEVERITY, type ExternalBackupStatus } from '@breeze/shared';
import { ProviderRequestError, type BackupProviderAdapter, type VendorDevice } from '../types';
import { CustomerRequestError, DropsuiteClient, scrubTokens } from './client';

export const dropsuiteCredentialsSchema = z.object({
  resellerToken: z.string().uuid(),
  authToken: z.string().trim().min(1).max(200),
}).strip();

type RecordData = Record<string, unknown>;
type ClientFactory = (baseUrl: string, resellerToken: string) => Pick<DropsuiteClient, 'get' | 'list' | 'abort'>;
const productionFactory: ClientFactory = (baseUrl, resellerToken) => new DropsuiteClient({ baseUrl, resellerToken });
let clientFactory = productionFactory;
export function __setDropsuiteClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory ?? productionFactory;
}

function validateBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const allowed = ['dropsuite.us', 'dropsuite.com', 'dropmyemail.com'];
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
        || !url.pathname.startsWith('/api')) {
      return 'Dropsuite base URL must use HTTPS on a Dropsuite host with an /api path';
    }
    return null;
  } catch {
    return 'Invalid Dropsuite base URL';
  }
}

function connect(credentials: unknown, baseUrl: string) {
  const parsed = dropsuiteCredentialsSchema.safeParse(credentials);
  if (!parsed.success) throw new ProviderRequestError('Dropsuite credentials are incomplete', { code: 'invalid_credentials', reauth: true });
  const invalidUrl = validateBaseUrl(baseUrl);
  if (invalidUrl) throw new ProviderRequestError(invalidUrl, { code: 'invalid_base_url', reauth: false });
  return { creds: parsed.data, client: clientFactory(baseUrl, parsed.data.resellerToken) };
}

/** Normalise JSON-encoded errors without exposing vendor internals. */
function normaliseErrors(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function hasErrors(value: unknown): boolean {
  const errors = normaliseErrors(value);
  return errors != null && errors !== '' && !(typeof errors === 'object' && Object.keys(errors).length === 0);
}
function date(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function requireId(record: RecordData, key = 'id'): string {
  if ((typeof record[key] !== 'string' && typeof record[key] !== 'number') || !String(record[key]).trim()) {
    throw new ProviderRequestError('Dropsuite record has no identity', { code: 'malformed_response', reauth: false });
  }
  return String(record[key]);
}
function validateUsers(users: RecordData[]): RecordData[] {
  users.forEach(user => requireId(user));
  return users;
}
function text(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
}

export function mapDropsuiteStatus(item: RecordData, googleDrive: boolean, now: Date): ExternalBackupStatus {
  switch (item.current_backup_status) {
    case 'Completed': return hasErrors(item.errors) ? 'completed_with_errors' : 'completed';
    case 'Running': case 'Preparing Backup': case 'Connecting': return 'in_progress';
    case 'Connection Failed': case 'Authentication Error': case 'System Error': return 'failed';
  }
  if (googleDrive && !item.current_backup_status) return date(item.last_backup) ? 'completed' : 'no_backups';
  const added = date(item.added_on);
  if (!date(item.last_backup) && added && now.getTime() - added.getTime() > 24 * 3600_000) return 'no_backups';
  return 'unknown';
}

const WORKLOADS = {
  m365_mail: ['Microsoft 365 mail', 'mailboxes'],
  gws_mail: ['Google Workspace mail', 'mailboxes'],
  m365_onedrive: ['Microsoft 365 OneDrive', 'drives'],
  m365_sharepoint: ['Microsoft 365 SharePoint', 'sites'],
  m365_teams: ['Microsoft 365 Teams', 'teams'],
  gws_drive: ['Google Workspace Drive', 'drives'],
  gws_shared_drive: ['Google Workspace shared drives', 'drives'],
} as const;
type Workload = keyof typeof WORKLOADS;
const failingStatuses = new Set<ExternalBackupStatus>(['failed', 'no_backups', 'unknown', 'completed_with_errors']);
function enabledFlag(value: unknown): boolean { return value === true || value === 1 || value === 'true' || value === '1'; }

/** All source payloads are scrubbed BEFORE projection or truncating error text. */
export function rollupWorkload(customer: RecordData, workload: Workload, payload: RecordData[], now: Date, tokens: readonly string[]): VendorDevice | null {
  if (!payload.length) return null;
  const cleanCustomer = scrubTokens(customer, tokens) as RecordData;
  const items = (scrubTokens(payload, tokens) as RecordData[]).filter(item => !item.deactivated_since);
  const disabled = enabledFlag(customer.customer_deactivated) || enabledFlag(customer.flg_suspended);
  const googleDrive = workload === 'gws_drive' || workload === 'gws_shared_drive';
  const statusCounts: Record<string, number> = Object.create(null);
  const vendorStatuses: Record<string, number> = Object.create(null);
  const failingItems: Array<{name: string; status: ExternalBackupStatus; lastBackup: string | null; error: string | null}> = [];
  let status: ExternalBackupStatus = 'completed';
  let lastSuccess: Date | null = null;
  let newest: Date | null = null;
  let created: Date | null = null;
  let usedBytes = 0;
  let errorsCount = 0;
  const staleMs = (workload === 'm365_teams' ? 7 * 24 : 48) * 3600_000;
  for (const item of items) {
    const mapped = disabled ? 'not_started' : mapDropsuiteStatus(item, googleDrive, now);
    statusCounts[mapped] = (statusCounts[mapped] ?? 0) + 1;
    if (typeof item.current_backup_status === 'string') vendorStatuses[item.current_backup_status] = (vendorStatuses[item.current_backup_status] ?? 0) + 1;
    if (EXTERNAL_BACKUP_STATUS_SEVERITY[mapped] > EXTERNAL_BACKUP_STATUS_SEVERITY[status]) status = mapped;
    const lastBackup = date(item.last_backup);
    if (lastBackup && (!newest || lastBackup > newest)) newest = lastBackup;
    if (lastBackup) {
      if (workload === 'm365_teams') {
        if ((mapped === 'completed' || mapped === 'completed_with_errors') && (!lastSuccess || lastBackup > lastSuccess)) lastSuccess = lastBackup;
      } else if (!lastSuccess || lastBackup < lastSuccess) lastSuccess = lastBackup;
    }
    const added = date(item.added_on);
    if (added && (!created || added < created)) created = added;
    const storage = Number(item.storage ?? 0);
    if (Number.isFinite(storage) && storage >= 0) usedBytes += storage;
    errorsCount += Number(hasErrors(item.errors)) + Number(mapped === 'failed');
    if (!disabled && failingItems.length < 50 && (failingStatuses.has(mapped) || (lastBackup && now.getTime() - lastBackup.getTime() > staleMs))) {
      const errorValue = normaliseErrors(item.errors);
      failingItems.push({
        name: text(item.display_name || item.email || item.username || item.sp_site || item.group_name || item.sd_drive || item.id || item.drive_account_id) ?? 'Unnamed item',
        status: mapped,
        lastBackup: lastBackup?.toISOString() ?? null,
        error: googleDrive || !hasErrors(item.errors) ? null : (typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue)).slice(0, 200),
      });
    }
  }
  const vendorCustomerId = String(cleanCustomer.id);
  return {
    vendorCustomerId, vendorDeviceId: `${vendorCustomerId}:${workload}`,
    name: `${WORKLOADS[workload][0]} (${items.length} ${WORKLOADS[workload][1]})`,
    accountType: workload.startsWith('gws_') ? 'gws' : 'm365', dataSources: [workload],
    status: disabled || !items.length ? 'not_started' : status,
    computerName: null, osType: 'unknown', macAddresses: [], clientVersion: null, osVersion: null,
    vendorStatusCode: null, selectedBytes: null, usedBytes, errorsCount,
    lastSuccessAt: lastSuccess, lastSessionAt: newest, lastCompletedAt: newest,
    vendorCreatedAt: created, vendorExpiresAt: null,
    raw: scrubTokens({ workload, itemCount: items.length, deactivatedCount: payload.length - items.length, statusCounts, vendorStatuses, failingItems }, tokens) as RecordData,
  };
}

export const dropsuiteAdapter: BackupProviderAdapter = {
  inventoryKind: 'saas',
  key: 'dropsuite', label: 'NinjaOne SaaS Backup (Dropsuite)',
  credentialsSchema: dropsuiteCredentialsSchema,
  validateBaseUrl, defaultSyncIntervalMinutes: 60, rootContinuity: 'customer_overlap',
  async testConnection(credentials, baseUrl) {
    try {
      const { creds, client } = connect(credentials, baseUrl);
      await client.get('status');
      const customers = await client.list('users', creds.authToken, 'admin');
      return { ok: true, rootId: 'dropsuite', rootName: 'Dropsuite reseller', customerCount: customers.length };
    } catch (error) {
      return { ok: false, error: error instanceof ProviderRequestError ? error.message : 'Dropsuite connection test failed', reauth: error instanceof ProviderRequestError && error.reauth };
    }
  },
  async listCustomers(credentials, baseUrl) {
    const { creds, client } = connect(credentials, baseUrl);
    const users = validateUsers(await client.list('users', creds.authToken, 'admin'));
    const clean = users.map(user => scrubTokens(user, [creds.authToken, creds.resellerToken, text(user.authentication_token) ?? '']));
    return clean.map(user => ({ vendorCustomerId: String(user.id), name: text(user.organization_name || user.email) ?? String(user.id), parentId: null, level: enabledFlag(user.is_business) ? 'business' : 'personal', externalCode: text(user.external_id) }));
  },
  async listDevices(credentials, baseUrl) {
    const { creds, client } = connect(credentials, baseUrl);
    // Tokens live only in this invocation, never on the singleton adapter.
    const users = validateUsers(await client.list('users', creds.authToken, 'admin'));
    const results: Array<{ devices: VendorDevice[]; failedCustomerIds: string[] }> = new Array(users.length);
    let next = 0;
    let aborted = false;
    const now = new Date();
    async function worker() {
      while (!aborted && next < users.length) {
        const index = next++;
        const user = users[index]!;
        const id = String(user.id);
        const accessToken = text(user.authentication_token);
        if (!accessToken) { results[index] = { devices: [], failedCustomerIds: [id] }; continue; }
        const tokens = [creds.authToken, creds.resellerToken, accessToken];
        const list = (path: string) => client.list(path, accessToken, 'customer');
        try {
          let mail: Workload = 'm365_mail';
          try {
            const tenants = await list(`users/${encodeURIComponent(id)}/tenants`);
            if (tenants.length && tenants.every(tenant => tenant.type === 'gws')) mail = 'gws_mail';
          } catch (error) {
            // Tenant permissions are optional metadata; budget/fatal failures
            // still stop this customer or the whole run respectively.
            if (!(error instanceof CustomerRequestError) || error.code === 'request_budget') throw error;
          }
          const workloads: Array<[Workload, RecordData[]]> = [
            [mail, await list('accounts')], ['m365_onedrive', await list('onedrives')],
          ];
          for (const [workload, path, child] of [
            ['m365_sharepoint', 'sharepoints/domains', 'sites'],
            ['m365_teams', 'teams_and_groups/domains', 'teams'],
            ['gws_shared_drive', 'shareddrives/domains', 'drives'],
          ] as const) {
            const items: RecordData[] = [];
            for (const domain of await list(path)) items.push(...await list(`${path}/${encodeURIComponent(requireId(domain))}/${child}`));
            workloads.push([workload, items]);
          }
          workloads.push(['gws_drive', await list('googledrives')]);
          results[index] = { devices: workloads.flatMap(([workload, items]) => {
            items.forEach(item => requireId(item, workload === 'gws_drive' ? 'drive_account_id' : 'id'));
            const row = rollupWorkload(user, workload, items, now, tokens);
            return row ? [row] : [];
          }), failedCustomerIds: [] };
        } catch (error) {
          if (!(error instanceof CustomerRequestError)) { aborted = true; client.abort(); throw error; }
          results[index] = { devices: [], failedCustomerIds: [id] };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, users.length) }, () => worker()));
    const failedCustomerIds = results.flatMap(result => result.failedCustomerIds);
    if (users.length && failedCustomerIds.length === users.length) {
      throw new ProviderRequestError('All Dropsuite customers failed enumeration', { code: 'all_customers_failed', reauth: false });
    }
    return { devices: results.flatMap(result => result.devices), failedCustomerIds };
  },
};
