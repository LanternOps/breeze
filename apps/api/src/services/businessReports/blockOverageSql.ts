import { sql, type SQL } from 'drizzle-orm';

/** A void → reissue chain longer than this is not followed (the same cap as
 *  `MAX_REISSUE_HOPS` in contractBilledFinalTerm.ts: up to ten invoices). */
const MAX_CHAIN_INVOICES = 10;

/**
 * Hour-block overage lines in SQL (#9828 W1; shared with W3's profitability
 * mix). `closeHourBlockPeriods` bills a block's overage hours through
 * `addContractLine`, so the line is `source_type = 'contract'` with a NULL
 * cost — usage for an earlier period, not recurring revenue. Nothing on the
 * line says so; it is identified only by its `contract_hour_periods` row.
 *
 * Returns the CTE definitions — not the `WITH` keyword. The chain CTE is
 * recursive, so the caller writes `WITH RECURSIVE ${blockOverageLineIdsCte(…)}`
 * (adding its own CTEs after a comma if it has any) and then anti-joins
 * `il.id NOT IN (SELECT line_id FROM block_overage_lines)` or uses the set in a
 * category `CASE`.
 *
 * `invoiceIds` is a SQL expression yielding the invoice ids to inspect (a
 * scoped sub-SELECT — it must carry the caller's tenancy predicate).
 *
 * The rule is the consume-once rule of `loadBilledFinalTermValues`
 * (contractBilledFinalTerm.ts): a top-level contract line matches a closed
 * hour period on (contract, contract line, hours = quantity, rate =
 * unit_price) whose `overage_invoice_id` is the line's invoice or one of its
 * void → reissue PREDECESSORS (a reissue copies the line; the hour period
 * still points at the voided original). Each closed hour period billed at most
 * ONE overage line, so per match key only the first `n` candidate lines are
 * overage, where `n` is the number of matching hour periods. A plain EXISTS
 * would also drop a coincidentally identical second line, which the TS keeps.
 */
export function blockOverageLineIdsCte(args: { invoiceIds: SQL }): SQL {
  return sql`block_overage_chain(invoice_id, ancestor_id, org_id, depth) AS (
      SELECT inv.id, inv.id, inv.org_id, 1
      FROM invoices inv
      WHERE inv.id IN (${args.invoiceIds})
      UNION ALL
      SELECT ch.invoice_id, prev.id, ch.org_id, ch.depth + 1
      FROM block_overage_chain ch
      JOIN invoices prev ON prev.replaced_by_invoice_id = ch.ancestor_id AND prev.org_id = ch.org_id
      WHERE ch.depth < ${MAX_CHAIN_INVOICES}
    ),
    block_overage_candidates AS (
      SELECT il.id AS line_id, il.invoice_id, il.source_contract_id, il.source_id, il.quantity, il.unit_price,
        ROW_NUMBER() OVER (
          PARTITION BY il.invoice_id, il.source_contract_id, il.source_id, il.quantity, il.unit_price
          ORDER BY il.id
        ) AS rn
      FROM invoice_lines il
      WHERE il.invoice_id IN (${args.invoiceIds})
        AND il.parent_line_id IS NULL
        AND il.source_type = 'contract'
        AND il.source_contract_id IS NOT NULL
        AND il.source_id IS NOT NULL
    ),
    block_overage_lines(line_id) AS (
      SELECT c.line_id
      FROM block_overage_candidates c
      WHERE c.rn <= (
        SELECT COUNT(DISTINCT h.id)
        FROM contract_hour_periods h
        JOIN block_overage_chain ch ON ch.ancestor_id = h.overage_invoice_id AND ch.invoice_id = c.invoice_id
        WHERE h.contract_id = c.source_contract_id
          AND h.contract_line_id = c.source_id
          AND h.overage_hours = c.quantity
          AND h.overage_unit_price = c.unit_price
      )
    )`;
}
