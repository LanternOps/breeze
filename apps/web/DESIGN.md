---
name: Breeze RMM Console
description: "The Calm Control Room: the technician's console. Dense, legible, and quiet until something needs a human."
colors:
  primary: "hsl(225 62% 48%)"
  primary-foreground: "hsl(0 0% 100%)"
  primary-ink: "hsl(225 62% 48%)"
  ring: "hsl(225 62% 48%)"
  background: "hsl(220 20% 98%)"
  card: "hsl(220 20% 99%)"
  popover: "hsl(0 0% 100%)"
  foreground: "hsl(224 28% 14%)"
  secondary-foreground: "hsl(224 20% 18%)"
  muted: "hsl(220 16% 94%)"
  muted-foreground: "hsl(220 10% 46%)"
  accent: "hsl(220 20% 92%)"
  border: "hsl(220 16% 90%)"
  destructive: "hsl(4 76% 44%)"
  destructive-foreground: "hsl(0 0% 100%)"
  destructive-ink: "hsl(4 76% 38%)"
  success: "hsl(152 56% 37%)"
  success-foreground: "hsl(0 0% 100%)"
  success-ink: "hsl(152 60% 26%)"
  warning: "hsl(36 88% 50%)"
  warning-foreground: "hsl(28 60% 16%)"
  warning-strong: "hsl(30 85% 38%)"
  warning-ink: "hsl(30 85% 30%)"
  info: "hsl(205 85% 38%)"
  info-foreground: "hsl(0 0% 100%)"
  chart-neutral: "hsl(220 12% 72%)"
typography:
  headline:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.556
  title-sm:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  body-strong:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
  label:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.333
  label-caps:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "0.025em"
  figure:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.333
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  hairline-gap: "4px"
  gap: "8px"
  control-x: "12px"
  button-x: "16px"
  card-padding-compact: "16px"
  card-padding: "24px"
  page-gutter: "16px"
  page-gutter-md: "24px"
  header-height: "64px"
  rail-width: "64px"
  sidebar-width: "256px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "hsl(225 62% 48% / 0.9)"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.muted}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-destructive-hover:
    backgroundColor: "hsl(4 76% 44% / 0.9)"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    padding: "6px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  input-compact:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card-padding}"
  card-compact:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card-padding-compact}"
  dialog:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "24px"
  menu:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px 0"
  chip-neutral:
    backgroundColor: "{colors.muted}"
    textColor: "hsl(224 28% 14% / 0.7)"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip-primary:
    backgroundColor: "hsl(225 62% 48% / 0.15)"
    textColor: "{colors.primary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip-success:
    backgroundColor: "hsl(152 56% 37% / 0.15)"
    textColor: "{colors.success-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip-warning:
    backgroundColor: "hsl(36 88% 50% / 0.15)"
    textColor: "{colors.warning-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip-danger:
    backgroundColor: "hsl(4 76% 44% / 0.15)"
    textColor: "{colors.destructive-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  tag-priority-urgent:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 6px"
  tag-priority-high:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 6px"
  count-badge:
    backgroundColor: "hsl(36 88% 50% / 0.15)"
    textColor: "{colors.warning-strong}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 6px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
  tab:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-strong}"
    padding: "12px 4px"
  tab-active:
    textColor: "{colors.primary}"
  table-header:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label-caps}"
    padding: "12px"
  domain-strip:
    backgroundColor: "{colors.primary}"
    height: "2px"
  toast:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
---

# Design System: Breeze RMM Console

<!-- Scope: apps/web only, the technician console. This is a child of the
     repo-root DESIGN.md, which documents Breeze Mobile; apps/portal/DESIGN.md
     documents the customer portal, a different room on purpose. Nothing in
     either applies here, and nothing here applies to them.
     Source of truth for every value: apps/web/src/styles/globals.css
     (`@theme inline` mapping near line 47, `:root` near 34258, `.dark` near
     34333). Frontmatter colors are the light theme; dark values are given in
     prose and in .impeccable/design.json. Usage counts are utility-token
     occurrences across non-test .ts/.tsx/.astro files under apps/web/src,
     taken 2026-11-09. They describe the codebase on that day and will move. -->

## Overview

**Creative North Star: "The Calm Control Room"**

Breeze's web console is the room an MSP technician works in all day: a well-run operations floor where the light is steady, every gauge reads at a glance, and alarms sound only when they mean it. The voice is calm, legible, steady, and quietly warm. Information density wins over decoration. Body copy and controls sit at 14px, metadata at 12px, cards are hairline-ruled sheets with almost no lift, and one slate-blue ink carries every action. The status hues (alarm red, healthy green, caution amber, info sky) are the only other saturated colours in the room, and they mean state and nothing else.

Materially, the console is cool slate paper. Every neutral sits on a 220–224° blue-grey hue at low saturation, from the 98% page ground to the 14% ink. Depth comes from hairline borders and a near-invisible 1px shadow, not from elevation; real shadows appear only on layers that float, and they grow with float distance. Dark mode is the same room at night: deep navy-charcoal surfaces (7–10% lightness, never pure black), a lightened primary, and status fills that carry dark labels. The technician sets the room's density (comfortable, compact, dense) and its typeface (Plus Jakarta Sans or the OS system font), so both are runtime preferences, not fixed constants.

