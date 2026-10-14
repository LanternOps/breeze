/**
 * The AI Operator's own tool surface. Today it holds exactly one entry.
 *
 * `operator_plan` is the carrier for a plan approval (Recipe Library spec
 * §6.4). It performs no external effect: releasing it marks
 * `ai_operator_plan_approvals.state = 'approved'`, stamps the approver, and
 * wakes the task, which then dispatches each approved effect as its own child
 * intent. It is registered as a REAL tool because registration is what buys
 * tier 3, the four-eyes classification, the RBAC gate, the effect-digest pin,
 * the approval card, the mobile takeover and the durable release worker —
 * every one of which this primitive would otherwise have to reimplement, and
 * a reimplementation is where a four-eyes bypass would hide (spec §11).
 */
import type { AiTool } from './aiTools';
import { markPlanApproved } from './aiOperator/planApproval';

/**
 * Immutable arguments of a plan intent (spec §6.4). Deliberately small: the
 * effect ROWS are the authority (D-E4-3); these arguments are the seal plus
 * what the approver reads on the card.
 */
export interface OperatorPlanEffectArgument {
  ordinal: number;
  provider: 'breeze' | 'm365' | 'google';
  toolName: string;
  targetLabel: string;
  principalLabel: string | null;
  rendering: string;
}

export interface OperatorPlanArguments {
  taskId: string;
  planRevision: number;
  effectSetDigest: string;
  effects: OperatorPlanEffectArgument[];
  reason?: string;
}

/**
 * The approver is NOT `auth`: the release runs as the requester. The handler
 * therefore takes only the releasing intent id from `context` and lets
 * `markPlanApproved` read the approver off the intent row's decision columns.
 * Reached any other way (chat, MCP, script builder) there is no intent id, so
 * it refuses.
 */
export async function operatorPlanHandler(
  _input: Record<string, unknown>,
  auth: { orgId?: string | null },
  context?: { actionIntentId?: string },
): Promise<string> {
  const intentId = context?.actionIntentId;
  if (!intentId) {
    return JSON.stringify({ error: 'operator_plan runs only as the release of its own approved intent' });
  }
  if (!auth.orgId) {
    return JSON.stringify({ error: 'operator_plan requires an organization context' });
  }
  const result = await markPlanApproved({ orgId: auth.orgId, intentId });
  if (!result.ok) return JSON.stringify({ error: `${result.reason}: ${result.detail}` });
  return `Plan revision ${result.planRevision} approved for task ${result.taskId}; `
    + `${result.effectCount} effect(s) will be dispatched in order.`;
}

export function registerAiOperatorTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('operator_plan', {
    tier: 3,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'AI Operator plan approval: one four-eyes decision over an ordered set of provider effects',
    definition: {
      name: 'operator_plan',
      description: 'Approval carrier for an AI Operator plan. Raised only by the operator coordinator; executes nothing itself and marks the approved plan so each effect can be dispatched in order.',
      input_schema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'The AI Operator task UUID' },
          planRevision: { type: 'integer', minimum: 0, description: 'Plan revision this approval seals' },
          effectSetDigest: { type: 'string', minLength: 64, maxLength: 64, description: 'SHA-256 of the canonical effect set' },
          effects: {
            type: 'array',
            maxItems: 64,
            description: 'Frozen human-readable rendering of each effect, in dispatch order',
            items: {
              type: 'object',
              properties: {
                ordinal: { type: 'integer', minimum: 0 },
                provider: { type: 'string', enum: ['breeze', 'm365', 'google'] },
                toolName: { type: 'string', maxLength: 100 },
                targetLabel: { type: 'string', maxLength: 200 },
                principalLabel: { type: ['string', 'null'], maxLength: 320 },
                rendering: { type: 'string', maxLength: 500 },
              },
              required: ['ordinal', 'provider', 'toolName', 'targetLabel', 'rendering'],
            },
          },
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['taskId', 'planRevision', 'effectSetDigest', 'effects'],
      },
    },
    handler: operatorPlanHandler,
  });
}
