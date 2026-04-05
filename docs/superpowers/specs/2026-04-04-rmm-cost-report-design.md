# The True Cost of RMM in 2026 — Report & Outreach Design Spec

## Overview

A comprehensive, data-driven pricing index for the RMM market — covering 25+ platforms with verified pricing, ownership context, hidden cost analysis, and total cost of ownership calculations. Published on breezermm.com/blog as Breeze RMM's first content marketing asset, designed to earn backlinks and build MSP community awareness simultaneously.

**Model:** Follows the Pressless WordPress cost report playbook — neutral, data-first research that earns citations and links because the data didn't exist in one place before.

**Approach:** Hybrid (Approach C) — structured like a pricing index, reads like a consolidation narrative. Each platform section opens with ownership/acquisition context, then drops into data tables. The pricing validates the narrative; the narrative makes the pricing shareable.

**Positioning:** Breeze is the author/publisher, not a featured product. Neutral report with a soft CTA at the end. Maximum citation willingness, minimum sales friction.

**Timeline:** Ship fast (1-2 weeks) with V1 covering 8-10 platforms. Expand to 25+ as a living report — each new platform section is its own content moment.

---

## Report Structure

### URL

`breezermm.com/blog/rmm-pricing-costs`

### 1. Opening Section: The Hook (~300-400 words)

Editorial lead framing the problem:

- The MSP tool stack is the largest operating expense after payroll
- $13B+ in acquisitions have consolidated the RMM market under 3-4 PE firms
- Pricing is deliberately opaque — most vendors require "contact sales"
- This report catalogs what MSPs actually pay, how those prices got there, and what the alternatives are
- Methodology note: how pricing was verified (vendor pages, G2/Capterra, r/msp community reports, direct inquiries, date of verification)

### 2. Core Sections: Platform Profiles

Each platform gets a self-contained profile following a consistent template:

```
## [Platform Name]
*[Owner / PE firm]. [Key acquisition context in one line.]*

### Ownership & History
1-2 paragraphs. Who owns it, how it got here, major acquisitions/events.

### Pricing
Table: per-endpoint or per-technician pricing by tier.
Contract terms, minimums, renewal terms, documented price changes.

### What's Included vs Add-On
Feature parity breakdown — which features cost extra?

### Hidden Costs
Contract lock-in, early termination, forced bundling, onboarding fees, migration costs.

### Community Sentiment
2-3 representative quotes from r/msp, G2, or forums. Focus on pricing-related feedback.

### TCO at Scale
Calculated monthly/annual cost at 50, 250, 1K, 5K endpoints.
```

**V1 Platforms (priority order):**

1. NinjaOne — $5B valuation, $500M+ ARR, Audi F1 sponsorship, Dropsuite acquisition
2. ConnectWise Automate — Thoma Bravo ($1.5B, 2019), Axcient + SkyKick acquisitions
3. Datto RMM — Kaseya ($6.2B, 2022), post-acquisition pricing impact
4. Kaseya VSA — The acquirer's own product, 18 total acquisitions, IT Complete bundling
5. N-able N-central — SolarWinds spin-off, stock collapse, Adlumin acquisition
6. Atera — Per-technician disruptor, $500M valuation, AI Copilot
7. Syncro — Per-technician alternative, XMM rebrand
8. SuperOps — Newest VC-backed challenger, $54M funding

**V2 Platforms (add post-launch, each is a content moment):**

- Action1, Pulseway, Level, Gorelo, JumpCloud, Intune, ManageEngine, Naverisk, Auvik, Hexnode, LogMeIn Resolve, Splashtop, TeamViewer, ITarian

**V3 — Open Source Platforms (dedicated profiles):**

- Tactical RMM, MeshCentral, OpenUEM, NetLock, Flamingo/OpenFrame, OpenRPort

### 3. Summary Comparison Tables

Aggregate data into scannable tables — the most linkable/citable part of the report.

**Table 1: Pricing Model Overview**

| Platform | Owner | Model | Starting Price | Contract | Min Commitment |
|----------|-------|-------|---------------|----------|----------------|

**Table 2: TCO by MSP Size**

| Platform | 50 endpoints | 250 | 1,000 | 5,000 | 10,000 |
|----------|-------------|-----|-------|-------|--------|

**Table 3: Feature Parity Matrix**

| Feature | NinjaOne | ConnectWise | Datto | N-able | Atera | Syncro | SuperOps |
|---------|----------|-------------|-------|--------|-------|--------|----------|

Features to compare: Remote access, Patch management (OS + 3rd party), Scripting/automation, Alerting/monitoring, Backup integration, Security/AV management, Reporting, PSA integration, Mobile app, Multi-tenant, API access, AI features, Documentation/KB, Network monitoring.

Values: Included / Add-on ($) / Not available

### 4. Acquisition & Consolidation Section (~800-1,000 words)

Dedicated narrative section:

