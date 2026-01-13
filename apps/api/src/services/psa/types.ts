export type PSAProviderType =
  | 'jira'
  | 'servicenow'
  | 'connectwise'
  | 'autotask'
  | 'freshservice'
  | 'zendesk';

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

export interface PSAProvider {
  testConnection(): Promise<PSAConnectionTest>;
  getCompanies(): Promise<PSACompany[]>;
  createTicket(input: PSATicketCreate): Promise<PSATicket>;
  updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket>;
  getTicket(ticketId: string): Promise<PSATicket>;
  syncTickets(): Promise<PSATicket[]>;
}
