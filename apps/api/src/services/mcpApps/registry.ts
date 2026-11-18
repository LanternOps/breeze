/**
 * B-W05 (#6159, D-B43, D-B46): the MCP App registry — one row per `ui://`
 * view, each bound to exactly one read-only tool.
 *
 * registry.contract.test.ts holds every row to the pilot's rules: effective
 * tier 1 and read-only for every action, resource domain == tool domain,
 * registered permission == the tool's guardrail permission, a static-safety
 * scan of the HTML and a size cap. A second app is one row plus its own view.
 */
import { MCP_APP_MIME_TYPE } from '../mcpClientExtensions';
import type { McpToolUiMeta } from '../mcpToolPresentation';
import { FLEET_HEALTH_VIEW_HTML } from './fleetHealthView';

export type McpAppDefinition = {
  /** Bounded audit identifier (`details.mcpApp`, D-B44); never caller text. */
  readonly key: string;
  readonly toolName: string;
  readonly resourceUri: `ui://breeze/${string}`;
  readonly name: string;
  readonly html: string;
  /** Must equal TOOL_PERMISSIONS[toolName] (asserted by the contract). */
  readonly permission: { readonly resource: string; readonly action: 'read' };
};

export const MCP_APPS: readonly McpAppDefinition[] = Object.freeze([
  Object.freeze({
    key: 'fleet-health/v1',
    toolName: 'get_fleet_health',
    resourceUri: 'ui://breeze/fleet-health/v1',
    name: 'Breeze fleet health',
    html: FLEET_HEALTH_VIEW_HTML,
    permission: Object.freeze({ resource: 'devices', action: 'read' as const }),
  }),
]);

/**
 * Resource `_meta.ui` (MCP Apps 2026-01-26). Empty CSP lists mean the host's
 * restrictive default: no network, no remote scripts, fonts or images. No
 * `domain`, no `permissions`.
 */
export const MCP_APP_RESOURCE_UI_META = Object.freeze({
  csp: Object.freeze({ connectDomains: Object.freeze([]) as readonly never[], resourceDomains: Object.freeze([]) as readonly never[] }),
  prefersBorder: true as const,
});

export const MCP_APP_MAX_HTML_BYTES = 65_536;

/** Exact string equality only — never a pattern, never a prototype lookup. */
export function findMcpAppByUri(uri: string): McpAppDefinition | undefined {
  return MCP_APPS.find((app) => app.resourceUri === uri);
}

export function findMcpAppByTool(toolName: string): McpAppDefinition | undefined {
  return MCP_APPS.find((app) => app.toolName === toolName);
}

/**
 * D-B43: the single gate shared by `tools/list` (`_meta.ui`) and
 * `resources/read` (the view). Pure AND. Tier-1 listing has no RBAC check of
 * its own, so "listed" alone is not enough — the app's permission must pass.
 */
export function isMcpAppAvailable(input: {
  flagOn: boolean;
  declared: boolean;
  listedForCaller: boolean;
  permissionGranted: boolean;
}): boolean {
  return input.flagOn && input.declared && input.listedForCaller && input.permissionGranted;
}

/**
 * The tool's `_meta.ui`. `visibility: ['model']`: the view is display-only and
 * a host must refuse any app-initiated call to the tool (Gate B 2).
 */
export function mcpAppToolMeta(app: McpAppDefinition): { ui: McpToolUiMeta } {
  return { ui: { resourceUri: app.resourceUri, visibility: ['model'] } };
}

export function mcpAppResourceContents(app: McpAppDefinition): {
  contents: [{ uri: string; mimeType: typeof MCP_APP_MIME_TYPE; text: string; _meta: { ui: typeof MCP_APP_RESOURCE_UI_META } }];
} {
  return {
    contents: [{ uri: app.resourceUri, mimeType: MCP_APP_MIME_TYPE, text: app.html, _meta: { ui: MCP_APP_RESOURCE_UI_META } }],
  };
}
