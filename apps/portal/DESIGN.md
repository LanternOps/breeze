---
name: Breeze Customer Portal
description: The Guest Ledger — the MSP as concierge; a client's account kept like a well-ruled register.
colors:
  service-green: "hsl(155 32% 24%)"
  linen-on-green: "hsl(42 45% 97%)"
  service-green-ink: "hsl(155 32% 24%)"
  warm-plaster: "hsl(40 28% 94%)"
  linen-white: "hsl(42 45% 99%)"
  register-ink: "hsl(30 12% 12%)"
  quiet-ink: "hsl(32 8% 36%)"
  plaster-deep: "hsl(40 24% 90%)"
  plaster-shade: "hsl(40 26% 88%)"
  hairline: "hsl(38 16% 78%)"
  hairline-input: "hsl(38 16% 74%)"
  focus-ring: "hsl(155 32% 30%)"
  brick: "hsl(8 62% 40%)"
  spruce: "hsl(152 45% 26%)"
  amber: "hsl(35 90% 44%)"
  spruce-on-tint: "hsl(152 45% 25%)"
  amber-on-tint: "hsl(33 85% 28%)"
  brick-on-tint: "hsl(8 62% 38%)"
typography:
  display:
    fontFamily: "Literata, Georgia, 'Times New Roman', serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  figures:
    fontFamily: "Literata, Georgia, 'Times New Roman', serif"
    fontWeight: 600
    fontVariation: "lining-nums tabular-nums"
  body:
    fontFamily: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.08em"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
spacing:
  cell-x: "16px"
  cell-y: "14px"
  header-below: "28px"
  page-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.service-green}"
    textColor: "{colors.linen-on-green}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.linen-white}"
    textColor: "{colors.register-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.linen-white}"
    textColor: "{colors.register-ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.linen-white}"
    rounded: "{rounded.lg}"
---

# Design System: Breeze Customer Portal

<!-- Scope: apps/portal only. The repo-root DESIGN.md documents a different
     surface (Breeze Mobile). The technician console (apps/web) is a different
     room on purpose; nothing here applies there. -->

## Overview

**Creative North Star: "The Guest Ledger"**

The portal is the MSP as concierge. It greets the customer like a valued guest and handles money and requests with a front desk's quiet precision: a client arrives from an email, sees their account laid out like a well-kept register, approves or pays in one obvious step, and leaves trusting the firm that keeps this file. The world deliberately refuses the category default for customer portals — the white sidebar shell, boxed tables, blue accents, and pill badges are the anti-reference, not a fallback.

Materially, the world is warm paper. One warm hue family (38–42°, plaster and linen) carries every neutral; there is no pure grey anywhere — even the borders and muted text are tinted toward the paper. The working ink is a deep service green (155°), never SaaS blue. Ledgers are ruled by hairlines rather than boxed into chips; statuses are a small ink dot beside quiet small-caps text; the serif speaks only where a service business speaks with its own voice. Density is calm and readable — this reader is the customer's office manager arriving on a phone, not a technician triaging across monitors.

**Key Characteristics:**
- Warm plaster ground, linen-white cards, 12px surfaces
- Deep service green as the only working accent
- Hairline-ruled ledgers, never boxed tables or zebra stripes
- Statuses as dot + small-caps text, never filled pills (paper documents excepted)
- Literata for page titles and money; Hanken Grotesk for everything else
- One authored motion moment (content settles onto the desk)
- White-label ready: partner logo, name, and a CSP-safe partner accent on documents

## Colors

One warm family of paper neutrals, one green working ink, and three warm-shifted status hues that sit in the same room.

### Primary
- **Service Green** (`hsl(155 32% 24%)`): the working ink. Primary buttons, the active-nav register mark, informational status dots, and link emphasis. This is the portal's only working accent — blue never appears.
- **Linen on Green** (`hsl(42 45% 97%)`): text and icons on a Service Green fill.

### Neutral
- **Warm Plaster** (`hsl(40 28% 94%)`): the page ground. The whole portal sits on it; cards read as sheets laid on the desk.
- **Linen White** (`hsl(42 45% 99%)`): card, popover, input, and secondary-button surface.
- **Register Ink** (`hsl(30 12% 12%)`): primary text. A warm near-black, not neutral black.
- **Quiet Ink** (`hsl(32 8% 36%)`): secondary text — ledes, dates, supporting figures, column headers.
- **Plaster Deep / Plaster Shade** (`hsl(40 24% 90%)` / `hsl(40 26% 88%)`): muted fills and hover washes. Row hover is Plaster Shade at 55% alpha.
- **Hairline** (`hsl(38 16% 78%)`): rules and borders. Contract-tested to stay ≥1.4:1 against the ground — a fainter hairline hid the signature checkbox from real customers.