The confirmed visual anti-reference is PRODUCT.md's "AI vibe-coded" list: gradient text, glassmorphism, neon-on-dark, identical card grids. The build honours it. There are no `bg-clip-text` uses, `backdrop-blur` appears only on four overlay veils, and gradients appear only as functional texture: scroll-fade masks at the edges of scrolling rows and the 1px dot grid behind the topology canvases. One faint card wash (`components/alerts/AlertsSummary.tsx`, card to `secondary/30`) is the lone decorative gradient.

**Key Characteristics:**
- Cool slate neutrals; one slate-blue working accent; four status hues that mean state only
- Status text in dedicated ink tokens that clear 4.5:1 on the card and on their own tints
- 14px workhorse body, 12px metadata, nothing smaller; medium weight by default
- Hairline + whisper-shadow cards (8px); controls at 6px; pills fully round
- Filled slate-blue pill for the active sidebar item; underline tabs in page content
- A 2px domain strip across the top of every page names the product area
- Chips appear only when a value deviates from its default
- User-selectable density (`data-density`) and font (`data-font`); theme follows the OS by default
- Tabular numerals on every table; monospace for machine identifiers
- Restrained motion: 150ms colour transitions, one settle easing for entrances, a global reduced-motion kill switch

## Colors

One cool slate family for every neutral, one slate-blue ink for action, four status hues tuned against a light card, and a matching ink for each hue's text. Values are HSL triplets stored as raw components in `:root` and `.dark` (`--primary: 225 62% 48%`) and exposed as Tailwind colours through `@theme inline` (`--color-primary: hsl(var(--primary))`), so every utility re-themes at runtime.

### Primary
- **Steady Slate-Blue** (`primary`; dark `hsl(225 70% 62%)`): every primary action (filled buttons), links, the active sidebar item, the active tab rule, selected toggles, and the focus ring (`ring` mirrors it). It reads 6.4:1 as text on a light card and 4.6:1 on a dark card.
- **On Slate-Blue** (`primary-foreground`; dark `hsl(224 28% 7%)`): the label on a primary fill. It flips to near-black in dark mode because the dark primary is light, which is why `text-white` on `bg-primary` is wrong (3.9:1 in dark).
- **Paper Primary** (`--paper-primary`, light block only, equal to the light `primary`): the accent the shared document paper (`@breeze/document-ui`) paints with, since invoices and quotes stay white in dark mode. `tokenPresence.test.ts` asserts it equals `--primary`.

### Status
- **Alarm Red** (`destructive`; dark `hsl(4 80% 64%)`): breach, destructive actions, errors. Darkened under #7511 so red text on a plain card and the label on a red fill both clear AA; `globals.destructiveContrast.test.ts` holds that line.
- **Healthy Green** (`success`; dark `hsl(152 52% 44%)`): healthy or done: online, passed, paid, resolved. In dark mode its fill carries a dark label (`hsl(152 50% 8%)`).
- **Caution Amber** (`warning`; dark `hsl(40 90% 52%)`): waiting or at risk, as a fill or tint only. The fill carries a dark brown label (`warning-foreground`). As text on a light card it is 2.3:1.
- **Burnt Amber** (`warning-strong`; dark equals `warning`): the non-text warning indicator in light mode: thin rings, outlines, dots, icons, and count text (about 4.4–4.6:1). It marks the unsaved-edit ring and tab count badges.
- **Info Sky** (`info`; dark `hsl(205 80% 62%)`): informational and "updating / awaiting" states, deliberately a different hue from the primary.
- **Idle Grey** (`chart-neutral`; dark `hsl(224 14% 34%)`): the "inactive / not yet" segment in status charts. Its lightness sits far from `success` so the green and grey pair separates under colour-vision deficiency. It is below 3:1 against a card by design, like a meter track, so a segment in it always carries a visible label and count.

### Ink
Small status-coloured text on the card or on the hue's own 10–20% tint: chip labels, SLA timers, internal-note labels. Each ink clears 4.5:1 on the card and on a 20% tint of its hue in both themes.
- **Primary Ink** (`primary-ink`; dark `hsl(225 70% 70%)`): equal to the primary in light; lifted in dark, where `text-primary` on a primary tint is 3.9:1.
- **Healthy Ink** (`success-ink`; dark `hsl(152 52% 48%)`): 6.4:1 on a light card, 5.4:1 on a 15% tint.
- **Caution Ink** (`warning-ink`; dark `hsl(40 92% 58%)`): 6.4:1 on a light card, 5.7:1 on a 15% tint.
- **Alarm Ink** (`destructive-ink`; dark `hsl(4 80% 70%)`): 7.0:1 on a light card, 5.5:1 on a 15% tint.

