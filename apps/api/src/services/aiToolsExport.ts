/**
 * `export_dataset` (spec §5.7) — the bridge between "we have this data" and
 * "the sandbox can compute on it".
 *
 * Every other read tool hands the model a view compacted to 8 000 characters.
 * This one hands it a HANDLE to the complete result, in a shape a script can
 * read. It is what makes an unattended `analysis` run possible at all.
 *
 * captureExempt: the result already IS a handle. Running W01's capture wrapper
 * over it would store a copy of a pointer.
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';
import { sanitizeThrownToolError } from './aiToolErrors';
import { createArtifact } from './artifacts/artifactService';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';
// W01's region accessor (env BREEZE_REGION). The only region source; this
// wave writes no local region resolver of its own — reconciliation R1.
import { breezeRegion } from '../config/env';
import { emitRunProgress } from './aiAgents/runProgress';
import { DATASET_ADAPTERS, EXPORT_DATASETS, type ExportDataset } from './aiToolsExportDatasets';
import {
  buildExportStream, ExportCapError,
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS, EXPORT_DEFAULT_MAX_BYTES,
  type ExportFormat,
} from './aiToolsExportWriter';

export {
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS, EXPORT_DEFAULT_MAX_BYTES,
} from './aiToolsExportWriter';

/** Page size handed to each adapter. 500 is `search_logs`'s own page cap. */
const EXPORT_PAGE_SIZE = 500;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
};

function isExportDataset(value: unknown): value is ExportDataset {
  return typeof value === 'string' && (EXPORT_DATASETS as readonly string[]).includes(value);
}

