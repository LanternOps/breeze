// Tool sources (BYO MCP/OpenAPI) — spec docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.
export type ToolSourceKind = 'mcp' | 'openapi';            // 'openapi' arrives in W2; schema rejects it in W1
export type ToolSourceAuthKind = 'none' | 'bearer' | 'api_key_header' | 'basic' | 'oauth2_client_credentials';
export type ToolSourceStatus = 'active' | 'error' | 'disabled';
export type ToolTier = 1 | 2 | 3;

export interface ToolSourceDto {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  slug: string;
  name: string;
  kind: ToolSourceKind;
  endpointUrl: string;
  credentialOrigin: string;
  authKind: ToolSourceAuthKind;
  hasCredential: boolean;
  status: ToolSourceStatus;
  lastDiscoveredAt: string | null;
  lastError: string | null;
  rateLimitPerMinute: number;
  toolCount: number;
  enabledToolCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSourceToolDto {
  id: string;
  sourceId: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  proposedTier: ToolTier;
  tier: ToolTier;
  enabled: boolean;
  reviewNeeded: boolean;
  revision: string;
  discoveredAt: string;
  removedAt: string | null;
  lastError: string | null;
}
