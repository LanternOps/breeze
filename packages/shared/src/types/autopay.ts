import {z} from 'zod';
export const AUTOPAY_ENROLLMENT_STATUSES = ['requested', 'active', 'paused', 'cancelled'] as const;
export const AUTOPAY_CANCEL_SOURCES = ['client', 'msp', 'system'] as const;
export const AUTOPAY_NEEDS_ATTENTION_REASONS = ['method_unusable', 'stripe_account_changed', 'key_missing_permissions', 'verification_failed'] as const;
export const ACH_MODES = ['ach_preferred', 'ach_only'] as const;
export const AUTOPAY_OFFSET_RULES = ['earlier', 'later'] as const;
export const AUTOPAY_PAYMENT_METHOD_TYPES = ['card', 'us_bank_account'] as const;
export const CARD_FUNDING_TYPES = ['credit', 'debit', 'prepaid', 'unknown'] as const;
export const ACCOUNT_HOLDER_TYPES = ['individual', 'company'] as const;
export const ORG_PAYMENT_METHOD_STATUSES = ['pending_verification', 'active', 'unusable', 'removed'] as const;
export const AUTOPAY_SCHEDULE_STATES = ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'action_required', 'succeeded', 'failed', 'skipped_by_client', 'excluded_by_msp', 'cancelled', 'not_needed'] as const;
export const AUTOPAY_INELIGIBLE_REASONS = ['not_enrolled', 'enrolled_after_issue', 'consent_required', 'method_not_usable', 'over_cap', 'cap_currency_mismatch', 'ach_currency_unsupported', 'excluded_contract', 'excluded_invoice', 'charging_disabled', 'stripe_unavailable', 'above_authorized_cap'] as const;
export const COLLECTION_ATTEMPT_STATES = ['reserved', 'created', 'confirming', 'processing', 'succeeded', 'failed', 'requires_action', 'canceled', 'unapplied'] as const;
export const ACTIVE_COLLECTION_ATTEMPT_STATES = ['reserved', 'created', 'confirming', 'processing'] as const;
export const RESERVING_COLLECTION_ATTEMPT_STATES = ['reserved', 'created', 'confirming', 'processing', 'requires_action'] as const;
export const COLLECTION_FAILURE_CLASSES = ['soft', 'hard', 'auth_required', 'nsf', 'revoked'] as const;
export const COLLECTION_ATTEMPT_INITIATORS = ['scheduler', 'msp_charge_now', 'client_on_session'] as const;
export const BILLING_NOTICE_KINDS = ['autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring', 'autopay_paused', 'autopay_resumed'] as const;
export const BILLING_NOTICE_STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled', 'handler_failed'] as const;
export const BILLING_LINK_PURPOSES = ['enroll', 'skip_invoice', 'stop_autopay', 'confirm_payment'] as const;
export const CONSENT_SOURCES = ['setup_page', 'pay_and_save', 'portal'] as const;

