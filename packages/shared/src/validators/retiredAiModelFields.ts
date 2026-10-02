import { z } from 'zod';

/**
 * Request fields retired by the AI model registry cleanup (W08, #7606), per the
 * #6472 policy: a retired meaningful write is REJECTED with an actionable
 * message naming its replacement, never accepted and silently ignored. Each one
 * has a `breaking-changes.json` entry whose removedIn matches this version
 * (pinned by apps/api/src/upgrade/breakingChangesManifest.test.ts).
 */
export const AI_MODEL_FIELDS_RETIRED_IN = '0.122';

export const RETIRED_AI_MODEL_FIELDS = {
  reviewerModel:
    "set the script reviewer's model under Settings → AI Providers & Models → Defaults by feature (PUT /api/v1/ai/models/assignments, feature script_reviewer).",
  allowedModels:
    'set the models AI for Office may use under Settings → AI Providers & Models → Defaults by feature (feature office_chat), or narrow them for one organization with PUT /api/v1/ai/models/orgs/:orgId/assignments.',
  model:
    'send offeringId instead: an enabled model from GET /api/v1/ai/models (the AI agents feature); offeringId null follows the AI agents default.',
} as const;

export type RetiredAiModelField = keyof typeof RETIRED_AI_MODEL_FIELDS;

export function retiredAiModelFieldMessage(field: RetiredAiModelField): string {
  return `${field} was retired in v${AI_MODEL_FIELDS_RETIRED_IN}: ${RETIRED_AI_MODEL_FIELDS[field]}`;
}

/**
 * Declared (so zod's default unknown-key stripping cannot turn it into a silent
 * no-op) and rejected whenever present, with any value including null.
 */
export function retiredAiModelField(field: RetiredAiModelField) {
  return z.never({ error: retiredAiModelFieldMessage(field) }).optional();
}
