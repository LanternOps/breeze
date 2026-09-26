/**
 * Topology AI tool input schemas (M3-D12 reads + M4 Task 1 reads, #6000).
 *
 * Every schema is STRICT: a read tool never accepts an org, a rescan flag, an
 * arbitrary URL/OID or any other field it does not use. `site_id` is required
 * on every tool, and the M4-D1 gate additionally requires it to equal the
 * site the investigation is pinned to. Bounds mirror `topology/aiRead.ts`.
 */
import { z } from 'zod';
import { TOPOLOGY_INTERFACE_METRIC_SERIES } from '@breeze/shared';

// Reusable validators (duplicated locally to avoid circular imports)
const uuid = z.string().guid();
const revision = z.string().regex(/^(0|[1-9]\d{0,19})$/);

export const TOPOLOGY_AI_GRAPH_MAX_NODES = 150;
export const TOPOLOGY_AI_EVIDENCE_MAX_OBSERVATIONS = 100;

export const topologyToolSchemas: Record<string, z.ZodType> = {
  get_topology: z.object({
    site_id: uuid,
    view: z.enum(['overview', 'physical', 'logical']).optional(),
    focus_node_id: uuid.optional(),
    graph_revision: revision.optional(),
    limit: z.number().int().min(1).max(TOPOLOGY_AI_GRAPH_MAX_NODES).optional(),
  }).strict(),
  get_link_evidence: z.object({
    site_id: uuid,
    relationship_id: uuid,
    limit: z.number().int().min(1).max(TOPOLOGY_AI_EVIDENCE_MAX_OBSERVATIONS).optional(),
    cursor: z.string().max(2048).optional(),
  }).strict(),
  get_diagnostic_run: z.object({
    site_id: uuid,
    run_id: uuid,
  }).strict(),
  // M3 Task 6 (M3-D12) — bounded topology port history and link health.
  get_interface_history: z.object({
    site_id: uuid,
    interface_id: uuid,
    series: z.array(z.enum(TOPOLOGY_INTERFACE_METRIC_SERIES)).min(1).max(4),
    from: z.string().datetime(),
    to: z.string().datetime(),
    resolution: z.enum(['auto', 'raw', '5m', '1h']).optional(),
    max_buckets: z.number().int().min(1).max(120).optional(),
  }).strict(),
  get_link_health: z.object({
    site_id: uuid,
    relationship_id: uuid,
  }).strict(),
  get_topology_impact: z.object({
    site_id: uuid,
    subject_kind: z.enum(['node', 'relationship']),
    subject_id: uuid,
    window_minutes: z.number().int().min(1).max(30).optional(),
    graph_revision: revision.optional(),
  }).strict(),
  get_recent_network_changes: z.object({
    site_id: uuid,
    since: z.string().datetime(),
    until: z.string().datetime(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(2048).optional(),
  }).strict(),
  // M3-D12 topology monitoring read tool (one site, bounded response).
  get_topology_monitoring_status: z.object({
    site_id: uuid,
  }).strict(),
};
