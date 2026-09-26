import { Hono, type Context } from 'hono';
import {
  topologyPolicyArmRequestSchema,
  topologyPolicyDisarmRequestSchema,
  topologyTelemetryArmRequestSchema,
} from '@breeze/shared';
import { requireInteractiveSession, requireMfa } from '../../middleware/auth';
import { getUserEpochs } from '../../services/authEpochs';
import {
  consumeStepUpGrant,
  topologyArmResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
} from '../../services/mfaStepUpGrant';
import { armTopologyMonitoringPolicy, disarmTopologyMonitoringPolicy } from '../../services/topology/monitoringArming';
import { TopologyOperationError } from '../../services/topology/operationErrors';
import { armTopologyTelemetry, revokeTopologyTelemetryArm } from '../../services/topology/telemetryArms';
import { ENABLE_2FA } from '../auth/schemas';
import { requireTopologySiteCapability } from './middleware';
import { topologyOperation } from './operations';

/**
 * Human-only arming (M3-D2/D3/D12). Every route here is an interactive user
 * session with a satisfied second factor; arming additionally consumes a fresh
 * `topology_arm` step-up grant bound to the exact site/action/subject. There is
 * deliberately no AI tool or MCP surface for these writes (the spec forbids AI
 * scheduling); the read side is `monitoringStatus.ts`.
 */
export const topologyMonitoringArmRoutes = new Hono();
const base = '/sites/:siteId';
const stepUpRequired = () => new TopologyOperationError('step_up_required', 403, 'A fresh step-up verification is required');

/** Validate now (no write on a missing/stale grant); consume inside the arm transaction. */
async function stepUpConsumer(
  c: Context,
  input: { siteId: string; action: 'arm_policy' | 'arm_telemetry'; subjectId: string },
  grantId: string | undefined,
): Promise<(() => Promise<void>) | undefined> {
  if (!ENABLE_2FA) return undefined;
  const auth = c.get('auth');
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) throw new TopologyOperationError('topology_authority_unavailable', 503);
  const binding: StepUpGrantBinding = {
    userId: auth.user.id,
    operation: 'topology_arm',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest: topologyArmResourceDigest(input),
  };
  if (!grantId || !(await validateStepUpGrant(grantId, binding))) throw stepUpRequired();
  return async () => {
    if (!(await consumeStepUpGrant(grantId, binding))) throw stepUpRequired();
  };
}

topologyMonitoringArmRoutes.post(
  `${base}/policies/:id/arm`,
  requireInteractiveSession(),
  requireMfa(),
  requireTopologySiteCapability('configure'),
  topologyOperation(async (c, body) => {
    const ctx = c.get('topologyContext');
    const request = topologyPolicyArmRequestSchema.parse(body);
    const policyId = c.req.param('id')!;
    const consumeStepUp = await stepUpConsumer(c, { siteId: ctx.scope.siteId, action: 'arm_policy', subjectId: policyId }, request.stepUpGrantId);
    return armTopologyMonitoringPolicy(ctx, policyId, request, { consumeStepUp });
  }, { mutation: true }),
);

topologyMonitoringArmRoutes.post(
  `${base}/policies/:id/disarm`,
  requireInteractiveSession(),
  requireTopologySiteCapability('configure'),
  topologyOperation((c, body) =>
    disarmTopologyMonitoringPolicy(
      c.get('topologyContext'),
      c.req.param('id')!,
      topologyPolicyDisarmRequestSchema.parse(body).expectedRevision,
    ), { mutation: true }),
);

topologyMonitoringArmRoutes.post(
  `${base}/telemetry-arms`,
  requireInteractiveSession(),
  requireMfa(),
  requireTopologySiteCapability('configure'),
  topologyOperation(async (c, body) => {
    const ctx = c.get('topologyContext');
    const request = topologyTelemetryArmRequestSchema.parse(body);
    const consumeStepUp = await stepUpConsumer(c, { siteId: ctx.scope.siteId, action: 'arm_telemetry', subjectId: request.targetNodeId }, request.stepUpGrantId);
    return armTopologyTelemetry(ctx, request, { consumeStepUp });
  }, { mutation: true, status: 201 }),
);

topologyMonitoringArmRoutes.delete(
  `${base}/telemetry-arms/:armId`,
  requireInteractiveSession(),
  requireTopologySiteCapability('configure'),
  topologyOperation((c) => revokeTopologyTelemetryArm(c.get('topologyContext'), c.req.param('armId')!)),
);
