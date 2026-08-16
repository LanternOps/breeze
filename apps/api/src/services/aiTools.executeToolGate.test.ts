import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Integration: `executeTool` (the universal dispatch chokepoint for the chat,
 * MCP, and SDK paths) runs the declarative device gate BEFORE the handler, so a
 * tool declaring `deviceArgs` cannot reach a device outside the caller's scope
 * even if its handler does no checking of its own.
 *
 * Second suite below: the same chokepoint carries an explicit
 * `ToolExecutionContext` from caller to CORE handler, and deliberately does not
 * carry it to extension-contributed handlers.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

// Keep every real schema export; only force input validation to pass so the
// probe tool (which has no registered Zod schema) reaches the gate.
vi.mock('./aiToolSchemas', async (orig) => ({
  ...(await orig<typeof import('./aiToolSchemas')>()),
  validateToolInput: () => ({ success: true }),
}));

import { db } from '../db';
import { aiTools, executeTool } from './aiTools';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { AuthContext } from '../middleware/auth';
import { ExtensionContributionRegistry } from '../extensions/contributionRegistry';
import type { ExtensionAiTool, ExtensionManifestV1 } from '@breeze/extension-sdk';

const PROBE = '__device_gate_probe__';
const FOREIGN_DEVICE = '99999999-9999-9999-9999-999999999999';
const OWN_DEVICE = '33333333-3333-3333-3333-333333333333';

