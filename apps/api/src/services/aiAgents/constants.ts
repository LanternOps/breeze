import type { AiAgentMode } from '@breeze/shared';

/** Modes the API accepts on write. 'act' is appended in wave 4. The DB CHECK already admits it. */
export const SUPPORTED_AGENT_MODES: readonly AiAgentMode[] = ['off', 'shadow'] as const;

export function isSupportedAgentMode(mode: string): mode is AiAgentMode {
  return (SUPPORTED_AGENT_MODES as readonly string[]).includes(mode);
}
