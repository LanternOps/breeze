/**
 * `breeze-ext pack` — writes a deterministic `.breeze-ext` ZIP bundle (with
 * integrity inventory) from an extension source directory.
 *
 * Not implemented yet: the deterministic ZIP writer and integrity inventory
 * land in later tasks (Task 2 and Task 3 of this plan).
 */

export interface PackOptions {
  /** Path to the extension source directory (contains the manifest). */
  path: string;
  /** Output path for the produced `.breeze-ext` bundle. */
  out: string;
}

export async function runPack(_options: PackOptions): Promise<never> {
  throw new Error('breeze-ext pack: not implemented yet');
}
