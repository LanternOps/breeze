/**
 * The header that marks a message as OUR OWN outbound mail (spec §8.5).
 *
 * Loop prevention used to recognise our mail by sender domain — a custom From
 * has neither `no-reply` nor TICKETS_INBOUND_DOMAIN, so a notification that
 * comes back (a contact address forwarding to the partner's support mailbox,
 * which forwards into Breeze) would open or update a ticket. We mark our own
 * mail instead of guessing from the sender.
 *
 * Forging it only gets the forger's own mail ignored, which is why this is safe
 * to trust from untrusted inbound. The inverse rule — suppressing by SENDING
 * DOMAIN — is explicitly rejected by the spec: with a root domain every
 * technician's address is on the sending domain, and a technician may
 * legitimately write from the shared mailbox.
 *
 * Its own module so `services/inboundEmail/**` can consume the constant without
 * importing anything from the partner-lane send path.
 */
export const BREEZE_OUTBOUND_HEADER = 'X-Breeze-Outbound';
export const BREEZE_OUTBOUND_HEADER_VALUE = '1';
