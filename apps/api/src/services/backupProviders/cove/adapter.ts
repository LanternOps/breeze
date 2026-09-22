import { z } from 'zod';
import {
  COVE_DEFAULT_BASE_URL,
  CoveJsonRpcClient,
  type CoveCredentials,
} from './client';
import {
  ProviderRequestError,
  type BackupProviderAdapter,
  type ProviderTestResult,
  type VendorCustomer,
  type VendorDevice,
} from '../types';

export const COVE_PROVIDER_KEY = 'cove';
export const COVE_PROVIDER_LABEL = 'Cove Data Protection';

/**
 * The credential blob stored (encrypted, row-bound) in
 * `backup_provider_connections.credentials_encrypted`.
 *
 * Cove has no static API key: this is a real console login. The UI tells the
 * MSP to create a dedicated user with a read-only role, a unique password and
 * NO 2FA, and the password is never returned by any route.
 *
 * Identity fields are trimmed (a pasted username reliably picks up a trailing
 * space); the password deliberately is NOT — a password may legitimately end
 * in whitespace, and silently trimming it turns a working credential into an
 * unexplained auth failure the operator cannot debug.
 */
export const coveCredentialsSchema = z.object({
  partnerName: z.string().trim().min(1).max(200),
  username: z.string().trim().min(1).max(320),
  // NOT `.trim()`ed like the identity fields above — a password may
  // legitimately end in whitespace, and silently trimming it would turn a
  // working credential into an unexplained auth failure. Blank/whitespace-only
  // is still rejected via `.refine`, which checks without mutating the value.
  password: z.string().max(5000).refine((v) => v.trim().length > 0, {
    message: 'password is required',
  }),
}).strip();

type CoveClientLike = Pick<
  CoveJsonRpcClient,
  'login' | 'enumeratePartners' | 'enumerateAccountStatisticsAll'
>;

type CoveClientFactory = (baseUrl: string) => CoveClientLike;

const productionFactory: CoveClientFactory = (baseUrl) =>
  new CoveJsonRpcClient({ baseUrl: baseUrl || COVE_DEFAULT_BASE_URL });

let clientFactory: CoveClientFactory = productionFactory;

/**
 * Test seam. Pass `null` to restore the production factory. Kept out of the
 * `BackupProviderAdapter` interface on purpose: a factory parameter there would
 * be dead weight on every future vendor.
 */
export function __setCoveClientFactoryForTests(factory: CoveClientFactory | null): void {
  clientFactory = factory ?? productionFactory;
}

function parseCredentials(creds: unknown): CoveCredentials {
  const parsed = coveCredentialsSchema.safeParse(creds);
  if (!parsed.success) {
    // `reauth: true` on purpose: a stored blob that no longer satisfies the
    // schema is a credential problem the operator must fix by re-entering it,
    // not something a retry can resolve.
    throw new ProviderRequestError(
      'Cove credentials are incomplete (partner name, username and password are all required)',
      { code: 'invalid_credentials', reauth: true },
    );
  }
  return parsed.data;
}

async function connect(creds: unknown, baseUrl: string): Promise<{
  client: CoveClientLike;
  root: { visa: string; partnerId: string; partnerName: string };
}> {
  const parsed = parseCredentials(creds);
  const client = clientFactory(baseUrl);
  const root = await client.login(parsed);
  return { client, root };
}

export const coveAdapter: BackupProviderAdapter = {
  key: COVE_PROVIDER_KEY,
  label: COVE_PROVIDER_LABEL,
  credentialsSchema: coveCredentialsSchema,

  /**
   * Never throws. The create/PATCH/test routes render this straight into a
   * 200 `{ success: false, error }` body (the PSA `testResult` shape) so the
   * web card can explain the failure; a throw would become an opaque 500.
   */
  async testConnection(creds: unknown, baseUrl: string): Promise<ProviderTestResult> {
    try {
      const { client, root } = await connect(creds, baseUrl);
      const customers = await client.enumeratePartners(root.partnerId);
      return {
        ok: true,
        rootId: root.partnerId,
        rootName: root.partnerName,
        customerCount: customers.length,
      };
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        return { ok: false, error: error.message, reauth: error.reauth };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Cove connection test failed',
        reauth: false,
      };
    }
  },

  async listCustomers(creds: unknown, baseUrl: string, rootId: string): Promise<VendorCustomer[]> {
    const { client } = await connect(creds, baseUrl);
    return client.enumeratePartners(rootId);
  },

  /**
   * Throws `ProviderRequestError` if ANY page fails — deliberately NOT
   * degraded to a partial list. The sync job deletes rows whose vendor device
   * vanished, so a truncated enumeration reported as success would delete a
   * customer's whole backup inventory.
   */
  async listDevices(creds: unknown, baseUrl: string, rootId: string): Promise<VendorDevice[]> {
    const { client } = await connect(creds, baseUrl);
    return client.enumerateAccountStatisticsAll(rootId);
  },
};
