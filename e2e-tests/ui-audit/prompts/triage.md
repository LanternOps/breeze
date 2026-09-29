# UI triage — per-route prompt (Opus-class vision model)

Use a top-tier model. On the 2026-09-26 run (28 entries, 71 screenshots),
Haiku marked 35 of 39 findings `false-positive` and was wrong on all 10
disagreements that were checked by eye. For example, it said a clipped button
and a Save button covering text "fit within the viewport". Opus got all 10
right and found 17 defects no detector caught. A missed bug is silent, so the
cheap model saves nothing here. Sonnet is untested.

Feed `triage-queue.json` entries, batching 3–5 per call. Each is an `items`
entry with its `screenshots`, or a `shell` entry (one layout finding seen on
3+ routes) with its single `screenshot`. Send the JSON plus the images,
including every `crops` / `crop` close-up. The queue already excludes clean
renders and every finding that doesn't need eyes: axe, console, network and
navigation findings.

---

You are triaging automated UI-audit findings for Breeze RMM, a dense B2B
admin console (tables, forms, dashboards) used all day by MSP technicians.
For the route below you get the detector findings and the screenshots where
they fired. Decide, for each finding, whether it is a real defect a user
would notice.

Rules:
- Judge only what the images show. Screenshots cover the viewport only (the
  app scrolls its main panel, not the page). A finding further down the page
  comes with a close-up in its `crops` (or `crop` on a shell entry). Judge it
  from the close-up. Say `not-visible` only if neither image shows the
  element or the problem. Do not guess.
- Truncation with an ellipsis is fine; text cut mid-word with no ellipsis is a bug.
- A horizontal scrollbar on a data table inside its own scroll container is
  fine; the whole page scrolling sideways on mobile is a bug.
- `blocked` lists writes the audit stopped during capture. An error box,
  empty preview or failed state that comes from one of them is caused by the
  audit, not the product: don't report it.
- Also report any obvious visual defect in the images that no detector caught
  (overlapping text, broken alignment, unreadable dark-mode elements, empty
  states that look broken). Put these in `extra`.
- UX (optional, at most 3 per entry): problems visible in these images that
  would slow down or mislead a technician doing the page's job. Examples: the
  primary action is buried or missing, a destructive action looks the same as
  a safe one, a status can't be read at a glance, a raw error is shown with no
  next step, controls that belong together are split up. Each one must be
  specific to this page and fixable. Leave out taste ("could be more modern"),
  generic advice, and anything you would have to guess about behaviour you
  can't see. Leave `ux` empty rather than pad it. The whole-page design
  critique is a separate pass (`critique.md`).

Return JSON only:

```json
{
  "path": "<route>",
  "verdicts": [
    {
      "finding": "<kind> <selector>",
      "verdict": "bug" | "minor" | "false-positive" | "not-visible",
      "screenshot": "<file or crop you judged from>",
      "why": "<one sentence>",
      "fix_hint": "<one sentence, CSS-level, optional>"
    }
  ],
  "extra": [
    { "source": "visual", "screenshot": "<file>", "what": "<one sentence>", "severity": "high" | "medium" | "low" }
  ],
  "ux": [
    { "screenshot": "<file>", "what": "<one sentence>", "why": "<the technician's cost, one sentence>", "fix": "<one sentence>", "impact": "high" | "medium" | "low" }
  ]
}
```
