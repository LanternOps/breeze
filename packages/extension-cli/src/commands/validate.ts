/**
 * `breeze-ext validate` — checks an extension source directory's manifest
 * and layout for conformance before packing.
 *
 * Not implemented yet: manifest schema validation, capability checks, and
 * route-namespace collision checks land in a later task.
 */

export interface ValidateOptions {
  /** Path to the extension source directory (contains the manifest). */
  path: string;
  /** Emit machine-readable JSON instead of human-readable text. */
  json?: boolean;
}

export async function runValidate(_options: ValidateOptions): Promise<never> {
  throw new Error('breeze-ext validate: not implemented yet');
}
