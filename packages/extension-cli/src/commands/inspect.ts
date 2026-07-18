/**
 * `breeze-ext inspect` — prints a `.breeze-ext` bundle's manifest,
 * integrity inventory, and signature status without installing it.
 *
 * Not implemented yet: bundle inspection lands in Task 7 of this plan.
 */

export interface InspectOptions {
  /** Path to the `.breeze-ext` bundle to inspect. */
  bundle: string;
  /** Emit machine-readable JSON instead of human-readable text. */
  json?: boolean;
}

export async function runInspect(_options: InspectOptions): Promise<never> {
  throw new Error('breeze-ext inspect: not implemented yet');
}
