/**
 * Operator abuse/security contact surface (#8872).
 *
 * Deployment-level, read SERVER-SIDE ONLY (Astro frontmatter / endpoints):
 * the web image is built once, so `PUBLIC_*` values are not inlined at build
 * time for these — they come from the container environment at request time.
 * Nothing here may be imported by a client island.
 *
 * Self-hosted deployments publish nothing unless they set the variables; the
 * hosted operator's contacts must never be baked into the product.
 */

export interface SecurityContacts {
  abuseEmail?: string;
  securityEmail?: string;
  policyUrl?: string;
}

export interface AuthFooterLink {
  /** i18n key in the `pages` namespace. */
  key: 'authFooter.reportAbuse' | 'authFooter.security';
  href: string;
}

type EnvLike = Record<string, string | undefined>;

// Deliberately loose: one "@", no whitespace, something on both sides. The
// value is operator-supplied config, not user input; we only want to refuse
// obviously broken strings so a typo doesn't ship as `mailto:not-an-email`.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && EMAIL_RE.test(trimmed) ? trimmed : undefined;
}

function cleanHttpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSecurityContacts(env: EnvLike): SecurityContacts {
  const contacts: SecurityContacts = {};
  const abuseEmail = cleanEmail(env.PUBLIC_ABUSE_CONTACT);
  const securityEmail = cleanEmail(env.PUBLIC_SECURITY_CONTACT);
  const policyUrl = cleanHttpsUrl(env.PUBLIC_SECURITY_POLICY_URL);
  if (abuseEmail) contacts.abuseEmail = abuseEmail;
  if (securityEmail) contacts.securityEmail = securityEmail;
  if (policyUrl) contacts.policyUrl = policyUrl;
  return contacts;
}

export function hasSecurityContacts(contacts: SecurityContacts): boolean {
  return Boolean(contacts.abuseEmail || contacts.securityEmail || contacts.policyUrl);
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * RFC 9116 body, or null when there is no `Contact:` to publish (the spec
 * requires at least one, and `Expires:`). Security contact first: that is the
 * one researchers are looking for; abuse is the second audience.
 */
export function buildSecurityTxt(contacts: SecurityContacts, now: Date): string | null {
  const lines: string[] = [];
  if (contacts.securityEmail) lines.push(`Contact: mailto:${contacts.securityEmail}`);
  if (contacts.abuseEmail) lines.push(`Contact: mailto:${contacts.abuseEmail}`);
  if (lines.length === 0) return null;
  lines.push(`Expires: ${new Date(now.getTime() + ONE_YEAR_MS).toISOString()}`);
  if (contacts.policyUrl) lines.push(`Policy: ${contacts.policyUrl}`);
  lines.push('Preferred-Languages: en');
  return `${lines.join('\n')}\n`;
}

/**
 * Links for the auth-shell footer. "Report abuse" prefills the subject with
 * the host so a report names the instance; "Security" prefers the policy
 * page (trust center) and falls back to the security mailbox.
 */
export function getAuthFooterLinks(contacts: SecurityContacts, host: string): AuthFooterLink[] {
  const links: AuthFooterLink[] = [];
  if (contacts.abuseEmail) {
    const subject = encodeURIComponent(`Abuse report: ${host}`);
    links.push({ key: 'authFooter.reportAbuse', href: `mailto:${contacts.abuseEmail}?subject=${subject}` });
  }
  const securityHref = contacts.policyUrl ?? (contacts.securityEmail ? `mailto:${contacts.securityEmail}` : undefined);
  if (securityHref) links.push({ key: 'authFooter.security', href: securityHref });
  return links;
}
