/**
 * Advisory AI readiness for an org's `chat` surface, read from the registry on
 * the CALLER's held system connection (W08 #7606; replaces the legacy
 * in-context readiness check in llmConfigResolver.ts, which read the retired
 * single-connection view and its pinned default model).
 *
 * Topology's AI tool gate resolves its preconditions inside a held
 * transaction; escaping to a second pooled connection there is the #6671
 * pool-exhaustion shape, so every read here uses the ambient connection
 * (readiness.test.ts pins it). It is a gate, not the decision: resolveModel
 * decides before any model call, and nothing here writes (a partner not
 * bootstrapped yet is judged as its bootstrap will leave it, never
 * bootstrapped by this read).
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { ANTHROPIC_API_CONNECTION_KINDS, isGatewayConnectionKind } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import {
  aiModelRegistryPartnerCutover,
  aiPlatformModels,
  organizations,
  partnerAiConnections,
  partnerAiModels,
} from '../../db/schema';
import { isPlatformLlmConfigured, type LlmUnusableCode } from '../llm/llmAvailability';
import { resolveCatalogEndpoint } from '../llm/llmConfigResolver';
import { getEffectiveAssignment } from './assignments';
import { decryptConnectionKey } from './connectionKeys';
import { resolveBootstrapDefaultModelId } from './registryBootstrap';

export interface ChatReadinessConnectionFacts {
  kind: string;
  /** Only 'active' is usable: 'error' and the soft-disconnected 'disconnected' (#7700) are not. */
  status: string;
  keyUsable: boolean;
  /** Catalog connections only: does the active revision map AND verify the offering's model? */
  catalog: 'n/a' | 'ok' | 'unusable';
}

export interface ChatReadinessFacts {
  orgFound: boolean;
  /** A platform credential is configured (the platform-funded path). */
  platformConfigured: boolean;
  /**
   * The org's effective chat default offering; for a partner not bootstrapped
   * yet, the offering its bootstrap will create. null = no default (none
   * assigned, the offering is gone, or an ambiguous bootstrap that assigns none).
   */
  defaultOffering: null | {
    enabled: boolean;
    /** null = a platform offering (funded by the platform key). */
    connection: null | ChatReadinessConnectionFacts;
  };
}

/** Pure: why chat cannot be served for these facts, or null when it can. */
export function chatReadinessCode(f: ChatReadinessFacts): LlmUnusableCode | null {
  if (!f.orgFound) return 'ai_unavailable';
  if (!f.defaultOffering || !f.defaultOffering.enabled) return 'ai_unavailable';
  const c = f.defaultOffering.connection;
  if (!c) return f.platformConfigured ? null : 'ai_not_configured';
  if (c.status !== 'active' || !c.keyUsable || c.catalog === 'unusable') return 'ai_unavailable';
  return null;
}

/**
 * Whether a connection's stored key can authenticate. An Anthropic-dialect
 * connection needs a key; a gateway kind may be legitimately keyless (a
 * no-auth gateway, W06). A stored key must decrypt on this node.
 */
export function connectionKeyUsable(conn: { id: string; kind: string; apiKeyEncrypted: string | null }): boolean {
  if (conn.apiKeyEncrypted === null) return isGatewayConnectionKind(conn.kind);
  try {
    decryptConnectionKey({ id: conn.id, apiKeyEncrypted: conn.apiKeyEncrypted });
    return true;
  } catch {
    return false;
  }
}

type ConnectionRow = { id: string; kind: string; status: string; apiKeyEncrypted: string | null; catalogEntryId: string | null };

/**
 * Built per call, not at module load: suites that mock the schema without the
 * registry tables still import this module (through topology/aiToolGate).
 */
const connectionColumns = () => ({
  id: partnerAiConnections.id,
  kind: partnerAiConnections.kind,
  status: partnerAiConnections.status,
  apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted,
  catalogEntryId: partnerAiConnections.catalogEntryId,
});

