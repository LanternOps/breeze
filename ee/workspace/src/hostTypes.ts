/**
 * The single seam between Workspace and the v1 extension host contract.
 *
 * The legacy `@breeze/extension-api` adapter package is gone. Of the six types
 * it exported, only two have v1 equivalents (`BreezeExtensionV1` and
 * `ExtensionRuntimeContext`); the rest are re-declared here.
 *
 * These local declarations are deliberate — the v1 SDK does NOT export them.
 * Do not "fix" this file by importing them from `@breeze/extension-sdk`:
 *
 * - `ExtensionAuditEvent`: v1 loosened the host's `audit()` parameter to
 *   `Record<string, unknown>`. Workspace keeps emitting a structured, typed
 *   event so a typo in an audit call site is still a compile error. It is a
 *   `type` (not an `interface`) on purpose: only a type alias is assignable to
 *   `Record<string, unknown>`, which is what lets `context.audit` satisfy
 *   `WorkspaceAudit`.
 * - `ExtensionAgentContext`: never existed in v1; it is the shape the host
 *   gateway puts on `c.get('agent')` for agent-authenticated requests.
 * - `WorkspaceDatabase`: see below.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';

export type {
  BreezeExtensionV1,
  ExtensionRegistrar,
  ExtensionRuntimeContext,
  ExtensionAiContext,
  ExtensionAiInvokeResult,
} from '@breeze/extension-sdk';
export { ExtensionAiError } from '@breeze/extension-sdk';

/**
 * The Drizzle handle every Workspace service actually queries through.
 *
 * v1 types `context.db` loosely (`Record<string, unknown> & { execute() }`),
 * but at runtime the host supplies the **org-scoped Drizzle connection**, and
 * that connection is what enforces RLS. Narrowing it is therefore a single,
 * documented adapter at the registration boundary (`asWorkspaceDatabase`)
 * rather than a cast scattered through every service — and it must never be
 * widened into a permissive fake, which would hide a real tenancy defect
 * behind a green suite.
 */
export type WorkspaceDatabase = PostgresJsDatabase;

/** Narrow the host's loosely-typed `context.db` to the org-scoped Drizzle handle. */
export function asWorkspaceDatabase(db: ExtensionRuntimeContext['db']): WorkspaceDatabase {
  return db as unknown as WorkspaceDatabase;
}

/** Column-level encryption seam; v1 has it inline on the runtime context. */
export type ExtensionSecrets = ExtensionRuntimeContext['secrets'];

/** Level-first host logger: `log('error', message, fields?)`. */
export type ExtensionLog = ExtensionRuntimeContext['log'];

/** Structured audit event Workspace emits (see the note at the top of the file). */
export type ExtensionAuditEvent = {
  orgId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  result: 'success' | 'failure';
  errorMessage?: string;
  /** Structured event payload (W2/W7 content + helper events carry one). */
  details?: Record<string, unknown>;
};

/** Audit sink as Workspace consumes it; `context.audit` is assignable to this. */
export type WorkspaceAudit = (event: ExtensionAuditEvent) => Promise<void>;

/** Agent identity the host gateway attaches to agent-authenticated requests. */
export interface ExtensionAgentContext {
  deviceId: string;
  agentId: string;
  orgId: string;
  siteId: string | null;
  role: string;
}

/**
 * Helper (tray) device identity the host gateway attaches to /helper/*
 * requests. Mirrors core's `HelperDevice` (apps/api middleware/helperAuth):
 * the gateway applies core helper auth when the legacy-manifest `helperRoutes`
 * flag is set, so this is the shape found on `c.get('helperDevice')`.
 */
export interface ExtensionHelperDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string | null;
  hostname: string;
  osType: string;
  osVersion: string;
  agentVersion: string;
}