function deviceLookup(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

// A tool that ALWAYS succeeds and does NO checking of its own — so the only
// thing that can deny a foreign device is the central gate.
const handler = vi.fn(async () => JSON.stringify({ success: true, ranHandler: true }));

beforeEach(() => {
  vi.clearAllMocks();
  aiTools.set(PROBE, {
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: { name: PROBE, description: 'probe', input_schema: { type: 'object', properties: {} } },
    handler,
  } as AiTool);
});

afterEach(() => {
  aiTools.delete(PROBE);
});

describe('executeTool runs the declarative device gate before the handler', () => {
  it('denies a foreign device and never invokes the handler', async () => {
    vi.mocked(db.select).mockImplementation(() => deviceLookup([]) as any); // gate lookup excluded
    const out = await executeTool(PROBE, { deviceId: FOREIGN_DEVICE }, makeAuth());
    expect(JSON.parse(out).error).toMatch(/not found or access denied/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the handler when the declared device is accessible', async () => {
    vi.mocked(db.select).mockImplementation(
      () => deviceLookup([{ id: OWN_DEVICE, hostname: 'h', siteId: 's', status: 'online' }]) as any,
    );
    const out = await executeTool(PROBE, { deviceId: OWN_DEVICE }, makeAuth());
    expect(JSON.parse(out).ranHandler).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // Regression (finding A): the helper device-scope gate must ONLY engage when
  // auth.helperDeviceId is set. A normal (non-helper) caller's input must reach
  // the handler untouched — no forced/injected device field.
  it('passes input through untouched for a normal (non-helper) caller', async () => {
    vi.mocked(db.select).mockImplementation(
      () => deviceLookup([{ id: OWN_DEVICE, hostname: 'h', siteId: 's', status: 'online' }]) as any,
    );
    const input = { deviceId: OWN_DEVICE, foo: 'bar' };
    await executeTool(PROBE, input, makeAuth()); // makeAuth() has no helperDeviceId
    // Third argument is the (here omitted) ToolExecutionContext.
    expect(handler).toHaveBeenCalledWith(input, expect.anything(), undefined);
  });
});

// ============================================================================
// ToolExecutionContext carrier (#3409 PR4c-1)
// ============================================================================

const CONTEXT_PROBE = '__tool_context_probe__';

/**
 * A snapshot-shaped fixture. Its contents are irrelevant here — this suite only
 * proves the CHANNEL: the same object identity the caller handed to
 * `executeTool` is what the handler receives.
 */
const VERIFIED_SNAPSHOT = {
  script: {
    id: 'script-1',
    orgId: 'org-123',
    language: 'powershell',
    content: 'Write-Host 1',
    timeoutSeconds: 300,
    runAs: 'system',
  },
  parameterDefinitions: '[]',
  deviceOrgIds: ['org-123'],
  variableReferences: [],
} satisfies NonNullable<ToolExecutionContext['verifiedRunScript']>;

/**
 * A handler declared with the FULL three-parameter shape, so the recorded call
 * arguments stay typed (`mock.calls[0][2]` is the context, not an out-of-range
 * tuple index).
 */
function makeRecordingHandler() {
  return async (
    _input: Record<string, unknown>,
    _auth: AuthContext,
    _context?: ToolExecutionContext,
  ) => JSON.stringify({ ok: true });
}

function registerContextProbe(handlerImpl: AiTool['handler']) {
  aiTools.set(CONTEXT_PROBE, {
    tier: 1,
    definition: {
      name: CONTEXT_PROBE,
      description: 'context probe',
      input_schema: { type: 'object', properties: {} },
    },
    handler: handlerImpl,
  } as AiTool);
}

function makeExtensionTool(handlerImpl: ExtensionAiTool['handler']): ExtensionAiTool {
  return {
    definition: {
      name: 'context_probe_ext',
      description: 'extension context probe',
      input_schema: { type: 'object', properties: {}, additionalProperties: true },
    },
    tier: 1,
    handler: handlerImpl,
  };
}

function makeExtensionManifest(): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'context-probe-ext',
    version: '1.0.0',
    routeNamespace: 'context-probe-ext',
    requires: {
      breeze: '>=1.0.0',
      serverSdk: '^1.0.0',
      capabilities: ['server.ai-tools.v1'],
    },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    publicRoutes: [],
    jobs: [],
    aiTools: [{ name: 'context_probe_ext' }],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
  };
}

describe('executeTool carries an explicit ToolExecutionContext', () => {
  afterEach(() => {
    aiTools.delete(CONTEXT_PROBE);
  });

  it('hands the caller-supplied context to the core handler as its third argument', async () => {
    const contextHandler = vi.fn(makeRecordingHandler());
    registerContextProbe(contextHandler);
    const auth = makeAuth();
    const input = { foo: 'bar' };
    const context: ToolExecutionContext = { verifiedRunScript: VERIFIED_SNAPSHOT };

    await executeTool(CONTEXT_PROBE, input, auth, { context });

    expect(contextHandler).toHaveBeenCalledWith(input, auth, context);
    // Identity, not a structural copy: the release path's verified material must
    // arrive as the very object it verified.
    expect(contextHandler.mock.calls[0]?.[2]).toBe(context);
  });

  it('leaves the third argument undefined when the caller supplies no context', async () => {
    const contextHandler = vi.fn(makeRecordingHandler());
    registerContextProbe(contextHandler);

    await executeTool(CONTEXT_PROBE, { foo: 'bar' }, makeAuth());

    expect(contextHandler.mock.calls[0]?.[2]).toBeUndefined();
  });

  /**
   * The compatibility proof for the other 188 handlers: a handler DECLARED with
   * only `(input, auth)` — the pre-existing shape — must keep running unchanged
   * even when a context is in flight. It reads its two arguments positionally,
   * so any reordering or retyping of the leading parameters breaks this test.
   */
  it('runs a handler declared with only (input, auth), context or not', async () => {
    const twoArgHandler: AiTool['handler'] = async (input, auth) =>
      JSON.stringify({ sawInput: input.foo, sawOrg: auth.orgId, arity: 2 });
    registerContextProbe(twoArgHandler);

    const withContext = JSON.parse(await executeTool(
      CONTEXT_PROBE,
      { foo: 'bar' },
      makeAuth(),
      { context: { verifiedRunScript: VERIFIED_SNAPSHOT } },
    ));
    const withoutContext = JSON.parse(
      await executeTool(CONTEXT_PROBE, { foo: 'bar' }, makeAuth()),
    );

    expect(withContext).toEqual({ sawInput: 'bar', sawOrg: 'org-123', arity: 2 });
    expect(withoutContext).toEqual(withContext);
  });

  /**
   * Pre-verified release material is HOST-internal. An extension handler is
   * third-party code that may well be written `(input, auth, ...rest)`, so it is
   * not enough that the type omits a third parameter — the call must physically
   * pass only two arguments.
   */
  it('never hands the context to an extension-contributed handler', async () => {
    const extensionHandler = vi.fn(
      async (_input: Record<string, unknown>, _auth: unknown) => 'ext-ok',
    );
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeExtensionManifest());
    session.registrar.mountRoute(new Hono());
    session.registrar.registerAiTool(
      'context_probe_ext',
      makeExtensionTool(extensionHandler),
    );
    registry.activate(session.finish());

    const out = await executeTool(
      'context_probe_ext',
      {},
      makeAuth(),
      {
        registry,
        store: { isEnabled: async () => true },
        context: { verifiedRunScript: VERIFIED_SNAPSHOT },
      },
    );

    expect(out).toBe('ext-ok');
    expect(extensionHandler.mock.calls[0]).toHaveLength(2);
  });
});
