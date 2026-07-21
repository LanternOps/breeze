# The True Cost of RMM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a data-driven RMM pricing index blog post on breezermm.com/blog backed by verified research data, plus an outreach playbook document for distribution.

**Architecture:** Single long-form markdown blog post in the existing Astro content collection at `/Users/toddhebebrand/breezermm.com website/src/content/blog/`. Data sourced from the Excel research workbook. Outreach playbook saved as a separate doc. No infrastructure changes needed — the blog is already built.

**Tech Stack:** Markdown (Astro content collection), existing `[slug].astro` template, data from `true_cost_of_rmm_research_apr_2026.xlsx`

**Spec:** `docs/superpowers/specs/2026-04-04-rmm-cost-report-design.md`

**Data source:** `/Users/toddhebebrand/Documents/true_cost_of_rmm_research_apr_2026.xlsx` (13 sheets, 91 sources)

---

## Existing Content Context

The breezermm.com blog already has 33 posts. Two related posts exist:
- `best-rmm-for-small-msp-2026.md` — recommendation piece for small MSPs, not a pricing index
- `open-source-rmm-tools-complete-guide.md` — open-source comparison (MeshCentral, TacticalRMM, Breeze)

This report is differentiated: it's a **neutral pricing index** with acquisition context and hidden cost analysis. Not a recommendation. Not a Breeze pitch. Data-first, narrative-supported.

**Blog post conventions** (from existing posts):
- Frontmatter: `title`, `description`, `author`, `pubDate`, `tags`, `image`, `imageAlt`
- Author: `"Todd Hebebrand"`
- Tags use lowercase kebab-case
- Markdown with `---` horizontal rules between major sections
- Long-form editorial voice — direct, opinionated, evidence-backed
- No Breeze pitch in body text; the BlogCTA sidebar component handles that automatically

---

## Task 1: Write the Blog Post — Opening Section

**Files:**
- Create: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

- [ ] **Step 1: Create the blog post file with frontmatter and opening section**

Write the file with this exact frontmatter and the opening ~400 words:

```markdown
---
title: "The True Cost of RMM in 2026: Annual Pricing Index"
description: "Verified pricing for 25+ RMM platforms with hidden cost analysis, acquisition context, and total cost of ownership calculations for MSPs at every scale."
author: "Todd Hebebrand"
pubDate: "2026-04-XX"
tags: ["rmm", "msp", "comparison", "pricing"]
image: "/images/generated/blog-visuals/true-cost-rmm-2026.png"
imageAlt: "RMM pricing comparison showing cost per endpoint across major platforms"
---
```

The opening section (~400 words) should cover:
- The MSP tool stack as largest operating expense after payroll
- $13B+ in acquisitions consolidating the market under 3-4 PE firms
- Pricing opacity — most major vendors require "contact sales"
- What this report is: verified pricing for 25+ platforms, hidden cost analysis, acquisition context, TCO at scale
- Methodology note: sources include official pricing pages, contract terms (linked), G2/Capterra, r/msp community reports. 91 sources total. All data verified as of April 2026.
- Note that this is a living report — last updated date, corrections welcome

Key data points to weave into the opening (from the research workbook):
- Combined PSA + RMM market: $388M in Q2 2024 (Canalys via ChannelE2E)
- Top 5 vendors hold 2/3+ of market: ConnectWise 24.3%, Kaseya 22.7%, N-able 11.4%, NinjaOne 9.4%
- ~45,000 pure-play MSPs globally, ~90,000 at looser threshold (Canalys)
- Industry benchmark: 350 fully managed endpoints per technician

Write in the same voice as existing posts — direct, opinionated, evidence-backed. No hedging.

- [ ] **Step 2: Verify the file renders**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && npx astro build 2>&1 | tail -20
```

Expected: Build succeeds, new post appears in output.

- [ ] **Step 3: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add src/content/blog/true-cost-of-rmm-pricing-index-2026.md && git commit -m "blog: add opening section for RMM pricing index report"
```

---

## Task 2: Write Platform Profiles — PE-Owned Incumbents

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources (from workbook):**
- `Commercial_Pricing` sheet — rows for ConnectWise Automate, ConnectWise RMM, Datto RMM, Kaseya VSA, N-able N-central, N-able N-sight
- `Hidden_Costs` sheet — ConnectWise (6 entries), Kaseya/Datto (7 entries), N-able (3 entries)
- `Acquisitions_Timeline` sheet — Thoma Bravo→ConnectWise, Kaseya→Datto, N-able spin-off
- `Community_Sentiment` sheet — ConnectWise RMM, Datto RMM, Kaseya VSA, N-central ratings
- `Cost_Model` sheet — all are "quote-only" so TCO tables show "Quote required"

- [ ] **Step 1: Write the ConnectWise section**

Section structure:
```markdown
---

## ConnectWise Automate & ConnectWise RMM

*Thoma Bravo. Acquired 2019 for ~$1.5B. ~110 positions cut on deal announcement.*
```

