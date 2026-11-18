/**
 * `manage_fleet_findings` (full-control W12, #6782; the #6141 fleet-findings
 * gap): the AI twin of PATCH /fleet-findings/:id — acknowledge, dismiss or
 * reopen one finding. Tier 2: reversible (reopen), tenant-internal, nothing
 * reaches a device. Reads stay with `get_fleet_findings`; `remediate` is not
 * built (W12 plan, "Not built").
 *
 * It calls the route's own `applyFleetFindingLifecycle`, which locks the
 * finding, refuses a caller who cannot see EVERY member device (a finding is
 * one row shared by all of them) and answers 404 when none is visible. The
 * acting user is recorded only when it is a `users` row (W12-D3); the REST
 * twin carries `requireMfa()` (W12-D5).
 */
import type { AiTool } from './aiTools';
import { applyFleetFindingLifecycle } from './fleetFindings/query';
import { mfaGatedToolError } from './aiToolMfaGate';
import { FLEET_FINDING_ACTIONS } from './aiToolSchemasSoftware';
import { auditToolWrite, clip, json, jsonError, notFound, thrown, verifiedUserIdOrNull } from './aiToolsSoftwareShared';

type Action = (typeof FLEET_FINDING_ACTIONS)[number];

export function registerFleetFindingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_fleet_findings', {
    tier: 2,
    domain: 'devices',
    searchHint: 'acknowledge, dismiss or reopen a fleet finding (a pattern seen across devices)',
    definition: {
      name: 'manage_fleet_findings',
      description: 'Actions: acknowledge, dismiss or reopen one fleet finding (ids from get_fleet_findings); dismiss takes optional notes. Applies to every device in the finding.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...FLEET_FINDING_ACTIONS], description: 'The action to perform' },
          findingId: { type: 'string', description: 'Fleet finding UUID' },
          notes: { type: 'string', description: 'Why (dismiss)' },
        },
        required: ['action', 'findingId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!FLEET_FINDING_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError('manage_fleet_findings', action, auth);
      if (mfa) return mfa;
      try {
        const findingId = String(input.findingId);
        const notes = typeof input.notes === 'string' ? input.notes : undefined;
        const result = await applyFleetFindingLifecycle(auth, findingId, action, notes, await verifiedUserIdOrNull(auth));
        if (!result.ok) {
          if (result.status === 404) return notFound('Fleet finding');
          return jsonError(result.error, result.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION_ERROR');
        }
        const finding = result.finding;
        auditToolWrite(auth, {
          orgId: finding.orgId,
          action: `fleet_finding.${action}`,
          resourceType: 'fleet_finding',
          resourceId: finding.id,
          details: { notes: notes ?? null, newStatus: finding.status },
        });
        return json({ id: finding.id, status: finding.status, title: clip(finding.title) });
      } catch (error) {
        return thrown('manage_fleet_findings', error);
      }
    },
  });
}