export type AutopayEnrollmentStatus = (typeof AUTOPAY_ENROLLMENT_STATUSES)[number];
export type AutopayCancelSource = (typeof AUTOPAY_CANCEL_SOURCES)[number];
export type AutopayNeedsAttentionReason = (typeof AUTOPAY_NEEDS_ATTENTION_REASONS)[number];
export type AchMode = (typeof ACH_MODES)[number];
export type AutopayOffsetRule = (typeof AUTOPAY_OFFSET_RULES)[number];
export type AutopayPaymentMethodType = (typeof AUTOPAY_PAYMENT_METHOD_TYPES)[number];
export type CardFundingType = (typeof CARD_FUNDING_TYPES)[number];
export type AccountHolderType = (typeof ACCOUNT_HOLDER_TYPES)[number];
export type OrgPaymentMethodStatus = (typeof ORG_PAYMENT_METHOD_STATUSES)[number];
export type AutopayScheduleState = (typeof AUTOPAY_SCHEDULE_STATES)[number];
export type AutopayIneligibleReason = (typeof AUTOPAY_INELIGIBLE_REASONS)[number];
export type CollectionAttemptState = (typeof COLLECTION_ATTEMPT_STATES)[number];
export type ActiveCollectionAttemptState = (typeof ACTIVE_COLLECTION_ATTEMPT_STATES)[number];
export type CollectionFailureClass = (typeof COLLECTION_FAILURE_CLASSES)[number];
export type CollectionAttemptInitiator = (typeof COLLECTION_ATTEMPT_INITIATORS)[number];
export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];
export type BillingNoticeStatus = (typeof BILLING_NOTICE_STATUSES)[number];
export type BillingLinkPurpose = (typeof BILLING_LINK_PURPOSES)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const AUTOPAY_SETUP_SOURCES = CONSENT_SOURCES;
export const AUTOPAY_SETUP_OUTCOMES = ['activated','pending_verification','stale_generation','failed','in_progress','abandoned','unsupported_method'] as const;
export type AutopaySetupSource = (typeof AUTOPAY_SETUP_SOURCES)[number];
export type AutopaySetupOutcome = (typeof AUTOPAY_SETUP_OUTCOMES)[number];
export interface AutopaySetupCompletion { outcome: AutopaySetupOutcome; orgId: string }
/** Branding a client-facing autopay page shows: the MSP's name, logo and billing email. */
export interface AutopayBranding { partnerName: string; logoUrl: string | null; supportEmail: string | null }
export interface AutopaySetupResult extends AutopaySetupCompletion {
 methodLabel: string | null; feeText: string;
 /** Present on the client return: who the client is dealing with. */
 branding?: AutopayBranding;
 /** The enrollment as it stands now, so a superseded return can say whether the client is set up. */
 current?: { status: AutopayEnrollmentStatus; methodLabel: string | null } | null;
}
export interface InvoiceAutopayOffer { eligible: boolean; consentText: string; consentVersion: string; disclosureHash: string }
export type AutopayScheduleTerms=z.infer<typeof autopayScheduleTermsSchema>;
export type AutopayFeeTerms=z.infer<typeof autopayFeeTermsSchema>;
export interface AutopayDisclosure {
 version:string;text:string;hash:string;textHash:string;partnerName:string;scheduleText:string;feeText:string;
 achMode:AchMode|'card_only';scheduleTerms:AutopayScheduleTerms;feeTerms:AutopayFeeTerms;
}
export interface AutopayMethodView {
 type:AutopayPaymentMethodType;cardBrand:string|null;cardFunding:CardFundingType|null;cardLast4:string|null;
 cardExpMonth:number|null;cardExpYear:number|null;bankName:string|null;bankLast4:string|null;status:OrgPaymentMethodStatus;
}
export interface AutopayEnrollmentView {
 status:AutopayEnrollmentStatus;generation:number;effectiveFrom:string|null;needsAttentionReason:AutopayNeedsAttentionReason|null;
 /** Customer pages: who stopped it and when, and when the MSP paused it. */
 cancelSource?:AutopayCancelSource|null;cancelledAt?:string|null;pausedAt?:string|null;
}
export interface AutopayListRow {
 orgId:string;orgName:string;billingContact:{email?:string|null}|null;
 stripeReadiness:{ready:boolean;missing:string[]};status:AutopayEnrollmentStatus|'not_requested'|'needs_attention';
 enrollment:AutopayEnrollmentView|null;method:AutopayMethodView|null;lastCharge:{state:CollectionAttemptState;createdAt:string;principalAmount:string;currency:string}|null;
 awaitingNotice:{count:number;oldestCreatedAt:string;reason:string|null;invoiceId:string}|null;requestNoticeStatus:BillingNoticeStatus|null;
}
export interface AutopayCustomerPage {
 stopOnly?:false;
 orgId:string;orgName:string;partnerName:string;logoUrl:string|null;primaryColor:string|null;contactEmail:string;
 /** The MSP's billing email (the reply-to of every billing notice). */
 supportEmail:string|null;
 scheduleText:string;achMode:AchMode|'card_only';consentVersion:string;consentText:Record<AutopayPaymentMethodType,string>;
 disclosures:Record<AutopayPaymentMethodType,AutopayDisclosure>;
 fees:Record<AutopayPaymentMethodType|'debit',{text:string;feeAmount:string;kind:'none'|'card_percent'|'ach_flat';appliedBps:number|null;reason:string}>;
 enrollment:AutopayEnrollmentView|null;method:AutopayMethodView|null;processingWarning:string;
}
/** Minimal portal read model when enrollment setup is disabled. */
export type AutopayStopOnlyPage = Pick<AutopayCustomerPage,
 'orgId'|'orgName'|'partnerName'|'supportEmail'|'enrollment'|'method'|'processingWarning'> & {stopOnly:true};