Include:
- **Ownership**: Thoma Bravo PE acquisition, two separate RMM products (Automate = legacy, RMM = former Continuum), Axcient + SkyKick acquisitions in 2024
- **Pricing**: Quote-only. No public per-endpoint price. Companion pricing exists (ScreenConnect: $33.60/mo single session, $52.90/mo three sessions, unattended access $0.60/endpoint/mo)
- **Hidden costs** (from Hidden_Costs sheet, all High confidence, sourced from official contract terms):
  - Auto-renews for equal term or one year, whichever shorter; requires 60-day non-renewal notice
  - Per-unit pricing may increase at renewal; promotional pricing increases at renewal
  - Quantities cannot be decreased during term (can't right-size after client churn)
  - Fees are non-cancellable and non-refundable
  - Scripts/connectors/customizations may require paid professional services
  - Admin coursework required to unlock certain support paths
- **Community sentiment**: Capterra 4.2/5, 3.7/5 customer service, 5.8/10 recommend. r/msp complaints about 10-12% annual increases and worse support post-Thoma Bravo.
- **TCO**: Quote required — cannot calculate without direct sales engagement
- Source URLs from workbook

- [ ] **Step 2: Write the Kaseya / Datto RMM section**

```markdown
---

## Kaseya VSA & Datto RMM

*Kaseya (Insight Partners). Datto acquired 2022 for $6.2B. 18 acquisitions over ~10 years.*
```

Include:
- **Ownership**: Insight Partners backing, $6.2B Datto deal, 18 total acquisitions (Vonahi, Graphus, audIT, Arcode, SaaS Alerts), IT Complete / Kaseya 365 bundling strategy
- **Pricing**: Both quote-only. Kaseya 365 Endpoint bundle is the pushed package. Datto ended high-water-mark billing in Dec 2025, moved to CMQ + variable consumption.
- **Hidden costs** (from Hidden_Costs sheet, all High confidence):
  - Subscriptions auto-renew for equal committed term/quantity unless cancelled
  - Early termination during committed term = 100% of remaining fees accelerated
  - CMQ floor: quantities can increase but cannot decrease below committed minimum
  - Billing model shift: HWM→CMQ means customers used to elastic billing face higher floors
  - Auto-added licenses: Datto RMM, Advanced Software Management, Ransomware Detection can auto-add when usage triggers
  - Bundle pressure: Kaseya 365 Endpoint pushed over standalone; standalone available in theory but economically pressured
- **Community sentiment**: Datto RMM Capterra 4.3/5, 4.0/5 service, 6.5/10 recommend. Kaseya VSA Capterra 4.0/5, 3.6/5 service, 5.9/10 recommend. r/msp: 5-8% renewal increases, pressure toward multi-year terms.
- **TCO**: Quote required
- Source URLs from workbook

- [ ] **Step 3: Write the N-able section**

```markdown
---

## N-able N-central & N-sight

*Spun off from SolarWinds July 2021. Public company (NYSE: NABL). Adlumin acquired for up to $266M (2024).*
```

Include:
- **Ownership**: SolarWinds spin-off context (post-breach), public company, Silver Lake + Thoma Bravo investors, stock decline from ~$2.5B market cap to $4.66/share (March 2026), Adlumin acquisition
- **Pricing**: Both quote-only. N-central = enterprise, N-sight = SMB.
- **Hidden costs** (from Hidden_Costs sheet, High confidence):
  - Renewal commitment ratchet: prior commitment + 80% of overage rolled into next renewal
  - Commitment changes only once per year; cannot reduce fees mid-year
  - r/msp reports forced 1-3 year commitments
- **Community sentiment**: N-central Capterra 4.1/5. Pricing less transparent than newer competitors.
- **TCO**: Quote required
- Source URLs

- [ ] **Step 4: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add PE-owned incumbent platform profiles (ConnectWise, Kaseya, N-able)"
```

---

## Task 3: Write Platform Profiles — NinjaOne

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Commercial_Pricing` sheet — NinjaOne row
- `Cost_Model` sheet — NinjaOne indicative floor ($1.50/endpoint at 10K) and ceiling ($3.75/endpoint at ≤50)
- `Acquisitions_Timeline` sheet — Dropsuite ($270M), NinjaOne F1 entry
- `Market_Data` sheet — $5B valuation, $500M+ ARR, ~70% YoY growth, 9.4% market share

- [ ] **Step 1: Write the NinjaOne section**

```markdown
---

## NinjaOne

*Private. $5B valuation. $500M+ ARR. ~70% YoY growth. Audi F1 sponsor (2026).*
```

Include:
- **Ownership**: Private company, $783M total raised, Series C extension $500M (Feb 2025) led by ICONIQ Growth and CapitalG (Alphabet), 9.4% market share and growing fastest among top 5
- **The F1 angle**: Multi-year Audi Revolut F1 partnership announced Jan 2026. NinjaOne manages endpoints and systems across factory and trackside globally. Sponsorship value not publicly disclosed. Context: MSPs paying per-endpoint fees are funding an F1 sponsorship.
- **Dropsuite acquisition**: ~$270M (completed June 2025). SaaS backup (M365, Google Workspace). Rebranded to "NinjaOne SaaS Backup." Adds backup bundle revenue.
- **Pricing**: Partial public range. Published benchmarks: ~$3.75/device/mo at ≤50 endpoints, ~$1.50/device/mo at 10,000 endpoints. Exact tier schedule not publicly posted. Free onboarding and training. No maintenance fees. Cancel with 60 days' notice if not in promotional commitment.
- **TCO at scale** (from Cost_Model, using published range):

| MSP Size | Endpoints | Monthly (floor) | Monthly (ceiling) | Annual (floor) | Annual (ceiling) |
|----------|-----------|-----------------|-------------------|----------------|------------------|
| Solo | 50 | $75 | $188 | $900 | $2,250 |
| Small | 250 | $375 | $938 | $4,500 | $11,250 |
| Mid | 1,000 | $1,500 | $3,750 | $18,000 | $45,000 |
| Growth | 5,000 | $7,500 | $18,750 | $90,000 | $225,000 |
| Large | 10,000 | $15,000 | $37,500 | $180,000 | $450,000 |

- Note: actual pricing falls somewhere in this range based on negotiation, volume, and bundled products. The spread itself is the story — a 2.5x difference between floor and ceiling.
- Source URLs

- [ ] **Step 2: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add NinjaOne platform profile with pricing range and F1 context"
```

---

## Task 4: Write Platform Profiles — Transparent-Pricing Challengers

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Pricing_Details` sheet — Atera (3 tiers), Syncro (2 tiers), SuperOps (3 tiers), Level, Action1, Gorelo
- `Cost_Model` sheet — calculated TCO for all scenarios
- `Hidden_Costs` sheet — SuperOps (2 entries), Pulseway (2 entries), Action1 (1 entry)
- `Community_Sentiment` sheet — relevant entries

- [ ] **Step 1: Write the Atera section**

```markdown
---

## Atera

*Private. $500M valuation (2021). $182M total funding. Per-technician pricing pioneer.*
```

Include:
- **Pricing** (all High confidence, from Pricing_Details):

| Plan | Monthly | Annual-effective | Includes |
|------|---------|-----------------|----------|
| Pro | $159/tech | $129/tech | RMM, monitoring, alerts, PSA/helpdesk, billing, reporting |
| Growth | $209/tech | $179/tech | Adds advanced automation/analytics |
| Power | $249/tech | $209/tech | Higher-tier bundle |
| Superpower | Quote-based | Quote-based | Enterprise |

- No endpoint cap, monthly or annual billing, AI Copilot varies by tier/add-on
- **TCO at scale** (from Cost_Model):

| MSP Size | Endpoints | Techs | Pro Monthly | Pro Annual | $/endpoint |
|----------|-----------|-------|-------------|------------|------------|
| Solo | 50 | 1 | $129 | $1,548 | $2.58 |
| Small | 250 | 3 | $387 | $4,644 | $1.55 |
| Mid | 1,000 | 8 | $1,032 | $12,384 | $1.03 |
| Growth | 5,000 | 20 | $2,580 | $30,960 | $0.52 |
| Large | 10,000 | 40 | $5,160 | $61,920 | $0.52 |

- **The per-tech math**: At scale, per-technician destroys per-endpoint on cost. At 10,000 endpoints / 40 techs, Atera Pro is $0.52/endpoint — cheaper than any per-endpoint vendor's floor price. But at solo scale (50 endpoints / 1 tech), it's $2.58/endpoint.

- [ ] **Step 2: Write the Syncro section**

```markdown
---

## Syncro

*Recently rebranded to "Syncro XMM." Combined PSA + RMM. Per-technician pricing.*
```

Include:
- **Pricing** (High confidence):

| Plan | Monthly | Annual-effective | Includes |
|------|---------|-----------------|----------|
| Core | $159/tech | $129/tech | Unlimited endpoints, PSA + RMM core |
| Team | $209/tech | $179/tech | Unlimited endpoints, expanded features |

- Cloud Backup add-on: $1.90/user/mo
- **TCO at scale**: Identical to Atera at same tier prices. Unlimited endpoints means no overage math.
- Per-endpoint effective cost table (same as Atera)

- [ ] **Step 3: Write the SuperOps section**

```markdown
---

## SuperOps

*$54.4M total funding. Series C $25M (Jan 2025). AI assistant "Monica." Per-technician with endpoint packs.*
```

Include:
- **Pricing** (High confidence):

| Plan | Monthly/tech | Included endpoints/tech | Extra 150-endpoint pack |
|------|-------------|----------------------|----------------------|
| Standard RMM-only | $109 | 150 | $75 |
| Pro | $149 | 150 | $75 |
| Super | $179 | 150 | $75 |

- **Hidden cost**: Everyone in a portal must be on the same plan (mixed-role teams may overbuy). Above 150 endpoints/tech, $75 per additional 150-endpoint pack.
- **TCO at scale** (from Cost_Model):

| MSP Size | Endpoints | Techs | Standard Monthly | Standard Annual |
|----------|-----------|-------|-----------------|----------------|
| Solo | 50 | 1 | $109 | $1,308 |
| Small | 250 | 3 | $327 | $3,924 |
| Mid | 1,000 | 8 | $872 | $10,464 |
| Growth | 5,000 | 20 | $3,230 | $38,760 |
| Large | 10,000 | 40 | $6,385 | $76,620 |

Note: Growth and Large include endpoint overage packs.

- [ ] **Step 4: Write the Level section**

```markdown
---

## Level

*Modern, security-focused RMM. P2P encrypted. Cloud-native. No contracts.*
```

Include:
- **Pricing** (High confidence): $2/endpoint/month after first 10 free forever. No contracts, no minimums, no hidden fees, no setup charges.
- **Counter-example**: Level is the transparency benchmark. Explicitly no lock-in.
- **TCO at scale**:

| MSP Size | Endpoints | Monthly | Annual | $/endpoint |
|----------|-----------|---------|--------|------------|
| Solo | 50 | $80 | $960 | $1.60 |
| Small | 250 | $480 | $5,760 | $1.92 |
| Mid | 1,000 | $1,980 | $23,760 | $1.98 |
| Growth | 5,000 | $9,980 | $119,760 | $2.00 |
| Large | 10,000 | $19,980 | $239,760 | $2.00 |

- [ ] **Step 5: Write the Action1, Gorelo sections**

**Action1:**
- $4/endpoint/month after first 200 free. Patch management focused. Public tier caps at 1,000 endpoints — enterprise is custom. 127% YoY revenue growth.
- TCO: Solo=free (50 endpoints within free tier), Small=$200/mo ($2,400/yr), Mid=$3,200/mo ($38,400/yr). Growth/Large=quote required.

**Gorelo:**
- $99/user/month billed yearly. All-in-one PSA + RMM + Documentation + AI.
- TCO: Solo=$99/mo ($1,188/yr), Small=$297/mo ($3,564/yr), Mid=$792/mo ($9,504/yr), Growth=$1,980/mo ($23,760/yr), Large=$3,960/mo ($47,520/yr)
- Effective $/endpoint: $1.98 solo → $0.40 large. Cheapest per-tech option in the dataset.

- [ ] **Step 6: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add transparent-pricing challenger profiles (Atera, Syncro, SuperOps, Level, Action1, Gorelo)"
```

---

## Task 5: Write Platform Profiles — Adjacent Platforms

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Pricing_Details` sheet — Hexnode (3 tiers), Microsoft Intune, M365, JumpCloud
- `Cost_Model` sheet — calculated TCO
- `Hidden_Costs` sheet — Pulseway, ManageEngine, TeamViewer, JumpCloud entries

- [ ] **Step 1: Write the Microsoft Intune / M365 section**

```markdown
---

## Microsoft Intune & M365

*Microsoft. Not an MSP tool — but increasingly what MSPs are asked about.*
```

Include:
- **Pricing** (High confidence, per-user):

| Plan | Monthly/user | Notes |
|------|-------------|-------|
| Intune Plan 1 | $8 | Standalone UEM |
| M365 Business Premium | $22 | Includes Intune + far more |
| M365 E3 | $36 | Enterprise bundle |
| M365 E5 | $57 | Full security bundle |

- **Context**: Intune is not an RMM. No scripting engine, no PSA, no multi-tenant MSP dashboard, no remote access built in. But it's what enterprise IT teams use, and MSPs increasingly encounter it at larger clients. At $8/user for standalone Intune, the math is brutal at scale: $80,000/month for 10,000 endpoints.
- **TCO**: Solo=$400/mo, Small=$2,000/mo, Mid=$8,000/mo, Growth=$40,000/mo, Large=$80,000/mo (Intune Plan 1 only)

- [ ] **Step 2: Write the JumpCloud section**

```markdown
---

## JumpCloud

*Directory-first platform with device management. Per-user pricing.*
```

Include:
- **Pricing** (High confidence): Device Management at $9/user/month (annual). Free tier (10 users/10 devices) is grandfathered — only for customers who signed up before current pricing. Many comparison posts overstate current free value.
- **TCO**: Solo=$450/mo, Small=$2,250/mo, Mid=$9,000/mo. Expensive at scale for pure endpoint management.

- [ ] **Step 3: Write the Hexnode section**

```markdown
---

## Hexnode

*UEM platform. Per-endpoint pricing with technician bundles.*
```

Include:
- **Pricing** (High confidence):

| Plan | Monthly/endpoint | Included techs | Min devices |
|------|-----------------|----------------|-------------|
| Pro | $2.20 | 2 | 15 |
| Enterprise | $3.20 | 3 | 15 |
| Ultimate | $4.70 | 4 | 15 |

- MSP pricing may differ. Primarily a UEM/MDM platform.

- [ ] **Step 4: Write brief sections for remaining quote-only platforms**

Short paragraphs for each, noting they are quote-only and linking to their pricing/request pages:
- **Pulseway**: Quote/configuration needed. Known for best-in-class mobile app. Hidden costs: one-time €149 advanced onboarding fee, third-party patching is security add-on (OS patching included).
- **ManageEngine RMM Central**: Quote-only. Enterprise-focused, on-premise option. Hidden cost: servers require two licenses per device.
- **TeamViewer**: Add-on dependent. 12-month auto-renewal, 28-day cancellation window. Price increases permitted with notice before renewal — silence = consent.
- **Splashtop**: Add-on dependent. Core remote access price is public, endpoint management modules are add-on.
- **Auvik**: Quote-only. Network-monitoring focused. $33.4M raised.
- **ITarian**: Free to 50 devices, paid tiers opaque. Connected to Comodo/Xcitium ecosystem.
- **LogMeIn Resolve**: Plan-dependent. Modular prices exist but full MSP bundle is custom.
- **Naverisk**: Quote needed. Starts at $110/mo. All-in-one RMM + PSA + Service Desk.

- [ ] **Step 5: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add adjacent platform profiles (Intune, JumpCloud, Hexnode, quote-only platforms)"
```

---

## Task 6: Write the Summary Comparison Tables

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Cost_Model` sheet — all calculated rows and effective $/endpoint table
- `Feature_Matrix` sheet — full 16-platform feature comparison

- [ ] **Step 1: Write the pricing overview table**

```markdown
---

## The Comparison Tables

### Pricing Model Overview
```

Build the master pricing table from Commercial_Pricing and Pricing_Details:

| Platform | Owner | Model | Public Price | Contract | Min Commitment |
|----------|-------|-------|-------------|----------|----------------|
| NinjaOne | Private ($5B) | Per-endpoint | $1.50-$3.75/endpoint/mo | 60-day cancel notice | None published |
| ConnectWise | Thoma Bravo | Per-endpoint | Quote-only | Auto-renew, 60-day notice | Yes (no decrease) |
| Datto RMM | Kaseya | Per-endpoint | Quote-only | Auto-renew CMQ | CMQ floor |
| Kaseya VSA | Kaseya | Per-endpoint | Quote-only | Auto-renew committed | CMQ + 100% termination fee |
| N-able N-central | Public (NABL) | Per-endpoint | Quote-only | Annual commitment | 80% overage ratchet |
| Atera | Private ($500M) | Per-technician | $129-$209/tech/mo | Monthly or annual | None |
| Syncro | Private | Per-technician | $129-$179/tech/mo | Monthly or annual | None |
| SuperOps | Private ($54M) | Per-tech + packs | $109-$179/tech/mo | Monthly or annual | 150 endpoints/tech |
| Level | Private | Per-endpoint | $2/endpoint/mo | None | None |
| Action1 | Private | Per-endpoint | $4/endpoint/mo (≤1K) | None published | 200 free |
| Gorelo | Private | Per-technician | $99/tech/mo | Annual | None |
| Hexnode | Private | Per-endpoint | $2.20-$4.70/endpoint/mo | Annual | 15 devices |
| Intune | Microsoft | Per-user | $8/user/mo | M365 terms | None |
| JumpCloud | Private | Per-user | $9/user/mo | Annual | None |

Add editorial note: "Seven of the top ten RMM platforms by market share do not publish pricing. You cannot comparison shop without calling sales."

- [ ] **Step 2: Write the TCO by MSP size table**

Build from Cost_Model sheet. Only include platforms with public pricing:

| Platform | Plan | Solo (50) | Small (250) | Mid (1K) | Growth (5K) | Large (10K) |
|----------|------|-----------|-------------|----------|-------------|-------------|
| Gorelo | Launch | $1,188/yr | $3,564/yr | $9,504/yr | $23,760/yr | $47,520/yr |
| SuperOps | Standard | $1,308/yr | $3,924/yr | $10,464/yr | $38,760/yr | $76,620/yr |
| Atera | Pro | $1,548/yr | $4,644/yr | $12,384/yr | $30,960/yr | $61,920/yr |
| Syncro | Core | $1,548/yr | $4,644/yr | $12,384/yr | $30,960/yr | $61,920/yr |
| NinjaOne | Floor est. | $900/yr | $4,500/yr | $18,000/yr | $90,000/yr | $180,000/yr |
| Level | Flat | $960/yr | $5,760/yr | $23,760/yr | $119,760/yr | $239,760/yr |
| Action1 | Growth | Free | $2,400/yr | $38,400/yr | Quote | Quote |
| NinjaOne | Ceiling est. | $2,250/yr | $11,250/yr | $45,000/yr | $225,000/yr | $450,000/yr |

Sorted by annual cost at Mid (1,000 endpoints). Quote-only vendors listed separately below the table with a note.

Add editorial: "At 1,000 endpoints, the cheapest transparent option (Gorelo at $9,504/year) costs less than half of Level ($23,760/year) and potentially less than a quarter of NinjaOne's ceiling estimate ($45,000/year). The per-technician model rewards scale."

- [ ] **Step 3: Write the effective cost per endpoint table**

The break-even analysis from Cost_Model:

| Platform | Plan | Solo $/ep | Small $/ep | Mid $/ep | Growth $/ep | Large $/ep |
|----------|------|-----------|------------|----------|-------------|------------|
| Gorelo | Launch | $1.98 | $1.19 | $0.79 | $0.40 | $0.40 |
| Atera | Pro | $2.58 | $1.55 | $1.03 | $0.52 | $0.52 |
| Syncro | Core | $2.58 | $1.55 | $1.03 | $0.52 | $0.52 |
| Level | Flat | $1.60 | $1.92 | $1.98 | $2.00 | $2.00 |
| NinjaOne | Range | $1.50-$3.75 | $1.50-$3.75 | $1.50-$3.75 | $1.50-$3.75 | $1.50 |

Add editorial: "Per-technician pricing inverts the curve. Per-endpoint is cheaper at small scale but scales linearly. Per-technician is more expensive at small scale but flattens — at 5,000+ endpoints, Atera Pro is $0.52/endpoint while Level is $2.00/endpoint. The break-even point is around 65-90 endpoints per technician depending on tier."

Include the break-even reference from the Cost_Model:
- Atera Pro ($129/tech): breaks even with $1.50/endpoint at 86 endpoints/tech, with $2.00/endpoint at 65, with $3.75/endpoint at 34
- Syncro Core ($129/tech): same break-even as Atera Pro
- Gorelo Launch ($99/tech): breaks even with $2.00/endpoint at 50 endpoints/tech

- [ ] **Step 4: Write the feature parity matrix**

From Feature_Matrix sheet. Use a simplified notation:
- ✓ = Included
- $ = Add-on / paid extra
- ~ = Integration / partner (not native)
- ✗ = Not available

Cover top 8-10 platforms across the 14 feature categories from the spec. Use the exact data from the Feature_Matrix sheet rows.

- [ ] **Step 5: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add summary comparison tables (pricing, TCO, cost/endpoint, feature matrix)"
```

---

## Task 7: Write the Acquisition & Consolidation Section

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Acquisitions_Timeline` sheet — all 7+ entries with deal values, strategic implications, pricing impact, sentiment
- `Market_Data` sheet — market share data, managed services market size
- `Security_Risk` sheet — Kaseya VSA 2021, SolarWinds 2020, ScreenConnect CVEs

- [ ] **Step 1: Write the consolidation narrative (~800-1,000 words)**

```markdown
---

## The Consolidation: $13B+ and Counting
```

Structure:
1. **The timeline** — formatted as a visual list, not a table:
   - 2019: Thoma Bravo acquires ConnectWise (~$1.5B). ~110 positions cut.
   - 2021: N-able spun off from SolarWinds (post-breach context). Begins trading NYSE: NABL.
   - 2022: Kaseya acquires Datto for $6.2B. Insight Partners consortium. Creates largest MSP platform.
   - 2024: ConnectWise acquires Axcient + SkyKick. N-able acquires Adlumin (up to $266M). N-able explores sale but stays independent. ConnectWise CEO change.
   - 2025: NinjaOne acquires Dropsuite (~$270M). Kaseya acquires Arcode + SaaS Alerts (18th acquisition).
   - 2026: NinjaOne announces Audi F1 partnership. $5B valuation. $500M+ ARR.

2. **The PE playbook** — what happens after acquisition:
   - Pricing opacity increases (public pricing → quote-only)
   - Contract terms tighten (auto-renew, termination fees, ratchets)
   - Products get bundled → standalone pricing becomes punitive
   - Support headcount gets optimized → longer ticket times
   - Innovation slows on legacy products → new products get the investment

3. **The ownership map** — who owns what:
   - Kaseya (Insight Partners): Datto RMM, Kaseya VSA, IT Glue, 15+ more. 18 total acquisitions.
   - ConnectWise (Thoma Bravo): Automate, RMM, ScreenConnect, Manage, Axcient, SkyKick
   - N-able (public, Silver Lake + Thoma Bravo investors): N-central, N-sight, Adlumin
   - NinjaOne (private, $5B): NinjaOne platform, Dropsuite

4. **The security cost** — from Security_Risk sheet:
   - Kaseya VSA ransomware-era vulnerability (CVE-2021-30116, 2021)
   - SolarWinds Orion auth bypass (CVE-2020-10148, 2020)
   - ScreenConnect critical auth bypass (CVE-2024-1709, 2024) — 3,400+ vulnerable hosts observed
   - ScreenConnect code injection (CVE-2025-3935, 2025)
   - Editorial: "Your RMM agent runs with elevated privileges on every endpoint you manage. When the vendor's security fails, it fails everywhere at once."

5. **The market reality** — from Market_Data:
   - Top 5 hold 2/3+ of the $388M PSA+RMM market
   - ConnectWise 24.3%, Kaseya 22.7%, N-able 11.4%, NinjaOne 9.4%
   - Managed services market: $548B → $608B (2024-2025)

- [ ] **Step 2: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add acquisition and consolidation section with timeline and security context"
```

---

## Task 8: Write the Open Source & TCO Section

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

**Data sources:**
- `Open_Source_RMM` sheet — 6 platforms with license, status, pricing, hosting notes
- `OpenSource_TCO` sheet — infrastructure costs and deployment scenarios

- [ ] **Step 1: Write the open source section**

```markdown
---

## Open Source & Self-Hosted Alternatives

*The per-endpoint fee is zero. The cost is not.*
```

For each platform, brief profile from Open_Source_RMM sheet:

**Tactical RMM** — Source-available (not OSI-approved open source despite common description). Paid self-host plans: $55/mo (0-199 endpoints), $80/mo (200-499), $100/mo (500-999), $120/mo (1000+). Commercial open-core model. Most mature community-built MSP stack option.

**MeshCentral** — Apache 2.0. Software free. Originally an Intel project. Primarily remote access/management, not full RMM. Typical small deployment: $5-12/mo hosting. Often used alongside TacticalRMM.

**OpenUEM** — Apache 2.0. Launched 2025. SourceForge Rising Star Jan 2026. Asset inventory, remote assistance, software deployment, Windows Update monitoring. SIXE offers professional deployment/support.

**NetLock RMM** — Currently presents as commercial product. Pro at €55/month unlimited devices. German solo developer. Supports air-gapped environments.

**Flamingo / OpenFrame** — Launched from stealth Oct 2025. $2.2M pre-seed. OpenFrame is the open-source core. AI agents (Fae for customer-facing, Mingo for backend). 1,000+ MSP waitlist. Self-hosted free, managed SaaS pricing TBD.

- [ ] **Step 2: Write the self-hosted TCO analysis**

From OpenSource_TCO sheet. Use editable assumptions: $100/hr loaded labor rate, $10/mo infra reserve.

| Scenario | Compute | DB | Other | Maint hrs/mo | Monthly Infra | Monthly Labor | Monthly Total | Annual |
|----------|---------|-----|-------|-------------|--------------|--------------|--------------|--------|
| Lab / Solo | Hetzner CPX21 ($12) | Aiven PG Dev ($5) | $10 | 4 | $27 | $400 | $427 | $5,124 |
| Small Prod | AWS Lightsail 4GB ($20) | DO PG single ($15) | $10 | 6 | $45 | $600 | $645 | $7,740 |
| Mid Prod | Hetzner CPX41 ($39) | DO PG single ($15) | $10 | 8 | $64 | $800 | $864 | $10,368 |
| HA Prod | Hetzner CPX41 ($39) | DO PG HA ($30) | $10 | 12 | $79 | $1,200 | $1,279 | $15,348 |

Editorial: "Open source eliminates the per-endpoint fee but introduces a maintenance tax. At $100/hr loaded labor, 4-12 hours/month of maintenance costs $400-$1,200. For a mid-size MSP (1,000 endpoints), the $864/month self-hosted cost compares favorably to commercial options ($790-$3,750/month depending on vendor). But the comparison only works if you have someone capable of maintaining it. The infrastructure cost is predictable; the labor cost depends entirely on your team."

Note: "These estimates assume you are not also paying for Tactical RMM's commercial license ($55-120/mo). If you are, add that to the infrastructure line."

- [ ] **Step 3: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add open source alternatives and self-hosted TCO analysis"
```

---

## Task 9: Write the Closing Sections

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

- [ ] **Step 1: Write the methodology and sources section**

```markdown
---

## Methodology & Sources

This report uses [XX] sources verified as of April 2026.
```

Include:
- How pricing was verified: official vendor pricing pages, published contract terms, G2/Capterra review data, Reddit r/msp community reports, direct vendor documentation
- For quote-only vendors: clearly marked as quote-only rather than estimated or fabricated
- Confidence ratings: most data points are High confidence (official sources); community sentiment is Medium (aggregator snapshots + anecdotal)
- Living report note: last updated [date], corrections welcome via [GitHub issue / email]
- Full source list: link to or inline the 91 sources from Source_Index sheet, grouped by category

- [ ] **Step 2: Write the CTA / about section**

```markdown
---

## About This Report

This report is published by the team behind [Breeze RMM](https://breezermm.com), an open-source, AI-native remote monitoring and management platform. We built this because we are in the space and this data did not exist in one place.

The report is designed to be useful regardless of which RMM you choose. If you spot an error or your pricing experience differs from what we found, [let us know](mailto:todd@breezermm.com) — corrections make the report better.

If you would like to be notified when we update this report, subscribe below.
```

Note: The BlogCTA sidebar component and subscribe form are already built into the blog template — no additional CTA implementation needed.

- [ ] **Step 3: Verify full build**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && npx astro build 2>&1 | tail -20
```

Expected: Clean build with the new post.

- [ ] **Step 4: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: add methodology, sources, and about section — complete report draft"
```

---

## Task 10: Write the Outreach Playbook Document

**Files:**
- Create: `/Users/toddhebebrand/breezermm.com website/docs/rmm-cost-report-outreach.md`

- [ ] **Step 1: Write the outreach playbook**

This is a standalone document (not a blog post) containing the full distribution strategy from the design spec. Follow the exact format of the Pressless outreach doc at `/Users/toddhebebrand/pressless/docs/wordpress-cost-report-outreach.md`.

Include all tiers from the spec:
- **Tier 1: MSP Industry Publications** — ChannelE2E, Channel Futures, CRN, ChannelPro Network. Customized email template for each with specific angles. Fill in the top findings from the actual report data once written.
- **Tier 2: MSP Communities** — Reddit r/msp (full text post with TCO table), Reddit r/sysadmin (Intune/JumpCloud angle), MSPGeek, Tech Tribe, ASCII Group
- **Tier 3: Tech Communities** — Hacker News (PE consolidation angle), IndieHackers (meta-strategy)
- **Tier 4: Direct Outreach** — Template email, 10-15 target sites to identify via Ahrefs/SEMrush for "RMM pricing" / "best RMM" / "RMM comparison" keywords
- **Tier 5: Syndication** — Medium (canonical URL), dev.to (canonical_url frontmatter), LinkedIn article
- **Tier 6: Surveys** — Tally survey design for MSP Tool Cost Survey
- **Sequencing** — Week 1/2/3 timeline
- **What NOT to do** — Same rules as Pressless playbook

Fill in the email templates with actual data points from the report (e.g., the specific findings that will go in bullet points).

- [ ] **Step 2: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add docs/rmm-cost-report-outreach.md && git commit -m "docs: add RMM cost report outreach and distribution playbook"
```

---

## Task 11: Generate Hero Image

**Files:**
- Create: `/Users/toddhebebrand/breezermm.com website/public/images/generated/blog-visuals/true-cost-rmm-2026.png`

- [ ] **Step 1: Check if blog-infographic-generation skill exists and use it**

The breezermm.com website has a `scripts/` directory and existing generated blog visuals. Check the skill `blog-infographic-generation` for the image generation workflow. If available, use it to generate a hero image matching the style of existing blog visuals.

If the skill is not applicable or the generation pipeline is not set up, create a placeholder note and skip — the post can launch without a hero image (the template handles missing images gracefully).

- [ ] **Step 2: Update frontmatter image path if generated**

Update the `image` field in the blog post frontmatter to point to the generated file.

- [ ] **Step 3: Commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -A public/images/generated/blog-visuals/ src/content/blog/true-cost-of-rmm-pricing-index-2026.md && git commit -m "blog: add hero image for RMM pricing index report"
```

---

## Task 12: Final Review and Polish

**Files:**
- Modify: `/Users/toddhebebrand/breezermm.com website/src/content/blog/true-cost-of-rmm-pricing-index-2026.md`

- [ ] **Step 1: Read the complete post end-to-end**

Read the full blog post file. Check for:
- Consistent voice and tone matching existing posts
- All data points have source citations or are marked as estimates
- Quote-only vendors are never given fabricated prices
- No Breeze pitch in body text (only in the About section at the end)
- Tables render correctly in markdown
- All section anchors work for deep linking
- No broken markdown formatting
- Confidence levels from the workbook are respected (High = stated as fact, Medium = noted as estimate, Low = clearly marked as anecdotal)

- [ ] **Step 2: Cross-reference data against workbook**

Spot-check 5-10 data points from the blog post against the Excel workbook to ensure no transcription errors. Key ones to verify:
- Atera pricing tiers ($129/$179/$209 annual-effective)
- NinjaOne range ($1.50-$3.75)
- Level pricing ($2/endpoint after 10 free)
- Kaseya early termination (100% remaining fees)
- N-able ratchet (80% of overage)
- Market share numbers (ConnectWise 24.3%, Kaseya 22.7%)

- [ ] **Step 3: Verify final build**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && npx astro build 2>&1 | tail -20
```

- [ ] **Step 4: Final commit**

```bash
cd "/Users/toddhebebrand/breezermm.com website" && git add -u && git commit -m "blog: final polish and review of RMM pricing index report"
```
