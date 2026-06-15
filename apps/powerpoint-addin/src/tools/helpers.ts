/**
 * PowerPoint tool plumbing. The host-neutral input validators (`requireString`,
 * `optionalString`, `ToolInputError`) live in the core and are re-exported here
 * so the PowerPoint tool files import them from one local module (mirrors Word).
 * PowerPoint-only helpers (slide caps, the 1.4 capability gate, the optional
 * non-negative integer reader) stay here.
 */
import { ToolInputError, optionalString, requireString } from '@breeze/office-addin-core';

export { ToolInputError, optionalString, requireString };

/** Max slides a read tool hydrates into `cells` before reporting truncation. */
export const OVERVIEW_SLIDE_CAP = 200;

/**
 * The PowerPointApi requirement-set version the write surface (addTextBox, font
 * setters, native slides.add) matured at. `insert_text_box` / `format_selection`
 * gate on it; `add_slide` uses it to choose the native path before OOXML.
 */
export const POWERPOINT_WRITE_API_SET = '1.4';

/**
 * Feature-detect a PowerPointApi requirement set. Reads through `Office.context`,
 * which is absent in a plain browser tab — treat that as "unsupported".
 */
export function isPowerPointApiSupported(version: string): boolean {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  return officeGlobal?.context?.requirements?.isSetSupported('PowerPointApi', version) === true;
}

/**
 * Read an optional non-negative integer wire field (e.g. `slideIndex`). Returns
 * undefined when absent; throws ToolInputError on a non-integer or negative value.
 */
export function optionalNonNegativeInt(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new ToolInputError(`${key} must be a non-negative integer`);
  return value;
}