### Status
- **Spruce** (`hsl(152 45% 26%)`): paid, resolved, online, accepted.
- **Amber** (`hsl(35 90% 44%)`): reserved for states the customer should act on (overdue-adjacent, partially paid, in progress). A freshly sent invoice is informational green, never amber.
- **Brick** (`hsl(8 62% 40%)`): overdue, urgent, declined, errors. A warm brick red, not signal red.

### Named Rules
**The One Ink Rule.** Service green is the only working accent in the portal chrome. Blue is banned; a second accent hue is banned. Partner brand color appears only inside the paper document world via `.doc-accent-*`.

**The On-Tint Rule.** The base status tokens are tuned as *backgrounds* (dots, fills). Any status-colored *text* — on the plaster ground or on a 10%-alpha tint — must use the `-on-tint` variant (`text-success-on-tint`, `text-warning-on-tint`, `text-destructive-on-tint`, `text-primary-on-tint`). The base tokens fail WCAG AA as 12px text; the pairings are asserted in `src/styles/tokenContrast.test.ts`, which is the contract, not a suggestion.

**The No-Grey Rule.** Every neutral carries the 30–42° warm tint. Introducing a desaturated grey (`gray-*`, `slate-*`, `zinc-*`) breaks the paper.

**The After-Hours Rule.** Dark mode is the same room after hours: warm charcoal (30° family), never blue-black, with the green and status hues lightened to carry text. The `.dark` class block and the `prefers-color-scheme` media block are asserted identical by `src/styles/themeParity.test.ts` — edit both or the test fails. `.dark` is the explicit opt-in, `.light` the opt-out.

## Typography

**Display Font:** Literata (with Georgia, 'Times New Roman', serif) — weights 500/600, self-hosted via @fontsource
**Body Font:** Hanken Grotesk (with ui-sans-serif, system-ui) — weights 400/500/600/700, self-hosted via @fontsource
**Document Fonts (paper world only):** Barlow Condensed 600 (headings) + DM Sans 400/500/700 (body), scoped to `[data-doc-theme='condensed']`

**Character:** a warm humanist grotesk that reads like a front-desk register, paired with a screen-first serif that appears only when the firm speaks with its own voice. These faces are deliberately distinct from apps/web — the technician's console and the client's ledger are different rooms.

### Hierarchy
- **Display** (600, 1.75rem, leading-tight, tracking-tight): the serif page title. Every page opens with one, followed by one line of service copy.
- **Title** (600, 1.125rem): empty-state headings and card titles, still in the serif.
- **Body** (400–500, 0.875rem): controls, table cells, prose. The portal's prevailing size.
- **Label** (600, 0.75rem, 0.08em tracking, uppercase): column headers and status text.
- **Figures** (Literata 600, `.text-figures`): money. The balance is the largest element on a phone card (1.25rem serif).

### Named Rules
**The Two Serif Moments Rule.** Literata appears in exactly two places: page/section titles and money figures. Everything else — nav, labels, buttons, body — stays in Hanken Grotesk. A serif label or serif button is out of world.

**The Lining Figures Rule.** The body sets `font-variant-numeric: lining-nums` globally; any *column* of figures (amounts, dates, balances) additionally takes `.text-figures` for tabular spacing so ledger columns actually align. Money and date columns are right-aligned in tables.

## Layout

A quiet 16rem (w-64) left rail carries the firm's name (partner logo or serif wordmark), the nav, and a "We're here to help" concierge block above the foot — the rail is separated by a hairline, not a filled panel. The content column is centered at `max-w-5xl` with 20px gutters on phones and 32px at `sm:`. Every page opens with the serif `PageHeader` (title + one-line lede, optional action button at the baseline), with 28px below it before the ledger begins.

The responsive contract is phone-first because portal readers usually arrive from an email on a phone: below `lg` the rail disappears behind a `Menu` disclosure in the header, and below `sm` each table row reflows into a stacked card (`ROW`/`CELL` in `src/components/portal/ui.tsx` — one DOM tree, `order-*` utilities re-rank the card so identifier + status lead and the balance owed is the largest element). At `sm:` and up real table semantics return with `scope="col"` headers. The mobile viewport uses `min-h-dvh`, never `h-screen`. The support/concierge block is duplicated under `<main>` on mobile so a phone reader can always reach their MSP.

