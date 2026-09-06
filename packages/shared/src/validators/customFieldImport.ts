/**
 * Shared ceilings for the RMM custom-field importer (#3257 / #4768).
 *
 * These numbers used to live only in `apps/api/src/services/customFields/import/types.ts`.
 * W09 (#4777) moves them here so the web wizard (`CustomFieldValueImportStep.tsx`)
 * chunks its commit requests against the SAME numbers the API actually enforces,
 * rather than a copy that can drift. The API file re-exports both names
 * unchanged so no existing caller (W07/W08 routes and services) has to change.
 */

/**
 * Ceiling on rows in one import request. Same cap as the org and contact
 * importers (`apps/api/src/services/contacts/types.ts`) and the PSA company
 * importer's `PSA_COMPANY_LIST_CAP` (`./psa.ts`) — one number across every
 * import route so the browser can chunk once and target all of them.
 */
export const MAX_IMPORT_ROWS = 1000;

/**
 * A SEPARATE, lower ceiling on `sum(row.values.length)` for the device
 * custom-field VALUES importer (W08). One device row carries up to 30 values,
 * so 1000 rows x 30 values is 30,000 writes in one request — a cap on rows
 * alone does not bound the work. Rejected at the zod layer with copy telling
 * the browser to split the chunk.
 */
export const MAX_IMPORT_VALUES = 5000;
