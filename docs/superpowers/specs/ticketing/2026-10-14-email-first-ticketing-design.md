# Email-first ticketing: shared-queue notice and the technician reply in the customer email

**Date:** 2026-10-14
**Tracking issue:** LanternOps/breeze#8758
**Status:** Draft for maintainer review. Direction accepted (`track:spec`). Not approved, and not scheduled.
**Builds on:** inbound email-to-ticket (phase 4), connected Microsoft 365 mailbox send (`graphReplySender.ts`), `ticketing.inbound.fullMessageReply`.
**Related:** #8759 (a one-time secret link is a public reply and has to leave in this email).

## Problem

Two gaps in `ticketNotifyWorker` for a team that works out of one shared support mailbox.

1. An unassigned ticket emails nobody. `ticket.created` and `ticket.assigned` mail the assignee only, and only when there is one. An unassigned create never queues a notify job: `assigneeNotificationFromOutboxRow` (`apps/api/src/jobs/ticketOutboxPublisher.ts`) returns null unless the event is `ticket.created` or `ticket.assigned`, `assigneeId` is set, and the payload carries `actorUserId`. Portal, technician, alert, API, and AI tickets therefore never appear in the mailbox the team already watches. The default inbound assignee (#7948) covers "nobody is told" by pre-assigning one person. That is the wrong shape for a shared queue.

2. A public reply from the ticket screen is a portal notice. The comment text is not in the mail. `ticketing.inbound.fullMessageReply` can append it, but only when the reply is **not** sent through a connected Microsoft 365 mailbox (`fullMessageReply && !graphMailbox` in `collectRequesterEmail`). With the support mailbox connected, Graph `createReply` still sends the portal notice. The flag is also stored on `ticketing.inbound`, which the Inbound email card replaces wholesale, so the card cannot edit it.

Confirmed live on a self-hosted partner with the flag set and `support@thetmg.com` connected: the customer received "New reply on your ticket" and "Sign in to the portal to view it." The technician's text was not in the message.

## Goals

- One settings concept, partner default then organization override, edited on Settings → Ticketing and on the organization ticket settings screen.
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

**Settings (rule 9).**

| | |
|---|---|
| Home | Partner default: Settings → Ticketing, `TicketingSettingsTabs.tsx` (`TicketingHubPage`). Organization override: `OrgTicketSettingsEditor`. Not `InboundEmailCard`. |
| Level | Partner default → organization override. An organization field that is set wins; an omitted field inherits. Blank on the org screen means inherit, and the control shows the inherited value and that it comes from the partner. |
| Resolver | One function, `resolveEmailCustomer`, used by the notify worker for both the queue notice and the customer reply body. Draft, save, and send read that function. Nothing else reads `fullMessageReply` after the migration below. |
| Places configured | 0 in the UI today (the legacy flag is not on a screen) → 2 (`TicketingSettingsTabs` and `OrgTicketSettingsEditor`). |

The count goes up. The removal plan is the one-time migration in **Legacy flag** below: after it runs, the old key is not a third place to configure this.

**Partner default**, on `partners.settings.ticketing.emailCustomer` (sibling of `inbound`, not inside it, so an Inbound card save cannot wipe it):

```jsonc
{
  "queueNotifyAddresses": [],          // emails; empty = off
  "replyIncludesComment": false        // absent/false = today's portal notice
}
```

`apps/api/src/routes/orgs.ts` validates `ticketing` as an object whose only key today is `inbound`. Zod strips unknown keys, so a PATCH that sends `emailCustomer` is dropped until that schema includes it. Add `emailCustomer` there.

**Organization override**, a nullable jsonb column `email_customer` on `org_ticket_settings` (`apps/api/src/db/schema/ticketConfig.ts`). `NULL` inherits the partner. A present object may set either field; an omitted field inherits. The column needs a migration. `org_ticket_settings` in `apps/api/src/services/tenantExportPolicyRegistry.ts` already lists `sla_overrides` under `excludedOpen`; add `email_customer` there too (jsonb is an open container). `orgTicketSettingsSchema` (`packages/shared/src/validators/ticketConfig.ts`, used by `routes/orgTicketSettings.ts`) also strips unknown keys, so the org PATCH must accept this field or the editor cannot save it.

Resolution is `resolveEmailCustomer`: org value if that field is set, otherwise the partner value. New partners stay off (`[]` and `false`), so current MSP behavior does not change.

**Legacy flag.** Do not keep reading `ticketing.inbound.fullMessageReply` beside the new field. A one-time migration copies `fullMessageReply: true` onto `emailCustomer.replyIncludesComment` where that field is absent. After the migration, readers ignore the old key. Writes go to `emailCustomer` only. The Inbound card never learns about the flag.

Our deployment sets the partner values: `queueNotifyAddresses` is the connected support mailbox, and `replyIncludesComment` is true. An MSP can override one organization without changing the partner.

### D2. Queue notice: every source, one new event, one skip, and the loop break

Ticket sources are the values of `ticketSourceEnum` in `apps/api/src/db/schema/portal.ts`: `portal`, `email`, `alert`, `manual`, `api`, and `ai`. The notice fires for all of them.

**Create, publisher change.** When the new ticket is unassigned, mail `queueNotifyAddresses`. Do not assign the ticket. This is a new branch in `ticketOutboxPublisher`, next to `assigneeNotificationFromOutboxRow`: a `ticket.created` row with no `assigneeId` enqueues the queue notice when the resolved address list is non-empty. Today that function returns null for that row, so the job is never queued. When the ticket already has an assignee, the existing assignee mail is the only staff mail. The notice contains ticket number, subject, organization, requester, source, and a staff link.

**Customer reply, new event `ticket.customer_replied`.** No assignee mail exists for a customer reply. The `ticket.commented` branch in `ticketNotifyWorker.ts` sends only requester mail (`collectRequesterEmail`) and skips comments marked inbound. A portal comment (`apps/api/src/routes/portal/tickets.ts`, the insert on `POST /tickets/:id/comments`) writes the row and emits no event and no outbox row. A plain public `ticket.commented` is the wrong event: that path also emails the requester, so a portal reply would mail the customer their own comment.

`ticket.customer_replied` is staff mail only. Emit it when a customer posts a public reply (the portal insert above, and an inbound message that appends a customer comment). Payload carries whether the ticket has an assignee. Unassigned: mail `queueNotifyAddresses`. Assigned: mail the assignee. Do not call `collectRequesterEmail` for this event.

**Skip when that mailbox already has the message.** If this event was ingested from a connected mailbox, and that mailbox is one of the queue addresses, do not send that address a second copy. The customer's message is the notice. Any other address in the list still receives one. Mail that arrived at the connected support mailbox takes this skip. Portal, manual, alert, API, and AI tickets have nothing in that mailbox, so they get the notice.

**Lane.** The queue notice and the assignee mail from `ticket.customer_replied` use the platform `EmailService` lane (`getEmailService()`), the same lane as today's assignee notifications. They are not Graph `createReply` and they are not partner-lane mail. A self-hosted install with no platform transport has a null email service and sends nothing. Import mode already stays silent if the notice is produced from the outbox: `IMPORT_SIDE_EFFECTS` in `apps/api/src/services/ticketService.ts` writes no outbox row.

**The notice is a new message to the queue address**, not a `createReply` on the customer's thread. Stamp the existing `X-Breeze-Outbound: 1` (`BREEZE_OUTBOUND_HEADER` in `apps/api/src/services/emailDomains/outboundMarker.ts`). Ingest already drops a message with that header: `ownOutboundReason` (`loopPrevention.ts`) returns `outbound-marker`, and `inboundEmailService.ts` logs it ignored and returns. That drop is not the autoresponse suppressor. Autoresponse rules only stop the acknowledgement. Partner-lane mail stamps this header in `partnerLaneSend.ts`; the platform lane does not, so the queue notice stamps it itself. A second header is not needed. `Auto-Submitted: auto-generated` is the wrong signal: device and monitoring mail uses it and should still become a ticket (`ticketCreationLoopReason` deliberately does not drop it). The requester acknowledgement is unchanged and keeps its own loop rules.

### D3. Graph replies carry the comment, to the requester only

Keep `sendThreadedReply` in `apps/api/src/services/ticketMailbox/graphReplySender.ts`: `createReply` on the latest inbound message, set the body, send. That is what threads in the customer's mailbox and in the shared mailbox. `resolveOutboundMailbox.ts` picks that message: the newest `ticket_email_inbound` row for the ticket with `provider = m365`.

`createReply` addresses the original sender, or the Reply-To when one is set. Copying To and Cc is `createReplyAll`, which this code does not call. The comment text is withheld today because the connected-mailbox path is unvalidated (`fullMessageReply && !graphMailbox` in `collectRequesterEmail`). The risks on this path are an external Reply-To, and that newest inbound message coming from someone other than `ticket.submitterEmail`. Before send, replace the draft's recipients:

- To = `ticket.submitterEmail` only
- Cc and Bcc cleared
- Reply-To = the connected mailbox, so the answer comes back to the support inbox

No other address from the original message is kept. If `submitterEmail` is missing, do not send. If there is no inbound message to reply to, `sendNewMail` to `submitterEmail` only. The subject of that fallback is an open maintainer call (see below); the working proposal is `RE:` plus the ticket subject.

When `replyIncludesComment` is on, the HTML body is the public comment. A portal "view ticket" link may sit under it. The worker enters the customer-mail path only for a public comment. The live-ticket, live-comment, and `isPublic` checks that decide whether the text is appended live in `collectRequesterEmail` (the comment select, then `!ticket.deletedAt && !comment.deletedAt && comment.isPublic`). `appendFullReplyBody` only escapes the text and splices it into the HTML. The same body is used on the Graph path and on the platform `EmailService` path. The `!graphMailbox` half of the gate goes away.

When `replyIncludesComment` is off, the body stays the portal notice, including for a connected mailbox.

#8759 posts a public comment that contains only the one-time link. That comment is this body, so the link is in the customer's mail once `replyIncludesComment` is on.

## Testing

- Resolution: org field wins over partner; omitted org field inherits; default partner sends no queue mail and sends the portal notice. After the migration, a stored `fullMessageReply: true` is not read.
- Migration: a partner with `fullMessageReply: true` and no `emailCustomer.replyIncludesComment` ends with `replyIncludesComment: true`. A partner who already set the new field is left alone.
- Create, unassigned, source `portal`: the publisher enqueues one queue notice, the address receives it, the ticket stays unassigned. Create with an assignee: assignee mail only, no queue notice.
- Create from a message ingested from the connected mailbox, and that mailbox is a queue address: that address gets no second copy. A second configured address still gets one.
- Portal comment on an unassigned ticket emits `ticket.customer_replied` and does not emit a requester email for that event. Assigned: the assignee receives one staff mail.
- A message carrying `X-Breeze-Outbound: 1` is ignored by ingest (`outbound-marker`) and does not create or append a ticket. An `Auto-Submitted: auto-generated` message from anyone else still can.
- Public reply, `replyIncludesComment` on, connected mailbox: Graph draft To is only `submitterEmail`, Cc and Bcc empty, Reply-To is the mailbox, body contains the comment text. Internal note sends nothing to the customer.
- Public reply with the flag off, connected mailbox: body is the portal notice.
- Missing `submitterEmail`: no customer send.
- Import mode: no outbox row, no queue notice.

## Rollout

Off for every existing partner until they set an address or turn the reply field on. The migration turns `replyIncludesComment` on only for partners who already set `fullMessageReply`. Once the recipient replace in D3 ships, that migrated flag applies on the connected-mailbox path too. The old key is not consulted. No change to the requester acknowledgement or to the default inbound assignee.

## Open maintainer calls

These are not decided here.

- Whether a queue address outside the connected mailbox is accepted, and how it is validated.
- How the queue-notice body combines with partner email templates.
- The subject `sendNewMail` uses when there is no inbound message to reply to.
