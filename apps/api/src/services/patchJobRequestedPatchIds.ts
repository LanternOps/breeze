import { z } from 'zod';

/**
 * `patch_jobs.patches.patchIds` — the list a job that names its patches (the
 * AI tool `manage_patches` action `install`) carries. Same id validation the
 * tool's input schema applies (`z.string().guid()`), so no id the tool
 * accepted is refused.
 *
 * One definition for both ends, so "a job with a valid patch list" means the
 * same thing at dispatch (jobs/patchJobExecutor.ts) and at delivery
 * (services/installPatchesRevalidation.ts, #12493). A leaf module on purpose:
 * unit suites mock the eligibility and schema modules wholesale.
 */
export const requestedPatchIdsSchema = z.array(z.string().guid()).min(1);
