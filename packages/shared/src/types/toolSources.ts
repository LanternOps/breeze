// Tool sources (BYO MCP/OpenAPI) — spec docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.
export type ToolSourceKind = 'mcp' | 'openapi';
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
  /** For `openapi`: the API base URL every operation is sent to. */
  endpointUrl: string;
  /** OpenAPI document URL; null for `mcp` sources. */
  specUrl: string | null;
  credentialOrigin: string;
  authKind: ToolSourceAuthKind;
  hasCredential: boolean;
  status: ToolSourceStatus;
  lastDiscoveredAt: string | null;
  lastError: string | null;
  /** Diagnostics of the last COMPLETED discovery; null until one completes. */
  lastDiscoverySummary: ToolSourceDiscoverySummary | null;
  rateLimitPerMinute: number;
  toolCount: number;
  enabledToolCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Why an operation/tool was not turned into an enable-able tool. */
export type ToolSourceSkipReason =
  | 'unsupported_method'
  | 'unsupported_path'
  | 'unsupported_param_style'
  | 'unsupported_request_body'
  | 'unsupported_security_location'
  | 'schema_too_large'
  | 'too_many_parameters'
  | 'name_not_addressable';

export interface ToolSourceDiscoverySkip {
  /** Tool name (MCP) or operationId / synthesised `method path` label (OpenAPI). */
  name: string;
  /** Upper-case HTTP verb; OpenAPI only. */
  method?: string;
  /** Path template as written in the document; OpenAPI only. */
  path?: string;
  reason: ToolSourceSkipReason;
}

export interface ToolSourceDiscoveryWarning {
  /** `servers[]` origins that differ from the pinned credential origin — ignored, never routed to. */
  code: 'server_origin_mismatch';
  origins: string[];
}

/**
 * `tool_sources.last_discovery_summary` (W2, D17). Replaced on every completed
 * discovery; left as-is when a discovery fails, so `at` names the run it
 * describes. `skipped` is capped (document order); `skippedTotal` is exact.
 */
export interface ToolSourceDiscoverySummary {
  version: 1;
  at: string;
  /** Projectable operations in the document (OpenAPI); null for MCP. */
  operationCount: number | null;
  skipped: ToolSourceDiscoverySkip[];
  skippedTotal: number;
  warnings: ToolSourceDiscoveryWarning[];
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
