import { oemUpdateRunResultSchema, type OemUpdateRunResult } from '@breeze/shared';

/** The agent's result is JSON text on the envelope's stdout. Anything else is no result. */
export function parseStoredOemResult(stored: unknown): OemUpdateRunResult | null {
  if (!stored || typeof stored !== 'object') return null;
  const { stdout } = stored as { stdout?: unknown };
  if (typeof stdout !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = oemUpdateRunResultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
