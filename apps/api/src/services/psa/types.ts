import type { PsaProviderId } from '@breeze/shared';

// Derived from the single-source provider list in @breeze/shared
// (packages/shared/src/validators/psa.ts) so API, web, and service layer
// can never drift.
export type PSAProviderType = PsaProviderId;

/**
 * Providers whose adapter can enumerate companies for organization import.
 *
 * Derived from the shared `PSA_PROVIDERS` list via `satisfies`, so a typo or a
 * value that is not a real provider fails to compile. Jira is the one exclusion:
 * it is an issue tracker with no company/account object to map onto an
 * organization. `psaCompanyImport.test.ts` asserts this list plus `'jira'`
 * covers `PSA_PROVIDERS` exactly, so ADDING a new provider forces an explicit
 * capable/not-capable decision instead of silently defaulting to incapable.
 */
export const ORG_IMPORT_CAPABLE_PSA_PROVIDERS = [
  'connectwise',
  'autotask',
  'freshservice',
  'servicenow',
  'zendesk'
] as const satisfies readonly PsaProviderId[];

export type OrgImportCapablePsaProvider = (typeof ORG_IMPORT_CAPABLE_PSA_PROVIDERS)[number];

export function isOrgImportCapableProvider(
  provider: string
): provider is OrgImportCapablePsaProvider {
  return (ORG_IMPORT_CAPABLE_PSA_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Raised when a capability is asked of a provider that cannot serve it.
 *
 * Exists so "this provider does not support company import" can never be
 * confused with "this provider returned zero companies" — the pre-#3246 Jira
 * adapter returned `[]` for `getCompanies()`, which would have rendered as a
 * successful import preview of an empty PSA. Routes map this to 400.
 */
export class PsaCapabilityError extends Error {
  readonly provider: string;
  readonly capability: string;

  constructor(provider: string, capability: string) {
    super(`PSA provider "${provider}" does not support ${capability}`);
    this.name = 'PsaCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * Default ceiling on companies pulled from one PSA in one import.
 *
 * Aligned with the org-import seam's `MAX_IMPORT_ROWS` (1000): a preview that
 * returned more rows than the commit route's zod schema accepts would be a
 * dead end for the user.
 */
export const PSA_COMPANY_LIST_CAP = 1000;

export interface PSAConnectionTest {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface PSACompany {
  id: string;
  name: string;
  externalId?: string;
}

export interface PSATicket {
  id: string;
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: Record<string, unknown>;
}

export interface PSATicketCreate {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  dueDate?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PSATicketUpdate {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  dueDate?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PSACompanyListOptions {
  /** Max companies to return. Defaults to `PSA_COMPANY_LIST_CAP`. */
  limit?: number;
}

export interface PSACompanyList {
  companies: PSACompany[];
  /**
   * True when the cap stopped the page walk with companies still unread
   * upstream. MUST be surfaced to the user: importing the first 1000 of 1500
   * companies creates exactly the partial-tenant state the external link table
   * exists to prevent.
   */
  truncated: boolean;
}

export interface PSAProvider {
  testConnection(): Promise<PSAConnectionTest>;
  /**
   * Enumerate companies/accounts/organizations, walking the provider's native
   * pagination until `limit` is reached. Adapters that cannot enumerate
   * companies at all throw `PsaCapabilityError` rather than returning empty.
   */
  getCompanies(options?: PSACompanyListOptions): Promise<PSACompanyList>;
  createTicket(input: PSATicketCreate): Promise<PSATicket>;
  updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket>;
  getTicket(ticketId: string): Promise<PSATicket>;
  syncTickets(): Promise<PSATicket[]>;
}
