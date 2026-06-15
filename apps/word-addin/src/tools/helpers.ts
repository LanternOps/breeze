/**
 * Word tool plumbing. The host-neutral input validators (`requireString`,
 * `optionalString`, `ToolInputError`) live in the core and are re-exported here
 * so the Word tool files import them from one local module (mirrors Excel).
 * Word-only constants (paragraph caps) stay here.
 */
import { ToolInputError, optionalString, requireString } from '@breeze/office-addin-core';

export { ToolInputError, optionalString, requireString };

/** Max paragraphs a read tool hydrates into `cells` before reporting truncation. */
export const OVERVIEW_PARAGRAPH_CAP = 200;

/** The five `Word.InsertLocation` values insert_text accepts (wire enum). */
export const INSERT_LOCATIONS = ['Replace', 'Start', 'End', 'Before', 'After'] as const;
export type InsertLocationName = (typeof INSERT_LOCATIONS)[number];
