/**
 * PSA Integration Services
 *
 * Provides a unified interface for integrating with various
 * Professional Services Automation (PSA) and ticketing systems.
 */

import { JiraClient, createJiraClient } from './jira';
import { AutotaskProvider } from './autotask';
import { ConnectWiseProvider } from './connectwise';
import { FreshserviceProvider } from './freshservice';
import { ServiceNowProvider } from './servicenow';
import { ZendeskProvider } from './zendesk';
import { PSAProvider, PSAProviderType, PSATicket, PSATicketCreate, PSATicketUpdate } from './types';
import { validateProviderCredentials } from './credentials';

export * from './types';
export * from './jira';
export * from './servicenow';
export * from './connectwise';
export * from './autotask';
export * from './freshservice';
export * from './zendesk';

class JiraProvider implements PSAProvider {
  private client: JiraClient;

  constructor(client: JiraClient) {
    this.client = client;
  }

  async testConnection() {
    return this.client.testConnection();
  }

  async getCompanies() {
    return [];
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const issue = await this.client.createIssue({
      summary: input.title,
      description: input.description || '',
      priority: input.priority,
      customFields: input.metadata
    });

    return this.mapIssue(issue);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const fields: Record<string, unknown> = {};

    if (updates.title) {
      fields.summary = updates.title;
    }

    if (updates.description) {
      fields.description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: updates.description }]
          }
        ]
      };
    }

    if (Object.keys(fields).length > 0) {
      await this.client.updateIssue(ticketId, fields);
    }

    return this.getTicket(ticketId);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const issue = await this.client.getIssue(ticketId);
    return this.mapIssue(issue);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const issues = await this.client.getBreezeLinkedIssues();
    return issues.map((issue) => this.mapIssue(issue));
  }

  private mapIssue(issue: import('./jira').JiraIssue): PSATicket {
    return {
      id: issue.id,
      externalId: issue.key,
      externalUrl: issue.self,
      title: issue.fields.summary,
      description: issue.fields.description as string,
      status: issue.fields.status.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName,
      createdAt: issue.fields.created,
      updatedAt: issue.fields.updated,
      raw: issue as unknown as Record<string, unknown>
    };
  }
}

/**
 * Create PSA provider based on type.
 *
 * Validates + normalizes credentials first (`validateProviderCredentials`):
 * a missing required key (e.g. baseUrl) throws a typed `PsaConfigError` the
 * routes map to 400, instead of a deep TypeError inside an adapter.
 */
export function createPSAProvider(
  provider: PSAProviderType | string,
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> = {}
): PSAProvider {
  const validated = validateProviderCredentials(provider, credentials);
  const creds = validated.credentials;

  switch (validated.provider) {
    case 'jira': {
      const client = createJiraClient(
        creds as unknown as Parameters<typeof createJiraClient>[0],
        settings as unknown as Parameters<typeof createJiraClient>[1]
      );
      return new JiraProvider(client);
    }
    case 'servicenow':
      return new ServiceNowProvider(
        creds as unknown as ConstructorParameters<typeof ServiceNowProvider>[0],
        settings as unknown as ConstructorParameters<typeof ServiceNowProvider>[1]
      );
    case 'connectwise':
      return new ConnectWiseProvider(
        creds as unknown as ConstructorParameters<typeof ConnectWiseProvider>[0],
        settings as unknown as ConstructorParameters<typeof ConnectWiseProvider>[1]
      );
    case 'autotask':
      return new AutotaskProvider(
        creds as unknown as ConstructorParameters<typeof AutotaskProvider>[0],
        settings as unknown as ConstructorParameters<typeof AutotaskProvider>[1]
      );
    case 'freshservice':
      return new FreshserviceProvider(
        creds as unknown as ConstructorParameters<typeof FreshserviceProvider>[0],
        settings as unknown as ConstructorParameters<typeof FreshserviceProvider>[1]
      );
    case 'zendesk':
      return new ZendeskProvider(
        creds as unknown as ConstructorParameters<typeof ZendeskProvider>[0],
        settings as unknown as ConstructorParameters<typeof ZendeskProvider>[1]
      );
  }
}
