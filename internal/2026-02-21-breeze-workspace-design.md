# Breeze Workspace — Design Document

> Date: 2026-02-21
> Status: Approved for implementation planning
> Module: Breeze Workspace (inside Breeze Tauri app)

---

## Vision

A unified productivity module built inside Breeze where messages, documents, and email are one surface — operated natively by AI because everything is plain, structured data.

This is not "AI added to an office suite." It is an office suite built for AI from the start.

The core insight: every other AI assistant is handed a Word document and has to *infer* the structure. Breeze Workspace gives the AI a typed schema, defined actions, known relations, and live computed fields from the device agent. It doesn't guess — it operates.

---

## Design Principle: Context Is Intrinsic

> A block always carries its full context graph. You never have to tell the AI what it's looking at.

A ticket block knows its linked device. A device block knows its space. A space knows its org. Relations resolve automatically. Computed fields pull from live agent data. The AI traverses the full graph in every response — context is not injected manually, it is architectural.

---

## Section 1: Mental Model

Everything in Breeze Workspace is made of two things: **Spaces** and **Blocks**.

### Spaces

A Space is a container with a purpose — a client, a project, a team, a department. Every Space contains:

- **Feed** — real-time chat and activity stream. Markdown messages, @mentions, AI actions logged here
- **Doc tree** — markdown pages, hierarchical and linkable
- **Inbox** — email threads scoped to this space by participant, domain, or tag
- **Block apps** — structured data built from the block system (tickets, inventory, orders — whatever the space needs)

```
Breeze Workspace
├── Space: ACME Corp (client)
│   ├── Feed (chat + activity)
│   ├── Inbox (filtered to @acme.com)
│   ├── Docs (runbooks, notes, SOPs)
│   └── Blocks: [Tickets] [Devices] [Contacts]
│
├── Space: Internal IT
│   ├── Feed
│   ├── Docs (policies, knowledge base)
│   └── Blocks: [Tickets] [Inventory] [On-Call Schedule]
│
└── Space: Sales
    ├── Feed
    ├── Docs (proposals, templates)
    └── Blocks: [Leads] [Order Forms] [Contracts]
```

The AI has full context across every Space it has access to. It does not switch modes — it is the same AI whether you are asking about a device, a ticket, an email, or a document.

---

## Section 2: The Block System

A **Block Type** is a schema defined once and reused everywhere. It has four parts:

### Fields

Standard typed primitives:
```
text · number · date · select · multi-select · person · relation · file · boolean · formula · computed
```

The `computed` field is the Breeze-specific primitive. It auto-populates from live agent data. A "Device" block type has a computed `reliability_score` field that updates in real time without anyone touching it. No other workspace product can do this.

### Views

How records in a block type are displayed:
```
table · kanban · calendar · gallery · list · timeline · form
```

Same block type, different view. Tickets are kanban by default. Switch to calendar for scheduling. Share a form URL with a client to submit new requests — the submission creates a record in the same block.

### Relations

How block types link to each other and to native Breeze data:
- Ticket → Device (a live Breeze device — status, metrics, change log all accessible)
- Order → Contact
- Contact → Company
- Any block → any other block
- Any block → Breeze org, site, device, alert (native relations, always live)

### Actions

What the AI and automations can do with records of this type:
```
create · update · transition_status · assign · comment · archive · trigger_workflow
```

Defined per block type. Inventory block: `create, update, adjust_quantity`. Ticket block: `create, assign, transition_status, comment, close`. Financial block: `create` only without approval.

---

### Pre-Built Block App Templates

Ship with a library of ready-to-install block apps:

| Template | Key Fields | Views | Breeze Integration |
|---|---|---|---|
| **Tickets** | title, status, priority, assignee, device, description | kanban, table, list | Device field = live Breeze device; alert auto-creates ticket |
| **Knowledge Base** | title, body, category, tags, linked devices | gallery, list | AI generates from past incidents and device runbooks |
| **Contacts / CRM** | name, company, email, phone, stage | table, kanban | Email inbox auto-links to contact records |
| **Inventory** | item, SKU, quantity, location, reorder threshold | table, gallery | Agent can detect software/hardware and populate records |
| **Order Forms** | requester, items, quantity, status, approver | form → table | Public form URL; submission creates record; AI routes approval |
| **On-Call Schedule** | person, start, end, escalation | calendar | AI checks before alerting or assigning tickets |

Any Space can install any template. Any org can define custom block types. Businesses compose their own workflows.

### Blocks Inside Other Surfaces

Blocks are woven through every surface — not siloed:

- **In a Doc**: embed a filtered block view inline. A client runbook shows a live table of open tickets
- **In the Feed**: AI logs "I created Ticket #51 for SERVER-003 disk alert" as a card — clickable, live data
- **In email**: reply to a client and the AI references the linked ticket: "Logged as #51, currently In Progress"

