---
name: Breeze Mobile
description: Trusted-device companion to Breeze RMM. Out-of-band approval surface for MCP step-up, with ambient AI chat and fleet status.
colors:
  brand: "#1c8a9e"
  brand-soft: "#3eaec3"
  brand-deep: "#0f5f6e"
  approve: "#2cb567"
  approve-pressed: "#208c50"
  approve-on: "#04230f"
  deny: "#d94a3d"
  deny-on: "#fff5f3"
  warning: "#dba84a"
  warning-on: "#241906"
  critical: "#7a1d18"
  critical-on: "#fff5f3"
  dark-bg-0: "#0a1014"
  dark-bg-1: "#0f161b"
  dark-bg-2: "#162026"
  dark-bg-3: "#1f2c33"
  dark-border: "#2b3940"
  dark-text-hi: "#eef4f6"
  dark-text-md: "#a8b8be"
  dark-text-lo: "#6b7d83"
  light-bg-0: "#f9fbfb"
  light-bg-1: "#f1f5f6"
  light-bg-2: "#e6ecee"
  light-bg-3: "#d8e0e3"
  light-border: "#bfc9cd"
  light-text-hi: "#0a1014"
  light-text-md: "#3a484e"
  light-text-lo: "#6b7d83"
typography:
  display:
    fontFamily: "Geist-SemiBold, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: "36px"
    letterSpacing: "-0.4px"
  title:
    fontFamily: "Geist-SemiBold, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.2px"
  bodyLg:
    fontFamily: "Geist-Regular, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "24px"
  body:
    fontFamily: "Geist-Regular, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  bodyMd:
    fontFamily: "Geist-Medium, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
  meta:
    fontFamily: "Geist-Medium, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
    letterSpacing: "0.1px"
  metaCaps:
    fontFamily: "Geist-SemiBold, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "14px"
    letterSpacing: "1.0px"
  mono:
    fontFamily: "GeistMono-Regular, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  monoMd:
    fontFamily: "GeistMono-Medium, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
  "20": "80px"
components:
  button-approve:
    backgroundColor: "{colors.approve}"
    textColor: "{colors.approve-on}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
    typography: "{typography.bodyMd}"
  button-approve-pressed:
    backgroundColor: "{colors.approve-pressed}"
    textColor: "{colors.approve-on}"
    rounded: "{rounded.lg}"
  button-deny:
    backgroundColor: "{colors.dark-bg-2}"
    textColor: "{colors.dark-text-hi}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
    typography: "{typography.bodyMd}"
  card-details:
    backgroundColor: "{colors.dark-bg-2}"
    textColor: "{colors.dark-text-hi}"
    rounded: "{rounded.md}"
    padding: "16px"
  band-risk-low:
    backgroundColor: "{colors.brand-deep}"
    textColor: "{colors.dark-text-hi}"
    rounded: "{rounded.md}"
    padding: "16px"
  band-risk-medium:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.warning-on}"
    rounded: "{rounded.md}"
    padding: "16px"
  band-risk-high:
    backgroundColor: "{colors.deny}"
    textColor: "{colors.deny-on}"
    rounded: "{rounded.md}"
    padding: "16px"
  band-risk-critical:
    backgroundColor: "{colors.critical}"
    textColor: "{colors.critical-on}"
    rounded: "{rounded.md}"
    padding: "16px"
  toast-approve:
    backgroundColor: "{colors.approve}"
    textColor: "{colors.approve-on}"
    rounded: "{rounded.md}"
    padding: "16px"
  toast-deny:
    backgroundColor: "{colors.deny}"
    textColor: "{colors.deny-on}"
    rounded: "{rounded.md}"
    padding: "16px"
  input-reason:
    backgroundColor: "{colors.dark-bg-2}"
    textColor: "{colors.dark-text-hi}"
    rounded: "{rounded.md}"
    padding: "16px"
    typography: "{typography.body}"
---

# Design System: Breeze Mobile

## 1. Overview

**Creative North Star: "The Calm Sentinel"**

Breeze Mobile is the security identity that makes high-tier AI agent actions safe. Its load-bearing moment is the 11:47pm buzz — owner of a 30-tech MSP glances at their phone, reads a request, trusts it's real, taps once. Every other surface (AI chat, fleet status, alerts) is ambient. The system rejects the visual register of generic mobile SaaS: no gradient text, no glassmorphism, no neon-on-dark, no candy palettes. It also rejects the cold, default look of stock React Native: Geist replaces system sans, brand-tinted neutrals replace pure greys, and color is committed to a single cool teal anchor with strict status semantics.

