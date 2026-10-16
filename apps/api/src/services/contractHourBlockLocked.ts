import { ZodError } from 'zod';

export const HOUR_BLOCK_STAMPED_KEYS = ['hourBlockFirstPeriodStart', 'hourBlockRetiredAt'] as const;

/** The server-stamped block columns a PATCH named and the strict update schema refused. */
export function stampedKeysFromZod(error: { issues: ReadonlyArray<{ code?: string; keys?: readonly string[] }> }): string[] {
  const out = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    for (const k of issue.keys ?? []) if ((HOUR_BLOCK_STAMPED_KEYS as readonly string[]).includes(k)) out.add(k);
  }
  return [...out];
}

/** 400 body for HOUR_BLOCK_FIELD_LOCKED, or null when the failure is not about a stamped key. */
export function stampedKeysErrorBody(err: unknown): { error: string; code: 'HOUR_BLOCK_FIELD_LOCKED'; details: { fields: string[] } } | null {
  if (!(err instanceof ZodError)) return null;
  const fields = stampedKeysFromZod(err);
  if (fields.length === 0) return null;
  return { error: `These fields are set by the server and cannot be changed: ${fields.join(', ')}`, code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields } };
}

/** zValidator hook (third argument) for the line PATCH routes: only the stamped-key failure is mapped; every
 *  other validation failure falls through to the shared readable 400. */
export function hourBlockStampedKeyHook(
  result: { success: boolean; error?: unknown },
  c: { json: (body: unknown, status: 400) => Response },
): Response | undefined {
  if (result.success) return undefined;
  const body = stampedKeysErrorBody(result.error);
  return body ? c.json(body, 400) : undefined;
}
