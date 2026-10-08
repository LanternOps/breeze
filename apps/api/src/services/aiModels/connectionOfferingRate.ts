/**
 * #7773 (#7766 residual): the rate of the enabled offering of ONE model on ONE
 * connection, for pricing a BYOK usage key the turn never bound (the Agent SDK
 * CLI's own refusal swap).
 *
 * It reads through the AMBIENT `db` and never opens a context of its own, so
 * the settlement transaction can re-verify a row's rate on the connection it
 * already holds (assertInvocationsMatchBinding) — loadOfferingCandidate cannot
 * be used there: it opens a second pooled connection per read. The caller
 * picks the context: settleInvocation's pre-fetch wraps it in a short system
 * context; the settlement calls it inside its own transaction.
 *
 * The rate mirrors the candidate loader (connectionCandidate / gatewayCandidate):
 * the offering's own price (all four rates, else unpriced) wins; an
 * anthropic_byok offering without one takes its linked platform row's standard
 * rate. Standard only: the Agent SDK never confirms fast, so an unbound key is
 * never billed fast. A catalog connection is not read: its usage key is the
 * catalog's provider model id, not an offering's model id, and its rate is the
 * catalog revision's — the caller keeps the bound rate there.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import type { RateSnapshot } from './pricing';
import type { TurnBinding } from './turnBinding';

export type ConnectionOfferingRateMiss = 'no_connection' | 'catalog_connection' | 'no_enabled_offering' | 'unpriced_offering';

export type ConnectionOfferingRate =
  | { rate: RateSnapshot }
  | { rate: null; reason: ConnectionOfferingRateMiss };

export interface ConnectionOfferingRateInput {
  partnerId: string | null;
  connectionId: string | null;
  connectionKind: TurnBinding['connectionKind'];
  model: string;
}

type Num = string | number | null;
interface RateRow {
  price_input_cents_per_m: Num;
  price_output_cents_per_m: Num;
  price_cache_read_cents_per_m: Num;
  price_cache_write_cents_per_m: Num;
  linked_input_cents_per_m: Num;
  linked_output_cents_per_m: Num;
  linked_cache_read_cents_per_m: Num;
  linked_cache_write_cents_per_m: Num;
}

function fourRates(i: Num, o: Num, cr: Num, cw: Num): RateSnapshot['standard'] | null {
  if (i == null || o == null || cr == null || cw == null) return null;
  return {
    inputCentsPerM: Number(i),
    outputCentsPerM: Number(o),
    cacheReadCentsPerM: Number(cr),
    cacheWriteCentsPerM: Number(cw),
  };
}

export async function readConnectionOfferingRate(input: ConnectionOfferingRateInput): Promise<ConnectionOfferingRate> {
  if (!input.partnerId || !input.connectionId) return { rate: null, reason: 'no_connection' };
  if (input.connectionKind === 'catalog') return { rate: null, reason: 'catalog_connection' };
  const result = await db.execute<RateRow & Record<string, unknown>>(sql`
    SELECT o.price_input_cents_per_m, o.price_output_cents_per_m,
           o.price_cache_read_cents_per_m, o.price_cache_write_cents_per_m,
           p.input_cents_per_m AS linked_input_cents_per_m, p.output_cents_per_m AS linked_output_cents_per_m,
           p.cache_read_cents_per_m AS linked_cache_read_cents_per_m, p.cache_write_cents_per_m AS linked_cache_write_cents_per_m
    FROM partner_ai_models o
    LEFT JOIN ai_platform_models p ON p.id = o.platform_model_id
    WHERE o.partner_id = ${input.partnerId}::uuid
      AND o.connection_id = ${input.connectionId}::uuid
      AND o.model_id = ${input.model}
      AND o.enabled
    LIMIT 1
  `);
  const value = (result as { rows?: RateRow[] }).rows ?? result;
  const row = Array.isArray(value) ? (value[0] as RateRow | undefined) : undefined;
  if (!row) return { rate: null, reason: 'no_enabled_offering' };
  const own = fourRates(
    row.price_input_cents_per_m, row.price_output_cents_per_m,
    row.price_cache_read_cents_per_m, row.price_cache_write_cents_per_m,
  );
  if (own) return { rate: { source: 'offering', standard: own } };
  if (input.connectionKind === 'anthropic_byok') {
    const linked = fourRates(
      row.linked_input_cents_per_m, row.linked_output_cents_per_m,
      row.linked_cache_read_cents_per_m, row.linked_cache_write_cents_per_m,
    );
    if (linked) return { rate: { source: 'linked_platform', standard: linked } };
  }
  return { rate: null, reason: 'unpriced_offering' };
}
