/**
 * Topology M4 Task 2 (#6000): the server-side gate between a model's COMPLETE
 * answer and anything a client may see or the database may keep.
 *
 * `validateTopologyAiExplanation` parses the buffered output strictly
 * (`topologyAiModelOutputSchema`), keeps only citation ids that are members of
 * the snapshot's host-only manifest, and demotes:
 *   - any statement whose claim category no cited record supports,
 *   - every model `cause`/`physical_fault` claim (interpretation, never a
 *     verified finding — an ICMP timeout cannot prove a cut cable),
 * to a `hypothesis`, with a machine reason. Text is sanitized, bounded and
 * stripped of URLs/Markdown links (no public links for internal citations).
 * Anything unparseable becomes ONE deterministic fallback; raw prose is never
 * echoed.
 *
 * `reauthorizeTopologyAiCitations` re-checks the caller's CURRENT site access
 * and each cited resource's live existence, and
 * `applyTopologyAiCitationAvailability` removes statements that depended only
 * on evidence that is no longer available.
 */
import { sql } from 'drizzle-orm';
import {
  TOPOLOGY_AI_LIMITS, topologyAiExplanationSchema, topologyAiModelOutputSchema, topologyRecipeIdSchema,
  type TopologyAiCitation, type TopologyAiExplanation, type TopologyAiFinding, type TopologyAiNextCheck,
} from '@breeze/shared';

import { db } from '../../db';
import { getUserPermissions } from '../permissions';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from './access';
import type { TopologyAiEvidenceSnapshot } from './aiEvidence';
import { sanitizeTopologyAiText } from './aiRedaction';
import { scoped } from './graphRead';

export const TOPOLOGY_AI_FALLBACK_REASON = 'invalid_model_output';
const FALLBACK_TEXT = 'The explanation could not be validated; no model statement is shown.';
const ALWAYS_HYPOTHESIS = new Set(['cause', 'physical_fault']);

export function topologyAiFallbackExplanation(reason = TOPOLOGY_AI_FALLBACK_REASON): TopologyAiExplanation {
  return { schemaVersion: 1, status: 'partial', findings: [], missingData: [FALLBACK_TEXT], nextChecks: [], citationIds: [], citations: [], reasons: [reason] };
}

const URL_OR_LINK = /\[([^\]]{0,200})\]\([^)]*\)|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/giu;

