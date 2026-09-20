import { Hono } from 'hono';

import {
  createTopologyDiagnosticSchema,
  topologyCollectorsQuerySchema,
  topologyCollectorsResponseSchema,
  type CreateTopologyDiagnosticRequest,
} from '@breeze/shared';

import { TopologyOperationError } from '../../services/topology/operationErrors';
import {
  cancelTopologyDiagnosticRun,
  createTopologyDiagnosticRun,
  getTopologyDiagnosticRun,
} from '../../services/topology/diagnosticRuns';
import { selectTopologyOrigins } from '../../services/topology/originEligibility';
import { requireTopologySiteCapability } from './middleware';
import { topologyOperation } from './operations';

export const topologyDiagnosticRoutes = new Hono();

const base = '/sites/:siteId';
const MAX_IDEMPOTENCY_KEY_BYTES = 255;

/** The collectors query is the same request the planner takes, minus its key. */
function collectorRequest(query: Record<string, string>): CreateTopologyDiagnosticRequest {
  const parsed = topologyCollectorsQuerySchema.parse(query);
  return createTopologyDiagnosticSchema.parse({
    recipeId: parsed.recipe,
    recipeVersion: 1,
    subject: { kind: parsed.subjectKind, id: parsed.subjectId },
    graphRevision: parsed.graphRevision,
    ...(parsed.contextKey === undefined ? {} : { contextKey: parsed.contextKey }),
    ...(parsed.family === undefined ? {} : { family: parsed.family }),
  });
}

function idempotencyKey(header: string | undefined): string {
  if (!header || Buffer.byteLength(header, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new TopologyOperationError(
      'idempotency_key_required',
      400,
      'A non-empty Idempotency-Key header of at most 255 bytes is required',
    );
  }
  return header;
}

topologyDiagnosticRoutes.get(
  `${base}/collectors`,
  requireTopologySiteCapability('read'),
  // The response is validated against the contract it advertises, so a page
  // that outgrew the promised ceiling is a server error, never a silent
  // over-sized body.
  topologyOperation(async (c) =>
    topologyCollectorsResponseSchema.parse({
      items: await selectTopologyOrigins(
        c.get('topologyContext'),
        collectorRequest(c.req.query()),
      ),
      nextCursor: null,
    }),
  ),
);

topologyDiagnosticRoutes.post(
  `${base}/diagnostic-runs`,
  requireTopologySiteCapability('execute'),
  topologyOperation(
    (c, body) =>
      createTopologyDiagnosticRun(
        c.get('topologyContext'),
        createTopologyDiagnosticSchema.parse(body),
        idempotencyKey(c.req.header('Idempotency-Key')),
      ),
    { mutation: true, status: 202 },
  ),
);

topologyDiagnosticRoutes.get(
  `${base}/diagnostic-runs/:runId`,
  requireTopologySiteCapability('read'),
  topologyOperation(async (c) => {
    const run = await getTopologyDiagnosticRun(c.get('topologyContext'), c.req.param('runId')!);
    // An inaccessible id is indistinguishable from an unknown one.
    if (!run) throw new TopologyOperationError('diagnostic_run_not_found', 404, 'Diagnostic run not found');
    return run;
  }),
);

// Deliberately not a `mutation` handler: the stop request carries no body, and
// the shared mutation reader requires one.
topologyDiagnosticRoutes.post(
  `${base}/diagnostic-runs/:runId/cancel`,
  requireTopologySiteCapability('execute'),
  topologyOperation((c) =>
    cancelTopologyDiagnosticRun(c.get('topologyContext'), c.req.param('runId')!),
  ),
);
