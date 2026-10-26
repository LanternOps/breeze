/**
 * `list_fleet_designs` and `get_fleet_design` (full-control W10, #6780): the AI
 * twins of GET /ai/fleet-design and GET /ai/fleet-design/:reportRunId.
 *
 * Tier 1, read-only, agent-reachable for an unrestricted caller. The queries
 * are the routes' own (`listFleetDesigns`, `loadFleetDesignReport` with the
 * caller's org condition). A design enumerates every device function, watch
 * and rule of an organization, so a site- or device-restricted session gets
 * none of it (plan fact 6). The detail returns the counts, the provenance
 * scalars and the design markdown (capped); it does NOT return the stored
 * `summary` the REST detail relays, which carries the full outcome including
 * script bodies. The markdown is model-generated from device-reported data:
 * it is fenced as untrusted text by `RAW_TEXT_FIELDS_BY_TOOL`.
 */
import type { AiTool } from './aiTools';
import { loadFleetDesignReport } from './aiAgents/fleetDesignReport';
import { listFleetDesigns, sectionCounts } from './fleetDesign/listing';
import { bounded, jsonError, notFound, restrictedReadDenied, str, thrown } from './aiToolsAiReadsShared';

/** Characters of design markdown handed to the model; the rest is behind the report download. */
export const FLEET_DESIGN_MARKDOWN_MAX = 60_000;

export function registerFleetDesignReadTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_fleet_designs', {
    tier: 1,
    domain: 'ai',
    searchHint: 'fleet design reports the AI designer produced; device functions, monitoring watches and alert rules designed for an organization',
    deviceArgs: [],
    definition: {
      name: 'list_fleet_designs',
      description:
        'List completed Fleet Design reports (up to 100, newest first) with function, watch and rule counts. Organization-wide: not available to site-restricted sessions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Only this organization UUID' },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const denied = restrictedReadDenied(auth, 'Fleet designs');
      if (denied) return denied;
      try {
        const designs = await listFleetDesigns(auth, str(input.orgId));
        return bounded({ designs, showing: designs.length });
      } catch (error) {
        return thrown('list_fleet_designs', error);
      }
    },
  });

  aiTools.set('get_fleet_design', {
    tier: 1,
    domain: 'ai',
    searchHint: 'one fleet design report: what the AI designer proposed for an organization, as readable markdown',
    deviceArgs: [],
    definition: {
      name: 'get_fleet_design',
      description:
        'One Fleet Design report: counts, when it was generated, and the design as markdown (capped at 60,000 characters). Read-only: applying a design is a separate, approval-gated action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          reportRunId: { type: 'string', description: 'Report run UUID from list_fleet_designs' },
        },
        required: ['reportRunId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const denied = restrictedReadDenied(auth, 'Fleet designs');
      if (denied) return denied;
      const reportRunId = str(input.reportRunId);
      if (!reportRunId) return jsonError('reportRunId is required', 'VALIDATION_ERROR');
      try {
        const row = await loadFleetDesignReport(reportRunId, (col) => auth.orgCondition(col));
        if (!row) return notFound('Fleet design');
        const counts = sectionCounts(row.summary);
        const design = row.summary?.fleetDesign;
        const markdown = design?.outcome?.markdown ?? '';
        return bounded({
          reportRunId: row.reportRunId,
          reportId: row.reportId,
          orgId: row.orgId,
          generatedAt: counts.generatedAt,
          runId: counts.runId,
          agentName: design?.agentName ?? null,
          siteName: design?.siteName ?? null,
          functionCount: counts.functionCount,
          watchCount: counts.watchCount,
          ruleCount: counts.ruleCount,
          evidenceTruncated: counts.evidenceTruncated,
          devicesNotAssessed: design?.devicesNotAssessed ?? 0,
          unavailable: design?.unavailable ?? [],
          markdown: markdown.length > FLEET_DESIGN_MARKDOWN_MAX ? markdown.slice(0, FLEET_DESIGN_MARKDOWN_MAX) : markdown,
          markdownTruncated: markdown.length > FLEET_DESIGN_MARKDOWN_MAX,
          downloadPath: `/api/reports/runs/${row.reportRunId}/download`,
        });
      } catch (error) {
        return thrown('get_fleet_design', error);
      }
    },
  });
}
