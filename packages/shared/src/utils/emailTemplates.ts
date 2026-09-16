/** Partner-editable outbound customer emails. Distinct from ticketTemplate.ts
 *  canned/autoreply vars. Comment content is never a merge key. */

export const EMAIL_TEMPLATE_IDS = [
  'ticket_comment_notification',
  'ticket_autoresponse',
  'ticket_resolved',
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

export type EmailTemplateVarKey =
  | 'ticket_number'
  | 'ticket_subject'
  | 'requester_name'
  | 'requester_email'
  | 'org_name'
  | 'partner_name'
  | 'portal_url'
  | 'email_only_hint'
  | 'resolution_note';

const COMMENT_NOTIFICATION_VARS = [
  'ticket_number',
  'ticket_subject',
  'requester_name',
  'requester_email',
  'org_name',
  'partner_name',
  'portal_url',
  'email_only_hint',
] as const satisfies readonly EmailTemplateVarKey[];

const AUTORESPONSE_VARS = [
  'ticket_number',
  'ticket_subject',
  'requester_name',
  'requester_email',
  'org_name',
  'partner_name',
] as const satisfies readonly EmailTemplateVarKey[];

const VARS_BY_ID: Record<EmailTemplateId, readonly EmailTemplateVarKey[]> = {
  ticket_comment_notification: COMMENT_NOTIFICATION_VARS,
  ticket_autoresponse: AUTORESPONSE_VARS,
  ticket_resolved: [...COMMENT_NOTIFICATION_VARS, 'resolution_note'],
};

const LABEL_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'Public reply notice',
  ticket_autoresponse: 'Ticket received acknowledgement',
  ticket_resolved: 'Ticket resolved',
};

const HAS_CTA_BY_ID: Record<EmailTemplateId, boolean> = {
  ticket_comment_notification: true,
  ticket_autoresponse: false,
  ticket_resolved: true,
};

export function varsForEmailTemplate(id: EmailTemplateId): readonly EmailTemplateVarKey[] {
  return VARS_BY_ID[id];
}

export function emailTemplateLabel(id: EmailTemplateId): string {
  return LABEL_BY_ID[id];
}

export function emailTemplateHasCta(id: EmailTemplateId): boolean {
  return HAS_CTA_BY_ID[id];
}
