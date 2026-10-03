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
export const AUTOPAY_INELIGIBLE_REASONS = ['not_enrolled', 'enrolled_after_issue', 'method_not_usable', 'over_cap', 'cap_currency_mismatch', 'ach_currency_unsupported', 'excluded_contract', 'excluded_invoice', 'charging_disabled', 'stripe_unavailable'] as const;
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
export const AUTOPAY_SETUP_OUTCOMES = ['activated','pending_verification','stale_generation','failed','in_progress','abandoned'] as const;
export type AutopaySetupSource = (typeof AUTOPAY_SETUP_SOURCES)[number];
export type AutopaySetupOutcome = (typeof AUTOPAY_SETUP_OUTCOMES)[number];
export interface AutopaySetupCompletion { outcome: AutopaySetupOutcome; orgId: string }
export interface AutopaySetupResult extends AutopaySetupCompletion { methodLabel: string | null; feeText: string }
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
export interface AutopayEnrollmentView { status:AutopayEnrollmentStatus;generation:number;effectiveFrom:string|null;needsAttentionReason:AutopayNeedsAttentionReason|null }
export interface AutopayListRow {
 orgId:string;orgName:string;billingContact:{email?:string|null}|null;
 stripeReadiness:{ready:boolean;missing:string[]};status:AutopayEnrollmentStatus|'not_requested'|'needs_attention';
 enrollment:AutopayEnrollmentView|null;method:AutopayMethodView|null;lastCharge:{state:CollectionAttemptState;createdAt:string;principalAmount:string;currency:string}|null;
 awaitingNotice:{count:number;oldestCreatedAt:string;reason:string|null;invoiceId:string}|null;requestNoticeStatus:BillingNoticeStatus|null;
}
export interface AutopayCustomerPage {
 stopOnly?:false;
 orgId:string;orgName:string;partnerName:string;logoUrl:string|null;primaryColor:string|null;contactEmail:string;
 scheduleText:string;achMode:AchMode|'card_only';consentVersion:string;consentText:Record<AutopayPaymentMethodType,string>;
 disclosures:Record<AutopayPaymentMethodType,AutopayDisclosure>;
 fees:Record<AutopayPaymentMethodType|'debit',{text:string;feeAmount:string;kind:'none'|'card_percent'|'ach_flat';appliedBps:number|null;reason:string}>;
 enrollment:AutopayEnrollmentView|null;method:AutopayMethodView|null;processingWarning:string;
}
/** Minimal portal read model when enrollment setup is disabled. */
export type AutopayStopOnlyPage = Pick<AutopayCustomerPage,
 'orgId'|'orgName'|'partnerName'|'enrollment'|'method'|'processingWarning'> & {stopOnly:true};
export type AutopayPortalPage = AutopayCustomerPage | AutopayStopOnlyPage;
export interface PaymentValues {
 autopayOffsetDays:number|null;autopayOffsetRule:AutopayOffsetRule|null;autopayCapEnabled:boolean|null;
 autopayCapAmount:string|null;autopayCapCurrency:string|null;achMode:AchMode|null;
}
export type EffectivePaymentSetting<T>={value:T;source:'org'|'partner'|'default'};
export interface ResolvedPaymentSettings {
 remindersEnabled:EffectivePaymentSetting<boolean>;
 reminderBeforeDueDays:EffectivePaymentSetting<number>;
 reminderRepeatDays:EffectivePaymentSetting<number|null>;
 overdueReminderEveryDays:EffectivePaymentSetting<number>;
 autopayOffsetDays:EffectivePaymentSetting<number>;autopayOffsetRule:EffectivePaymentSetting<AutopayOffsetRule>;
 autopayCap:EffectivePaymentSetting<AutopayScheduleTerms['cap']>;achMode:EffectivePaymentSetting<AchMode>;
}
export interface PaymentSettingsView { autopayEnabled:boolean;values:PaymentValues;inherited:ResolvedPaymentSettings;effective:ResolvedPaymentSettings }

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
 state:AutopayScheduleState|'processing'|'unapplied';reason:string|null;collectOn:string|null;
 noticeSentAt:string|null;excluded:boolean;canExclude:boolean;canChargeNow:boolean;processing:boolean;unapplied:boolean;
}
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
}
export type InvoicePayResult={url:string;outcome?:never;attemptId?:never;reason?:never}|(CollectionResult&{url?:never});
