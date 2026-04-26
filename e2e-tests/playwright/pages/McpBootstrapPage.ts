// e2e-tests/playwright/pages/McpBootstrapPage.ts
// The MCP bootstrap flow is API-only (no UI). This POM serves as a thin
// namespace for the API helpers and request builders used in mcp-bootstrap.spec.ts.
import type { Page, APIRequestContext } from '@playwright/test';
import { BasePage } from './BasePage';

export class McpBootstrapPage extends BasePage {
  constructor(page: Page, private readonly request: APIRequestContext) {
    super(page);
  }

  buildMcpBody(id: number, toolName: string, args: Record<string, unknown>) {
    return {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };
  }

  async callMcpTool(
    toolName: string,
    args: Record<string, unknown>,
    opts: { id?: number; headers?: Record<string, string> } = {},
  ) {
    const { id = 1, headers = {} } = opts;
    const response = await this.request.post('/api/v1/mcp/message', {
      data: this.buildMcpBody(id, toolName, args),
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });
    return response;
  }

  async simulateEmailActivation(tenantId: string) {
    return this.request.post(`/test/activate/${tenantId}`, { data: {} });
  }

  async simulatePaymentCompletion(tenantId: string) {
    return this.request.post(`/test/complete-payment/${tenantId}`, { data: {} });
  }
}
