import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { captureException } from '../sentry';
import { findLatestArchivedCredentialForAccount } from '../stripeCredentialArchive';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import type { CustomMergeExecutor, MergeTableOutcome } from '../orgMergeCustomExecutors';
import { getPartnerStripeClient, PartnerStripeError } from '../partnerStripe';

export function autopayMergeBlockerCount(loser: string): SQL {
  return sql`SELECT count(*)::int AS n FROM invoice_collection_attempts
    WHERE org_id=${loser}::uuid AND state IN (${sql.join(RESERVING_COLLECTION_ATTEMPT_STATES.map(state => sql`${state}`), sql`, `)})`;
}
const outcome=(moved=0,notes:string[]=[]):MergeTableOutcome=>({moved,dropped:0,notes});
async function update(q:SQL) { return extractRowCount(await db.execute(q)); }

export const autopayMergeExecutors: Readonly<Record<string,CustomMergeExecutor>> = {
  org_autopay_enrollments: async(loser)=>{
    const n=await update(sql`UPDATE org_autopay_enrollments SET status='cancelled',cancel_source='system',cancel_reason='org_merged',cancelled_at=COALESCE(cancelled_at,now()),generation=generation+1 WHERE org_id=${loser}::uuid AND (status<>'cancelled' OR cancel_reason IS DISTINCT FROM 'org_merged')`);
    return outcome(0,n?[`${n} autopay enrollment(s) cancelled and retained with the source organization`]:[]);
  },
  org_payment_methods: async(loser)=>{
    const n=await update(sql`UPDATE org_payment_methods SET status='removed',is_autopay_method=false,removed_at=COALESCE(removed_at,now()),unusable_reason='org_merged' WHERE org_id=${loser}::uuid AND status<>'removed'`);
    return outcome(0,n?[`${n} payment method(s) removed; original-account detach queued after commit`]:[]);
  },
  invoice_autopay_schedules: async(loser,survivor)=>{
    await update(sql`UPDATE invoice_autopay_schedules SET state='cancelled',state_reason='org_merged',next_attempt_at=NULL WHERE org_id=${loser}::uuid AND state IN ('awaiting_notice','scheduled','collecting','retry_scheduled','action_required')`);
    return outcome(await update(sql`UPDATE invoice_autopay_schedules SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid`));
  },
  invoice_collection_attempts: async(loser,survivor)=>{
    return outcome(await update(sql`UPDATE invoice_collection_attempts SET payment_method_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND state NOT IN (${sql.join(RESERVING_COLLECTION_ATTEMPT_STATES.map(state => sql`${state}`), sql`, `)})`));
  },
  billing_notice_outbox: async(loser,survivor)=>{
    await update(sql`UPDATE billing_notice_outbox SET status='cancelled',last_error='org_merged' WHERE org_id=${loser}::uuid AND status IN ('pending','sending','failed')`);
    return outcome(await update(sql`UPDATE billing_notice_outbox SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND invoice_id IS NOT NULL`));
  },
  billing_link_tokens: async(loser,survivor)=>{
    await update(sql`UPDATE billing_link_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE org_id=${loser}::uuid`);
    // Enrollment links stay with their cancelled source authority. Drop their
    // optional invoice reference before the invoice moves to the survivor.
    await update(sql`UPDATE billing_link_tokens SET invoice_id=NULL WHERE org_id=${loser}::uuid AND purpose IN ('enroll','stop_autopay')`);
    return outcome(await update(sql`UPDATE billing_link_tokens SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND invoice_id IS NOT NULL`));
  },
};

// Removed rows are the durable queue. Only org_merged remains pending; a successful
// detach changes its reason to org_merged:detached, leaving the authority removed.
export async function drainAutopayMethodDetaches(): Promise<void> {
  await runOutsideDbContext(async()=>{
    const rows=await withSystemDbAccessContext(()=>db.execute(sql`
      SELECT m.id,m.org_id,m.detach_attempts,m.stripe_payment_method_id,e.partner_id,e.stripe_account_id,e.stripe_customer_id
      FROM org_payment_methods m JOIN org_autopay_enrollments e ON e.id=m.enrollment_id AND e.org_id=m.org_id
      WHERE m.status='removed' AND m.unusable_reason='org_merged' AND m.detach_failed_at IS NULL AND m.detach_next_attempt_at<=now()
      ORDER BY m.detach_next_attempt_at,m.removed_at,m.id LIMIT 100`));
    for (const row of rows as unknown as Array<{id:string;org_id:string;detach_attempts:number;stripe_payment_method_id:string;partner_id:string;stripe_account_id:string;stripe_customer_id:string|null}>) {
      try {
        const client = await withSystemDbAccessContext(async () => {
          let live: Awaited<ReturnType<typeof getPartnerStripeClient>> | null = null;
          try { live = await getPartnerStripeClient(row.partner_id); }
          catch (error) { if (!(error instanceof PartnerStripeError) || error.code !== 'NO_STRIPE_KEY') throw error; }
          if (live?.stripeAccountId === row.stripe_account_id) return live;
          const archived = await findLatestArchivedCredentialForAccount(row.partner_id, row.stripe_account_id);
          if (!archived) throw new Error('original Stripe account credential unavailable');
          const original = await getPartnerStripeClient(row.partner_id, { archivedCredentialId: archived.id, reason: 'autopay_org_merge_detach' });
          if (original.stripeAccountId !== row.stripe_account_id) throw new Error('archived Stripe credential account mismatch');
          return original;
        });
        try {
          const method=await client.stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
          const customer=typeof method.customer==='string'?method.customer:method.customer?.id;
          if(customer && customer!==row.stripe_customer_id) throw new Error('payment method customer changed');
          if(customer) await client.stripe.paymentMethods.detach(row.stripe_payment_method_id);
        } catch (error) {
          if ((error as { code?: string })?.code !== 'resource_missing') throw error;
        }
        await withSystemDbAccessContext(()=>db.execute(sql`UPDATE org_payment_methods SET unusable_reason='org_merged:detached' WHERE id=${row.id}::uuid AND status='removed' AND unusable_reason='org_merged'`));
      } catch(error) {
        const terminal = (row.detach_attempts ?? 0) + 1 >= 8;
        const tags = { service: 'autopayMethodDetach', autopay_method_id: row.id, org_id: row.org_id, autopay_phase: terminal ? 'detach_failed' : 'retry' };
        console.error('[autopay] method detach failed', tags);
        captureException(new Error(`Autopay method detach ${tags.autopay_phase}`), undefined, tags);
        // A persistence failure must not prevent later rows from draining.
        try {
          await withSystemDbAccessContext(()=>db.execute(sql`UPDATE org_payment_methods
            SET detach_attempts=detach_attempts+1,
                detach_failed_at=CASE WHEN detach_attempts+1>=8 THEN now() ELSE NULL END,
                detach_next_attempt_at=now()+LEAST(60*power(2,LEAST(detach_attempts,9)),21600)*interval '1 second'
            WHERE id=${row.id}::uuid AND status='removed' AND unusable_reason='org_merged' AND detach_failed_at IS NULL`));
        } catch (persistError) {
          console.error('[autopay] method detach backoff persistence failed', tags);
          captureException(new Error('Autopay detach backoff persistence failed'), undefined, { ...tags, autopay_phase: 'persistence' });
        }
      }
    }
  });
}