---

## Section 3: The AI

Because every surface is structured plain data, the AI has a complete, traversable model of the entire business:

```
Spaces → Docs (markdown)
       → Feed (messages)
       → Inbox (email threads)
       → Blocks (typed records + resolved relations)
                → Breeze devices (live agent data)
                → Breeze alerts, audit logs, change history
```

### What the AI Can Do

**Read** — queries across the full graph:
> *"Which ACME tickets have been open more than 5 days with no update?"*
> *"What changed on SERVER-003 in the 24 hours before this ticket was created?"*
> *"Summarize everything that happened with this client this week."*

**Write** — creates and updates records:
> Device alert fires → AI creates Ticket #51 in the linked Space, priority High, assigned to on-call, logged in Feed.

**Transition** — moves state through defined actions:
> *"The service restart fixed it."* → AI resolves Ticket #47, comments with steps taken, notifies assignee.

**Generate** — produces content from structured data:
> *"Write the incident post-mortem."* → AI pulls the ticket, the device change log, the Feed thread, and the resolution. Produces a doc. No human assembly required.

**Automate** — rules that run without prompting:
> When device alert fires → create ticket in linked Space → message on-call in Feed → draft client email (hold for Tier 3 approval)

### Trust Model

The same 4-tier guardrail system from the RMM side applies to the Workspace. One consistent trust model across the entire product:

| Tier | Workspace Actions |
|---|---|
| **1 — Auto** | Query, summarize, read any surface, generate drafts |
| **2 — Auto + audit** | Create/update block records, post to Feed, create docs |
| **3 — Approval required** | Send emails, post external-facing content, financial blocks |
| **4 — Blocked** | Bulk delete, actions without defined schema support |

Same approval dialog. Same audit log. Same cost tracking. A technician already understands the system. A business owner already trusts it.

### Context Injection at Query Time

When the AI receives any message it receives:
- Current Space (name, purpose, linked org and devices)
- Relevant block types and recent records in that space
- Relations resolved to live data (device records → agent telemetry, not just IDs)
- Active doc content if one is open
- Recent Feed thread
- Open email thread if in Inbox view

The AI never sees stale data. Computed fields pull from the same device tables the RMM already maintains. The agent heartbeat keeps everything current.

---

## Section 4: Technical Architecture

Breeze already has most of this infrastructure. This is addition, not replacement.

### New Database Tables

Six new tables on top of existing Postgres/Drizzle schema:

```sql
workspace_spaces          — containers linked to existing org/site hierarchy
workspace_block_types     — schemas (field definitions as JSONB, per org or global)
workspace_block_records   — records (field values as JSONB, indexed by type + space)
workspace_docs            — markdown content (linked to space, versionable)
workspace_feed_messages   — chat messages (markdown, linked to space + block records)
workspace_email_threads   — email thread metadata (IMAP/M365 sync, linked to space)
```

### Real-Time

Same SSE infrastructure already in Breeze. Feed messages, block record updates, and device computed fields stream through existing channels. No new real-time infrastructure.

### Offline / Local

Tauri app caches workspace data in a local SQLite database, synced via the existing agent. Edit a doc offline. Update a block record on a plane. Syncs on reconnect. The agent is already on the machine — no new sync infrastructure needed.

### Email Integration

- **Phase 1**: IMAP/SMTP — works for everyone, zero OAuth friction
- **Phase 2**: Microsoft Graph API — adds calendar, Teams, user provisioning

Same pattern as Huntress/SentinelOne integrations — sync job in BullMQ, stored locally, AI can read and draft, send requires Tier 3 approval.

### Markdown Pipeline

One unified AST renderer across all surfaces in the Tauri app. Docs, Feed messages, block descriptions, email bodies — all rendered through the same pipeline. AI outputs markdown. Humans write markdown. Export converts to PDF/DOCX/XLSX only when leaving the system.

---

## Section 5: Security Architecture

> **Philosophy**: Build secure systems, not secured systems. Eliminate attack surfaces by design, not by detection.

This is a fundamentally different security posture than every existing productivity tool. Traditional office software was built for humans to manipulate rich formats. Security was bolted on afterward. Breeze Workspace inverts this: the format is incapable of hosting entire categories of attacks.

### Email Converted at the Edge

Email is received as HTML and converted to markdown at ingest — before it reaches any renderer.

| Traditional email client | Breeze Workspace |
|---|---|
| Renders full HTML | Converts to markdown at edge |
| Executes scripts | No script engine |
| Loads remote images | Remote resources stripped at ingest |
| Renders CSS tricks | No CSS |
| Follows tracking pixels | Tracking pixels eliminated |
| Phishing links styled to look safe | All links are plain text, AI-analyzed before display |