export function registerExportTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('export_dataset', {
    tier: 1,
    domain: 'admin',
    searchHint: 'dataset file exports: logs, device and software inventory, metrics, vulnerabilities and custom fields',
    captureExempt: true,
    // The central gate runs org+site verifyDeviceAccess on every id here
    // BEFORE this handler is entered. The run-target check below is a second,
    // different question — see ToolExecutionContext.runTargets.
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'export_dataset',
      description:
        "Export a complete dataset as a file handle without read-tool compaction. Datasets: event_logs, agent_logs, device_inventory, software_inventory, metrics, vulnerabilities, custom_fields. Use workspace_stage to stage the handle for analysis.",
      input_schema: {
        type: 'object' as const,
        properties: {
          dataset: { type: 'string', enum: [...EXPORT_DATASETS], description: 'Which dataset to export' },
          format: { type: 'string', enum: ['jsonl', 'csv'], description: 'Output format (default jsonl)' },
          filters: { type: 'object', description: 'Dataset-specific filters, same shape as the corresponding read tool' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to these device UUIDs' },
          siteId: { type: 'string', description: 'Restrict to one site UUID' },
          maxRows: { type: 'number', description: `Row cap (default ${EXPORT_DEFAULT_MAX_ROWS}, max ${EXPORT_HARD_MAX_ROWS})` },
        },
        required: ['dataset'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext, context?: ToolExecutionContext) => {
      // Hoisted above the try so the catch block can log them: a bare stack
      // trace with no org/run/dataset is nearly unusable for correlating a
      // background agent-run failure back to the run/org that hit it.
      let orgId: string | null = null;
      let runId: string | null = null;
      let dataset: ExportDataset | undefined;
      try {
        if (!isExportDataset(input.dataset)) {
          return JSON.stringify({ error: 'unknown_dataset', dataset: input.dataset });
        }
        dataset = input.dataset;
        // The artifact's OWNER org: never `accessibleOrgIds[0]`, an arbitrary
        // org for a multi-org caller (#6667). A run's auth always carries its org.
        const resolvedOrg = resolveWritableToolOrgId(auth);
        if (!resolvedOrg.orgId) {
          return JSON.stringify({ error: resolvedOrg.error ?? 'No organization context available' });
        }
        orgId = resolvedOrg.orgId;

        // Run IDENTITY comes from the PRINCIPAL, not from ToolExecutionContext
        // (reconciliation R4): `buildAgentAuthContext` puts the run id on
        // `principal` (agentAuthContext.ts:78) and the run org on `auth.orgId`
        // (:89), so there is nothing to copy and nothing to drift.
        runId = auth.principal?.kind === 'ai_agent' ? auth.principal.runId : null;

        // Every artifact is OWNED by a run: that ownership is what scopes it,
        // expires it and bills it. A direct chat/MCP call has no run to own one,
        // so it is refused with a typed error instead of being handed an orphan.
        if (!runId) {
          return JSON.stringify({
            error: 'export_requires_run',
            message: 'export_dataset writes a run-owned artifact and can only be called inside an agent run.',
          });
        }

        const deviceIds = Array.isArray(input.deviceIds) ? input.deviceIds as string[] : null;

        // Spec §8 data minimisation. A run's target set is frozen at admission;
        // an export that spans a device outside it is refused even though the
        // agent principal could reach that device org-wide. An ABSENT/EMPTY
        // target list means "no run frame" (direct chat/MCP), not "no devices".
        const runTargets = context?.runTargets;
        if (deviceIds && runTargets && runTargets.length > 0) {
          const allowed = new Set(runTargets);
          const outside = deviceIds.filter((id) => !allowed.has(id));
          if (outside.length > 0) {
            return JSON.stringify({
              error: 'device_outside_run_targets',
              message: 'Those devices are not in this run\'s admitted target set.',
              count: outside.length,
            });
          }
        }

        const format: ExportFormat = input.format === 'csv' ? 'csv' : 'jsonl';
        const maxRows = Math.min(
          Math.max(1, Number(input.maxRows) || EXPORT_DEFAULT_MAX_ROWS),
          EXPORT_HARD_MAX_ROWS,
        );
        // `0` is a meaningful value here (budget fully spent) and must NOT be
        // treated as "no override" — a `&&`/truthiness check would silently
        // fall through to the full default the moment a run's staged-byte
        // budget hits zero, defeating the whole point of the field.
        const maxBytes = context?.stagedBytesRemaining !== undefined
          ? context.stagedBytesRemaining
          : EXPORT_DEFAULT_MAX_BYTES;

        const adapter = DATASET_ADAPTERS[dataset];
        const pager = await adapter.createPager({
          auth,
          orgId,
          filters: (input.filters as Record<string, unknown>) ?? {},
          deviceIds,
          // Read by the inventory adapters only (their generator has no
          // deviceIds filter). Empty ⇒ no frozen set, i.e. no restriction.
          runTargets: runTargets && runTargets.length > 0 ? [...runTargets] : null,
          siteId: typeof input.siteId === 'string' ? input.siteId : null,
          pageSize: EXPORT_PAGE_SIZE,
        });

        const stream = buildExportStream(pager, { format, maxRows, maxBytes, wallMs: EXPORT_WALL_MS });
        // `stream.stats` and `stream.body` reject/error from the SAME source
        // (buildExportStream wires body's 'error' to reject stats). When the
        // byte cap trips, `createArtifact`'s own body consumption throws first
        // and is caught below — but `stream.stats` still settles (rejected) on
        // its own, and nothing else ever awaits it in that path. Attaching a
        // handler now (not consuming the value — `stats` is still read via
        // `await stream.stats` below on the success path) prevents that from
        // surfacing as an unhandled rejection.
        stream.stats.catch(() => {});

        const record = await createArtifact({
          orgId,
          runId,
          kind: 'input_capture',
          name: `${dataset}.${format === 'csv' ? 'csv' : 'jsonl'}`,
          contentType: CONTENT_TYPES[format],
          body: stream.body,
          maxBytes,
          createdByTool: 'export_dataset',
          region: breezeRegion(),
        });

        const stats = await stream.stats;

        await emitRunProgress(
          { orgId, runId },
          'export',
          `Exported ${stats.rows} ${dataset} rows${stats.truncated ? ' (truncated)' : ''}`,
        );

        return JSON.stringify({
          dataset,
          format,
          truncated: stats.truncated,
          artifact: {
            handle: record.id,
            bytes: stats.bytes,
            rows: stats.rows,
            head: stats.head,
            tail: stats.tail,
          },
        });
      } catch (error) {
        if (error instanceof ExportCapError) {
          return JSON.stringify({
            error: error.code,
            message: 'The export exceeded this run\'s artifact byte budget. Narrow the filters or the device set and try again.',
          });
        }
        // sanitizeThrownToolError already logs the raw message/stack plus this
        // context (aiToolErrors.ts) — no need for a second, differently-
        // prefixed console.error here.
        const message = sanitizeThrownToolError('export-dataset', error, { orgId, runId, dataset });
        return JSON.stringify({ error: 'export_failed', message });
      }
    },
  });
}