Spacing rhythm: ledger cells are `16px × 14px` (px-4 py-3.5); nav items `12px × 8px`; the shell header is 64px tall (80px at `sm:`). Auth pages center a `max-w-md` column on the same plaster ground.

*Recorded ceiling (future commitments, not current rules): a ledger foot-rule/summary line, rail wordmark scale, and lower-viewport composition on sparse desktop pages.*

## Elevation & Depth

Flat by conviction. Depth is conveyed by surface color (linen card on plaster ground) and hairlines, not shadows. The single shadow in the portal is the mobile nav popover (`shadow-lg shadow-foreground/5` — a warm, near-invisible ambient). Document paper gets its lift from the pinned-white surface against the chrome, plus its accent top rule.

### Named Rules
**The Settle Rule.** The portal has exactly one authored motion moment: `.settle-in` — page content settles onto the desk (240ms, `cubic-bezier(0.22, 1, 0.36, 1)`, 6px of upward travel), replayed per client-side navigation by the view-transitions router and disabled wholesale under `prefers-reduced-motion`. Everything else is 150ms color transitions on hover. No slides, no scale-ins, no staggered reveals.

## Shapes

Soft 12px surfaces on a base radius of `0.75rem`: cards and document paper at 12px (`rounded-lg`/`rounded-xl`), buttons, inputs, and nav items at 10px (`rounded-md`), status dots and the register mark fully round. Rules are everywhere the form language: the ledger is drawn with horizontal hairlines (`divide-y divide-border/70`), the empty state is a ruled band (`border-y`), the rail and concierge blocks are separated by hairlines. Boxes are reserved for true surfaces (cards, popovers, documents); data is never boxed.

## Components

### Buttons
- **Shape:** softly rounded (10px), text 0.875rem semibold.
- **Primary (`BTN_PRIMARY`, ui.tsx):** Service Green fill, Linen on Green text, `8px 16px` padding, optional 16px leading icon.
- **Hover / Focus:** fill to 90% alpha on hover; `focus-visible` ring in the green ring token with 2px offset from the background. Disabled: 50% opacity, `cursor-not-allowed`.
- **Secondary (`BTN_SECONDARY`):** linen card surface with a hairline border; hover washes to Plaster Shade. No ghost or tertiary variant exists.

### Status Marks (signature)
- **Style (`StatusMark`, ui.tsx):** a 6px round dot of the background-tuned status token beside 12px semibold small-caps text in the matching `-on-tint` foreground (e.g. `bg-success` + `text-success-on-tint`).
- **Semantics:** green = settled/informational, amber = customer action wanted, brick = urgent/negative, muted 60% dot = inert (draft, void, closed, offline).
- **This is the only status treatment in the chrome.** Tinted chips (`bg-success/10` etc., `statusColor()` in `src/lib/invoiceStatus.ts`) exist solely inside the paper document world.
- **One mark per row (the diet).** A row carries at most one StatusMark — the state the customer reads. Context columns (ticket priority) render as plain 12px text ("Normal priority"), muted for routine values, keeping the tinted `-on-tint` foreground only for high and urgent. Two uniform dot clusters side by side is the new chip soup.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Linen White on the plaster ground, hairline border where the card floats (device cards, popovers).
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 16px ledger cells; document paper `16–40px` responsive.

### The Ledger (signature)
- **Structure:** `<table>` with small-caps `TH` headers under a hairline, `tbody` with `divide-y divide-border/70`, rows hover-washed in Plaster Shade at 55% (`.ledger-row`). Figures right-aligned in `.text-figures`.
- **Responsive:** the `ROW`/`CELL` contract reflows each row into a stacked card below `sm` (see Layout).
- **Empty state (`EmptyState`):** a ruled band (`border-y`) with a 40px 1.5-stroke Lucide icon, serif title, quiet copy — never a dashed drop-zone box.
- **Errors (`ErrorNotice`):** a `bg-destructive/10` rounded banner with `text-destructive-on-tint`, `role="alert"`.

### Inputs / Fields
- **Style (`INPUT`, ui.tsx):** linen surface, hairline-input border, 10px radius, `8px 12px` padding, quiet-ink placeholder.
- **Focus:** border and 1px ring shift to Service Green.

