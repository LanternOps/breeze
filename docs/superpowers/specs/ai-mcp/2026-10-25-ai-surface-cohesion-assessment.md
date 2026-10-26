---
title: AI surface cohesion — assessment and proposal
date: 2026-10-25
tracking_issue: LanternOps/breeze#10131
status: accepted by Todd 2026-10-25 ("all good and what we need") with one amendment — the Operator surface must get an AI-obvious noun, not "Tasks" (PSA collision). No issues created yet.
baseline_commit: 8d1871dfe1 (origin/main)
website_baseline: breezermm.com commit 1679c41 (docs/glossary.md adopted 2026-10-24)
scope: apps/web, apps/mobile, apps/docs, ee/workspace copy and navigation; breezermm.com glossary corrections
---

# AI surface cohesion

## 1. Verdict

The website now has one vocabulary and one sentence: **"Operators run Breeze. The workers do the work. Wisp runs your day."** The product does not yet follow it. In the app the AI reads as six products that happen to share a sidebar section: a chat assistant with seven names, AI Agents, the Operator, Fleet Orchestration, Wisp, and AI for Office, plus a knowledge indexer that is also called Wisp.

The engine underneath is already one thing. Wisp is the Operator with a face, memory and a grant; Wisp's specialists are agent runs and Operator tasks; every action clears the same risk engine and lands in the same Approvals page. The incoherence is almost entirely **naming and navigation**, not architecture. That makes it cheap to fix and expensive to leave: every new wave adds a nav entry and a noun.

Three moves fix most of it:

