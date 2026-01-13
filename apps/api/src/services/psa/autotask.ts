import { PSACompany, PSAConnectionTest, PSAProvider, PSATicket, PSATicketCreate, PSATicketUpdate } from './types';

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
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  async getCompanies(): Promise<PSACompany[]> {
    const response = await this.request<AutotaskCompany[] | { items: AutotaskCompany[] }>(
      'GET',
      '/v1.0/Companies?$select=id,companyName'
    );

    return this.extractItems(response).map((company) => ({
      id: company.id.toString(),
      name: company.companyName || company.name || '',
      externalId: company.id.toString()
    }));
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
