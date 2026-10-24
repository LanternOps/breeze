/**
 * B-W05 (#6159, D-B46): every registered MCP App obeys the pilot's rules.
 *
 * No vi.mock — this suite needs the real tool registry, guardrail tables and
 * MCP tier floor. The static-safety scan is a guardrail against obvious
 * regressions, not an XSS proof; that proof is fleetHealthView.test.ts (jsdom,
 * hostile input) plus the real-host lab.
 */
import { describe, expect, it } from 'vitest';
import { getToolDefinitions, getToolDomain, getToolTier } from '../aiTools';
import { TIER2_ACTIONS, TIER3_ACTIONS, TOOL_PERMISSIONS } from '../aiGuardrails';
import { toolActionEnum } from '../aiToolActions';
import { buildMcpToolPresentation, isActionReadOnly, resolveActionTier } from '../mcpToolPresentation';
import { mcpResourceDomain, mcpToolDomain } from '../mcpDomains';
import { MCP_APP_MIME_TYPE } from '../mcpClientExtensions';
import { MCP_APPROVAL_REQUIRED_EXTRA_TOOLS } from '../../routes/mcpServer';
import { FLEET_HEALTH_VIEW_HTML } from './fleetHealthView';
import {
  MCP_APPS,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_RESOURCE_UI_META,
  findMcpAppByTool,
  findMcpAppByUri,
  isMcpAppAvailable,
  mcpAppResourceContents,
  mcpAppToolMeta,
} from './registry';

