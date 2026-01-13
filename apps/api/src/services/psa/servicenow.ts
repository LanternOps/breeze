import { PSACompany, PSAConnectionTest, PSAProvider, PSATicket, PSATicketCreate, PSATicketUpdate } from './types';

export interface ServiceNowCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

export interface ServiceNowSettings {
  incidentTable?: string;
  companyTable?: string;
}

type ServiceNowTableRecord = Record<string, unknown> & {
  sys_id?: string;
  number?: string;
  short_description?: string;
  description?: string;
  state?: string | number;
  priority?: string | number;
  assigned_to?: { display_value?: string } | string;
  company?: { value?: string } | string;
  sys_created_on?: string;
  sys_updated_on?: string;
};

export class ServiceNowProvider implements PSAProvider {
  private credentials: ServiceNowCredentials;
  private settings: ServiceNowSettings;

  constructor(credentials: ServiceNowCredentials, settings: ServiceNowSettings = {}) {
    this.credentials = credentials;
    this.settings = settings;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private get incidentTable(): string {
    return this.settings.incidentTable || 'incident';
  }

  private get companyTable(): string {
    return this.settings.companyTable || 'core_company';
  }

  private getAuthHeader(): string {
    const auth = Buffer.from(
      `${this.credentials.username}:${this.credentials.password}`
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
      throw new Error(`ServiceNow API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  private toTicket(record: ServiceNowTableRecord): PSATicket {
    return {
      id: record.sys_id || '',
      externalId: record.number,
      externalUrl: record.sys_id
        ? `${this.baseUrl}/nav_to.do?uri=${this.incidentTable}.do?sys_id=${record.sys_id}`
        : undefined,
      title: record.short_description || '',
      description: record.description,
      status: record.state !== undefined ? String(record.state) : 'unknown',
      priority: record.priority !== undefined ? String(record.priority) : undefined,
      assignee: typeof record.assigned_to === 'string'
        ? record.assigned_to
        : record.assigned_to?.display_value,
      companyId: typeof record.company === 'string'
        ? record.company
        : record.company?.value,
      createdAt: record.sys_created_on,
      updatedAt: record.sys_updated_on,
      raw: record
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/api/now/table/sys_user?sysparm_limit=1');
      return { success: true, message: 'Connected to ServiceNow' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  async getCompanies(): Promise<PSACompany[]> {
    const response = await this.request<{ result: ServiceNowTableRecord[] }>(
      'GET',
      `/api/now/table/${this.companyTable}?sysparm_fields=sys_id,name&sysparm_limit=100`
    );

    return (response.result || []).map((company) => ({
      id: company.sys_id || '',
      name: (company as { name?: string }).name || '',
      externalId: company.sys_id
    }));
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      short_description: input.title,
      description: input.description || '',
      priority: input.priority,
      state: input.status,
      assigned_to: input.assignee,
      company: input.companyId,
      ...input.metadata
    };

    const response = await this.request<{ result: ServiceNowTableRecord }>(
      'POST',
      `/api/now/table/${this.incidentTable}`,
      body
    );

    return this.toTicket(response.result);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      short_description: updates.title,
      description: updates.description,
      priority: updates.priority,
      state: updates.status,
      assigned_to: updates.assignee,
      company: updates.companyId,
      ...updates.metadata
    };

    const response = await this.request<{ result: ServiceNowTableRecord }>(
      'PATCH',
      `/api/now/table/${this.incidentTable}/${ticketId}`,
      body
    );

    return this.toTicket(response.result);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<{ result: ServiceNowTableRecord }>(
      'GET',
      `/api/now/table/${this.incidentTable}/${ticketId}?sysparm_display_value=true`
    );

    return this.toTicket(response.result);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<{ result: ServiceNowTableRecord[] }>(
      'GET',
      `/api/now/table/${this.incidentTable}?sysparm_limit=50&sysparm_order_byDESC=sys_updated_on`
    );

    return (response.result || []).map((record) => this.toTicket(record));
  }
}