### Neutral
- **Slate Mist** (`background`; dark `hsl(224 28% 7%)`): the page ground behind `main`, and the fill of every text input, so inputs read as wells set slightly into a card.
- **Card White** (`card`; dark `hsl(224 24% 10%)`): cards, sidebar, header, dialogs, drawers, toasts. The light step from ground to card is tiny (98% to 99%); the hairline does the separating.
- **Popover White** (`popover`, pure white; dark equals `card`): menus and popovers.
- **Ink Navy** (`foreground`; dark `hsl(220 15% 92%)`): primary text, a blue-tinted near-black.
- **Pewter** (`muted-foreground`; dark `hsl(220 12% 58%)`): secondary text, column headers, resting icons, timestamps. It is the most-used colour utility (`text-muted-foreground`, about 9,600 uses). It reads 4.8:1 on a card but only 4.2:1 on a `muted` fill, so it is not chip text in light mode.
- **Slate Fog** (`muted`, same value as `secondary`; dark `hsl(224 18% 16%)`): neutral chips, table-header bands (`bg-muted/40`), skeletons, icon tiles, and the universal hover wash (`hover:bg-muted`, about 1,600 uses).
- **Hover Wash** (`accent`; dark `hsl(224 18% 18%)`): a slightly deeper wash, used rarely.
- **Hairline Slate** (`border`, same value as `input`; dark `hsl(224 18% 18%)`): every border and divider. The base layer makes it the default border colour, so a bare `border` utility is always on-token. At 1.24:1 against a card it is decorative, not an affordance boundary.

### Named Rules
**The Token-Only Rule.** (confirmed 2026-11-09) Colour comes from the semantic tokens (`bg-card`, `text-muted-foreground`, `bg-success/15`, `text-warning-ink`, `border-warning/40`). Raw Tailwind palette classes (`amber-*`, `red-*`, `emerald-*`, `gray-*` and the rest) are not part of the system: tokens theme themselves, while a palette hue needs a hand-written `dark:` twin. The palette uses in the code today are documented debt, not precedent.

**The Status-Is-Status Rule.** (confirmed 2026-11-09, proven on the ticket workspace) Status hues mean state and nothing else. Red is breach, destructive, or error; amber is waiting or at risk (pending, held for approval, SLA at risk); green is healthy or done. Priority, type, category, and every other attribute that is not a state stay neutral, and an ordinal like priority ranks by ink weight and fill (solid foreground, outline, plain, faint), never by hue. A state the technician parked on purpose (On hold, Closed) is neutral too. The 2px domain strip is the one place a status hue names something other than a state (see Layout).

**The Ink Rule.** (confirmed 2026-11-09) Status-coloured text uses the matching ink token: `text-success-ink`, `text-warning-ink`, `text-destructive-ink`, `text-primary-ink`. Bare `text-warning` (2.3:1 on a card, 2.0:1 on its own tint) and `text-success` (3.8:1 and 3.2:1) are never text. `text-destructive` clears AA on a plain card (5.6:1) but not on its own 15% tint (4.4:1), so chips take the ink. `components/tickets/ticketChipContrast.test.tsx` measures every ticket chip against the real tokens, including under selected and hovered queue rows.

**The Strong Amber Rule.** In light mode a thin warning affordance (ring, outline, dot, icon, count) uses `warning-strong`, never `warning`, which sits below even the 3:1 non-text minimum on a card.

**The Distinct Info Rule.** `info` is sky (205°), not slate-blue (225°), so an informational or "updating" state never reads as a primary action.

**The AA Destructive Rule.** `--destructive` clears 4.5:1 as text on card and background, and its fill keeps its label at 4.5:1, in both themes. `globals.destructiveContrast.test.ts` enforces it; retuning red without running it is a regression.

**Documented debt in colour (recorded, not rules):**
- About 6,400 raw palette utility uses across roughly 540 files, heaviest in amber, red, emerald, blue, and gray; most of the 1,277 `dark:` variants exist to patch them. The ticket workspace is clean and guarded (`ticketChipContrast.test.tsx` fails on any palette class in `components/tickets`).
- Bare status text: `text-warning` 263 uses, `text-success` 198. The shared `StatusPill` roles (`billing/shared/statusPillRoles.ts`) still paint success and info as bare token text and warning and danger as hand-tuned literals (`hsl(36 92% 28%)`, `hsl(4 74% 42%)`) that the ink tokens now replace.
- `text-white` on `bg-primary`: 40 lines (3.9:1 in dark); `bg-blue-600 text-white` primary look-alikes: 17.
- `text-muted-foreground` on `bg-muted`: 113 class strings at 4.2:1, including the `ScopeBadge` default tone and the expired/cancelled approval chips. The ticket workspace sets neutral chip text from `foreground` at 70% in light (`NEUTRAL_CHIP_TEXT`, `components/tickets/ticketConfig.ts`, 5.7:1); it is a local constant, not yet a token.
- `ScopeBadge`'s partner-wide tone is `text-primary` on `bg-primary/10`, about 4.1:1 in dark; `primary-ink` fixes it.
- `info` has no ink twin; `text-info` on a 15% info tint is 4.2:1.
- Palette leaks inside shared primitives: `EmptyState` (`dark:border-zinc-600`), `OverflowTabs` tab dot (`bg-green-500`), the sidebar approvals badge (`bg-amber-500/20 text-amber-800`).
- Chart series use Tailwind-500 hex literals; `--chart-4` is referenced (`components/backup/backupDashboardHelpers.ts`) but never defined; there is no categorical chart palette token.
- `components/auth/AuthPanelBranding.tsx` duplicates the primary as a literal (`bg-[hsl(225,62%,48%)]`).
- The `globals.css` comments call the neutrals "warm" (`:root` and `.dark` blocks). The values are cool slate (220–224°); the comments are stale. The `statusPillRoles.ts` comment still gives red as L56%; it has been L44% since #7511.