- Visual timeline of major deals (2019-2026)
- The PE playbook: acquire, bundle, raise prices, reduce support headcount
- Total capital deployed ($13B+)
- The pattern: what happens to pricing 12-24 months post-acquisition
- Key deals detailed:
  - Thoma Bravo → ConnectWise (~$1.5B, 2019)
  - SolarWinds → N-able spin-off (2021, post-breach context)
  - Kaseya → Datto ($6.2B, 2022)
  - ConnectWise → Axcient + SkyKick (2024)
  - N-able → Adlumin ($266M, 2024)
  - NinjaOne → Dropsuite ($270M, 2025)
  - Kaseya → Arcode + SaaS Alerts (2025)
- NinjaOne spotlight: $5B valuation, $500M+ ARR, 70% YoY growth, Audi F1 sponsorship
- N-able decline: $2.5B market cap → $4.66/share
- Kaseya's 18 acquisitions and "IT Complete" lock-in strategy

### 5. Open Source & Alternative TCO Section

Neutral analysis — not a Breeze pitch, genuine math:

- Platform profiles for Tactical RMM, MeshCentral, OpenUEM, NetLock, Flamingo/OpenFrame
- Self-hosted cost estimates:
  - Cloud hosting (DigitalOcean/Hetzner/AWS for recommended specs)
  - Database hosting (managed vs self-hosted PostgreSQL)
  - Staff time for maintenance (hours/month)
- What you gain: no per-endpoint fees, no vendor lock-in, full control, no contract
- What you lose: vendor support, compliance certs, PSA integrations, staff time cost
- Honest framing: "Open source isn't free — it costs time instead of money"

### 6. Methodology & Sources

- How pricing was verified (visited each vendor page, cross-referenced with G2/Capterra/community reports)
- Date of verification for each data point
- Linked citations for every claim
- Invitation to submit corrections: "If your pricing experience differs, let us know — corrections make the report better"

### 7. CTA Section (soft)

> **About this report**
> This report is published by the team behind Breeze RMM, an open-source, AI-native RMM platform. We built this because we're in the space and this data didn't exist in one place. The report is designed to be useful regardless of which RMM you choose.
>
> [Join the mailing list] to be notified when we update this report.
> [Let us know] if you spot an error.

---

## Data Collection Requirements

### Per-Platform Pricing Data

For each of the 25+ platforms:

- Current per-endpoint or per-technician price by tier
- Monthly and annual billing options
- Contract length requirements, early termination terms
- Minimum endpoint/technician counts
- Setup/onboarding/migration fees
- Required add-ons vs included features
- Documented price changes over the past 2 years
- Bundling requirements (e.g., PSA + RMM forced bundles)

### Acquisition Data

For each major deal:

- Deal price and date
- Acquirer and PE backer
- Documented post-acquisition price increases
- Customer sentiment changes (G2 rating trajectory, r/msp threads)
- Product consolidation or sunsetting

### Market Data

- Total addressable market for RMM/MSP tools
- Number of MSPs globally
- Average MSP tool stack cost per endpoint
- Technician-to-endpoint ratios by MSP size
- G2/Capterra/TrustRadius ratings for all platforms
- RMM-related security incidents (Kaseya VSA 2021, SolarWinds 2020)

### Community Sentiment

Sources to mine:

- Reddit r/msp — "switching RMM", "RMM pricing", "[vendor] price increase", migration threads
- Reddit r/sysadmin — endpoint management cost discussions
- G2 reviews — filter 1-2 star for pricing complaints
- MSPGeek Discord/Slack
- NinjaOne F1 reaction threads

### TCO Calculations

Build for 5 MSP sizes:

| Size | Endpoints | Technicians |
|------|-----------|-------------|
| Solo | 50 | 1 |
| Small | 250 | 3 |
| Mid | 1,000 | 8 |
| Growth | 5,000 | 20 |
| Large | 10,000 | 40 |

For each platform at each size: monthly cost, annual cost, cost per endpoint.

---

## Blog Infrastructure

Breeze currently has no blog. Need to build:

- Blog section on breezermm.com (Astro-based, likely new content collection)
- Blog post template with support for:
  - Long-form content with anchor-linked sections (each platform profile is deep-linkable)
  - Data tables (responsive)
  - Callout/sidebar boxes (for the NinjaOne F1 spotlight, etc.)
  - Source citation footnotes
  - Table of contents with scroll-spy
  - Last-updated date (living report)
  - Social sharing meta tags (OG image, description)
  - Schema markup (Article, FAQ where relevant)

---

## Outreach & Distribution Playbook

### Tier 1: MSP Industry Publications

| Publication | Why They'd Care | Priority |
|-------------|----------------|----------|
| ChannelE2E | Covers every MSP acquisition and pricing change. Consolidation data is their beat. | High |
| Channel Futures | Publishes MSP 501 rankings. Data-driven content is their thing. | High |
| CRN (The Channel Company) | Biggest channel trade pub. Vendor moves and PE deals. | High |
| ChannelPro Network | SMB channel focus. TCO tables by MSP size resonate. | Medium |
| MSP Success Magazine | Kaseya-owned — probably won't cover unflattering Kaseya data. | Low |