Density is calm but confident. One card on screen at a time during the security moment; spacious rows everywhere else. Type carries the headline, not decoration. Motion is short, smooth, and deferential — ease-out-quint at all times, no bounce, no elastic. Color drives meaning: green is *only* approve / healthy, red is *only* deny / critical, amber is *only* warning. The brand teal carries identity but never status.

**Key Characteristics:**
- Dark-canonical, light supported. The 11:47pm scene drives the default.
- One color carries the surface (Committed strategy). Brand teal anchors. Status colors are reserved for status.
- Geist sans + GeistMono. The mono carries arguments and tool names; the sans carries everything else.
- Spacious rows over dense cards. Cards appear when something demands focus.
- Motion is one curve, five durations. Variance lives in the curve, not the speed.

## 2. Colors: The Cool Teal Committed Palette

The palette is Committed, not Restrained — one saturated teal carries the brand identity. Every neutral is tinted toward that hue. No pure black, no pure white. Status colors are independent of brand and are used only for their semantic meaning.

### Primary
- **Brand Teal** (`#1c8a9e`, canonical `oklch(58% 0.13 200)`): the identity anchor. Carries the countdown ring, the hold-to-confirm fill, links, focus states, the AI streaming pulse. Never appears as a status. Used on ≤25% of any approval-mode screen.
- **Brand Soft** (`#3eaec3`): hover and emphasis variant of the brand. Light wash on brand-tinted surfaces.
- **Brand Deep** (`#0f5f6e`): low-impact risk band background; secondary brand chrome.

### Status
- **Approve Green** (`#2cb567`, `oklch(70% 0.18 145)`): only on approve buttons, success toasts, healthy fleet states. Pressed variant `#208c50`. Wash overlay `rgba(44,181,103,0.18)` for the success sweep. On-color text `#04230f`.
- **Deny Red** (`#d94a3d`, `oklch(62% 0.22 25)`): only on deny actions, error toasts, high-impact risk bands. Wash `rgba(217,74,61,0.18)`. On-color text `#fff5f3`.
- **Warning Amber** (`#dba84a`, `oklch(78% 0.15 75)`): only for medium-impact risk bands and warning haptics. On-color text `#241906`.
- **Critical Maroon** (`#7a1d18`): only for critical (irreversible) risk bands. On-color text `#fff5f3`.

### Neutral — Dark (canonical)
- **Surface 0** (`#0a1014`): app background. Near-black, brand-tinted.
- **Surface 1** (`#0f161b`): elevated sheets (deny-reason sheet bottom).
- **Surface 2** (`#162026`): cards, inputs, secondary buttons (deny).
- **Surface 3** (`#1f2c33`): countdown ring track, hover, pressed accents.
- **Border** (`#2b3940`): hairline dividers, card outlines.
- **Text High** (`#eef4f6`), **Medium** (`#a8b8be`), **Low** (`#6b7d83`): primary, secondary, label text.

### Neutral — Light (supported)
- Surface ramp `#f9fbfb` → `#f1f5f6` → `#e6ecee` → `#d8e0e3`. Border `#bfc9cd`. Text ramp `#0a1014` / `#3a484e` / `#6b7d83`.

### Named Rules

**The One Voice Rule.** Brand teal carries identity, never status. If a chip is teal, it's a brand affordance (link, focus, pulse). If something needs to mean "good" or "bad", use approve green or deny red. Never substitute brand for status to "tone things down."

**The Tinted Neutral Rule.** No `#000`, no `#fff`. Every neutral is brand-hue tinted (chroma 0.005–0.012). The dark surface ramp is canonical at 200° hue.

**The 200° Hue Rule.** The brand and all neutrals share hue 200. Status colors hold their own hue (145, 25, 75) by design, so semantic intent reads instantly across the surface.

## 3. Typography

**Display Font:** Geist (Vercel) with `system-ui` fallback.
**Mono Font:** GeistMono with `ui-monospace` fallback.
**Label/Caps:** Geist SemiBold tracked +1.0px.

**Character:** Geist is geometric, near-neutral, modern without being sterile — the calm-control voice. GeistMono carries tool names and JSON arguments verbatim, so a tech can scan `breeze.devices.delete` without a second glance and trust the rendering. The two faces share metrics, so the mono/sans interplay in the approval card never feels patched together.

