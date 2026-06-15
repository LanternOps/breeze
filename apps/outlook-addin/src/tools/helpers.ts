/**
 * Outlook tool plumbing. The host-neutral input validators (`requireString`,
 * `optionalString`, `ToolInputError`) live in the core and are re-exported here
 * so the Outlook tool files import them from one local module (mirrors Word).
 */
import { ToolInputError, optionalString, requireString } from '@breeze/office-addin-core';

export { ToolInputError, optionalString, requireString };