function cleanText(value: string, maxBytes: number): string | null {
  return sanitizeTopologyAiText(value.replace(URL_OR_LINK, (_m, label: string | undefined) => label ?? ''), undefined, maxBytes);
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  let body = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/u.exec(body);
  if (fenced) body = fenced[1]!.trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function displayCitations(ids: string[], snapshot: TopologyAiEvidenceSnapshot): TopologyAiCitation[] {
  return ids.map((id) => {
    const { supports: _supports, ...display } = snapshot.manifest[id]!;
    return display;
  });
}

function finish(findings: TopologyAiFinding[], missingData: string[], nextChecks: TopologyAiNextCheck[], reasons: Set<string>, snapshot: TopologyAiEvidenceSnapshot, status?: TopologyAiExplanation['status']): TopologyAiExplanation {
  const citationIds = [...new Set([...findings.flatMap((f) => f.citationIds), ...nextChecks.flatMap((c) => c.citationIds)])].slice(0, TOPOLOGY_AI_LIMITS.citations);
  return topologyAiExplanationSchema.parse({
    schemaVersion: 1,
    status: status ?? (reasons.size ? 'partial' : 'complete'),
    findings, missingData, nextChecks, citationIds,
    citations: displayCitations(citationIds, snapshot),
    reasons: [...reasons].sort(),
  });
}

/** Validate one complete model answer against its snapshot. Never throws; never returns raw text. */
export function validateTopologyAiExplanation(raw: unknown, snapshot: TopologyAiEvidenceSnapshot): TopologyAiExplanation {
  const parsed = topologyAiModelOutputSchema.safeParse(parseRaw(raw));
  if (!parsed.success) return topologyAiFallbackExplanation();
  const reasons = new Set<string>();
  const known = (ids: string[]) => {
    const unique = [...new Set(ids)];
    const valid = unique.filter((id) => Object.prototype.hasOwnProperty.call(snapshot.manifest, id));
    if (valid.length !== unique.length) reasons.add('unsupported_citation');
    return valid.slice(0, TOPOLOGY_AI_LIMITS.citationsPerFinding);
  };

  const findings: TopologyAiFinding[] = [];
  for (const finding of parsed.data.findings) {
    const text = cleanText(finding.text, TOPOLOGY_AI_LIMITS.findingTextBytes);
    const citationIds = known(finding.citationIds);
    if (!text) { reasons.add('empty_statement'); continue; }
    let kind: TopologyAiFinding['kind'] = finding.kind;
    if (kind === 'finding') {
      if (ALWAYS_HYPOTHESIS.has(finding.claim)) { kind = 'hypothesis'; reasons.add('causal_claim_demoted'); }
      else if (!citationIds.length) { kind = 'hypothesis'; reasons.add('unsupported_citation'); }
      else if (!citationIds.some((id) => snapshot.manifest[id]!.supports.includes(finding.claim))) { kind = 'hypothesis'; reasons.add('claim_not_supported'); }
    }
    findings.push({ kind, claim: finding.claim, text, citationIds });
  }

  const missingData = parsed.data.missingData
    .map((item) => cleanText(item, 300))
    .filter((item): item is string => item !== null)
    .slice(0, TOPOLOGY_AI_LIMITS.missingData);

  const nextChecks: TopologyAiNextCheck[] = [];
  for (const check of parsed.data.nextChecks) {
    const recipe = topologyRecipeIdSchema.safeParse(check.recipeId);
    const rationale = cleanText(check.rationale, TOPOLOGY_AI_LIMITS.findingTextBytes);
    if (!recipe.success) { reasons.add('unknown_recipe'); continue; }
    if (!rationale) { reasons.add('empty_statement'); continue; }
    nextChecks.push({ recipeId: recipe.data, rationale, citationIds: known(check.citationIds) });
  }

  return finish(findings, missingData, nextChecks, reasons, snapshot);
}

type CitationTable = 'topology_nodes' | 'topology_relationships' | 'topology_observations';
const TABLE_BY_RESOURCE: Partial<Record<TopologyAiCitation['resourceType'], CitationTable>> = {
  node: 'topology_nodes', relationship: 'topology_relationships', link_health: 'topology_relationships', observation: 'topology_observations',
};

/**
 * Current authorization of cited evidence: the caller must still read the
 * snapshot's site (fresh permissions), and each node/relationship/observation
 * must still exist in that site. Change-history citations follow site access.
 */
export async function reauthorizeTopologyAiCitations(
  ctx: TopologyRequestContext,
  ids: string[],
  snapshot: TopologyAiEvidenceSnapshot,
): Promise<{ allowed: string[]; unavailable: string[] }> {
  const unique = [...new Set(ids)];
  const deny = () => ({ allowed: [], unavailable: unique });
  if (ctx.scope.orgId !== snapshot.scope.orgId || ctx.scope.siteId !== snapshot.scope.siteId) return deny();
  const permissions = await getUserPermissions(ctx.auth.user.id, {
    partnerId: ctx.auth.partnerId ?? undefined, orgId: ctx.auth.orgId ?? undefined, scope: ctx.auth.scope,
  });
  if (!permissions) return deny();
  try {
    const current = await requireTopologySiteAccess(ctx.auth, permissions, snapshot.scope.siteId, 'read');
    if (current.scope.orgId !== snapshot.scope.orgId || current.scope.siteId !== snapshot.scope.siteId) return deny();
  } catch (error) {
    if (error instanceof TopologyError) return deny();
    throw error;
  }

  const allowed = new Set<string>();
  const byTable = new Map<CitationTable, Map<string, string[]>>();
  for (const id of unique) {
    const record = snapshot.manifest[id];
    if (!record) continue;
    const table = TABLE_BY_RESOURCE[record.resourceType];
    if (!table) { allowed.add(id); continue; }
    const resources = byTable.get(table) ?? new Map<string, string[]>();
    resources.set(record.resourceId, [...(resources.get(record.resourceId) ?? []), id]);
    byTable.set(table, resources);
  }
  for (const [table, resources] of byTable) {
    const resourceIds = [...resources.keys()];
    const live = table === 'topology_observations' ? sql`true` : sql`t.deleted_at IS NULL`;
    const rows = await db.execute<{ id: string }>(sql`SELECT t.id FROM ${sql.identifier(table)} t
      WHERE ${scoped(snapshot.scope, 't')} AND ${live} AND t.id IN (${sql.join(resourceIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    for (const row of rows) for (const citationId of resources.get(row.id) ?? []) allowed.add(citationId);
  }
  return { allowed: unique.filter((id) => allowed.has(id)), unavailable: unique.filter((id) => !allowed.has(id)) };
}

/** Remove statements that depended only on unavailable evidence; never re-add text. */
export function applyTopologyAiCitationAvailability(
  explanation: TopologyAiExplanation,
  availability: { allowed: string[]; unavailable: string[] },
  snapshot: TopologyAiEvidenceSnapshot,
): TopologyAiExplanation {
  if (!availability.unavailable.length) return explanation;
  const allowed = new Set(availability.allowed);
  const reasons = new Set(explanation.reasons);
  reasons.add('citation_unavailable');
  const findings = explanation.findings
    .map((finding) => ({ ...finding, citationIds: finding.citationIds.filter((id) => allowed.has(id)) }))
    .filter((finding, i) => finding.citationIds.length > 0 || explanation.findings[i]!.citationIds.length === 0);
  const nextChecks = explanation.nextChecks.map((check) => ({ ...check, citationIds: check.citationIds.filter((id) => allowed.has(id)) }));
  return finish(findings, explanation.missingData, nextChecks, reasons, snapshot, explanation.status === 'evidence_changed' ? 'evidence_changed' : 'partial');
}