1. **Adopt the website glossary in the product** (locale-only, guarded by a test like the website's claims guard).
2. **Collapse the 12-entry AI section into the three layers of the sentence**: Wisp, the workers, and governance (which moves to Settings and Security where it already half-lives).
3. **One chat door with one voice**: the panel is Wisp when the person holds a grant and Breeze AI when they do not; the multi-tab page stops being called "Wisp chats" for people who have no Wisp.

Five decisions are needed from Todd (§11). The website glossary also has two factual errors about the product (§12).

## 2. What the user sees today

Verified by reading code and the en locale files on origin/main `8d1871dfe1`. Nothing was run in a browser.

### 2.1 The AI section of the sidebar (`apps/web/src/components/layout/Sidebar.tsx`)

| # | Label | Route | What it actually is |
|---|---|---|---|
| 1 | Fleet Orchestration | `/fleet` | Cross-device **findings** feed + remediation runs. Docs call it "Fleet Orchestration Brain". |
| 2 | Wisp | `/wisp` | Wisp home. Shown to anyone with `ai_sessions:use`; when Wisp is off for the deployment it forwards to the generic multi-tab chat. |
| 3 | AI Agents | `/settings/ai-agents` | Agent roster + builder (triage, patching, help desk, fleet designer, fix research). A settings page living in the AI nav. |
| 4 | AI Agent Runs | `/ai-agents/runs` | Run ledger. Page title says "Agent runs". |
| 5 | Operator | `/operator` | Long-running tasks + recipe Library. Title hard-coded, no h1. |
| 6 | AI Impact | `/ai-agents/impact` | Report. |
| 7 | Fix memory | `/ai-agents/fix-memory` | Output of the fix-research agent. |
| 8 | Fleet Design | `/ai-agents/fleet-design` | Output of the fleet-designer agent. |
| 9 | AI Usage | `/settings/ai-usage` | Spend + approval mode. A settings page. |
| 10 | Script authoring | `/settings/ai-script-authoring` | Policy. A settings page. |
| 11 | Tool Sources | `/settings/tool-sources` | MCP/OpenAPI tool config. A settings page. |
| 12 | AI for Office | `/ai-for-office` | A product for clients' end users. |

Elsewhere: Security → **AI Risk**; top-level **Approvals**; Administration → LLM Provider Catalog, AI Models, AI Kill Switch, **Wisp** (admin); Extensions → **Wisp Dashboard**, **Wisp Sources** (the ee knowledge connector, Puzzle icon); Settings index "AI" group → AI Agents, AI Usage, AI Providers & Models, Script authoring, **Wisp memory**, Tool Sources; the Settings sidebar shows no AI entry at all.

Four of the twelve AI-nav entries are settings pages; three are outputs of individual agents; one is a report. Only Wisp, the workers' roster, runs and tasks are places a person goes to *do* something.

### 2.2 One concept, many names

| Concept | Names in visible copy today |
|---|---|
| The built-in chat | "AI Assistant" (header button, script editor), "Breeze AI" (panel title, Office add-ins, incident actor), "Breeze AI Assistant" (empty state), "AI assistant" (flows, patches, playbooks), "the assistant" (script authoring, tool sources), "AI chat" (tool sources, approval timeout), "Breeze AI chat" (diagnostic access), "Ask Breeze" (mobile), "Wisp chats" (`/wisp/chat`, even with Wisp off) |
| "Wisp" | the agent; the generic multi-tab chat page; the ee file/email indexer ("Wisp Sources", "Wisp Dashboard", device tab "Wisp" = "Wisp index") |
| "Workspace" | legacy `/workspace` URL (chat); the ee extension's internal name and the AI-model setting "Workspace content enrichment"; the AI analysis sandbox ("What ran in the workspace") |
| "Operator" | the software ("Operator" nav, "AI Operator", "Delegate to Operator", "Handled by…") **and** people (docs: "Breeze operators", "your operator"; website: operators are always people) |
| Autonomous worker | AI Agent, Operator, Fleet Designer agent, the helpdesk agent, Specialist (Wisp), AI script reviewer, AI supervisor (entitlement copy), external "AI agent" (login MCP card) |
| Unit of work | Run (agents), Analysis run (chat), Remediation run (fleet), Task (Operator), Recipe (library) vs Workflow (Delegate dialog), Sweep, Check (Wisp activity) vs Assessment (Wisp admin), Investigation, Playbook |
| A conversation | conversation, chat, session, thread, tab, delegation |
| Deciding | Approve/Reject (chat, plan card), Approve/Deny (inbox, dialog), Approve all/Decline all, "Approve in inbox" vs nav "Approvals", statuses Denied / Rejected / Approval refused; standing authority = "always allow", "pre-authorization", "Promote" (graduation), "grant" (Wisp) |
| Spend | AI Usage, AI budget, AI Budgets ("AI spending limits"), credits, "$x this month · N credits", Wisp "¢ of ¢ today", Exposure budget (runs), Budget and reach (agents) |
| Risk tiers | Tool Sources "1 / 2 / 3"; AI Risk "Auto-Execute (Read-Only) / Auto-Execute + Audit / Requires Approval / Blocked" (hard-coded English); proposals "Low/Medium/High/Critical" |

### 2.3 Broken or missing links between the pieces

- Operator task detail says "Next action: Approve in inbox" as text; nothing in `components/aiOperator` links to `/approvals`.
- The device feed's "Learn about the AI Operator" link goes to the **AI Agents** docs page.
- The command palette has no "Ask AI" command and hard-codes `wispEnabled: false`, so Wisp pages never appear in it.
- The Operator Tasks device tab and `/operator` itself are not gated on the client flag; only the nav entry and launchers are.
- The `identity_onboarding` recipe merged in the baseline commit has no web copy yet.
- Public docs: Wisp, AI Agents, Operator and Impact sit under **Remote Management**; the chat, risk engine, MCP and AI for Office sit under **AI & Intelligence**; the docs home cards still say "AI Assistant"; `ai-tools.mdx` and `ai-usage-chargeback.mdx` are in no sidebar group; `mobile.mdx` never mentions Wisp.

## 3. Where the product contradicts the website glossary

`docs/glossary.md` (website, adopted 2026-10-24) says it is "the single source for product nouns on breezermm.com … in docs and in release notes". The product is not in its scope, but the website makes claims about the product that the product has to keep.

| Glossary rule | Product today | Consequence |
|---|---|---|
| **Operators are people. Never software.** "AI operator" is retired. | Nav "Operator", "AI Operator", "Delegate to Operator", "Plan for AI Operator task". | A prospect reads "operators run Breeze" on the site, then meets "the Operator" as a bot in the app. Direct contradiction. |
| **"Assistant" only with a product name in front.** Breeze's own AI is not called an assistant. | "AI Assistant" header button, "Breeze AI Assistant" empty state, "AI assistant" in a dozen places; docs page "AI Features: AI assistant…". | Contradiction. |
| **The workers** = the built-in AI. "In-product today: Settings → AI Brain." | Neither "the workers" nor "AI Brain" appears anywhere in product copy (web, mobile, or docs). The nearest things are "Fleet Orchestration" and the Settings "AI" group. | The website promises a label that does not exist. Either the product adopts "Workers" or the site drops the claim. |
| **"Agent" never bare**: endpoint agent, specialist agents, AI client. | "AI Agents", "AI Agent Runs" (qualified, acceptable); but the docs sidebar group "Agent" is the endpoint agent, and `ai.mdx` calls the Helper chat the "Helper AI agent". Wisp's "specialists" are request kinds (sweep, analysis, operator_recipe…), not the agents. | "Specialist" means two things across site and app. |
| **Workspace** = "the document-style working surface in ee/ (Notion-like) where … Wisp is chatted with". | There is no such surface. `ee/workspace` is a file/email **knowledge connector** (pgvector index) now labelled "Wisp Sources / Wisp Dashboard". `/workspace` was the multi-tab chat and now redirects to `/wisp/chat`. | The glossary entry is wrong about the product. See §12. |
| **Wisp runs only on Breeze Cloud; self-hosted installs show Wisp locked, with the reason.** | When `BREEZE_WISP_ENABLED` is off, the "Wisp" nav entry still shows and `/wisp` forwards to the generic multi-tab chat titled "Wisp chats". Locked state exists only for the plan gate. | Self-hosters see a page called Wisp that is not Wisp. |
| **Approval card**, **spend meter**, **the brief / the thread / a nudge**, **grant**, **standing instruction** | Present and consistent inside Wisp. | Good. Keep. |
| **Breeze Assist** = the end-user chat in Breeze Helper. | Helper copy says "Breeze Assist"; `ai.mdx` says "Helper AI Chat"; env docs say "helper (Breeze Assist)". | Minor; docs sweep. |

## 4. The model the product should present

Use the sentence as the information architecture.

```
Operators run Breeze.            → people, roles, permissions, Approvals (you hold them)
The workers do the work.         → the built-in AI everyone has:
                                    Breeze AI (the chat door) · Agents (the roster) ·
                                    Runs · AI Tasks (today's Operator) · Library (recipes)
Wisp runs your day.              → one per person, hosted: home · thread · brief ·
                                    nudges · memory · grant · spend meter
Governance                       → Risk engine · Approvals · Budgets & usage ·
                                    Providers & models · Tool sources · Kill switch · Audit
Doors for other people           → Breeze Helper / Breeze Assist (end users on the device)
                                    Breeze AI for Office (end users in Office)
                                    MCP server (AI clients) · Mobile
```

Relationships the UI should make visible, because they are already true in the engine:

- Wisp **sits above** the workers (spec §2 non-goals). When Wisp hands work to a specialist, the result is an agent run or a task, and the run/task page says "Wisp for Sam". So Wisp's home should link down into the workers' pages, and the workers' pages should never need to explain Wisp.
- The Operator is **not** a separate actor. A task is "handled by" an agent (the admitting agent). So "Operator" can disappear from copy without losing anything: the noun the user needs is **AI task**, and the home for AI tasks belongs beside runs. The qualifier is not optional: "Tasks" alone reads as ticket tasks and checklists in a product that is also a PSA (Todd, 2026-10-25).
- There is **one** approval object and one Approvals page. Every AI surface should say "Approvals" and link there.
- There is **one** chat conversation model (a conversation moves between side panel and full page without duplication). So there is one door, which speaks as Wisp when the person has a Wisp and as Breeze AI when they do not.

## 5. Proposed navigation

### Before (12 entries + 3 elsewhere + 2 under Extensions)

See §2.1.

### After

```
AI
  Wisp                      /wisp          (locked, with the reason, when not hosted / not on plan / partner switch off)
  Breeze AI                 /ai/chat       (the full-page multi-tab chat; today /wisp/chat)
  Workers
    Agents                  /settings/ai-agents → consider /ai/agents  (roster + builder)
    Runs                    /ai-agents/runs
    AI Tasks                /operator      (today "Operator"; Library stays as a tab)
    Impact                  /ai-agents/impact
  Breeze AI for Office      /ai-for-office (partner scope; or move to a "For your clients" group with Helper policy)

Security
  Approvals                 (stays top-level; it is the one inbox)
  AI Risk                   (stays)

Settings → AI               (one home; add "AI" to the Settings sidebar)
  Providers & models · Usage & budgets · Script authoring · Tool sources · Wisp memory · Knowledge sources (ee)

Administration              (unchanged: LLM Provider Catalog, AI Models, AI Kill Switch, Wisp)
```

Folded, not deleted:

- **Fleet Orchestration** → its findings feed becomes a tab on **Runs** ("Findings") or a section of the Wisp brief; its "AI Fleet Actions" button is just the chat door. The word "orchestration" and the docs' "Brain" are retired (the website already retired "the brain").
- **Fix memory** and **Fleet Design** → reached from their agents on the roster and from runs ("Open report"), not top-level. They are outputs, not destinations.
- **Wisp Dashboard / Wisp Sources** (ee) → "Knowledge sources" under Settings → AI (and linked from the Wisp home). Out of the Extensions section, off the Puzzle icon. The device tab "Wisp" (file index) → "Knowledge".

Net: 12 visible AI entries → 7, and every remaining entry is a place to do something.

Navigation registration is enforced by `settingsPageRegistry.test.ts`; the settings-catalogue "AI" group and the command palette (which hard-codes `wispEnabled: false`) move in the same PR.

## 6. Vocabulary for the product

Mirror of the website glossary, applied to in-app copy. Internal identifiers (`ai_operator_*`, `workspace_*`, `aiOperator` namespace, routes) do not change; this is copy and nav only, which is how W08 handled `ee/workspace`.

| Concept | Write it as (product) | Retire in visible copy |
|---|---|---|
| The chat door | **Breeze AI** (panel, header tooltip "Breeze AI (⌘⇧A)", full page "Breeze AI"), speaking as **Wisp** when the person has a grant | AI Assistant, Breeze AI Assistant, AI assistant, the assistant, AI chat, Breeze AI chat, "Wisp chats" for non-Wisp users |
| The built-in AI collectively | **the workers** (nav group "Workers", empty states: "the workers investigate…") | AI Brain, Fleet Orchestration Brain, "the AI" where a noun is needed |
| A named AI worker with a policy | **agent** (always under the Workers heading or as "AI agent"; roster page "Agents") | bare "agent" outside that context; "Operator" as an actor |
| Wisp's bounded delegation | **specialist** only when it is one of the roster agents doing the work ("handed to the patching agent"); request kinds stay internal | "Specialist requests" as an admin column → "Work handed off" |
| One bounded pass | **run** | analysis run / remediation run as distinct nouns (qualify the run, do not rename it) |
| A long-running, multi-step job | **AI task**, always qualified (home "AI Tasks"; "Start an AI task" replaces "Delegate to Operator"; device tab "AI Tasks"; "Plan for AI task"; ticket checklist "AI task step"; "Handled by {{agent}}" stays) | Operator, AI Operator, workflow, bare "task" (ticket tasks and checklists own that word) |
| A task template | **recipe** (Library) | workflow |
| Wisp's own run | **check** (home, activity, admin "Checks today") | assessment |
| A conversation | **conversation** (side panel), **chat** only as the tab noun, **thread** only for Wisp's one durable thread | session (except AI for Office, which is a different product), delegation |
| Deciding | **Approve / Deny**, status **Denied**; the place is **Approvals** (never "inbox" alone) | Reject, Decline, Approval refused, "approve in inbox" |
| Standing authority | **always allow** (per tool, pre-authorization), **promote** (agent graduation), **grant** (Wisp) — three real things, each explained once in its own place | pre-authorization as a user-facing word |
| Spend | **usage** (what was spent), **budget** (the cap), **credits** (prepaid balance, hosted), dollars everywhere | cents on the Wisp meter, "exposure budget" → "action budget", "Budget and reach" |
| Tiers | the four tiers named the same way everywhere: **Tier 1 reads · Tier 2 acts and logs · Tier 3 asks first · Tier 4 blocked**; translate `tierConfig.ts` | "Auto-Execute + Audit", "1 / 2 / 3" without the tier word |
| The ee indexer | **knowledge sources** / **Wisp's knowledge** | Workspace, Wisp Sources, Wisp Dashboard, "Workspace content enrichment", device tab "Wisp" |
| End-user chat on the device | **Breeze Assist** (inside Breeze Helper) | Helper AI Chat, Helper AI agent |
| Clients' AI in Office | **Breeze AI for Office** | AI for Office alone in nav |

Guard it: add `apps/web/src/lib/__tests__/aiVocabulary.test.ts` that scans the en locale JSON (and the hard-coded titles in `pages/operator/*`, `ai-risk/tierConfig.ts`) for the retired phrases, the way the website's `claimsGuard.test.ts` does. Without a guard the next wave reintroduces "AI Assistant" on day one.

## 7. One chat door, one voice

Today the side panel offers a **Turn on Wisp** toggle inside the Breeze AI conversation, the full page is called **Wisp chats** whether or not Wisp exists, and the Wisp home has a third conversation ("Talk to Wisp"). The Wisp spec's own line was "one place to talk, not two" (§5); §17.2 then produced three.

Proposal:

- **No Wisp grant** (Community, self-hosted, no plan, partner switch off): the panel and the full page are **Breeze AI**. No Wisp toggle. The Wisp nav entry is present but **locked with the reason**, exactly as the website promises.
- **Wisp grant held**: the panel **is Wisp**. Its header says Wisp, the thread is the one durable thread, and "Open in Wisp" goes to the home. The full page becomes "Wisp" with the home sections and the thread; the multi-tab page is reachable as **All chats** from the home (as today) but is not a nav entry.
- The person never chooses between two AIs in one box. Whether the voice is Wisp is decided by the grant, not a toggle. Pausing Wisp (A29) is the control that already exists for "not now".

What this costs: the WispToggle in `components/ai/`, the nav entry logic in `Sidebar.tsx`, the `/wisp` forward rule, `pages/wisp/*` titles. The conversation model (move between panel and page) is untouched.

## 8. Public docs

Apply the same three layers to `apps/docs/astro.config.mjs`:

- **AI** (one group, not two): Overview (the sentence and the diagram in §4), Breeze AI (today's `ai.mdx` chat section), Wisp, The workers (Agents, Runs, Tasks and recipes, Analysis runs, Impact), Governance (AI Risk, Approvals, budgets and usage, models and providers, tool sources, kill switch), For other people (Breeze Assist, Breeze AI for Office, MCP server), Reference (ai-tools, chargeback).
- Rename `ai.mdx` from "AI Features" and remove "Fleet Orchestration Brain" from it.
- Fix the docs home cards ("AI Assistant" → the sentence), `reference/api.mdx` "AI Assistant" heading, the device-feed Operator link target, and add Wisp to `mobile.mdx`.
- Resolve the `/workspace` redirect statement: spec says `/wisp`, docs and code say `/wisp/chat`. Code wins; fix the W08 plan text.

## 9. Sequencing and blast radius

| PR | Scope | Blast radius | Notes |
|---|---|---|---|
| 1. Vocabulary | en locale JSON in web + mobile, hard-coded titles, the vocabulary guard test, all 8 locales | Low (copy). `humanizedKeyBaseline.json` and `localeParity` will need updating. | Lands first; unblocks everything else. One PR per family (chat names; Operator → task; approve/deny; spend; tiers) keeps review tractable. |
| 2. Navigation | `Sidebar.tsx`, `settingsCatalog.ts`, `tabRegistry.ts`, command palette, `settingsPageRegistry.test.ts`, route redirects for folded pages | Medium (nav + tests). | Keep old routes as redirects. Fleet findings → Runs tab is the only real UI move. |
| 3. Chat door | WispToggle removal, grant-driven voice, `/wisp` forward rule, locked state when the deployment flag is off | Medium (touches W04/W08 code; entitlement logic unchanged). | Product decision §11.4 first. |
| 4. Knowledge connector relabel + move | `ee/workspace/manifest.json` labels, device tab, AI-models settings note, Helper string (#10114) | Low. | Table names stay `workspace_*` (SDK rule). |
| 5. Docs IA | `apps/docs` sidebar + the pages in §8 | Low. | `update-breeze-docs` skill. |
| 6. Website corrections | `docs/glossary.md` Workspace entry; the "Settings → AI Brain" sentence on `/features/ai-brain/`; the claims guard if "Workers" becomes a product label | Low. | §12. |

None of this touches tenancy, migrations, auth or the agent. All of it is before the Wisp release, which is the right moment: Wisp has not shipped (#9906 closed 10-26, unreleased), so no customer has learned the current names.

## 10. What not to do

- Do not rename database tables, route namespaces, locale namespaces or extension manifest names. W08 established copy-only relabelling and the SDK table-prefix rule depends on it.
- Do not make the Wisp home a dashboard (spec §17.2 anti-goal). Folding Fleet findings into the **brief** is fine; folding the findings *feed* into the home is not.
- Do not hide Wisp when it is unavailable. Locked with the reason is the published promise.
- Do not introduce a new umbrella brand ("Breeze Intelligence", "Copilot"). The sentence already is the brand; one more noun is the problem, not the cure.

## 11. Decisions

Todd accepted the assessment and recommendations 2–5 on 2026-10-25 ("all good and what we need") and amended 1 as recorded below.

1. **What does the Operator surface become in product copy?** Todd (2026-10-25): not bare "Tasks", it could be PSA. Candidates checked against existing nouns:
   - **AI Tasks** — qualified the way AI Agents, AI Impact, AI Usage and AI Risk already are; unmistakably not a ticket task; the unit noun "AI task" survives outside the AI section (device tab, alert button, ticket checklist). **Recommend.**
   - *Recipes* — the glossary's own word for the templates, and unmistakably AI. Under-describes the page, which is mostly running work, and still needs a noun for the running instance ("a recipe in progress"), which drifts back to task or run.
   - Rejected: *Jobs* (patch jobs, script jobs, BullMQ jobs); *Handoffs* (the Operator spec's terminal state "handed off to a technician"); *Delegations* (Wisp's grant copy already says "delegation"); *Cases*, *Work orders*, *Assignments* (PSA words); *Operations* (the Operator spec's name for the real effects); *Missions*, *Errands* (against the no-hype voice).
   - Keeping "Operator" and amending the website rule was the fallback; it undoes the 10-24 decision and leaves "operator" meaning two things forever.
2. **What is the chat door called?**
   - *Breeze AI*, speaking as Wisp when a grant exists — already the most common in-product name, the add-in name, and the incident-log actor. **Recommend.**
   - *Ask Breeze* — the mobile placeholder; reads as a verb, awkward as a page title.
   - Keep "AI Assistant" and amend the glossary — contradicts the site.
3. **Does "Workers" become a nav heading?** The website states the word maps to the product. Yes makes the sentence literally the sidebar. **Recommend yes**, as a group heading only (never a page called "Workers").
4. **One voice in the panel (grant-driven), or keep the Wisp toggle?** **Recommend grant-driven**, per spec §5 "one place to talk, not two".
5. **Do the roster agents take the website word "specialists"?** The site says "the specialist agents inside the workers"; the app's "specialist" is a Wisp request kind. **Recommend**: keep "agents" as the roster noun in product, say "hands work to an agent" in Wisp copy, and change the website's "specialist agents" to "the agents" or keep it as marketing gloss only. Either way, pick one.

## 12. Corrections owed to the website glossary

1. **Workspace.** The entry describes "a Notion-type UI where a Breeze user or an end user works and consults Wisp". No such surface exists. `ee/workspace` is the file-and-email knowledge connector; `/workspace` was the chat page. Rewrite as "Wisp's knowledge connector (file and email sources), hosted only" or drop the entry per the glossary's own rule that Workspace is named only where the surface is described. The ruling "Workspace is Wisp's working surface" (Rulings §1) inherits the error.
2. **"In the product, the workers live under Settings → AI Brain"** (`/features/ai-brain/` body and the glossary "In-product today" column). There is no "AI Brain" label in the product. Replace with the nav location once §11.3 is decided, or delete the sentence.
3. **"Specialist agents"** vs the product's "agents" / Wisp "specialists" (§11.5).
4. If "Breeze AI" becomes the chat door, add it to the glossary's "The AI, by name" table so the claims guard stops nothing it should allow.