The entire category of "malicious email payload" is eliminated, not detected. There is no surface for HTML injection, CSS overlay attacks, remote resource loading, or script execution because the format does not support them.

The AI analyzes every plain-text URL before the user sees it. Phishing is caught at ingest, not after the click.

### Documents Have No Macro Surface

| Traditional Office format | Breeze Workspace |
|---|---|
| Word macros | No macro engine |
| Excel external resource calls | Blocks are plain data |
| OLE object embedding | Not supported |
| "Enable editing" social engineering | Doesn't exist |
| PDF JavaScript | Not supported |
| PowerPoint animation triggers | Not supported |

A markdown document cannot contain a macro. A block record cannot call an external resource. The attack vector does not exist.

### Compliance Falls Out Naturally

- **Auditability**: Markdown + JSON is trivially inspectable. Every change is a versioned diff
- **DLP**: Simpler on plain text than binary formats — AI can scan all content at rest
- **Retention**: Structured data with timestamps — policies are database queries
- **E-discovery**: A SQL query and a markdown export, not a forensic extraction
- **Data residency**: All content is in your Postgres instance, not a third-party SaaS

### The Moat

This is not "here is our security product." This is "our architecture eliminates the threat class."

Competitors cannot replicate this without abandoning backwards compatibility with their existing formats. Microsoft cannot make Word incapable of macros — too many enterprise customers depend on them. Breeze Workspace has no such constraint. It was built this way from the start.

---

## What This Enables That Wasn't Previously Possible

Traditional productivity tools: the AI reads your documents and answers questions.

Breeze Workspace: the AI *operates* your business — writes docs, creates tickets, responds to emails, updates inventory, routes approvals, and monitors devices — because every surface is structured data with defined actions, live context, and a consistent trust model.

The device agent is always watching. The AI already knows the answer before you finish typing the question. Email threats are eliminated at the edge. Documents have no attack surface. Everything is auditable by default.

**Nobody else can build this.** Notion doesn't have the agent. Microsoft Copilot doesn't have the device context. ServiceNow costs $500k/year and still needs humans to connect the dots. Google Workspace has no trust model for autonomous action.

Breeze is the only platform with: real-time device telemetry + actionable AI + cross-org visibility + a Tauri-native app at every endpoint + a block system designed for AI to operate.

---

## Implementation Path

This design is intentionally modular. Each layer ships independently and adds value immediately:

**Phase 1 — Spaces + Feed + Docs**
The collaboration foundation. Teams chat in Spaces, write markdown docs, AI participates in Feed. No blocks yet. Replaces Slack + Notion for the basic case.

**Phase 2 — Block System + Templates**
Install Tickets, Knowledge Base, Contacts templates. AI can create and update records. The ticketing system is now built from blocks — no separate ticketing product needed.

**Phase 3 — Email Inbox**
IMAP/SMTP integration. Email scoped to Spaces. Markdown conversion at edge. AI triages, drafts, summarizes. The security architecture is active from day one.

**Phase 4 — Computed Blocks + Deep Breeze Integration**
Device blocks, alert-triggered automations, live computed fields. The IT context flows into every workspace surface. This is the moat.

**Phase 5 — Custom Block Types + Advanced Automations**
Any business builds any workflow. Order forms, dispatch, inventory, CRM — assembled from blocks, operated by AI, secured by architecture.

---

## Architecture Decisions

1. **Spaces are team/department-scoped** — a new organizational dimension independent of the existing org → site → device hierarchy. Examples: Sales, Internal IT, Finance, Client: ACME. Spaces can reference orgs and devices but are not derived from them.

2. **CRDT for collaborative editing** — every edit is a delta operation, mergeable automatically. The history is a log of operations, revertible like git. Sync is just exchanging missing deltas. Use Automerge or Yjs. This is the same mental model as decision #3.

3. **Delta sync with git-style history** — local SQLite stores the operation log (deltas only, not full snapshots). Sync sends missing operations. Each change has a hash and parent reference — like git objects. Full document state is reconstructed from the operation log. Enables offline editing, conflict-free merge on reconnect, and complete version history for free.

4. **Global block type marketplace** — block type definitions exist at two levels:
   - **Global marketplace**: curated templates (Tickets, Knowledge Base, CRM, Inventory, etc.) published by Breeze, installable into any Space
   - **Org-scoped custom types**: any org can define their own block types, private to their tenant
   - Future: orgs can publish custom types to the marketplace

5. **Email conversion at the API edge** — HTML → markdown conversion happens at the API ingest layer before storage. The Tauri app and SQLite cache only ever see clean markdown. No HTML reaches any renderer. Security guarantee is enforced at the boundary, not client-side.