## Typography

**Display Font:** none. The console has no display tier; the largest routine text is the 24px KPI figure.
**Body Font:** Plus Jakarta Sans (with system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif). Weights 400/500/600/700, self-hosted through `@fontsource` (latin + latin-ext) and wired through the runtime `:root { --font-sans }`.
**Label/Mono Font:** the Tailwind default mono stack (ui-monospace, SFMono-Regular, Menlo, …) for hostnames, IPs, IDs, versions, hashes, and script output.
**Document Fonts (paper world only):** Hanken Grotesk, Literata, Barlow Condensed, DM Sans, imported from `@breeze/document-ui/document.css` for invoice and quote previews. They never appear in console chrome.

**Character:** a geometric-humanist sans with open apertures and a slightly friendly "a" and "y". It is professional without being corporate, the competent colleague rather than enterprise software. Set mostly at 14px medium, it reads as calm and businesslike rather than expressive.

Technicians can swap the brand face for the OS font (`<html data-font="system">`, an appearance preference in `lib/appearance.ts`). Every surface must stay legible in either face.

### Hierarchy
- **Headline** (600, 1.25rem, line-height 1.4, -0.025em): page titles through `PageHeader` (`text-xl font-semibold tracking-tight`).
- **Title** (600, 1.125rem, line-height 1.556): card and section titles. `font-semibold text-lg` is the most common heading recipe (474 identical class strings).
- **Title-sm** (600, 1rem, line-height 1.5): dialog, drawer, confirm, and empty-state titles.
- **Body** (400, 0.875rem, line-height 1.43): table cells, form fields, descriptions, toasts. It is the console's prevailing size (`text-sm`, about 10,900 uses). Descriptions under page titles cap at `max-w-prose`.
- **Body-strong** (500, 0.875rem): buttons, nav items, tabs, field labels. Medium is the default emphasis (`font-medium` about 6,500 uses, against `font-semibold` 2,100 and `font-bold` 125).
- **Label** (500, 0.75rem, line-height 1.333): metadata, helper text, chips, timestamps (`text-xs`, about 7,200 uses).
- **Label-caps** (600, 0.75rem, 0.025em tracking, uppercase): table column headers (`text-xs font-semibold uppercase tracking-wide text-muted-foreground`, 232 class strings). Sidebar group toggles use the same caps at weight 500.
- **Figure** (700, 1.5rem, tabular figures): KPI and stat-tile numbers.
- **Mono** (400, 0.75–0.875rem): machine identifiers, inline code, terminal-adjacent text.

### Named Rules
**The 12px Floor Rule.** (confirmed 2026-11-09) Interface text is 14px (`text-sm`), metadata is 12px (`text-xs`), and nothing is smaller: no `text-[10px]`, `text-[11px]`, or 11px `chart-legend-xs` in new code. Larger sizes are for titles and figures only.

**The Tabular Table Rule.** Every `<table>` and `.tabular-nums` element sets `font-variant-numeric: tabular-nums` in the base layer, so numeric columns align without per-cell classes. Right-align numeric columns.

**The Mono-for-Machines Rule.** Anything a technician might paste into a terminal (hostname, IP, MAC, serial, ID, version, path) is set in `font-mono`. Prose about it stays in the sans.

**Documented debt in type (recorded, not rules):**
- Sub-12px text: `text-[10px]` 112 uses and `text-[11px]` 95, including 15 on the ticket workspace itself (`TicketBudgetCard.tsx` field labels, `TicketChecklistCard.tsx`). The 11px `chart-legend-xs` utility has 74 uses, one of them the sidebar approvals badge.
- Page titles render at three sizes: `PageHeader` (`text-xl`), a raw `<h1>` falling back to the base rule (1.5rem, 700), and hand-set `text-2xl font-semibold tracking-tight`.
- `.dark body { line-height: 1.6 }` changes text metrics between themes, so a theme switch can reflow layouts.

## Layout

The shell is a full-height, three-zone frame (`layouts/DashboardLayout.astro`). A left sidebar sits on `bg-card` with a hairline right edge. The header is a 64px `bg-card` band (`h-16`) with a hairline bottom edge. `main` scrolls inside them with a 16px gutter, rising to 24px at `md:` (`p-4 md:p-6`). Content is full-bleed; there is no global max-width container. Forms and prose cap themselves (`max-w-md`, `max-w-2xl`, `max-w-3xl`, `max-w-prose`). Two right-docked panels (AI chat, Help) open over the content edge at 400px (`components/layout/rightDockPanel.ts`).

