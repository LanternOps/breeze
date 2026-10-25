/**
 * W19 (#10065) `AI_TOOL_INDEX`: `lazy` (default) ships the always-on domain
 * index plus page-context blocks; `full` is the kill switch and ships the
 * whole legacy index byte for byte. Read at prompt-build time, never at
 * module load. Anything else reads as `lazy`. Dependency-free so scripts can
 * report the mode without loading the tool registry.
 */
export type ToolIndexMode = 'lazy' | 'full';

export function resolveToolIndexMode(env: Readonly<Record<string, string | undefined>> = process.env): ToolIndexMode {
  return env.AI_TOOL_INDEX?.trim().toLowerCase() === 'full' ? 'full' : 'lazy';
}