const BANNED_IN_VIEW_HTML: RegExp[] = [
  /https?:/i, /["'(]\/\//, /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/,
  /\beval\s*\(/, /\bFunction\s*\(/, /<script[^>]*\ssrc=/i, /<link\b/i, /<iframe\b/i, /@import/i,
  /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\bset(Timeout|Interval)\s*\(\s*["'`]/, /javascript:/i,
  /\bsrcdoc\b/i, /<img\b/i, /<object\b/i, /<embed\b/i, /<form\b/i, /\burl\s*\(/i, /\bimportScripts\b/,
  /\bsendBeacon\b/, /\bEventSource\b/, /\bwindow\.open\b/, /\blocation\s*=/, /\bnew\s+Worker\b/,
];

describe('MCP app registry (D-B46)', () => {
  it('holds exactly the fleet-health pilot', () => {
    expect(MCP_APPS).toHaveLength(1);
    expect(MCP_APPS[0]).toEqual({
      key: 'fleet-health/v1',
      toolName: 'get_fleet_health',
      resourceUri: 'ui://breeze/fleet-health/v1',
      name: 'Breeze fleet health',
      html: FLEET_HEALTH_VIEW_HTML,
      permission: { resource: 'devices', action: 'read' },
    });
    expect(Object.isFrozen(MCP_APPS)).toBe(true);
  });

  it.each(MCP_APPS)('$toolName is effective tier 1 and read-only for every action', (app) => {
    expect(getToolTier(app.toolName)).toBe(1);
    expect(MCP_APPROVAL_REQUIRED_EXTRA_TOOLS[app.toolName]).toBeUndefined();
    expect(TIER3_ACTIONS[app.toolName] ?? []).toEqual([]);
    expect(TIER2_ACTIONS[app.toolName] ?? []).toEqual([]);
    const actions = [...new Set([...(toolActionEnum(app.toolName) ?? []), ...(TIER2_ACTIONS[app.toolName] ?? []), ...(TIER3_ACTIONS[app.toolName] ?? [])])];
    const targets: (string | undefined)[] = actions.length > 0 ? actions : [undefined];
    for (const action of targets) {
      expect(resolveActionTier(app.toolName, action, 1)).toBe(1);
      expect(isActionReadOnly(app.toolName, action, 1)).toBe(true);
    }
    const definition = getToolDefinitions().find((tool) => tool.name === app.toolName);
    expect(definition).toBeDefined();
    const presentation = buildMcpToolPresentation(definition!, getToolTier(app.toolName), getToolDomain(app.toolName));
    expect(presentation.annotations.readOnlyHint).toBe(true);
    expect(presentation.annotations.destructiveHint).toBe(false);
  });

  it.each(MCP_APPS)('$resourceUri domain equals the tool domain', (app) => {
    expect(mcpToolDomain(app.toolName)).toBeDefined();
    expect(mcpResourceDomain(app.resourceUri)).toBe(mcpToolDomain(app.toolName));
  });

  it.each(MCP_APPS)('$key permission equals the tool guardrail permission', (app) => {
    // A flat {resource, action} entry, never a per-action map.
    expect(TOOL_PERMISSIONS[app.toolName]).toEqual(app.permission);
  });

  it.each(MCP_APPS)('$name html passes the static-safety scan', (app) => {
    expect(Buffer.byteLength(app.html, 'utf8')).toBeLessThanOrEqual(MCP_APP_MAX_HTML_BYTES);
    expect(app.html.startsWith('<!doctype html>')).toBe(true);
    for (const banned of BANNED_IN_VIEW_HTML) expect(app.html).not.toMatch(banned);
    // Exactly one inline script, marked so the hostile-input test can exclude it.
    expect(app.html.match(/<script\b/gi)).toHaveLength(1);
    expect(app.html).toMatch(/<script data-view>/);
  });

  it('resource URIs, keys and tool names are unique and URIs are versioned', () => {
    for (const app of MCP_APPS) expect(app.resourceUri).toMatch(/^ui:\/\/breeze\/[a-z-]+\/v\d+$/);
    for (const field of ['resourceUri', 'key', 'toolName'] as const) {
      expect(new Set(MCP_APPS.map((app) => app[field])).size).toBe(MCP_APPS.length);
    }
  });

  it('findMcpAppByUri is exact', () => {
    expect(findMcpAppByUri('ui://breeze/fleet-health/v1')).toBe(MCP_APPS[0]);
    for (const near of [
      'ui://breeze/fleet-health/v2', 'ui://breeze/fleet-health/v1?x', 'ui://breeze/fleet-health/v1/',
      'UI://breeze/fleet-health/v1', 'ui://breeze/fleet-health/v1#x', ' ui://breeze/fleet-health/v1',
      'ui://breeze/fleet-health', 'ui://breeze/fleet-health/v10', 'constructor', '__proto__', 'toString',
    ]) {
      expect(findMcpAppByUri(near)).toBeUndefined();
    }
  });

  it('findMcpAppByTool is exact', () => {
    expect(findMcpAppByTool('get_fleet_health')).toBe(MCP_APPS[0]);
    for (const near of ['get_fleet_health ', 'GET_FLEET_HEALTH', 'query_devices', 'constructor', '__proto__']) {
      expect(findMcpAppByTool(near)).toBeUndefined();
    }
  });

  it('isMcpAppAvailable is a strict AND (D-B43)', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const input = {
        flagOn: (mask & 1) !== 0,
        declared: (mask & 2) !== 0,
        listedForCaller: (mask & 4) !== 0,
        permissionGranted: (mask & 8) !== 0,
      };
      expect(isMcpAppAvailable(input)).toBe(mask === 15);
    }
  });

  it('mcpAppToolMeta is the model-only resource pointer', () => {
    expect(mcpAppToolMeta(MCP_APPS[0]!)).toEqual({ ui: { resourceUri: 'ui://breeze/fleet-health/v1', visibility: ['model'] } });
  });

  it('mcpAppResourceContents serves the html with the restrictive resource meta', () => {
    expect(MCP_APP_RESOURCE_UI_META).toEqual({ csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true });
    expect(mcpAppResourceContents(MCP_APPS[0]!)).toEqual({
      contents: [{
        uri: 'ui://breeze/fleet-health/v1',
        mimeType: MCP_APP_MIME_TYPE,
        text: FLEET_HEALTH_VIEW_HTML,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      }],
    });
  });
});
