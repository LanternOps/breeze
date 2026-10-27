---
title: Wisp working set — automatic links, record page context, "Talk to Wisp about this"
status: draft (awaiting Todd)
date: 2026-10-26
parent: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md §17.2 (thread links)
extends: docs/superpowers/specs/ai-mcp/2026-10-25-wisp-home-companion.md
plan: docs/superpowers/plans/ai-mcp/2026-10-26-wisp-working-set.md
---

# Wisp working set

## 1. Problem

Wisp thread links (`wisp_thread_links`, W08 of #9906) only fill when a person clicks "Link to Wisp" or the model happens to call `link_entity`. Nothing tells the model to, and nothing links on its own. So the session seed's "Linked objects" section is usually empty, and the continuity it was built for does not happen.

Separately, the AI chat page context (`AiPageContext`) knows only `device`, `alert`, `dashboard`, `custom` and `topology`. Ticket, quote, invoice, contract, organization and site pages set nothing. The docked chat on a ticket does not know it is on a ticket.

Todd, 2026-10-26: links should be references you click between, added automatically. Device and ticket pages get a small "Talk to Wisp about this", not a manual "Link to Wisp".

## 2. Decisions

Reviewed by an independent Fable subagent and Codex (gpt-6-astra, xhigh, read-only) on 2026-10-26. Both: AGREE WITH CHANGES. The changes are folded in below.

1. **Keep the table; it is a bounded working set, not a graph store.** Breeze's relational schema already holds the edges (ticket → device → site → org, alert → device, quote/invoice/contract → org). A Graphiti-style store (model extraction, separate graph database) would duplicate the source of truth outside RLS and compete with Wisp memory. Rejected.
2. **Three link sources in one table.** `source` is `user_pin` (a page button or the home picker), `wisp_pin` (the model's explicit `link_entity`) or `auto` (a focal act). Pins are sticky and never evicted; the pin cap stays `WISP_THREAD_LINK_LIMIT` (50). Auto links have their own cap, `WISP_THREAD_AUTO_LINK_LIMIT = 20`, and the least recently touched auto link is evicted at the cap. Adding a pin over an existing auto link promotes it; a source never demotes.
3. **Recency.** New columns `last_touched_at` and `touch_count`. A re-add of an existing link touches it. Ordering everywhere is by `last_touched_at`, not `created_at`.
4. **Auto-link only on focal acts.** A focal act is a successful call of a tool declared in the subject manifest (§3), in a Wisp chat session: a single-object detail read, or a mutating action naming the object. List, search, query and fleet tools are never focal. Ids come from the tool **input**, never the output. At most `WISP_AUTO_LINKS_PER_TURN = 5` auto adds per turn; further focal acts in the turn only touch existing links.
5. **Concern subjects are derived, not stored.** Open and snoozed concerns of the grant contribute their subject (mapped `org` → `organization`; `integration` and `incident` are not linkable) at read time, resolved through the same resolver. They leave the working set when the concern resolves. No second lifecycle.
6. **Recency spreads one hop, never inserts.** When a focal act touches object X, links already on the thread that are X's direct relations (via existing foreign keys) are touched too. Neighbours are never inserted.
7. **Neighbours on read, on demand.** A pill can expand to show the object's direct relations, resolved through the caller's permission and the live ceiling. Not part of the seed or the home first paint.
8. **Authority.** Auto-linking runs with the call's own narrowed auth and ceiling (the pre-tool gate's `toolAuth` and `GrantCeiling`), never session-level or system authority, and goes through `resolveEntityRef` like every other add. A failure to auto-link never fails the tool call; it is logged and captured. `link_entity` stays Tier 2. Each auto add writes an audit event `wisp.thread.link_added` with `details.source = 'auto'`.
9. **Seed order.** Current page record (if any, §4), then pins, then concern subjects, then auto links by `last_touched_at`; at most 15 auto lines. The existing 50 line / 4 KB cap, sanitizing and fencing stay.
10. **Record page context** (§4) serves both the plain AI chat and Wisp.
11. **"Talk to Wisp about this"** replaces "Link to Wisp" (§5).

## 3. Subject manifest

A central declarative map, `apps/api/src/services/wisp/toolSubjects.ts`, says which tools are focal and which input argument names which object:

```ts
type ToolSubject = { arg: string; kind: WispEntityKind; actions?: readonly string[] };
export const WISP_TOOL_SUBJECTS: Readonly<Record<string, readonly ToolSubject[]>>;
```

`actions` restricts a multiplexed `manage_*` tool to the listed `action` values (for example `manage_tickets` focal on `get`, `comment`, `assign`, `update_status`, `update_fields`; never `list`). A contract test requires every tool in `TOOL_TIERS` to be either in the map or in `WISP_NON_FOCAL_TOOLS` with no overlap, so a new tool cannot silently skip classification. The starting entries are the canonical tools listed in the plan's W02 Task 1.

## 4. Record page context

One new variant for every record page, IDs only. The server reads everything else:

```ts
{ type: 'record'; kind: 'ticket' | 'quote' | 'invoice' | 'contract' | 'organization' | 'site';
  id: string /* uuid */; orgId?: string /* uuid, client hint only */; label?: string /* ≤200, web badge only */ }
```

- `.strict()` in the Zod union, like topology.
- The prompt line is built from a server read (`loadEntityForPartner`, then the caller's `ENTITY_READ_PERMISSION` and org/site reach), never from `label`. A refused or missing record renders nothing.
- The session org anchor and the AI write default org come from the record's own org, after the access check, the same way `device` works today.
- Tool domains in the lazy index: ticket → `tickets`; quote, invoice, contract → `billing`; organization, site → `accounts`.
- Sanitizer, prompt switch and web badge get an exhaustive `never` check, so the next variant cannot be half-added.
- Pages that set it: `TicketWorkbench`, `QuoteWorkspace`, `InvoiceWorkspace`, `ContractWorkspace`, the organization record page, `SiteDetailPage`.
- In a Wisp session the record is also the seed's first line ("Viewing now").
- The web's org-mismatch rebind (`pageContextOrgMismatch`) applies to any context with an `orgId`, not only `device`.

## 5. Surface

- **Pills.** The links panel becomes a working-set strip: pins (with remove), then concern subjects (marked, no remove), then recent auto links (fading with age, with "Pin" and "Dismiss"). Up to 12 shown, then "More". A pill click navigates; an expand control shows its neighbours. "Dismiss" deletes an auto link.
- **"Talk to Wisp about this"** on device, ticket, quote, invoice, contract and organization headers, small (the existing `sm`/`md` sizes). With an active grant it:
  1. opens the docked panel in Wisp mode for that grant (enters it if needed);
  2. when the thread has a focus org and the record's org differs, asks "Wisp is focused on A. Switch to B?" and calls `setWispFocus` on yes; on no it stops;
  3. pins the record (`user_pin`);
  4. puts "About {label}: " in the composer if it is empty, and focuses it. It never sends a turn.
- **Without a Wisp grant** the same control reads "Ask AI about this" and opens the plain docked chat; the page context is already set by the page. *Default chosen; Todd may prefer to hide it instead.*

## 6. Out of scope

- Inline per-message references in the transcript (both reviewers suggested it). Follow-up issue once the manifest exists.
- Mobile surfaces.
- Multi-hop traversal.

## 7. Settings (CLAUDE.md rule 9)

No new setting. The caps are constants in `@breeze/shared`.