### Hierarchy
- **Display** (SemiBold 32/36, letter-spacing −0.4): the approval *what* headline only. *"Delete 4 devices in Acme Corp."* No other surface uses this size.
- **Title** (SemiBold 22/28, letter-spacing −0.2): empty-state titles, sheet headings.
- **Body Large** (Regular 17/24): default body in roomy reads.
- **Body** (Regular 16/24): default chat / list body.
- **Body Medium** (Medium 16/24): button labels, emphasized body.
- **Meta** (Medium 13/18, letter-spacing +0.1): timestamps, secondary captions.
- **Meta Caps** (SemiBold 11/14, letter-spacing +1.0): section eyebrows ("REQUESTING", "TOOL", risk-tier label).
- **Mono** (Regular 14/22): JSON argument trees in expanded details.
- **Mono Medium** (Medium 14/22): tool names in collapsed details.

### Named Rules

**The Imperative Headline Rule.** Approval display copy is imperative, present tense, plain English. *"Delete 4 devices in Acme Corp."* Not *"A request to perform device deletion has been initiated."* Display type earns its size through directness, not length.

**The Mono-For-Verbatim Rule.** Anything quoted from the underlying API (tool names, arguments, request IDs) is rendered in GeistMono so it visually marks itself as machine-truth, not editorial copy.

## 4. Elevation

The system is **flat by default with tonal layering**. Depth is conveyed by stepping the dark-surface ramp (`bg0` → `bg1` → `bg2` → `bg3`), not by shadows. The bottom sheet uses no shadow — just a top corner radius and the dimmed scrim behind it.

### Shadow Vocabulary

The success-wash overlay and the toast lift give a sense of elevation without using `box-shadow`:

- **Success wash** (`rgba(44,181,103,0.18)` full-screen, animated bottom-up): not a shadow, an atmosphere. Sweeps in 200ms, fades out 600ms.
- **Toast lift** (translate-Y 20→0, opacity 0→1, 240ms ease-out-quint): the toast appears to rise from the thumb zone.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. No `box-shadow` on cards, buttons, or sheets. Hierarchy comes from the surface ramp.

**The No-Glassmorphism Rule.** No `backdrop-filter`, no decorative blurs. The sheet scrim is a flat `rgba(0,0,0,0.55)`, intentional and dim, never blurred.

## 5. Components

### Buttons
- **Shape:** generously curved (`16px` radius, `rounded.lg`).
- **Approve:** `#2cb567` background, `#04230f` text, Body Medium, padding `20px / 24px`, weight `flex: 1.4` versus deny's `flex: 1`. Pressed shifts to `#208c50`. Always preceded by biometric (or recursive: 5s hold-to-confirm).
- **Deny:** `#162026` (Surface 2) background, high-text foreground, Body Medium, same padding, `flex: 1`. Pressed shifts to Surface 3. No biometric — single tap opens an optional reason sheet.
- **Asymmetric Pair Rule:** approve is always larger and right-anchored. Deny is smaller and left-anchored. The asymmetry is the design — approving requires more deliberate thumb travel.

### Hold To Confirm (recursive self-approval)
- **Shape:** 56px height, `rounded.lg`, brand teal 1px border, Surface 2 fill.
- **Behavior:** press-and-hold animates a brand-teal fill (35% opacity) from left edge over 5 seconds. Hold completes → Warning haptic + onComplete. Release before completion → fill rewinds in 180ms.
- **Use only:** when the requesting client is the same phone (recursive AI step-up).

### Cards / Details
- **Shape:** `rounded.md` (10px). Surface 2 fill, 1px Surface Border outline.
- **Internal padding:** `spacing.4` (16px).
- **Pattern:** the DetailsCollapse pairs a Meta-Caps eyebrow ("TOOL") with a Mono-Medium primary value, plus a Meta toggle ("Show details"). When expanded, JSON args render in Mono Regular below a top-border divider. Selectable text always.

### Risk Band
- **Shape:** `rounded.md`, padding `spacing.4`, full-width minus screen gutters.
- **Pattern:** Meta-Caps eyebrow (LOW IMPACT / MEDIUM IMPACT / HIGH IMPACT / CRITICAL) atop a body-sized summary line. Background and text color come from the tier's `riskTier` mapping — never overridden inline.