**Email template:** Lead with 3-4 top findings as bullet points, link to full report, offer underlying data for their own coverage. Sign as Todd Hebebrand, Breeze RMM.

### Tier 2: MSP Communities

**Reddit r/msp (~180K+ members)** — Text post (not link post). Lead with TCO comparison table for 250 endpoints. Include survey link. Engage actively for 2-3 hours. Be upfront about Breeze if asked. Don't pitch.

**Reddit r/sysadmin** — Shorter version focused on Intune/JumpCloud angle for internal IT teams.

**MSPGeek, The Tech Tribe, ASCII Group** — Share as a resource in relevant channels.

### Tier 3: Tech Communities

**Hacker News** — Use article title exactly. Post 8-10am ET weekday. PE consolidation and open-source sections are what HN cares about. Be transparent about being the founder.

**IndieHackers** — Meta-strategy angle: "How we're using data-driven content to compete with $5B incumbents as an open-source startup."

### Tier 4: Direct Outreach to Existing Citers

Find 10-15 sites that currently rank for "RMM pricing," "best RMM," "RMM comparison" keywords and cite external data. Use Ahrefs/SEMrush to identify targets.

**Email template:** Reference their specific article and what they currently cite. Offer updated data. Don't ask for the link — "feel free to reference." Follow up once max.

### Tier 5: Syndication

- **Medium** — Full republish with canonical URL to breezermm.com. Submit to "The Startup" or "Better Marketing."
- **dev.to** — Republish with canonical_url in front matter. Tags: msp, devops, sysadmin, open-source.
- **LinkedIn** — Article on Todd's profile. PE consolidation angle plays well with MSP owners and channel execs.

### Tier 6: Surveys (Data Flywheel)

Two Tally surveys:

1. **MSP Tool Cost Survey** — Platform used, endpoint count, monthly cost, satisfaction, switching history. Anonymous, 3 minutes.
2. **IT Team Tool Cost Survey** — For internal IT teams using Intune/JumpCloud/etc.

Aggregate results published as report update — "200 MSPs told us what they actually pay" becomes a second wave of content and links.

### Sequencing

**Week 1 (publish + first wave):**
1. Publish report with V1 platforms (8-10 profiles)
2. Send 5 MSP publication emails (Tier 1)
3. Post on Reddit r/msp with survey link
4. Share on LinkedIn (Todd's profile)

**Week 2 (expand + second wave):**
5. Post on HN (best morning)
6. Post on Reddit r/sysadmin
7. Publish on Medium + dev.to with canonical tags
8. Start 10-15 direct outreach emails (2-3/day)
9. Share in MSPGeek / Tech Tribe

**Week 3 (follow up + iterate):**
10. Follow up non-responses from Week 1
11. Post on IndieHackers (meta-strategy angle)
12. Add V2 platform profiles (each one is a social post)
13. Compile survey responses, update report

**Ongoing:**
- Monitor Ahrefs weekly for new referring domains
- Respond to every Reddit/HN comment within 24 hours
- Add platforms as updates — each is a content moment
- Quarterly pricing refresh to keep report evergreen

---

## What NOT To Do

- Don't mass-email. 15 targeted > 100 generic.
- Don't pitch Breeze in community posts. Pitch the data.
- Don't buy links or use PBNs.
- Don't cross-post identical content across subreddits.
- Don't coordinate upvotes on HN or Reddit.
- Don't follow up more than once on outreach.
- Don't editorialize vendors — "ConnectWise raised prices 30% post-acquisition" is a fact. "ConnectWise is ripping off MSPs" is an opinion that kills credibility.
- Don't include Breeze in comparison tables. Author only.

---

## V1 Scope (Ship in 1-2 Weeks)

**Must have:**
- Blog infrastructure on breezermm.com (Astro content collection, post template)
- 8-10 platform profiles with pricing, ownership, TCO
- 3 summary comparison tables
- Acquisition & consolidation narrative section
- Methodology & sources section
- Soft CTA
- Social meta tags and OG image
- At least 1 survey (MSP Tool Cost Survey on Tally)

**Can add post-launch:**
- V2 platform profiles (each is own content moment)
- Open source TCO section (can be V1 if time allows)
- Feature parity matrix (data-intensive, may need more time)
- Schema markup
- Email capture / mailing list integration

---

## Success Metrics

- **Backlinks:** 10+ referring domains within 60 days
- **Community:** Front page of r/msp, 50+ comments
- **Traffic:** 5,000+ unique visitors in first month
- **Survey:** 50+ MSP responses in first 30 days
- **Citations:** At least 2 industry publications reference the data
- **SEO:** Rank for "RMM pricing comparison" or "RMM cost" within 90 days