export type AutopayPortalPage = AutopayCustomerPage | AutopayStopOnlyPage;
export interface PaymentValues {
 autopayOffsetDays:number|null;autopayOffsetRule:AutopayOffsetRule|null;autopayCapEnabled:boolean|null;
 autopayCapAmount:string|null;autopayCapCurrency:string|null;achMode:AchMode|null;
 cardFeeBps:number|null;achFeeAmount:string|null;
}
export type EffectivePaymentSetting<T>={value:T;source:'org'|'partner'|'default'};
export interface ResolvedPaymentSettings {
 cardFeeBps:EffectivePaymentSetting<number>;achFeeAmount:EffectivePaymentSetting<string>;feeAttested?:boolean;
 remindersEnabled:EffectivePaymentSetting<boolean>;
 reminderBeforeDueDays:EffectivePaymentSetting<number>;
 reminderRepeatDays:EffectivePaymentSetting<number|null>;
 overdueReminderEveryDays:EffectivePaymentSetting<number>;
 autopayOffsetDays:EffectivePaymentSetting<number>;autopayOffsetRule:EffectivePaymentSetting<AutopayOffsetRule>;
 autopayCap:EffectivePaymentSetting<AutopayScheduleTerms['cap']>;achMode:EffectivePaymentSetting<AchMode>;
}
export interface FeeAuthorizationGap {
 orgId:string;orgName:string;methodType:AutopayPaymentMethodType;
 /** Null when no authorization for the current method is on file (distinct from an authorized 0);
  * such a client is listed whatever the configured fee, because collection refuses it. */
 authorizedCardFeeBps:number|null;authorizedAchFeeAmount:string|null;cardFeeBps:number;achFeeAmount:string;
 /** Set when the accepted cap is narrower than the configured one (the MSP raised or removed it):
  * invoices between the two are not charged automatically until the client accepts new terms. */
 capGap?:{authorized:{enabled:true;amount:string;currency:string};configured:{enabled:false}|{enabled:true;amount:string;currency:string}}|null;
}
/** The partner's processing-fee attestation on file. attestedByName is null when the user is no longer readable. */
export interface FeeAttestationRecord { attestedAt:string;attestedByName:string|null }
export interface PaymentSettingsView { feeAuthorizationGaps?:FeeAuthorizationGap[];
 /** Partner view only: null when no attestation is on file. */
 feeAttestation?:FeeAttestationRecord|null;
 autopayEnabled:boolean;values:PaymentValues;inherited:ResolvedPaymentSettings;effective:ResolvedPaymentSettings }

export const autopayScheduleTermsSchema=z.object({offsetDays:z.number().int().min(0).max(60),rule:z.enum(AUTOPAY_OFFSET_RULES),
 cap:z.discriminatedUnion('enabled',[z.object({enabled:z.literal(false)}),z.object({enabled:z.literal(true),amount:z.string(),currency:z.string()})])});