### Countdown Ring
- **Shape:** 56px SVG circle, 3px stroke. Surface 3 track, brand-teal progress arc.
- **Behavior:** linear progress from full to zero over the request's lifetime (typically 60s). On expiry, fires `onExpire` once. No haptic — silence is intentional.
- **Position:** top-left of the approval surface, paired with a "Report" link top-right.

### Toast
- **Shape:** `rounded.md`, padding `spacing.4`, anchored bottom-`spacing.20` with `spacing.6` horizontal gutters.
- **Behavior:** slide-up + fade-in 240ms, hold 1800ms, slide-down + fade-out 180ms. Color matches decision (approve green / deny red).

### Bottom Sheet (Deny Reason)
- **Shape:** Surface 1 fill, `rounded.xl` top corners only, padding `spacing.6` / bottom `spacing.10`.
- **Scrim:** `rgba(0,0,0,0.55)` dimming, tap-outside dismisses.
- **Input:** Surface 2 fill, `rounded.md`, multiline, 88px min-height, top-aligned text.

### Inputs
- **Shape:** `rounded.md`, Surface 2 fill, padding `spacing.4`, no border by default.
- **Placeholder:** Text Low color, sentence case.
- **Focus:** brand-teal 1px border (to be applied consistently in phase 2).

### Status Indicators
- Status color tokens (`approve.base`, `deny.base`, `warning.base`, `critical`) are the only colors permitted for healthy/critical/warning roles. The legacy `StatusBadge` component still uses generic Tailwind hex (`#dc2626`, `#22c55e`, etc.) — a phase-1 leftover scheduled for migration before being reused.

## 6. Do's and Don'ts

### Do:
- **Do** anchor every screen on Surface 0 (`#0a1014`) in dark mode. Step up the ramp for cards, never sideways into a different hue.
- **Do** use Geist for every label, headline, and body string. GeistMono for every value rendered verbatim from the API.
- **Do** reserve approve green for healthy / approve, deny red for deny / critical, amber for warning. One semantic, one color.
- **Do** use the brand teal (`#1c8a9e`) for identity affordances — countdown ring, focus, pulses, links — never for status.
- **Do** animate with `Easing.bezier(0.22, 1, 0.36, 1)` (ease-out-quint) at one of five durations: 180 / 240 / 320 / 400 / 280ms.
- **Do** keep the asymmetric button pair: approve `flex: 1.4`, deny `flex: 1`. Approve right, deny left.
- **Do** use `rounded.lg` (16px) on actionable surfaces, `rounded.md` (10px) on info cards and bands, `rounded.xl` (24px) on sheets.
- **Do** label section eyebrows in Meta Caps (11px, +1.0 letter-spacing). REQUESTING. TOOL. LOW IMPACT.

### Don't:
- **Don't** use `#000` or `#fff`. Pure black and pure white never appear in this system. Use `#0a1014` or `#eef4f6`.
- **Don't** use generic Tailwind / Material status hex (`#dc2626`, `#3b82f6`, `#22c55e`). They violate the 200°-hue tinted-neutral rule and read as AI-generated.
- **Don't** use `border-left` greater than 1px as a colored accent stripe on cards or list items. Forbidden.
- **Don't** use gradient text (`background-clip: text`). Forbidden.
- **Don't** use glassmorphism / `backdrop-filter` / decorative blurs. The bottom sheet uses a flat scrim, intentionally.
- **Don't** use `box-shadow` for elevation. Step the surface ramp instead.
- **Don't** apologize in copy. *"Sorry, I encountered an error..."* is forbidden. Plain noun + verb, present tense. *"Approve failed. Try again."*
- **Don't** use em dashes in copy (`—`) or `--`. Use commas, colons, semicolons, periods, parentheses.
- **Don't** write gerund chains (*"Loading your devices..."*). Use *"Loading."* or skeletons.
- **Don't** put status meaning on the brand teal. *"Healthy"* in teal reads as a system tell, not a status.
- **Don't** add bounce, elastic, or spring physics to motion. Ease-out-quint, every time.
- **Don't** ship modals as a first thought. The deny-reason sheet is a sheet, not a modal. Inline progressive disclosure preferred everywhere else.
- **Don't** introduce new typography sizes outside the nine-step scale. Variance is in weight and family pairing, not size.
- **Don't** use system fonts as a fallback in production. Geist must be loaded; `system-ui` is a degraded path, not an acceptable default.