**Domain strip (signature).** A 2px full-bleed bar runs along the top of `main`, and its colour names the product area: primary for organizations, devices, fleet, and remote; primary at 70% for tickets and Wisp; primary at 50% for reports, analytics, audit, and logs; warning for security; warning at 70% for monitoring; destructive for alerts; success for scripts, patching, software, policies, backup, and integrations; success at 70% for billing; muted-foreground at 30% for settings and admin (`getAccentClass`, `layouts/DashboardLayout.astro:29`).

**Sidebar behaviour:** 256px open (`w-64`) or a 64px icon rail (`w-16`). The user picks open, hover-peek, or collapsed, and the choice persists. Below 768px the sidebar is hidden and opens as an overlay drawer over a `bg-background/80` veil. From 768px to 1023px it is forced to the rail, and the toggle peeks the labelled sidebar over the page. At 1024px and up the user's mode applies.

**Breakpoints:** Tailwind defaults (sm 640, md 768, lg 1024, xl 1280, 2xl 1536). Responsive work concentrates at `sm:`. `ResponsiveTable` reflows rows into stacked label/value cards below `sm`.

**Spacing rhythm:** a 4px base dominated by 8, 12, and 16px. The most-used steps are `px-3`, `px-4`, `gap-2`, `py-2`, and `py-3`. Cards pad 24px (`p-6`) or 16px (`p-4`).

**Density (signature, user preference):** `<html data-density>` takes `comfortable` (the default, with no overrides at all), `compact` (about 25–35% tighter), or `dense` (about 40–55% tighter). The rules retune the standard padding, gap, space-y, and margin utilities inside `main` only, tighten sidebar rows, and are written to shrink the header to 56px or 48px. They never touch the sidebar body, floating UI, or `[data-document-root]` paper (`densityIsolation.test.ts`).

**Layers:** page content, then in-page sticky elements (z-10 to z-20), then chrome overlays such as the popped-out sidebar and right-dock panels (z-30 to z-40), then modals, menus, and toasts (z-50), then the onboarding tour highlight (z-61). Toasts stack bottom-right, 24px in, lifting to 96px at `lg:` when a page stamps `data-toast-rail` for a sticky right rail.

### Named Rules
**The Wayfinding Strip Rule.** The domain strip is the only place a status hue names a place rather than a state. It stays 2px, full-bleed, `aria-hidden`, and textless, and a new area picks its colour in `getAccentClass`, never in the page.

**The Density-Reachable Rule.** New layouts use the standard spacing steps (`p-4`, `p-6`, `gap-2`, `space-y-4`, `mt-4`) so compact and dense can retune them; an arbitrary `p-[13px]` is invisible to the density rules.

**Documented debt in layout (recorded, not rules):**
- The density header rules select on the literal `header.h-16` class (`components/layout/Header.tsx`), and no test pins that hook, so any change to the header's height class silently stops compact and dense from shrinking it.

## Elevation & Depth

Hairline-first and near-flat (confirmed 2026-11-09). Resting surfaces are separated by a 1px `border`-coloured hairline plus a whisper shadow (`shadow-xs`, about 850 uses); the light-mode tonal step between ground and card (98% to 99%) is too small to carry separation alone. Shadows grow with float distance, not with importance. All shadows are Tailwind's neutral black-alpha values, untinted. In dark mode they nearly vanish, and depth comes from the lightness ladder instead (background 7%, card 10%, muted 16%, border 18%).

### Shadow Vocabulary
- **Whisper** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`, `shadow-xs`): resting cards and panels, always with a hairline border.
- **Menu** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`, `shadow-md`): `ActionMenu` and small dropdowns.
- **Float** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`, `shadow-lg`): dialogs, toasts, popovers, overflow menus, the mobile nav drawer.
- **Sheet** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`, `shadow-xl`): right-edge drawers and the peeking sidebar overlay.
- **Tour Halo** (`box-shadow: 0 0 0 4px hsl(var(--primary) / 0.4), 0 0 16px 2px hsl(var(--primary) / 0.15)`): the onboarding tour target only.

### Named Rules
**The Hairline-First Rule.** (confirmed 2026-11-09) A resting surface is a hairline plus at most `shadow-xs`. A larger shadow means the element floats above the page.

**The Float-Distance Rule.** (confirmed 2026-11-09) Shadow grows with how far a layer floats, not with how important it is: `shadow-xs` resting cards, `shadow-md` menus, `shadow-lg` dialogs and toasts, `shadow-xl` drawers. An important card earns its weight through type and position, never through lift.

**The One Veil Rule.** (confirmed 2026-11-09) Every modal backdrop is the page's own ground at 80% (`bg-background/80`), so the room dims instead of going black. The shared `Dialog` and `Drawer` carry it; the mobile nav veil adds a slight `backdrop-blur-xs`, and no panel itself is ever frosted.

