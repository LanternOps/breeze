import { PSACompany, PSAConnectionTest, PSAProvider, PSATicket, PSATicketCreate, PSATicketUpdate } from './types';

export interface ZendeskCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface ZendeskSettings {
  defaultStatus?: string;
}

type ZendeskOrganization = { id: number; name: string };

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

  async getCompanies(): Promise<PSACompany[]> {
    const response = await this.request<{ organizations: ZendeskOrganization[] }>(
      'GET',
      '/api/v2/organizations.json'
    );

    return (response.organizations || []).map((org) => ({
      id: org.id.toString(),
      name: org.name,
      externalId: org.id.toString()
    }));
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
