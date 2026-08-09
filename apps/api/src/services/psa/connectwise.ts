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
import { PSA_COMPANY_PAGE_SIZE, collectPaginated, companyPage, toCompanyList, type RawCompanyRecord } from './pagination';

export interface ConnectWiseCredentials {
  baseUrl: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId?: string;
}

export interface ConnectWiseSettings {
  defaultBoardId?: number;
}

type ConnectWiseCompany = { id: number; name: string };

type ConnectWiseTicket = {
  id: number;
  summary?: string;
  status?: { name?: string };
  priority?: { name?: string };
  company?: { id?: number; name?: string };
  owner?: { identifier?: string };
  dateEntered?: string;
  lastUpdated?: string;
};

export class ConnectWiseProvider implements PSAProvider {
  private credentials: ConnectWiseCredentials;
  private settings: ConnectWiseSettings;

  constructor(credentials: ConnectWiseCredentials, settings: ConnectWiseSettings = {}) {
    this.credentials = credentials;
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    const auth = Buffer.from(
      `${this.credentials.companyId}+${this.credentials.publicKey}:${this.credentials.privateKey}`
    ).toString('base64');
    return `Basic ${auth}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json'
  ): Promise<T> {
    const response = await psaFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': this.getAuthHeader(),
        ...(this.credentials.clientId ? { 'clientId': this.credentials.clientId } : {}),
        'Accept': 'application/json',
        'Content-Type': contentType
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ConnectWise API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private toTicket(ticket: ConnectWiseTicket): PSATicket {
    return {
      id: ticket.id.toString(),
      externalId: ticket.id.toString(),
      externalUrl: `${this.baseUrl}/service/tickets/${ticket.id}`,
      title: ticket.summary || '',
      description: undefined,
      status: ticket.status?.name || 'unknown',
      priority: ticket.priority?.name,
      assignee: ticket.owner?.identifier,
      companyId: ticket.company?.id ? ticket.company.id.toString() : undefined,
      createdAt: ticket.dateEntered,
      updatedAt: ticket.lastUpdated,
      raw: ticket as Record<string, unknown>
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/system/info');
      return { success: true, message: 'Connected to ConnectWise' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  /**
   * ConnectWise Manage paginates with a 1-based `page=` alongside `pageSize=`.
   * It returns a bare array with no total, so "another page exists" is inferred
   * from a full page — one extra request on an exact multiple, which is the
   * correct trade against under-reading an MSP's company list.
   */
  async getCompanies(options: PSACompanyListOptions = {}): Promise<PSACompanyList> {
    const limit = options.limit ?? PSA_COMPANY_LIST_CAP;

    // `conditions=deletedFlag=false` drops soft-deleted companies server-side;
    // without it an MSP's archived customers arrive pre-selected and provision
    // dead organizations. `orderBy=id asc` makes the page walk deterministic —
    // page/offset paging over an unordered result set can skip or repeat rows
    // while still looking like a complete list.
    const query =
      `/company/companies?fields=id,name&conditions=${encodeURIComponent('deletedFlag=false')}` +
      `&orderBy=${encodeURIComponent('id asc')}&pageSize=${PSA_COMPANY_PAGE_SIZE}`;

    const result = await collectPaginated<RawCompanyRecord>(limit, async (cursor) => {
      const page = cursor ? Number(cursor) : 1;
      const response = await this.request<ConnectWiseCompany[]>('GET', `${query}&page=${page}`);
      const rows = response || [];

      // Never infer end-of-list from a SHORT page — ConnectWise may return
      // fewer than pageSize. Only an empty RAW page ends the walk.
      return companyPage(
        rows.map((company) => ({ id: company?.id, name: company?.name })),
        String(page + 1),
        options.skipExternalIds
      );
    });

    return toCompanyList(result);
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      summary: input.title,
      initialDescription: input.description || '',
      board: this.settings.defaultBoardId ? { id: this.settings.defaultBoardId } : undefined,
      company: input.companyId ? { id: Number(input.companyId) } : undefined,
      priority: input.priority ? { name: input.priority } : undefined,
      status: input.status ? { name: input.status } : undefined
    };

    const response = await this.request<ConnectWiseTicket>('POST', '/service/tickets', body);
    return this.toTicket(response);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const operations: Array<{ op: string; path: string; value: unknown }> = [];

    if (updates.title !== undefined) {
      operations.push({ op: 'replace', path: '/summary', value: updates.title });
    }
    if (updates.description !== undefined) {
      operations.push({ op: 'replace', path: '/initialDescription', value: updates.description });
    }
    if (updates.priority !== undefined) {
      operations.push({ op: 'replace', path: '/priority/name', value: updates.priority });
    }
    if (updates.status !== undefined) {
      operations.push({ op: 'replace', path: '/status/name', value: updates.status });
    }
    if (updates.companyId !== undefined) {
      operations.push({ op: 'replace', path: '/company/id', value: Number(updates.companyId) });
    }

    if (operations.length === 0) {
      return this.getTicket(ticketId);
    }

    await this.request(
      'PATCH',
      `/service/tickets/${ticketId}`,
      operations,
      'application/json-patch+json'
    );

    return this.getTicket(ticketId);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<ConnectWiseTicket>(
      'GET',
      `/service/tickets/${ticketId}`
    );

    return this.toTicket(response);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<ConnectWiseTicket[]>(
      'GET',
      '/service/tickets?orderBy=lastUpdated desc&pageSize=50'
    );

    return (response || []).map((ticket) => this.toTicket(ticket));
  }
}
