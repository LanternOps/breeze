/**
 * Cold-open chip prompts for the chat Home tab.
 *
 * Lives in its own pure `.ts` module (not inside ColdOpenChips.tsx) so the
 * wording is unit-testable: the mobile Vitest config deliberately includes only
 * `src/**\/*.test.ts`, never `.tsx`, so a suite never pulls React Native / Expo
 * modules into the runner.
 *
 * #5362: a chip must not be worded as a near-verbatim AI tool name. "Show fleet
 * status" name-matched the `get_fleet_status` tool (the deployment-invite
 * funnel, since renamed to `get_invite_funnel`), so the model answered "your
 * fleet is empty" from invite-funnel zeros on a 51-device tenant — directly
 * under the app's own "36 online · 15 offline" strip. Chips should read as a
 * user's question, not as a tool identifier.
 */
export const COLD_OPEN_SUGGESTIONS = [
  'What broke last night?',
  'How is the fleet doing right now?',
  'What ran via MCP today?',
] as const;

export type ColdOpenSuggestion = (typeof COLD_OPEN_SUGGESTIONS)[number];
