# Email-first ticketing: shared-queue notice and the technician reply in the customer email

**Date:** 2026-10-14
**Tracking issue:** LanternOps/breeze#8758
**Status:** Draft for maintainer review. Direction accepted (`track:spec`). Not approved, and not scheduled.
**Builds on:** inbound email-to-ticket (phase 4), connected Microsoft 365 mailbox send (`graphReplySender.ts`), `ticketing.inbound.fullMessageReply`.
**Related:** #8759 (a one-time secret link is a public reply and has to leave in this email).

## Problem

Two gaps in `ticketNotifyWorker` for a team that works out of one shared support mailbox.

1. An unassigned ticket emails nobody. `ticket.created` and `ticket.assigned` mail the assignee only, and only when there is one. Portal, technician, alert, API, and AI tickets never appear in the mailbox the team already watches. The default inbound assignee (#7948) covers "nobody is told" by pre-assigning one person. That is the wrong shape for a shared queue.

2. A public reply from the ticket screen is a portal notice. The comment text is not in the mail. `ticketing.inbound.fullMessageReply` can append it, but only when the reply is **not** sent through a connected Microsoft 365 mailbox (`fullMessageReply && !graphMailbox` in `collectRequesterEmail`). With the support mailbox connected, Graph `createReply` still sends the portal notice. The flag is also stored on `ticketing.inbound`, which the Inbound email card replaces wholesale, so the card cannot edit it.

Confirmed live on a self-hosted partner with the flag set and `support@thetmg.com` connected: the customer received "New reply on your ticket" and "Sign in to the portal to view it." The technician's text was not in the message.

## Goals

- One settings concept, partner default then organization override, edited on Settings → Ticketing.
- A shared mailbox is told when a ticket is created and left unassigned, for every ticket source, without assigning anyone.
- A public reply emails the comment text, including when it is sent from a connected Microsoft 365 mailbox, and threads in that mailbox.
- The notice this feature sends cannot itself become a ticket.

## Non-goals

- Changing the default inbound assignee (#7948). Leave it unset for a shared queue.
- Putting the comment text into internal notes. Internal notes stay off this path.
- Replacing the requester acknowledgement. It stays its own mail.
- Customer-portal download of anything. The staff link in the queue notice is for technicians.
- The secret-link action itself (#8759). That action posts a public reply; this spec is how the reply reaches the requester.
- Inbound sender-auth and pasted-screenshot ingest (#8299).

## Design

Decisions D1–D3 were settled on [#8758](https://github.com/LanternOps/breeze/issues/8758). This section is that record.

### D1. One concept, two fields

**Home:** Settings → Ticketing (`TicketingSettingsTabs.tsx`), not `InboundEmailCard.tsx`.

**Partner default**, on `partners.settings.ticketing.emailCustomer` (sibling of `inbound`, not inside it, so an Inbound card save cannot wipe it):

```jsonc
{
  "queueNotifyAddresses": [],          // emails; empty = off
  "replyIncludesComment": false        // absent/false = today's portal notice
}
```

**Organization override**, a nullable jsonb column `email_customer` on `org_ticket_settings` (`apps/api/src/db/schema/ticketConfig.ts`). `NULL` inherits the partner. A present object may set either field; an omitted field inherits.

Resolution is one function: org value if that field is set, otherwise the partner value. New partners stay off (`[]` and `false`), so current MSP behavior does not change.

**Legacy flag.** `ticketing.inbound.fullMessageReply` keeps working as a read fallback when `emailCustomer.replyIncludesComment` is absent. Writes go to `emailCustomer` only. The Inbound card stops needing to know about the flag.

Our deployment sets the partner values: `queueNotifyAddresses` is the connected support mailbox, and `replyIncludesComment` is true. An MSP can override one organization without changing the partner.

### D2. Queue notice: every source, one skip, and the loop break

Ticket sources are `portal`, `email`, `alert`, `manual`, `api`, and `ai` (`TicketSource` in the phase 1 plan). The notice fires for all of them.

**Create.** When the new ticket is unassigned, mail `queueNotifyAddresses`. Do not assign the ticket. When it already has an assignee, the existing assignee mail is the only staff mail. The notice contains ticket number, subject, organization, requester, source, and a staff link.

**Customer reply.** Unassigned: the same addresses. Assigned: the assignee, which is the mail that already exists.

**Skip when that mailbox already has the message.** If this event was ingested from a connected mailbox, and that mailbox is one of the queue addresses, do not send that address a second copy. The customer's message is the notice. Any other address in the list still receives one. Mail that arrived at the connected support mailbox takes this skip. Portal, manual, alert, API, and AI tickets have nothing in that mailbox, so they get the notice.

**The notice is a new message to the queue address**, not a `createReply` on the customer's thread. Stamp `X-Breeze-Queue-Notice: 1`. Ingest (`loopPrevention.ts`, a new reason next to the autoresponse rules) drops a message with that header and does not create or append a ticket. `Auto-Submitted: auto-generated` is the wrong signal: device and monitoring mail uses it and should still become a ticket. The requester acknowledgement is unchanged and keeps its own loop rules.

### D3. Graph replies carry the comment, to the requester only

Keep `sendThreadedReply` in `apps/api/src/services/ticketMailbox/graphReplySender.ts`: `createReply` on the latest inbound message, set the body, send. That is what threads in the customer's mailbox and in the shared mailbox.

`createReply` copies the original To, Cc, and Reply-To. That is why the comment text is withheld today (`ticketNotifyWorker.ts`, the `fullMessageReply && !graphMailbox` gate). Before send, replace the draft's recipients:

- To = `ticket.submitterEmail` only
- Cc and Bcc cleared
- Reply-To = the connected mailbox, so the answer comes back to the support inbox

No other address from the original message is kept. If `submitterEmail` is missing, do not send. If there is no inbound message to reply to, `sendNewMail` to `submitterEmail` only, subject `RE:` plus the ticket subject.

When `replyIncludesComment` is on, the HTML body is the public comment. A portal "view ticket" link may sit under it. The worker already enters this path only for a public comment; the body append still requires `isPublic` and a live ticket and comment, as `appendFullReplyBody` does today. The same body is used on the Graph path and on the platform `EmailService` path. The `!graphMailbox` half of the gate goes away.

When `replyIncludesComment` is off, the body stays the portal notice, including for a connected mailbox.

#8759 posts a public comment that contains only the one-time link. That comment is this body, so the link is in the customer's mail once `replyIncludesComment` is on.

## Testing

- Resolution: org field wins over partner; omitted org field inherits; absent `emailCustomer` falls back to legacy `fullMessageReply`; default partner sends no queue mail and sends the portal notice.
- Create, unassigned, source `portal`: queue address receives one notice, ticket stays unassigned. Create with an assignee: assignee mail only.
- Create from a message ingested from the connected mailbox, and that mailbox is a queue address: that address gets no second copy. A second configured address still gets one.
- A message carrying `X-Breeze-Queue-Notice: 1` does not create or append a ticket. An `Auto-Submitted: auto-generated` message from anyone else still can.
- Public reply, `replyIncludesComment` on, connected mailbox: Graph draft To is only `submitterEmail`, Cc and Bcc empty, Reply-To is the mailbox, body contains the comment text. Internal note sends nothing to the customer.
- Public reply with the flag off, connected mailbox: body is the portal notice.
- Missing `submitterEmail`: no customer send.

## Rollout

Off for every existing partner until they set an address or turn the reply field on. Partners who already set `fullMessageReply` through the API keep that behavior via the read fallback, including on the connected-mailbox path once the recipient replace in D3 ships. No change to the requester acknowledgement or to the default inbound assignee.
