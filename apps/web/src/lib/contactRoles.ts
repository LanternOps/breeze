/**
 * The contact role vocabulary. Mirrors CONTACT_ROLES in
 * apps/api/src/services/contacts/types.ts (the API validates it). Shared by the
 * org contacts card and the multi-org report recipient rule.
 */
export const CONTACT_ROLES = [
  'billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

/** Role → label key in the `settings` namespace. Full literal keys, so a
 *  non-camelCase token (`after_hours`) needs no transformation at call sites. */
export const CONTACT_ROLE_LABEL_KEYS: Record<ContactRole, string> = {
  billing: 'contactsCard.roles.billing',
  technical: 'contactsCard.roles.technical',
  escalation: 'contactsCard.roles.escalation',
  admin: 'contactsCard.roles.admin',
  site: 'contactsCard.roles.site',
  after_hours: 'contactsCard.roles.afterHours',
  portal: 'contactsCard.roles.portal',
};

export function isKnownContactRole(role: string): role is ContactRole {
  return (CONTACT_ROLES as readonly string[]).includes(role);
}