**Documented debt in depth (recorded, not rules):**
- Black backdrops: `bg-black/50` 26 uses, `bg-black/40` 14, plus single `bg-black/30` (the right-dock scrim in `rightDockPanel.ts`), `/60`, and `/80` uses.
- Off-ladder shadows: `shadow-sm` 15 uses and `shadow-2xl` 5.
- `hover-lift` and `stagger-1` to `stagger-4` are defined in `globals.css` and used nowhere.

## Shapes

The base radius is `--radius: 0.5rem`, and the scale derives from it. **Controls are 6px** (`rounded-md`, about 6,400 uses): buttons, inputs, selects, nav items, menus, toolbar toggles, error banners, and the ticket board's row tags. **Containers are 8px** (`rounded-lg`, about 1,700): cards, dialogs, toasts, chart tooltips. **Pills are fully round** (`rounded-full`, about 1,500): status chips, count badges, avatars, switches (24×44px), status dots, icon chips. **Small marks are 4px**: `rounded-sm`, and bare `rounded`, which compiles to the same 4px here, for 16px checkboxes, inline code chips (`bg-muted px-1 rounded`), and the tiny buttons inside toasts. **12px** (`rounded-xl`, 48 uses) is a rare outlier, mostly the `EmptyState` frame.

Rules are the other half of the form language. A 1px hairline is the default edge of every surface. `divide-y` separates list and table rows. A dashed hairline marks empty states and drop zones. A 2px bottom rule marks the active tab, and a left hairline marks drawers.

Icons are Lucide (`lucide-react`) at the default 2px stroke. 16px (`h-4 w-4`) is standard, 14px sits inline in dense rows and chips, and 20px is for nav and dialog icons. Icon-only buttons carry an `aria-label`, and the collapsed nav rail keeps an `sr-only` label on every link.

### Named Rules
**The 6/8/Full Rule.** Controls 6px, containers 8px, pills full. Bare `rounded` and `rounded-sm` are the same 4px radius under two names and belong to small marks only.

**Documented debt in shape (recorded, not rules):**
- Some text inputs and buttons use bare `rounded` (4px) where the control norm is 6px.
- One-off `rounded-[3px]`, `rounded-[1px]`, and `rounded-[6px]` (5 uses).
- Two chip silhouettes coexist without a stated rule: round pills (`StatusPill`, most lists) and the 6px bordered tags on the ticket board.

## Components

There is no shared Button, Input, Card, or Badge component; those primitives are Tailwind recipes repeated inline, and the recipes below are the most frequent spelling of each. Overlays, tabs, empty states, page headers, and filter selects do have shared components under `components/shared/`. The component character is quiet, compact, and dependable: controls disappear into the work.

### Buttons
- **Shape:** gently rounded corners (6px); text is 14px medium.
- **Primary:** slate-blue fill with the `primary-foreground` label (white in light, near-black in dark), `8px 16px` padding (`px-4 py-2`), about 36px tall. A 40px (`h-10`) variant sits beside 40px inputs. Small: `px-3 py-1.5`. Extra-small: `px-2 py-1 text-xs`.
- **Hover / Focus / Press:** the fill darkens to 90% of itself (`hover:bg-primary/90`). The global `:focus-visible` outline is a 2px `ring`-coloured line with a 2px offset (`globals.focusVisible.test.ts`). Every enabled `<button>` presses to `scale(0.98)` over 100ms ease-out, off under reduced motion. Disabled is 50% opacity with `cursor-not-allowed`.
- **Secondary (outline):** transparent with a hairline border and foreground text; hover washes to `muted` (`shared/ConfirmDialog.tsx`).
- **Destructive:** red fill with its own label token, hover to 90% (`shared/ConfirmDialog.tsx`). Destructive ghost: red text with a `destructive/10` hover wash.
- **Icon button:** muted icon, 6px padding, 6px radius, hover `muted` wash with a foreground icon (`shared/Drawer.tsx`). The bordered square variant is 36px or 40px.

### Chips / Badges
- **Status chips:** a 15% token tint, a 30% token border, and ink text (`bg-warning/15 text-warning-ink border-warning/30`), 12px medium. Round pills in lists and records; 6px bordered tags (`px-1.5 py-0.5`) on the ticket board. Each carries a text label, so colour is never the only signal; `StatusPill` (`billing/shared/StatusPill.tsx`) adds a visually hidden "Status:" prefix.
- **Status roles:** meaning drives the hue, not a per-status rainbow. `StatusPill` maps every billing state onto five roles (neutral, info, success, warning, danger), and the text label carries the finer distinction.
- **Neutral chips:** `bg-muted` with foreground text at 70% in light and `muted-foreground` in dark (`NEUTRAL_CHIP_TEXT`).
- **Priority and type:** neutral, ranked by weight and fill instead of hue. On the ticket board Urgent is a solid foreground tag, High an outline, Normal is not shown, and Low is faint.
- **Scope badge** (`shared/ScopeBadge.tsx`): a 12px icon plus a label; organization is neutral, partner-wide is a primary tint, system is neutral with a package icon.
- **Count badge:** fully round, `warning/15` fill, `warning-strong` tabular text (`shared/OverflowTabs.tsx`).
- **Filter chips** (`devices/FilterChipBar.tsx`): bordered `muted` pills inside a bordered `bg-card` well; the chip/advanced mode toggle is a segmented control whose selected half fills primary.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** Card White on the Slate Mist ground.
- **Shadow Strategy:** hairline plus Whisper (see Elevation & Depth). The canonical `rounded-lg border bg-card p-6 shadow-xs` appears verbatim 280 times.
- **Border:** a 1px hairline, always.
- **Internal Padding:** 24px standard, 16px compact. The section title is Title (18px semibold); internal stacks are `space-y-4` to `space-y-6`.
- **Empty state** (`shared/EmptyState.tsx`): a dashed-hairline frame (12px radius), a centred muted icon, a Title-sm heading, a muted description capped at `max-w-sm`, and an optional action with a 40px minimum target. A `plain` variant drops the frame when the empty state already sits inside a card.

