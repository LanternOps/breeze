import { Hono } from 'hono';
import { partnerAssignmentsPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { putPartnerAssignments, touchesSurface } from '../../services/aiModels/assignmentWrites';
import { APPROVALS_DECIDE_REQUIRED, canDecideApprovals, partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelAssignmentRoutes = new Hono();

aiModelAssignmentRoutes.put('/', ...partnerWrite, zValidator('json', partnerAssignmentsPutSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { assignments } = c.req.valid('json');
  // Changing the script reviewer's model is a privileged widening (same rule
  // as the partner script policy): approvals:decide on top of the write gate.
  if (touchesSurface(assignments, 'script_reviewer') && !canDecideApprovals(c)) {
    return c.json(APPROVALS_DECIDE_REQUIRED, 403);
  }
  return registryWrite(c, partnerId, async () => {
    const rows = await putPartnerAssignments({ partnerId, rows: assignments });
    writeRouteAudit(c, {
      orgId: null,
      action: 'ai_models.assignments.updated',
      resourceType: 'partner',
      resourceId: partnerId,
      details: { surfaces: assignments.map((a) => a.surface) },
    });
    return c.json({ assignments: rows.map((r) => ({ surface: r.surface, role: r.role, updatedAt: r.updatedAt.toISOString() })) });
  });
});
