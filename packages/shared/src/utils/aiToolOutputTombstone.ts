/**
 * The marker the nightly AI tool output retention job (#8855,
 * `apps/api/src/jobs/aiToolOutputRetention.ts`) writes over a tool output
 * older than the org's retention window. Tool cards render it as "output
 * expired" instead of the JSON. The mobile app mirrors this check
 * (`apps/mobile/.../toolIndicatorLogic.ts`; it has no `@breeze/shared` dependency).
 */
export const AI_TOOL_OUTPUT_SCRUBBED = 'scrubbed' as const;

export interface AiToolOutputTombstone {
  _retention: typeof AI_TOOL_OUTPUT_SCRUBBED;
  /** ISO time of the scrub. */
  at: string;
}

export function isAiToolOutputTombstone(value: unknown): value is AiToolOutputTombstone {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as { _retention?: unknown })._retention === AI_TOOL_OUTPUT_SCRUBBED;
}