export const autopayFeeTermsSchema=z.object({methodType:z.enum(AUTOPAY_PAYMENT_METHOD_TYPES),cardFeeBps:z.number().int().min(0).max(300),achFeeAmount:z.string(),feeAttested:z.boolean(),currency:z.string()});
export const bankPaymentConsentSchema=z.object({
 invoiceId:z.string().uuid(),orgId:z.string().uuid(),principal:z.string().regex(/^\d+\.\d{2}$/),
 fee:z.string().regex(/^\d+\.\d{2}$/),currency:z.literal('USD'),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type BankPaymentConsent=z.infer<typeof bankPaymentConsentSchema>;
export const autopayConsentSnapshotSchema=z.object({
 version:z.string(),text:z.string(),hash:z.string(),textHash:z.string(),partnerName:z.string(),scheduleText:z.string(),feeText:z.string(),
 achMode:z.enum(['ach_preferred','ach_only','card_only']),scheduleTerms:autopayScheduleTermsSchema,feeTerms:autopayFeeTermsSchema,
 source:z.enum(AUTOPAY_SETUP_SOURCES),contactEmail:z.string(),ip:z.string().nullable(),userAgent:z.string().nullable(),
 invoiceId:z.string().nullable(),checkoutKey:z.string().nullable(),
 bankPayment:bankPaymentConsentSchema.nullish(),
});
export type AutopayConsentSnapshot=z.infer<typeof autopayConsentSnapshotSchema>;
export const AUTOPAY_SNAPSHOT_KEYS={hash:'hash',checkoutKey:'checkoutKey'} as const satisfies Record<string,keyof AutopayConsentSnapshot>;

const collectionTermsSchema = autopayScheduleTermsSchema.extend({
 kind:z.literal('terms'), issuedAt:z.string().datetime({offset:true}),
 methodType:z.enum(AUTOPAY_PAYMENT_METHOD_TYPES),methodId:z.string().min(1),last4:z.string(),methodLabel:z.string(),
 accountHolderType:z.enum(ACCOUNT_HOLDER_TYPES).nullable(),noticeLeadDays:z.union([z.literal(1),z.literal(10)]),
 principal:z.string().regex(/^\d+\.\d{2}$/),currency:z.string().length(3),feeAmount:z.string().regex(/^\d+\.\d{2}$/),
 feeKind:z.enum(['none','card_percent','ach_flat']),cardFeeBps:z.number().int().min(0).max(300),
 achFeeAmount:z.string().regex(/^\d+\.\d{2}$/),chargeDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),noticeSeq:z.number().int().positive(),
});
/** Legacy rows predate the discriminator. Normalize at the read boundary; never
 * interpret the issuance placeholder as permission to collect. */
export const autopayTermsSnapshotSchema=z.preprocess(value=>{
 if(value && typeof value==='object' && !('kind' in value))return {...value,kind:'noticeSeq' in value && value.noticeSeq===0?'placeholder':'terms'};
 return value;
},z.discriminatedUnion('kind',[
 collectionTermsSchema,
 z.object({kind:z.literal('placeholder'),issuedAt:z.string().datetime({offset:true}),noticeSeq:z.literal(0)}).strict(),
]));
export type AutopayTermsSnapshot=z.infer<typeof autopayTermsSnapshotSchema>;
export type AutopayTerms=Omit<z.infer<typeof collectionTermsSchema>,'kind'>;
export function parseAutopayTerms(value:unknown):AutopayTerms {
 const parsed=autopayTermsSnapshotSchema.parse(value);
 if(parsed.kind!=='terms')throw new Error('Schedule has no collection terms');
 return parsed;
}
export const SCHEDULE_CONTROL_MARKERS=['skip','exclude','stop','renotice'] as const;
export type ControlMarker=typeof SCHEDULE_CONTROL_MARKERS[number];
export type PendingControlReason=`control_pending:${ControlMarker}`;

export type CollectionResult =
 | {outcome:'created';attemptId:string;state:Extract<CollectionAttemptState,'reserved'|'created'|'confirming'|'processing'|'succeeded'>;failureClass?:CollectionFailureClass|null;reason?:never}
 | {outcome:'failed'|'canceled'|'requires_action'|'unapplied';attemptId:string;state:CollectionAttemptState;failureClass:CollectionFailureClass|null;reason:string}
 | {outcome:'deferred'|'refused';attemptId:null;reason:string;state?:never;failureClass?:never};
export interface InvoiceAutopayView {
 /** Maximum noticed charge, including fees; collection may lower this amount. */
 chargePreview?: { amount: string; currency: string; methodLabel: string } | null;
 state:AutopayScheduleState|'processing'|'unapplied';reason:string|null;collectOn:string|null;
 noticeSentAt:string|null;excluded:boolean;canExclude:boolean;canChargeNow:boolean;processing:boolean;unapplied:boolean;
}
/** What the public skip page may offer. Only 'ready' offers "Skip this payment";
 * 'paid' and 'not_needed' mean a stale link (paid, closed, void, or not scheduled for
 * automatic payment) that must not offer a skip (D-22). */
/** 'reversed': the automatic payment succeeded, then was refunded or returned, so the invoice is open again. */
export const AUTOPAY_SKIP_VIEW_STATUSES=['ready','skipped','pending','processing','action_required','paid','reversed','not_needed'] as const;
export type AutopaySkipViewStatus=(typeof AUTOPAY_SKIP_VIEW_STATUSES)[number];
/** Why a skip link has nothing to skip (status 'not_needed'), so the page can say so plainly. */
export const AUTOPAY_SKIP_NOT_NEEDED_REASONS=['void','nothing_due','excluded','failed','stopped','paused','replaced','not_included','not_scheduled'] as const;
export type AutopaySkipNotNeededReason=(typeof AUTOPAY_SKIP_NOT_NEEDED_REASONS)[number];
export const bankPaySchema=bankPaymentConsentSchema.omit({invoiceId:true,orgId:true}).extend({
 methodType:z.literal('us_bank_account'),phase:z.enum(['setup','collect']),consentAccepted:z.literal(true),
 setupSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.phase==='collect'&&!value.setupSessionId)ctx.addIssue({code:'custom',path:['setupSessionId'],message:'Setup session required'});
});
export type BankPayInput=z.infer<typeof bankPaySchema>;
export interface BankAutopayOffer {
 available:boolean;principal:string;fee:string;currency:'USD';consentText:string;disclosureHash:string;
 methodStatus:Extract<OrgPaymentMethodStatus,'active'|'pending_verification'>|null;
 /** The saved bank account ("Bank account ending in 6789") when methodStatus is set. */
 methodLabel:string|null;
}
export type InvoicePayResult={url:string;outcome?:never;attemptId?:never;reason?:never}|(CollectionResult&{url?:never});
/** Invoice-page exit from an off-session payment awaiting bank confirmation:
 * the original PaymentIntent is canceled so the client can pay on-session. */
