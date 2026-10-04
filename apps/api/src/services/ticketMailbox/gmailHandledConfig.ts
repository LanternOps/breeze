/**
 * Opt-in "mark handled" behavior for the Gmail inbound connector.
 *
 * Default (GMAIL_HANDLED_LABEL unset/blank): OFF. The connector stays strictly
 * read-only and requests GMAIL_INBOUND_SCOPES (gmail.readonly + identity).
 *
 * When GMAIL_HANDLED_LABEL names a USER label, every message the sweep enqueues
 * as a ticket gets that label and, unless GMAIL_ARCHIVE_ON_HANDLE=false, is
 * removed from INBOX (still findable under the label and in All Mail). The label
 * call uses its own gmail.modify client (GMAIL_INBOUND_MODIFY_SCOPES), which the
 * customer's admin must add to the domain-wide-delegation grant; reading keeps the
 * read-only session, so a missing grant only stops the labelling.
 *
 * Read at call time (not module load) so tests and operators can flip it.
 */
export interface GmailHandledConfig {
  enabled: boolean;
  labelName: string;
  archive: boolean;
  labelCacheTtlMs: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function gmailHandledConfig(env: NodeJS.ProcessEnv = process.env): GmailHandledConfig {
  const labelName = (env.GMAIL_HANDLED_LABEL ?? '').trim();
  const ttlRaw = Number(env.GMAIL_HANDLED_LABEL_TTL_MS);
  return {
    enabled: labelName.length > 0,
    labelName,
    archive: (env.GMAIL_ARCHIVE_ON_HANDLE ?? 'true').trim().toLowerCase() !== 'false',
    labelCacheTtlMs: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS,
  };
}
