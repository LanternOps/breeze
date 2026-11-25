// Tool input examples: operator mode (#12421). W02 ships the mode and the
// registration option type only; W03 gives it behaviour (the description suffix).

export type ToolExamplesMode = 'auto' | 'off';

/** `AI_TOOL_EXAMPLES`: `off` only on the literal `off`; anything else (or unset) is `auto`. */
export function toolExamplesMode(env: Record<string, string | undefined> = process.env): ToolExamplesMode {
  return env.AI_TOOL_EXAMPLES === 'off' ? 'off' : 'auto';
}
