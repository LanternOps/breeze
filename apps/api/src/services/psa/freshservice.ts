import { PSACompany, PSAConnectionTest, PSAProvider, PSATicket, PSATicketCreate, PSATicketUpdate } from './types';

export interface FreshserviceCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface FreshserviceSettings {
  defaultStatus?: number;
}

type FreshserviceCompany = { id: number; name: string };

type FreshserviceTicket = {
  id: number;
  subject?: string;
  description?: string;
  status?: number | string;
  priority?: number | string;
  responder_id?: number;
  company_id?: number;
  created_at?: string;
  updated_at?: string;
};

export class FreshserviceProvider implements PSAProvider {
  private credentials: FreshserviceCredentials;
  private settings: FreshserviceSettings;

  constructor(credentials: FreshserviceCredentials, settings: FreshserviceSettings = {}) {
    this.credentials = credentials;
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    const auth = Buffer.from(`${this.credentials.apiKey}:X`).toString('base64');
    return `Basic ${auth}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
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
      throw new Error(`Freshservice API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private toTicket(ticket: FreshserviceTicket): PSATicket {
    return {
      id: ticket.id.toString(),
      externalId: ticket.id.toString(),
      externalUrl: `${this.baseUrl}/a/tickets/${ticket.id}`,
      title: ticket.subject || '',
      description: ticket.description,
      status: ticket.status !== undefined ? String(ticket.status) : 'unknown',
      priority: ticket.priority !== undefined ? String(ticket.priority) : undefined,
      assignee: ticket.responder_id ? ticket.responder_id.toString() : undefined,
      companyId: ticket.company_id ? ticket.company_id.toString() : undefined,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      raw: ticket as Record<string, unknown>
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/api/v2/agents/me');
      return { success: true, message: 'Connected to Freshservice' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  async getCompanies(): Promise<PSACompany[]> {
    const response = await this.request<{ companies: FreshserviceCompany[] }>(
      'GET',
      '/api/v2/companies'
    );

    return (response.companies || []).map((company) => ({
      id: company.id.toString(),
      name: company.name,
      externalId: company.id.toString()
    }));
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      subject: input.title,
      description: input.description || '',
      priority: input.priority,
      status: input.status ? Number(input.status) : this.settings.defaultStatus,
      responder_id: input.assignee ? Number(input.assignee) : undefined,
      company_id: input.companyId ? Number(input.companyId) : undefined,
      tags: input.tags,
      ...input.metadata
    };

    const response = await this.request<{ ticket: FreshserviceTicket }>(
      'POST',
      '/api/v2/tickets',
      body
    );

    return this.toTicket(response.ticket);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      subject: updates.title,
      description: updates.description,
      priority: updates.priority,
      status: updates.status ? Number(updates.status) : undefined,
      responder_id: updates.assignee ? Number(updates.assignee) : undefined,
      company_id: updates.companyId ? Number(updates.companyId) : undefined,
      tags: updates.tags,
      ...updates.metadata
    };

    const response = await this.request<{ ticket: FreshserviceTicket }>(
      'PUT',
      `/api/v2/tickets/${ticketId}`,
      body
    );

    return this.toTicket(response.ticket);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<{ ticket: FreshserviceTicket }>(
      'GET',
      `/api/v2/tickets/${ticketId}`
    );

    return this.toTicket(response.ticket);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<{ tickets: FreshserviceTicket[] }>(
      'GET',
      '/api/v2/tickets?order_by=updated_at&order_type=desc'
    );

    return (response.tickets || []).map((ticket) => this.toTicket(ticket));
  }
}