### Inputs / Fields
- **Style:** a 40px well (`h-10`; 36px `h-9` in toolbars and dense forms) on `background`, with a hairline border, 6px radius, 12px horizontal padding, and 14px text. `h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring` appears verbatim 151 times. `@tailwindcss/forms` normalizes native controls, and native `<select>` gets 28px of right padding globally.
- **Focus:** the native outline gives way to a 2px slate-blue ring (`focus:ring-2 focus:ring-ring`). Inputs use `focus:` rather than `focus-visible:` so a clicked field still shows where typing goes.
- **Filter select** (`shared/FilterSelect.tsx`): the same recipe plus a visually hidden `<label>`, so every filter has an accessible name.
- **Error / Disabled:** a red border and red helper text; the error banner is `rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive`. Disabled is 50% opacity.
- **Switch:** a 24×44px fully round track with a hairline border.

### Navigation
- **Sidebar** (`layout/Sidebar.tsx`, signature): `bg-card` with a hairline right edge and a brand header (partner logo or name). Nav items are 14px medium with a 20px icon, `8px 12px` padding, and a 6px radius. **The active item is a filled slate-blue pill** (`bg-primary text-primary-foreground`, `aria-current="page"`). Inactive items are muted, and hover washes `muted` and darkens the text. Sections collapse, and the collapsed rail centres icons and keeps `sr-only` labels.
- **Header** (`layout/Header.tsx`): the `bg-card` band described in Layout, holding the org switcher and the user menu among other controls.
- **Tabs** (`shared/OverflowTabs.tsx`): underline tabs on a hairline base. Each tab is 14px medium with `12px 4px` padding and a 2px bottom rule; active is a primary rule with primary text, inactive is muted with a muted-foreground rule on hover. Tabs that do not fit collapse into a "More" menu, and keyboard focus draws an inset ring.
- **Page header** (`shared/PageHeader.tsx`): an optional 36px `muted` icon tile (8px radius), a Headline title, a muted description capped at `max-w-prose`, and actions right-aligned. It stacks below `md`.

### Dialogs, Drawers & Menus
- **Dialog** (`shared/Dialog.tsx`): portaled. The veil is `bg-background/80`, fading in over 150ms ease-out. The panel is 8px radius, hairline, `bg-card`, Float shadow, `max-w-lg` by default (md to 5xl available), and scales in from 0.95 over 200ms `cubic-bezier(0.25, 1, 0.5, 1)`. It traps focus, closes on Escape, returns focus to the trigger, and swallows the second half of a double-click that lands after close.
- **Confirm dialog** (`shared/ConfirmDialog.tsx`): `max-w-md` with 24px padding, a 40px round tinted icon chip (destructive or warning), a Title-sm heading, and a muted message. Actions sit right-aligned with a 12px gap: outline Cancel, then the filled confirm.
- **Drawer** (`shared/Drawer.tsx`): full height on the right edge with a hairline left border and the Sheet shadow. The header is `px-5 py-4` over a hairline. It slides in over 220ms `cubic-bezier(0.22, 1, 0.36, 1)`.
- **Action menu** (`shared/ActionMenu.tsx`): `bg-popover`, hairline, 6px radius, Menu shadow, 176px minimum width, 4px vertical padding, optional 12px muted item descriptions, and hairline separators.

### Tables
- **Header:** Label-caps in `muted-foreground`, often on a `bg-muted/40` band. Sortable headers use `SortableTh`, a button with direction chevrons and `aria-sort`.
- **Body:** `divide-y` hairlines, `px-3`/`px-4 py-3` cells, row hover `bg-muted/40` or `bg-muted/50`, and tabular numerals by default.
- **Responsive:** `ResponsiveTable` swaps to stacked cards below `sm`.

### Toasts
- A bottom-right stack, 280–400px wide, 8px radius, hairline, Float shadow, entering with the fade-up settle (400ms). Success is a card with a green check icon; warning is a card with a `warning/50` border and an amber icon; error is a **filled** destructive toast with `role="alert"`. `runAction` fires one for every mutation.

