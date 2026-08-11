import {
  PSACompany,
  PSACompanyList,
  PSACompanyListOptions,
  PSAConnectionTest,
  PSAProvider,
  PSATicket,
  PSATicketCreate,
  PSATicketUpdate,
  PSA_COMPANY_LIST_CAP
} from './types';
import { psaFetch } from './http';
import { PSA_COMPANY_PAGE_SIZE, collectPaginated, companyPage, pinCursorToBase, toCompanyList, type RawCompanyRecord } from './pagination';

export interface ZendeskCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface ZendeskSettings {
  defaultStatus?: string;
}

type ZendeskOrganization = { id: number; name: string };

/** `next_page` is upstream-supplied and MUST go through `pinCursorToBase`. */
type ZendeskOrganizationPage = {
  organizations?: ZendeskOrganization[];
  next_page?: string | null;
};

type ZendeskTicket = {
  id: number;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee_id?: number;
  organization_id?: number;
  created_at?: string;
  updated_at?: string;
};

export class ZendeskProvider implements PSAProvider {
  private credentials: ZendeskCredentials;
  private settings: ZendeskSettings;

  constructor(credentials: ZendeskCredentials, settings: ZendeskSettings = {}) {
    this.credentials = credentials;
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    const auth = Buffer.from(
      `${this.credentials.email}/token:${this.credentials.apiToken}`
    ).toString('base64');
    return `Basic ${auth}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestUrl<T>(method, `${this.baseUrl}${path}`, body);
  }

  /**
   * Absolute-URL variant, used only for following an origin-pinned pagination
   * cursor. Callers MUST pass a URL that has already been through
   * `pinCursorToBase` — this method attaches the connection's credentials, so a
   * raw upstream-supplied URL here would leak them off-origin.
   */
  private async requestUrl<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await psaFetch(url, {
      method,
      headers: {
        'Authorization': this.getAuthHeader(),
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Zendesk API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private toTicket(ticket: ZendeskTicket): PSATicket {
    return {
      id: ticket.id.toString(),
      externalId: ticket.id.toString(),
      externalUrl: `${this.baseUrl}/agent/tickets/${ticket.id}`,
      title: ticket.subject || '',
      description: ticket.description,
      status: ticket.status || 'unknown',
      priority: ticket.priority,
      assignee: ticket.assignee_id ? ticket.assignee_id.toString() : undefined,
      companyId: ticket.organization_id ? ticket.organization_id.toString() : undefined,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      raw: ticket as Record<string, unknown>
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/api/v2/users/me.json');
      return { success: true, message: 'Connected to Zendesk' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  /**
   * Zendesk offset pagination returns `next_page` — an ABSOLUTE URL from the
   * PSA's own response body, previously ignored entirely (so this capped out at
   * the 30-per-page default). It is never dialed as-is: `pinCursorToBase`
   * refuses any origin other than the connection's stored baseUrl and rebuilds
   * the URL on that origin, so a hostile `next_page` cannot walk `requestUrl`
   * — and the Basic auth header it attaches — onto another host.
   */
  async getCompanies(options: PSACompanyListOptions = {}): Promise<PSACompanyList> {
    const limit = options.limit ?? PSA_COMPANY_LIST_CAP;

    // Zendesk organizations have no active/archived/deleted flag — deletion is
    // immediate, so there is nothing to filter out here (unlike ConnectWise's
    // deletedFlag or Autotask's isActive). Ordering is Zendesk's own and stable
    // across the cursor walk, so no sort parameter is needed either.
    const result = await collectPaginated<RawCompanyRecord>(limit, async (cursor) => {
      const response = cursor
        ? await this.requestUrl<ZendeskOrganizationPage>('GET', cursor)
        : await this.request<ZendeskOrganizationPage>(
            'GET',
            `/api/v2/organizations.json?per_page=${PSA_COMPANY_PAGE_SIZE}`
          );

      const nextPage = response?.next_page ?? null;

      return companyPage(
        (response?.organizations || []).map((org) => ({ id: org?.id, name: org?.name })),
        // Throws PsaCursorOriginError on an off-origin cursor — a hard refusal,
        // never a silent stop, so a redirected page can't masquerade as "done".
        nextPage ? pinCursorToBase(nextPage, this.baseUrl, 'Zendesk') : null,
        options.skipExternalIds
      );
    });

    return toCompanyList(result);
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      ticket: {
        subject: input.title,
        comment: { body: input.description || '' },
        priority: input.priority,
        status: input.status || this.settings.defaultStatus,
        assignee_id: input.assignee ? Number(input.assignee) : undefined,
        organization_id: input.companyId ? Number(input.companyId) : undefined,
        tags: input.tags,
        ...input.metadata
      }
    };

    const response = await this.request<{ ticket: ZendeskTicket }>(
      'POST',
      '/api/v2/tickets.json',
      body
    );

    return this.toTicket(response.ticket);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const ticket: Record<string, unknown> = {
      subject: updates.title,
      priority: updates.priority,
      status: updates.status,
      assignee_id: updates.assignee ? Number(updates.assignee) : undefined,
      organization_id: updates.companyId ? Number(updates.companyId) : undefined,
      tags: updates.tags,
      ...updates.metadata
    };

    if (updates.description !== undefined) {
      ticket.comment = { body: updates.description };
    }

    const response = await this.request<{ ticket: ZendeskTicket }>(
      'PUT',
      `/api/v2/tickets/${ticketId}.json`,
      { ticket }
    );

    return this.toTicket(response.ticket);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<{ ticket: ZendeskTicket }>(
      'GET',
      `/api/v2/tickets/${ticketId}.json`
    );

    return this.toTicket(response.ticket);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<{ tickets: ZendeskTicket[] }>(
      'GET',
      '/api/v2/tickets.json?sort_by=updated_at&sort_order=desc'
    );

    return (response.tickets || []).map((ticket) => this.toTicket(ticket));
  }
}
