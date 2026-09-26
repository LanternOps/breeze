import './topologyZod';
import { z } from 'zod';
import { topologyRecipeIdSchema } from './topologyConfiguration';

/**
 * Topology M4 (#6000) client-facing AI contracts. The evidence snapshot, alias
 * map and scope stamp are HOST-ONLY (API `services/topology/aiEvidence.ts`)
 * and deliberately have no shared schema: they must never reach a browser.
 *
 * A published explanation is always server-validated: every citation id is a
 * member of the evidence manifest, model causal prose stays a hypothesis, and
 * no raw model text, URL or Markdown blob survives (see `aiCitations.ts`).
 */
export const TOPOLOGY_AI_LIMITS = {
  findings: 12,
  findingTextBytes: 500,
  citationsPerFinding: 8,
  missingData: 8,
  nextChecks: 3,
  citations: 64,
} as const;

/** Finding kinds as published. `missing_data`/`next_check` are server-built from the dedicated arrays. */
export const TOPOLOGY_AI_FINDING_KINDS = ['finding', 'hypothesis', 'missing_data', 'next_check'] as const;
/**
 * What a statement claims. A model `finding` survives only when a cited
 * evidence record supports its claim category; `physical_fault` and `cause`
 * are interpretations and are ALWAYS published as hypotheses.
 */
export const TOPOLOGY_AI_CLAIMS = ['topology', 'health', 'measurement', 'change', 'reachability', 'physical_fault', 'cause'] as const;
export const TOPOLOGY_AI_EXPLANATION_STATUSES = ['complete', 'partial', 'evidence_changed'] as const;
export const TOPOLOGY_AI_CITATION_RESOURCES = ['node', 'relationship', 'observation', 'confirmation', 'change', 'link_health', 'node_health'] as const;

const uuid = z.string().uuid();
const citationId = z.string().min(1).max(200);
const text = z.string().min(1).max(1000);
const reason = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const topologyAiSelectionSchema = z.object({
  siteId: uuid,
  subject: z.object({ kind: z.enum(['node', 'relationship']), id: uuid }).strict(),
  view: z.enum(['overview', 'physical', 'logical']),
  graphRevision: z.string().regex(/^(0|[1-9]\d{0,19})$/),
}).strict();

export const topologyAiFindingSchema = z.object({
  kind: z.enum(TOPOLOGY_AI_FINDING_KINDS),
  claim: z.enum(TOPOLOGY_AI_CLAIMS),
  text,
  citationIds: z.array(citationId).max(TOPOLOGY_AI_LIMITS.citationsPerFinding),
}).strict();

export const topologyAiNextCheckSchema = z.object({
  recipeId: topologyRecipeIdSchema,
  rationale: text,
  citationIds: z.array(citationId).max(TOPOLOGY_AI_LIMITS.citationsPerFinding),
}).strict();

/** Display record for one cited evidence item; the inspector target reopens it under ordinary site access. */
export const topologyAiCitationSchema = z.object({
  id: citationId,
  resourceType: z.enum(TOPOLOGY_AI_CITATION_RESOURCES),
  resourceId: uuid,
  observedAt: z.string().datetime({ offset: true }).nullable(),
  inspectorTarget: z.object({ kind: z.enum(['node', 'relationship']), id: uuid }).strict().nullable(),
}).strict();

/** Host alias token as serialized to a model: `host-` + 8 hex chars (aiEvidence.ts). */
export const TOPOLOGY_AI_HOST_ALIAS_PATTERN = /\bhost-[0-9a-f]{8}\b/g;
export const topologyAiHostAliasSchema = z.object({ alias: z.string().regex(/^host-[0-9a-f]{8}$/), nodeId: uuid }).strict();

export const topologyAiExplanationSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(TOPOLOGY_AI_EXPLANATION_STATUSES),
  findings: z.array(topologyAiFindingSchema).max(TOPOLOGY_AI_LIMITS.findings),
  missingData: z.array(z.string().min(1).max(300)).max(TOPOLOGY_AI_LIMITS.missingData),
  nextChecks: z.array(topologyAiNextCheckSchema).max(TOPOLOGY_AI_LIMITS.nextChecks),
  citationIds: z.array(citationId).max(TOPOLOGY_AI_LIMITS.citations),
  citations: z.array(topologyAiCitationSchema).max(TOPOLOGY_AI_LIMITS.citations),
  reasons: z.array(reason).max(32),
  /**
   * Per-investigation host aliases the published text mentions, mapped to the
   * snapshot node they stand for (never a name). A client shows a real name
   * ONLY for a node present in its own authorized graph read; anything else
   * stays an alias. Omitted when the text mentions none.
   */
  hostAliases: z.array(topologyAiHostAliasSchema).max(TOPOLOGY_AI_LIMITS.citations).optional(),
}).strict();

/**
 * The ONLY shape a model answer may take. Parsed strictly from the buffered,
 * complete provider output; anything else is discarded for a deterministic
 * fallback. `recipeId` is re-checked against the recipe enum server-side so an
 * unknown recipe drops the check instead of failing the whole answer.
 */
export const topologyAiModelOutputSchema = z.object({
  findings: z.array(z.object({
    kind: z.enum(['finding', 'hypothesis']),
    claim: z.enum(TOPOLOGY_AI_CLAIMS),
    text,
    citationIds: z.array(citationId).max(16),
  }).strict()).max(TOPOLOGY_AI_LIMITS.findings),
  missingData: z.array(z.string().min(1).max(300)).max(TOPOLOGY_AI_LIMITS.missingData),
  nextChecks: z.array(z.object({
    recipeId: z.string().min(1).max(64),
    rationale: text,
    citationIds: z.array(citationId).max(16),
  }).strict()).max(TOPOLOGY_AI_LIMITS.nextChecks),
}).strict();