export type AutopayConfirmationRelease={outcome:'released'|'processing'|'paid'|'not_needed'};

/** Why a public autopay link cannot be used. Partner fields only when the token
 * matched a real link (its holder received it by email); never for an unknown token. */
export const AUTOPAY_LINK_FAILURE_CODES=['link_invalid','link_expired','link_replaced','link_used','autopay_not_enabled'] as const;
export type AutopayLinkFailureCode=(typeof AUTOPAY_LINK_FAILURE_CODES)[number];
export interface AutopayLinkFailureDetails extends Partial<AutopayBranding> { enrollmentStatus?:AutopayEnrollmentStatus|null }
/** Error body: details ride under `data` (the portal client's errorData), like QUOTE_SUPERSEDED's branding. */
export interface AutopayLinkFailure { error:string;code:AutopayLinkFailureCode;data?:AutopayLinkFailureDetails }
/** GET /autopay/public/:token/stop */
export interface AutopayStopView extends AutopayBranding {
 orgName:string;processingWarning:string;enrollment:AutopayEnrollmentView|null;method:AutopayMethodView|null;openInvoiceCount:number;
}
/** GET /autopay/public/:token/skip: names the invoice, amount and charge date. */
export interface AutopaySkipView extends AutopayBranding {
 /** What the page may offer; only 'ready' offers "Skip this payment" (see AUTOPAY_SKIP_VIEW_STATUSES). */
 status:AutopaySkipViewStatus;
 /** Set only with status 'not_needed'. */
 reason:AutopaySkipNotNeededReason|null;
 /** The MSP has switched automatic payments off for now; a skip still works (Q4). */
 onHold:boolean;
 state:AutopayScheduleState|'not_needed';collectOn:string|null;control:ControlMarker|null;processing:boolean;
 /** amount: the noticed principal; balance: what the invoice still owes now. */
 invoiceNumber:string|null;invoiceStatus:string;dueDate:string|null;amount:string|null;balance:string;fee:string|null;currency:string;
 methodLabel:string|null;methodType:AutopayPaymentMethodType|null;invoiceUrl:string|null;
}
/** GET /autopay/public/:token/confirm */
export interface AutopayConfirmView extends AutopayBranding {
 state:CollectionAttemptState|'not_needed';amount:string;currency:string;
 /** The invoice now: a canceled confirmation can leave it open with money still due (V-3). */
 invoiceNumber:string|null;invoiceStatus:string;balance:string;methodLabel:string|null;invoiceUrl:string|null;
}

/** The invoice pages' view of this invoice's automatic payment (client wording is the page's job). */
export const CUSTOMER_INVOICE_AUTOPAY_STATES=['awaiting_notice','scheduled','delayed','processing','action_required','retry_scheduled',
 'failed','skipped','not_included','paid_automatically'] as const;
export type CustomerInvoiceAutopayState=(typeof CUSTOMER_INVOICE_AUTOPAY_STATES)[number];
export interface CustomerInvoiceAutopayStatus {
 state:CustomerInvoiceAutopayState;
 /** YYYY-MM-DD: the scheduled charge date, or the next retry's date. */
 chargeDate:string|null;
 /** The noticed principal and maximum fee (collection may lower the fee). */
 amount:string|null;fee:string|null;currency:string;
 methodLabel:string|null;methodType:AutopayPaymentMethodType|null;
 /** delayed: 'method_not_usable' | 'pending_verification' | 'on_hold'; not_included: the ineligible reason. */
 reason:string|null;
 paidAt:string|null;
 /** False while money is reserved for this invoice (the pay routes would refuse). */
 canPayNow:boolean;
}