### Navigation
- **Style:** 0.875rem medium quiet-ink entries; hover washes Plaster Shade at 60% and darkens the text. The active entry turns semibold Register Ink and carries the **register mark** — a 2×16px round-ended green rule where a filled pill would be — with `aria-current="page"`. Hovered inactive entries preview a hairline-colored mark.
- **Mobile:** a `<details>` `Menu` disclosure in the header opening a linen popover.

### Document Paper (signature)
- **The paper world (`documentShell.tsx`):** proposals and invoices render on a 12px-radius bordered card pinned to white via `[data-doc-theme]` — the chrome follows the OS scheme, but a document carries partner brand color chosen against white and is what the customer prints or forwards, **so it stays light by design**. The ground is true white, but the paper's ink, rules, and washes are authored warm neutrals from the same 30–40° family as the chrome (never the scaffold's cool slate). Inside: a 6px partner-accent top rule, logo/seller header, eyebrow + document number (a Literata `<h1>`) + stamped status chip, hairline-ruled totals/terms rhythm, small-caps section labels; the hero balance figure speaks Literata — the serif speaks where the firm speaks, on paper too.
- **Auth surfaces are in the world too.** Forgot/reset/invite outcomes render as a ruled band (`border-y`, serif title, one line of copy, ≤38ch measure) — never a centered icon-chip-in-a-circle. Password rules are one helper line under the field, not a grey requirements box.
- **One inventory, one treatment.** Devices and Equipment are both hairline ledgers (Device / Type / Status / Last online) with a foot line — a card grid holding a second belief about the same machines is a lapse.
- **The ledger foot-rule:** a list that represents money or open work totals itself like a real register — a hairline foot row in small-caps ("Total outstanding" with a serif figure on Invoices, "2 open requests" on Support, "1 proposal awaiting your review" on Proposals). Single-currency sums only; a mixed-currency sum is a made-up number and is omitted.
- **Partner accent:** production CSP sets `style-src-attr 'none'`, so the accent must never ride a `style` attribute. It is delivered as ONE nonced `<style>` element from the layout (`src/lib/docAccent.ts`, sanitized against CSS injection) and consumed only through `.doc-accent-bg` / `.doc-accent-text` / `.doc-accent-border`, whose `var(--doc-accent, hsl(var(--primary)))` fallback keeps unbranded documents sensible.
- **Status on paper:** the tinted chip (`statusColor()`), with `-on-tint` foregrounds — a printed register wants a stamp, not the ledger's dot.
- **Optional condensed theme:** `[data-doc-theme='condensed']` swaps document type to Barlow Condensed headings + DM Sans body; faces load only when used.
- **Signature preview:** `.signature-preview` uses local cursive faces (Snell Roundhand → generic `cursive`); no webfont is shipped for it.

## Do's and Don'ts

### Do:
- **Do** open every page with `PageHeader`: the serif title plus one line of warm service copy ("Your account with us, always current."). Copy speaks concierge, not system.
- **Do** compose lists from the shared vocabulary in `src/components/portal/ui.tsx` (`ROW`, `CELL`, `TH`, `StatusMark`, `EmptyState`, `ErrorNotice`) so the register reads as one hand.
- **Do** put every column of money or dates in `.text-figures`, right-aligned, and let the balance owed lead the phone card.
- **Do** pair status dots with `-on-tint` text foregrounds — the pairing is contract-tested (`tokenContrast.test.ts`), and theme changes must keep the `.dark`/media blocks identical (`themeParity.test.ts`).
- **Do** deliver any runtime per-partner color through the nonced-`<style>` + `.doc-accent-*` path; the production CSP bans style attributes and dev won't show the breakage.
- **Do** wrap new page content in `.settle-in` and keep hover feedback to 150ms color transitions.

### Don't:
- **Don't** bring back the category defaults the world refuses: white sidebar shell, boxed/zebra tables, blue accents, or filled pill badges in the chrome. Chips exist only on paper documents.
- **Don't** use amber for anything the customer cannot act on — a freshly sent invoice is not a warning to the person who owes it.
- **Don't** introduce pure greys, blue-black dark surfaces, shadows on resting surfaces, or a second accent hue.
- **Don't** set the serif on labels, buttons, or body copy — Literata is titles and money only.
- **Don't** use technician language or technician density; the reader is an office manager ("Mac", "About an hour ago", never platform ids or "3d ago").
- **Don't** let documents follow the OS color scheme — `[data-doc-theme]` paper stays white by design.
