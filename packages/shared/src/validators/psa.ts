/**
 * PSA (Professional Services Automation) provider registry — shared grammar.
 *
 * The ONE source of truth for which PSA providers Breeze actually implements
 * (an adapter exists in apps/api/src/services/psa/ and the web UI can offer
 * it). The API route schema, the PSA service layer's provider type, and the
 * web form/list all derive from this list so they can never drift.
 *
 * NOTE: the Postgres `psa_provider` enum is intentionally WIDER than this list
 * (it also contains `halo`, `syncro`, `kaseya`, `other`). Those values predate
 * the route-level zod gate, have no adapter, and cannot be inserted through the
 * API — this list is the gate. Do not add a value here without shipping the
 * corresponding adapter.
 */

import { z } from 'zod';

export const PSA_PROVIDERS = [
  'connectwise',
  'autotask',
  'jira',
  'servicenow',
  'freshservice',
  'zendesk'
] as const;

export const psaProviderIdSchema = z.enum(PSA_PROVIDERS);

export type PsaProviderId = (typeof PSA_PROVIDERS)[number];
