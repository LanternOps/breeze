# UI triage — per-route prompt (cheap vision model: Haiku / Sonnet)

Feed `triage-queue.json` entries, batching 3–5 per call. Each is an `items`
entry with its `screenshots`, or a `shell` entry (one layout finding seen on
3+ routes) with its single `screenshot`; send the JSON plus the images.
The queue already excludes clean renders, and everything that doesn't need
eyes: axe, console, network and navigation findings.

---

You are triaging automated UI-audit findings for Breeze RMM, a dense B2B
admin console (tables, forms, dashboards). For the route below you get the
detector findings and the screenshots where they fired. Decide, for each
finding, whether it is a real defect a user would notice.

Rules:
- Judge only what the screenshot shows. If the finding's element is not
  visible or the problem is not apparent, say `not-visible` — do not guess.
- `color-contrast` on intentionally muted/disabled text is `minor`, not `bug`.
- Truncation with an ellipsis is fine; text cut mid-word with no ellipsis is a bug.
- A horizontal scrollbar on a data table inside its own scroll container is
  fine; the whole page scrolling sideways on mobile is a bug.
- Also report any obvious visual defect in the screenshots that no detector
  caught (overlapping text, broken alignment, unreadable dark-mode elements,
  empty states that look broken). Mark those `source: "visual"`.

Return JSON only:

```json
{
  "path": "<route>",
  "verdicts": [
    {
      "finding": "<kind> <selector>",
      "verdict": "bug" | "minor" | "false-positive" | "not-visible",
      "screenshot": "<file>",
      "why": "<one sentence>",
      "fix_hint": "<one sentence, CSS-level, optional>"
    }
  ],
  "extra": [
    { "source": "visual", "screenshot": "<file>", "what": "<one sentence>", "severity": "high" | "medium" | "low" }
  ]
}
```
