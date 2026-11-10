/**
 * Prefix of the one kind of `lastError` text that is safe to show a client: our own sanitized reason.
 * The poll worker also writes raw upstream error text to `lastError`, which must stay server-side
 * (#6192), so `listMailboxConnections` only exposes a value that starts with this.
 */
export const MAILBOX_VERIFICATION_FAILED = 'Mailbox verification failed';

/** Names the environment variables an operator has to set; never their values. */
export const MAILBOX_PLATFORM_NOT_CONFIGURED_REASON =
  'the Microsoft 365 ticket mailbox app is not configured on this server (set TICKET_MAILBOX_M365_CLIENT_ID and TICKET_MAILBOX_M365_CLIENT_SECRET)';

/** The platform-level Microsoft 365 mailbox app credentials are missing, so no tenant can be polled. */
export class MailboxPlatformNotConfiguredError extends Error {
  constructor() {
    super('TICKET_MAILBOX_M365_CLIENT_ID/SECRET not configured');
    this.name = 'MailboxPlatformNotConfiguredError';
  }
}