async function connectionFacts(conn: ConnectionRow, logicalModel: string | null): Promise<ChatReadinessConnectionFacts> {
  let catalog: ChatReadinessConnectionFacts['catalog'] = 'n/a';
  if (conn.kind === 'catalog') {
    const resolved = conn.catalogEntryId && logicalModel
      ? await resolveCatalogEndpoint(conn.catalogEntryId, logicalModel)
      : { ok: false as const };
    catalog = resolved.ok ? 'ok' : 'unusable';
  }
  return { kind: conn.kind, status: conn.status, keyUsable: connectionKeyUsable(conn), catalog };
}

/**
 * A partner with no cutover row is bootstrapped on its first AI request
 * (registryBootstrap.planBootstrap): onto its one live Anthropic connection if
 * it has exactly one, with no default if it has several, else onto the platform.
 */
async function pendingBootstrapOffering(partnerId: string): Promise<ChatReadinessFacts['defaultOffering']> {
  const connections = await db.select(connectionColumns()).from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, [...ANTHROPIC_API_CONNECTION_KINDS]),
      ne(partnerAiConnections.status, 'disconnected'),
    ))
    .orderBy(asc(partnerAiConnections.createdAt))
    .limit(2);
  if (connections.length > 1) return null;
  if (connections.length === 0) return { enabled: true, connection: null };
  const model = connections[0]!.kind === 'catalog' ? await resolveBootstrapDefaultModelId() : null;
  return { enabled: true, connection: await connectionFacts(connections[0]!, model) };
}

async function loadChatDefaultOffering(partnerId: string, orgId: string): Promise<ChatReadinessFacts['defaultOffering']> {
  const [cut] = await db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
    .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1);
  if (!cut) return pendingBootstrapOffering(partnerId);

  const assignment = await getEffectiveAssignment({ partnerId, orgId, surface: 'chat' });
  if (!assignment.defaultOfferingId) return null;
  const [offering] = await db.select({
    enabled: partnerAiModels.enabled,
    connectionId: partnerAiModels.connectionId,
    platformModelId: partnerAiModels.platformModelId,
    modelId: partnerAiModels.modelId,
    linkedModelId: aiPlatformModels.modelId,
  })
    .from(partnerAiModels)
    .leftJoin(aiPlatformModels, eq(aiPlatformModels.id, partnerAiModels.platformModelId))
    .where(and(eq(partnerAiModels.id, assignment.defaultOfferingId), eq(partnerAiModels.partnerId, partnerId)))
    .limit(1);
  if (!offering) return null;
  if (!offering.connectionId) {
    // A platform offering resolves through its platform row; without one it cannot be served.
    return { enabled: offering.enabled && offering.platformModelId !== null, connection: null };
  }
  const [conn] = await db.select(connectionColumns()).from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, offering.connectionId), eq(partnerAiConnections.partnerId, partnerId)))
    .limit(1);
  if (!conn) return { enabled: offering.enabled, connection: { kind: 'missing', status: 'missing', keyUsable: false, catalog: 'n/a' } };
  // The logical model the resolver uses (candidateLoader): the offering's own id, else its linked platform row's.
  return { enabled: offering.enabled, connection: await connectionFacts(conn, offering.modelId ?? offering.linkedModelId ?? null) };
}

async function loadChatReadinessFacts(orgId: string, platformConfigured: boolean): Promise<ChatReadinessFacts> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1);
  if (!org) return { orgFound: false, platformConfigured, defaultOffering: null };
  return { orgFound: true, platformConfigured, defaultOffering: await loadChatDefaultOffering(org.partnerId, orgId) };
}

/**
 * Why the org's chat surface cannot be served, or null when it can. Must run
 * inside a held SYSTEM context (partner-axis rows are invisible to an org
 * token); throws otherwise. Never escapes to another connection, never writes.
 */
export async function chatReadinessInSystemContext(
  orgId: string,
  deps: { platformConfigured?: () => boolean } = {},
): Promise<LlmUnusableCode | null> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('chatReadinessInSystemContext requires a held system DB context');
  }
  const platformConfigured = (deps.platformConfigured ?? (() => isPlatformLlmConfigured()))();
  return chatReadinessCode(await loadChatReadinessFacts(orgId, platformConfigured));
}
