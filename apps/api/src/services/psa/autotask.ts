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

export interface AutotaskCredentials {
  baseUrl: string;
  username: string;
  secret: string;
  integrationCode: string;
}

export interface AutotaskSettings {
  ticketQueueId?: number;
}

type AutotaskCompany = {
  id: number;
  companyName?: string;
  name?: string;
};

/** `nextPageUrl` is upstream-supplied and MUST go through `pinCursorToBase`. */
type AutotaskCompanyResponse =
  | AutotaskCompany[]
  | { items?: AutotaskCompany[]; pageDetails?: { nextPageUrl?: string | null } };

type AutotaskTicket = {
  id: number;
  title?: string;
  description?: string;
  status?: string | number;
  priority?: string | number;
  companyID?: number;
  createDate?: string;
  lastActivityDate?: string;
};

export class AutotaskProvider implements PSAProvider {
  private credentials: AutotaskCredentials;
  private settings: AutotaskSettings;

  constructor(credentials: AutotaskCredentials, settings: AutotaskSettings = {}) {
    this.credentials = credentials;
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private getHeaders(): Record<string, string> {
    return {
      'ApiIntegrationCode': this.credentials.integrationCode,
      'UserName': this.credentials.username,
      'Secret': this.credentials.secret
    };
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
        ...this.getHeaders(),
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Autotask API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private extractItems<T>(response: T[] | { items?: T[] }): T[] {
    if (Array.isArray(response)) {
      return response;
    }
    return response.items || [];
  }

  private toTicket(ticket: AutotaskTicket): PSATicket {
    return {
      id: ticket.id.toString(),
      externalId: ticket.id.toString(),
      externalUrl: `${this.baseUrl}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=Ticket&id=${ticket.id}`,
      title: ticket.title || '',
      description: ticket.description,
      status: ticket.status !== undefined ? String(ticket.status) : 'unknown',
      priority: ticket.priority !== undefined ? String(ticket.priority) : undefined,
      companyId: ticket.companyID ? ticket.companyID.toString() : undefined,
      createdAt: ticket.createDate,
      updatedAt: ticket.lastActivityDate,
      raw: ticket as Record<string, unknown>
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/v1.0/Companies?$top=1');
      return { success: true, message: 'Connected to Autotask' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  /**
   * Autotask REST returns `pageDetails.nextPageUrl` — an ABSOLUTE URL taken
   * straight from the PSA's response body. It is never dialed as-is: every
   * cursor goes through `pinCursorToBase`, which refuses any origin other than
   * the connection's stored baseUrl and rebuilds the URL on that origin. Without
   * that, a compromised or malicious Autotask instance could redirect the walk
   * to an arbitrary host — and `requestUrl` would attach the integration code,
   * username, and secret to the request.
   */
  async getCompanies(options: PSACompanyListOptions = {}): Promise<PSACompanyList> {
    const limit = options.limit ?? PSA_COMPANY_LIST_CAP;

    const result = await collectPaginated<RawCompanyRecord>(limit, async (cursor) => {
      const response = cursor
        ? await this.requestUrl<AutotaskCompanyResponse>('GET', cursor)
        : await this.request<AutotaskCompanyResponse>(
            'GET',
            // `$filter=isActive eq true` drops archived customers server-side —
            // otherwise an MSP's dead accounts arrive pre-selected and get
            // provisioned as live organizations with sites and link rows.
            // `$top`, matching testConnection on this same endpoint. (`MaxRecords`
            // is a field of Autotask's /query search JSON, not a URL parameter —
            // it would be ignored here, making the page-size constant a lie.)
            `/v1.0/Companies?$select=id,companyName&$filter=${encodeURIComponent('isActive eq true')}` +
            `&$top=${PSA_COMPANY_PAGE_SIZE}`
          );

      const nextPageUrl = Array.isArray(response)
        ? null
        : response.pageDetails?.nextPageUrl ?? null;

      return companyPage(
        this.extractItems(response).map((company) => ({
          id: company?.id,
          name: company?.companyName ?? company?.name
        })),
        // Throws PsaCursorOriginError on an off-origin cursor — a hard refusal,
        // never a silent stop, so a redirected page can't masquerade as "done".
        nextPageUrl ? pinCursorToBase(nextPageUrl, this.baseUrl, 'Autotask') : null,
        options.skipExternalIds
      );
    });

    return toCompanyList(result);
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description || '',
      status: input.status,
      priority: input.priority,
      companyID: input.companyId ? Number(input.companyId) : undefined,
      queueID: this.settings.ticketQueueId,
      ...input.metadata
    };

    const response = await this.request<AutotaskTicket>(
      'POST',
      '/v1.0/Tickets',
      body
    );

    return this.toTicket(response);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      title: updates.title,
      description: updates.description,
      status: updates.status,
      priority: updates.priority,
      companyID: updates.companyId ? Number(updates.companyId) : undefined,
      ...updates.metadata
    };

    const response = await this.request<AutotaskTicket>(
      'PATCH',
      `/v1.0/Tickets/${ticketId}`,
      body
    );

    return this.toTicket(response);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<AutotaskTicket>(
      'GET',
      `/v1.0/Tickets/${ticketId}`
    );

    return this.toTicket(response);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<AutotaskTicket[] | { items: AutotaskTicket[] }>(
      'GET',
      '/v1.0/Tickets?$top=50&$orderby=lastActivityDate desc'
    );

    return this.extractItems(response).map((ticket) => this.toTicket(ticket));
  }
}
