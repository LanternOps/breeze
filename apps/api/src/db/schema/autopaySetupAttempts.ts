import {AUTOPAY_SETUP_SOURCES,AUTOPAY_SETUP_OUTCOMES,AUTOPAY_PAYMENT_METHOD_TYPES} from '@breeze/shared';
import { pgTable,uuid,text,integer,bigserial,jsonb,timestamp,uniqueIndex,index,foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations,partners } from './orgs';
import { orgAutopayEnrollments } from './autopay';
export const autopaySetupAttempts=pgTable('autopay_setup_attempts',{
 id:uuid('id').primaryKey().defaultRandom(),ordinal:bigserial('ordinal',{mode:'number'}).notNull().unique(),
 orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
 partnerId:uuid('partner_id').notNull().references(()=>partners.id,{onDelete:'cascade'}),
 enrollmentId:uuid('enrollment_id').notNull(),generation:integer('generation').notNull(),
 tokenId:uuid('token_id'),source:text('source',{enum:AUTOPAY_SETUP_SOURCES}).notNull(),methodType:text('method_type',{enum:AUTOPAY_PAYMENT_METHOD_TYPES}).notNull(),
 stripeConnectionId:uuid('stripe_connection_id').notNull(),stripeAccountId:text('stripe_account_id').notNull(),
 stripeCustomerId:text('stripe_customer_id'),checkoutSessionId:text('checkout_session_id'),
 setupIntentId:text('setup_intent_id'),paymentIntentId:text('payment_intent_id'),
 consentSnapshot:jsonb('consent_snapshot').notNull(),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
 captureAttemptCount:integer('capture_attempt_count').notNull().default(0),
 captureNextAttemptAt:timestamp('capture_next_attempt_at',{withTimezone:true}).notNull().defaultNow(),
 discoveryNextAttemptAt:timestamp('discovery_next_attempt_at',{withTimezone:true}).notNull().defaultNow(),
 completedAt:timestamp('completed_at',{withTimezone:true}),outcome:text('outcome',{enum:AUTOPAY_SETUP_OUTCOMES})
},t=>[
 uniqueIndex('autopay_setup_attempts_checkout_uq').on(t.stripeAccountId,t.checkoutSessionId),
 uniqueIndex('autopay_setup_attempts_setup_intent_uq').on(t.stripeAccountId,t.setupIntentId),
 index('autopay_setup_attempts_capture_due_idx').on(t.captureNextAttemptAt,t.id).where(sql`${t.completedAt} IS NULL AND ${t.source} = 'pay_and_save' AND ${t.checkoutSessionId} IS NOT NULL`),
 index('autopay_setup_attempts_discovery_due_idx').on(t.discoveryNextAttemptAt,t.createdAt,t.id).where(sql`${t.completedAt} IS NULL`),
 index('autopay_setup_attempts_unfinished_idx').on(t.createdAt).where(sql`${t.completedAt} IS NULL`),
 foreignKey({name:'autopay_setup_attempts_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],
   foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}).onDelete('cascade'),
 foreignKey({name:'autopay_setup_attempts_org_partner_fk',columns:[t.orgId,t.partnerId],
   foreignColumns:[organizations.id,organizations.partnerId]}).onDelete('cascade')
]);
