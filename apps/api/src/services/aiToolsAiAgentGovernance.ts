/**
 * AI Agent GOVERNANCE tools (P2-5, #4192).
 *
 * Deliberately NOT named `aiToolsAgentMgmt.ts` — that module is ENDPOINT-agent
 * management (`query_agent_versions` / `trigger_agent_upgrade` /
 * `trigger_agent_restart`, i.e. the Go agent running on a device). This module
 * governs the AUTONOMOUS AI agents: today, granting one a pre-authorized
 * ("supervised") action key at the ORGANIZATION level.
 *
 * `manage_ai_agents` is Tier 3 / four_eyes and HUMAN-ONLY:
 *
 *  - four_eyes because the grant is an authority change, not a device action:
 *    it converts "this agent must ask a human for `<opKey>`" into "this agent
 *    may run `<opKey>` unattended for this org, from now on". Reviewing that
 *    and authorising it are separate responsibilities, so it is registered in
 *    BOTH `TIER3_FOUR_EYES_ACTIONS` and the whole-tool `TIER3_FOUR_EYES_TOOLS`
 *    fail-safe — a future action of this tool defaults to four_eyes rather
 *    than silently landing on the weaker `supervised` scope.
 *  - human-only because an agent that could call it would be able to grant
 *    ITSELF new unattended authority. `checkAgentGuardrails` denies the
 *    `ai_agent` principal outright (see `aiGuardrails.ts`).
 *
 * `orgId` IS an argument, and it is an ADDRESS rather than an authority.
 * It exists for exactly one reason: the effect-digest resolver
 * (`actionIntents/effectDigest.ts`) receives `(args, database)` and nothing
 * else, and both release paths recompute the digest inside
 * `withSystemDbAccessContext`, which carries no ambient org — so without the
 * argument the grant's authority set could not be pinned at all, and an
 * approver would be signing off on a key list free to move underneath them.
 *
 * It is never trusted:
 *
 *  - the creation route sets it from the AUTHENTICATED org, and creation
 *    rejects `args.orgId !== intent.orgId` (Task 15) — so it can only ever
 *    name the org the intent is already tenanted to;
 *  - the executor re-asserts the same equality under the graduation advisory
 *    lock before it writes anything, so a row edited between creation and
 *    release cannot redirect the grant;
 *  - the agent itself is still resolved server-side from (org, kind) — never
 *    named by the model — and `manage_ai_agents` is denied to the `ai_agent`
 *    principal outright, so a model cannot reach this tool at all.
 */

import { AI_AGENT_KINDS } from '@breeze/shared';

import type { AiTool, AiToolTier } from './aiTools';

export function registerAiAgentGovernanceTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ai_agents', {
    tier: 3 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_ai_agents',
      description:
        'Govern the autonomous AI agents for the current organization. Action: authorize_supervised_key — grant the ' +
        'organization\'s agent of the given kind a pre-authorized action key (`opKey`, e.g. "manage_services:restart") ' +
        'so future runs may execute it without raising an approval. The key must already be inside the partner ' +
        'baseline ceiling and the agent must have earned it on recent evidence. Requires a SECOND approver (four-eyes) ' +
        'and is never available to an AI agent itself. `orgId` must be the CURRENT organization — a request naming any ' +
        'other organization is rejected outright, both when the approval is raised and again before it executes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['authorize_supervised_key'],
          },
          kind: {
            type: 'string',
            enum: [...AI_AGENT_KINDS],
            description: 'Which agent to grant the key to (triage, patch, helpdesk)',
          },
          opKey: {
            type: 'string',
            description: 'The tool:action key to pre-authorize, e.g. "manage_services:restart"',
          },
          orgId: {
            type: 'string',
            description:
              'The CURRENT organization\'s id. Not a target selector — it must equal the organization the request is ' +
              'already authenticated for, and any other value is rejected. It is required because the approval pins ' +
              'that organization\'s authorized-key list, so a change during the approval window fails the release.',
          },
        },
        required: ['action', 'kind', 'opKey', 'orgId'],
      },
    },
    // Task 15 (#4192) supplies the body: `authorizeSupervisedKey` in
    // services/aiAgents/supervisedKeyGrant.ts, called with the org from the
    // executing auth context. Landing in the same PR as this registration.
    handler: async () => {
      throw new Error('manage_ai_agents:authorize_supervised_key is not implemented yet');
    },
  });
}
