/**
 * Host-neutral tool-input validation. Model input is untrusted, so every host's
 * tool executors validate through these before touching the Office surface.
 * Excel-only plumbing (`parseAddress`/`resolveSheet`/cell caps) stays in
 * `apps/excel-addin/src/tools/helpers.ts` — these three are the cross-host core.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new ToolInputError(`${key} must be a non-empty string`);
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  return value;
}
