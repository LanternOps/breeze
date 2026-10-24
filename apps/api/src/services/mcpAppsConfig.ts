import { MCP_UI_EXTENSION_ID } from './mcpClientExtensions';

/**
 * B-W05 (#6159, D-B45): kill switch for the MCP Apps pilot, read per call.
 *
 * Kept out of config/env.ts for the same reason as services/mcpIntentConfig.ts:
 * the routes/mcpServer* suites replace that module with a narrow literal mock,
 * and this is read on the MCP request path. Same accepted vocabulary as
 * config/env's envFlag; config/validate.ts rejects a typo at boot.
 *
 * Off (the default in the release that ships it): no `extensions` capability
 * is advertised, no `_meta.ui` is listed, the app URI answers as unknown, and
 * no negotiated-extension side key is read or written — every MCP response is
 * byte-identical to the pre-W05 server.
 */
export function mcpAppsEnabled(): boolean {
  const raw = process.env.MCP_APPS_ENABLED;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The server-side `capabilities.extensions` value advertised on streamable
 * `initialize` and on `server/discover` while the flag is on (D-B40), else
 * undefined so callers can add the key conditionally and keep flag-off bytes.
 */
export function mcpAppsServerExtensions(): { readonly [MCP_UI_EXTENSION_ID]: Record<string, never> } | undefined {
  return mcpAppsEnabled() ? { [MCP_UI_EXTENSION_ID]: {} } : undefined;
}