### Code & Terminal Surfaces
- xterm (`#1a1b26`) and Monaco (`#1e1e1e`) panes are fixed dark in both themes. They are tools with their own palettes, outside the console's colour system.

### Named Rules
**The Default-Is-Silent Rule.** (confirmed 2026-11-09, an Operate-density rule proven on the ticket board) A chip appears only when its value deviates from the default. A board of mostly Normal, Open, Incident rows shows no Normal, Open, or Incident chips, so the chip that does appear is information (`RowChips`, `components/tickets/TicketQueueList.tsx`).

**The One Hover Rule.** (confirmed 2026-11-09) A filled button darkens to 90% of its own fill on hover (`hover:bg-primary/90`, `hover:bg-destructive/90`). It never fades as a whole, label included.

**Documented debt in components (recorded, not rules):**
- 765 `className` strings contain `bg-primary`, in 326 distinct spellings. Hover is split between `hover:opacity-90` (482) and `hover:bg-primary/90` (143); disabled opacity between 50% (1,097), 60% (448), 40% (48), 30% (14), and 70% (7).
- Focus-ring dialects beside the intended `focus:ring-2 focus:ring-ring`: `focus-visible:ring-2` (187), `focus:ring-primary` (48), `focus:ring-primary/20–50` (43), `focus:ring-1` (19). All are on-hue; widths and opacities vary.
- The warning toast's icon is `text-warning`, 2.3:1 on a card and below the 3:1 non-text minimum; `warning-strong` is the indicator token.

## Do's and Don'ts

### Do:
- **Do** set every colour through a semantic token (`bg-card`, `text-muted-foreground`, `bg-success/15`, `text-warning-ink`, `border-warning/40`). Tokens theme themselves in dark mode.
- **Do** set status-coloured text in the matching ink (`text-success-ink`, `text-warning-ink`, `text-destructive-ink`, `text-primary-ink`), on the card and on the hue's own tint.
- **Do** keep status hues for state: red for breach, destructive, or error; amber for waiting or at risk; green for healthy or done. Keep priority, type, and category neutral and rank priority by weight and fill.
- **Do** show a chip only when its value deviates from the default.
- **Do** build a resting card as hairline + `shadow-xs` + 8px radius + 24px (or 16px) padding, and size any larger shadow by how far the layer floats: `shadow-md` menus, `shadow-lg` dialogs and toasts, `shadow-xl` drawers.
- **Do** use the shared overlays (`Dialog`, `ConfirmDialog`, `Drawer`) instead of a hand-rolled `fixed inset-0` panel. They carry the `bg-background/80` veil, motion, focus trap, and gesture-tail guard.
- **Do** darken a filled button with `hover:bg-primary/90` (or the matching token at 90%).
- **Do** use `warning-strong` for thin warning rings, dots, icons, and count text in light mode, and `warning` only as a fill or tint.
- **Do** pair every status colour with a text label, and every `chart-neutral` segment with a visible label and count.
- **Do** use `text-primary-foreground` on a primary fill and `text-destructive-foreground` on a red fill.
- **Do** keep page body text at 14px and metadata at 12px. Put identifiers in `font-mono` and numbers in tabular figures.
- **Do** keep interaction motion to Tailwind's 150ms `cubic-bezier(0.4, 0, 0.2, 1)` colour transitions. Use the settle easing `cubic-bezier(0.22, 1, 0.36, 1)` only for entrances (fade-up, drawer, slide-in), and leave the global `prefers-reduced-motion` kill switch intact.
- **Do** use the standard spacing steps (`p-4`, `p-6`, `gap-2`, `space-y-4`) so the compact and dense rules can reach the layout.

### Don't:
- **Don't** use raw Tailwind palette classes (`bg-amber-50`, `bg-green-100 text-green-800`, `text-gray-500`) for status or neutrals. The roughly 6,400 existing uses are documented debt, not precedent.
- **Don't** set `text-warning` (2.3:1) or `text-success` (3.8:1) as text. Existing code still has 263 and 198 of them.
- **Don't** set text below 12px: no `text-[10px]`, `text-[11px]`, or `chart-legend-xs` in new code. Existing code still has 207 arbitrary sub-12px sizes and 74 `chart-legend-xs` uses.
- **Don't** dim a modal with black (`bg-black/50`, `bg-black/40`). The one veil is `bg-background/80`; 45 black backdrops remain as debt.
- **Don't** use `hover:opacity-90` on a button. It fades the label along with the fill.
- **Don't** colour priority, type, or category with a status hue, or use a status hue for anything but state. The 2px domain strip is the only exception.
- **Don't** put `text-white` on `bg-primary`. The dark-mode primary is light, and white on it is 3.9:1.
- **Don't** give a resting card `shadow-md` or larger, or frost a panel with backdrop blur.
- **Don't** introduce gradient text, glassmorphism, neon-on-dark, or identical card grids. These are PRODUCT.md's confirmed anti-reference.
- **Don't** let density rules or dark mode reach the document paper (`[data-document-root]`). Invoices and quotes stay white by design.
