/**
 * Jira Integration Service
 *
 * Supports both Jira Cloud and Jira Server/Data Center
 */

export interface JiraCredentials {
  type: 'cloud' | 'server';
  // Cloud: email + API token
  email?: string;
  apiToken?: string;
  // Server: username + password or PAT
  username?: string;
  password?: string;
  personalAccessToken?: string;
  // Common
  baseUrl: string; // e.g., https://yourcompany.atlassian.net or https://jira.yourcompany.com
}

export interface JiraSettings {
  projectKey: string;
  issueType: string; // e.g., 'Task', 'Bug', 'Incident'
  priorityMapping: Record<string, string>; // Breeze severity -> Jira priority
  statusMapping: Record<string, string>; // Breeze status -> Jira status
  customFields?: Record<string, string>; // Field ID -> value
  labels?: string[];
  components?: string[];
  assignee?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: string;
    status: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string; emailAddress: string };
    created: string;
    updated: string;
    [key: string]: unknown;
  };
}

export interface CreateIssueParams {
  summary: string;
  description: string;
  priority?: string;
  labels?: string[];
  customFields?: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  body: string;
  author: { displayName: string };
  created: string;
}

class JiraClient {
  private credentials: JiraCredentials;
  private settings: JiraSettings;

  constructor(credentials: JiraCredentials, settings: JiraSettings) {
    this.credentials = credentials;
    this.settings = settings;
  }

  /**
   * Get authorization header based on credential type
   */
  private getAuthHeader(): string {
    if (this.credentials.type === 'cloud') {
      // Cloud uses email:apiToken as Basic auth
      const auth = Buffer.from(
        `${this.credentials.email}:${this.credentials.apiToken}`
      ).toString('base64');
      return `Basic ${auth}`;
    } else {
      // Server can use Basic auth or PAT
      if (this.credentials.personalAccessToken) {
        return `Bearer ${this.credentials.personalAccessToken}`;
      }
      const auth = Buffer.from(
        `${this.credentials.username}:${this.credentials.password}`
      ).toString('base64');
      return `Basic ${auth}`;
    }
  }

  /**
   * Make authenticated request to Jira API
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.credentials.baseUrl}/rest/api/3${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': this.getAuthHeader(),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jira API error (${response.status}): ${error}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  /**
   * Test connection to Jira
   */
  async testConnection(): Promise<{ success: boolean; message: string; user?: string }> {
    try {
      const myself = await this.request<{ displayName: string; emailAddress: string }>(
        'GET',
        '/myself'
      );
      return {
        success: true,
        message: `Connected as ${myself.displayName}`,
        user: myself.emailAddress || myself.displayName
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Connection failed'
      };
    }
  }

  /**
   * Get project details
   */
  async getProject(): Promise<{ id: string; key: string; name: string }> {
    return this.request('GET', `/project/${this.settings.projectKey}`);
  }

  /**
   * Create a new issue
   */
  async createIssue(params: CreateIssueParams): Promise<JiraIssue> {
    const { summary, description, priority, labels, customFields } = params;

    // Build issue fields
    const fields: Record<string, unknown> = {
      project: { key: this.settings.projectKey },
      issuetype: { name: this.settings.issueType },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }]
          }
        ]
      }
    };

    // Map priority
    if (priority && this.settings.priorityMapping[priority]) {
      fields.priority = { name: this.settings.priorityMapping[priority] };
    }

    // Add labels
    if (labels || this.settings.labels) {
      fields.labels = [...(this.settings.labels || []), ...(labels || [])];
    }

    // Add components
    if (this.settings.components?.length) {
      fields.components = this.settings.components.map(name => ({ name }));
    }

    // Add assignee
    if (this.settings.assignee) {
      fields.assignee = { accountId: this.settings.assignee };
    }

    // Add custom fields
    if (customFields || this.settings.customFields) {
      Object.assign(fields, this.settings.customFields, customFields);
    }

    const response = await this.request<{ id: string; key: string; self: string }>(
      'POST',
      '/issue',
      { fields }
    );

    // Fetch full issue details
    return this.getIssue(response.key);
  }

  /**
   * Get issue by key or ID
   */
  async getIssue(issueIdOrKey: string): Promise<JiraIssue> {
    return this.request('GET', `/issue/${issueIdOrKey}`);
  }

  /**
   * Update issue fields
   */
  async updateIssue(
    issueIdOrKey: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await this.request('PUT', `/issue/${issueIdOrKey}`, { fields });
  }

  /**
   * Transition issue to new status
   */
  async transitionIssue(issueIdOrKey: string, transitionName: string): Promise<void> {
    // Get available transitions
    const { transitions } = await this.request<{
      transitions: { id: string; name: string }[];
    }>('GET', `/issue/${issueIdOrKey}/transitions`);

    const transition = transitions.find(
      t => t.name.toLowerCase() === transitionName.toLowerCase()
    );

    if (!transition) {
      throw new Error(`Transition "${transitionName}" not available for this issue`);
    }

    await this.request('POST', `/issue/${issueIdOrKey}/transitions`, {
      transition: { id: transition.id }
    });
  }

  /**
   * Add comment to issue
   */
  async addComment(issueIdOrKey: string, comment: string): Promise<JiraComment> {
    return this.request('POST', `/issue/${issueIdOrKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: comment }]
          }
        ]
      }
    });
  }

  /**
   * Get comments for issue
   */
  async getComments(issueIdOrKey: string): Promise<JiraComment[]> {
    const response = await this.request<{ comments: JiraComment[] }>(
      'GET',
      `/issue/${issueIdOrKey}/comment`
    );
    return response.comments;
  }

  /**
   * Search issues with JQL
   */
  async searchIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const response = await this.request<{ issues: JiraIssue[] }>(
      'POST',
      '/search',
      {
        jql,
        maxResults,
        fields: ['summary', 'description', 'status', 'priority', 'assignee', 'created', 'updated']
      }
    );
    return response.issues;
  }

  /**
   * Get issues linked to Breeze (by label or custom field)
   */
  async getBreezeLinkedIssues(): Promise<JiraIssue[]> {
    const jql = `project = ${this.settings.projectKey} AND labels = "breeze-managed" ORDER BY created DESC`;
    return this.searchIssues(jql);
  }

  /**
   * Delete an issue
   */
  async deleteIssue(issueIdOrKey: string): Promise<void> {
    await this.request('DELETE', `/issue/${issueIdOrKey}`);
  }
}

/**
 * Create Jira client from PSA connection config
 */
export function createJiraClient(
  credentials: JiraCredentials,
  settings: JiraSettings
): JiraClient {
  return new JiraClient(credentials, settings);
}

/**
 * Default priority mapping
 */
export const DEFAULT_PRIORITY_MAPPING: Record<string, string> = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Lowest'
};

/**
 * Default status mapping
 */
export const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  active: 'To Do',
  acknowledged: 'In Progress',
  resolved: 'Done'
};

export { JiraClient };
