import { z } from 'zod';
import { ProviderRequestError, type BackupProviderAdapter, type VendorCustomer, type VendorDevice } from '../types';
import { AxcientClient, AxcientCustomerRequestError, type AxcientRecord } from './client';
import { axcientDeviceToVendorDevice } from './device';

export const AXCIENT_PROVIDER_KEY = 'axcient';
export const AXCIENT_PROVIDER_LABEL = 'Axcient x360Recover';
export const AXCIENT_DEFAULT_BASE_URL = 'https://axapi.axcient.com/x360recover';

export const axcientCredentialsSchema = z.object({ apiKey: z.string().trim().min(1) }).strip();

type ClientFactory = (baseUrl: string, apiKey: string) =>
  Pick<AxcientClient, 'getOrganization' | 'listClients' | 'listClientDevices' | 'abort'>;
const productionFactory: ClientFactory = (baseUrl, apiKey) => new AxcientClient({ baseUrl, apiKey });
let clientFactory: ClientFactory = productionFactory;
export function __setAxcientClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory ?? productionFactory;
}

/**
 * HTTPS on `axcient.com` or a subdomain, so a future regional host is a form
 * change rather than a code change. No userinfo, query or hash: the key
 * travels in a header and nothing else may ride along on the URL.
 */
export function validateAxcientBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !(url.hostname === 'axcient.com' || url.hostname.endsWith('.axcient.com'))) {
      return 'Axcient base URL must use HTTPS on an axcient.com host, with no credentials, query or fragment';
    }
    return null;
  } catch {
    return 'Invalid Axcient base URL';
  }
}

function connect(credentials: unknown, baseUrl: string) {
  const parsed = axcientCredentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    throw new ProviderRequestError('Axcient API key is missing', { code: 'invalid_credentials', reauth: true });
  }
  const invalidUrl = validateAxcientBaseUrl(baseUrl);
  if (invalidUrl) throw new ProviderRequestError(invalidUrl, { code: 'invalid_base_url', reauth: false });
  return clientFactory(baseUrl, parsed.data.apiKey);
}

/** Client ids go into a URL path, so only positive integers are accepted. */
function clientId(row: AxcientRecord): number {
  const raw = row.id;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ProviderRequestError('Axcient client has no numeric id', { code: 'malformed_response', reauth: false });
  }
  return id;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function listClientIds(client: ReturnType<ClientFactory>): Promise<Array<{ id: number; row: AxcientRecord }>> {
  // Inactive clients are kept (spec Decision 2): hiding them would make a
  // parked customer look like a sync bug.
  return (await client.listClients()).map((row) => ({ id: clientId(row), row }));
}

/**
 * Devices are filed under the client they were fetched for. A row that names a
 * different client fails only that customer: trusting the payload would put
 * one client's device under another client's organization.
 */
function projectClientDevices(id: number, rows: AxcientRecord[]): VendorDevice[] {
  return rows.map((row) => {
    if (row.client_id != null && String(row.client_id) !== String(id)) {
      throw new AxcientCustomerRequestError('Axcient returned a device for a different client', 'client_mismatch');
    }
    return axcientDeviceToVendorDevice({ ...row, client_id: id });
  });
}

export const axcientAdapter: BackupProviderAdapter = {
  key: AXCIENT_PROVIDER_KEY,
  label: AXCIENT_PROVIDER_LABEL,
  credentialsSchema: axcientCredentialsSchema,
  defaultBaseUrl: AXCIENT_DEFAULT_BASE_URL,
  validateBaseUrl: validateAxcientBaseUrl,
  defaultSyncIntervalMinutes: 30,
  rootContinuity: 'root_id',

  async testConnection(credentials, baseUrl) {
    try {
      const client = connect(credentials, baseUrl);
      const organization = await client.getOrganization();
      const clients = await client.listClients();
      return { ok: true, rootId: String(organization.id), rootName: organization.name, customerCount: clients.length };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ProviderRequestError ? error.message : 'Axcient connection test failed',
        reauth: error instanceof ProviderRequestError && error.reauth,
      };
    }
  },

  async listCustomers(credentials, baseUrl): Promise<VendorCustomer[]> {
    const client = connect(credentials, baseUrl);
    return (await listClientIds(client)).map(({ id, row }) => ({
      vendorCustomerId: String(id),
      name: text(row.name) ?? String(id),
      parentId: null,
      // Axcient clients are flat under the organization.
      level: '0',
      externalCode: text(row.client_code),
    }));
  },

  async listDevices(credentials, baseUrl) {
    const client = connect(credentials, baseUrl);
    const clients = await listClientIds(client);
    const results: Array<{ devices: VendorDevice[]; failedCustomerIds: string[] }> = new Array(clients.length);
    let next = 0;
    let aborted = false;
    async function worker() {
      while (!aborted && next < clients.length) {
        const index = next++;
        const { id } = clients[index]!;
        try {
          results[index] = { devices: projectClientDevices(id, await client.listClientDevices(id)), failedCustomerIds: [] };
        } catch (error) {
          // Only a classified per-customer failure may omit one customer. A
          // dead key, a malformed row or anything unexpected stops the run.
          if (!(error instanceof AxcientCustomerRequestError)) {
            aborted = true;
            client.abort();
            throw error;
          }
          results[index] = { devices: [], failedCustomerIds: [String(id)] };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, clients.length) }, () => worker()));
    const failedCustomerIds = results.flatMap((result) => result.failedCustomerIds);
    if (clients.length > 0 && failedCustomerIds.length === clients.length) {
      throw new ProviderRequestError('All Axcient clients failed enumeration', { code: 'all_customers_failed', reauth: false });
    }
    return { devices: results.flatMap((result) => result.devices), failedCustomerIds };
  },
};
