# Astro 7 + Tailwind 4 + Vite 8 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring both Astro apps (`apps/web`, `apps/portal`) from Astro 6.4.7 + Tailwind 3.4 onto Tailwind 4 (`@tailwindcss/vite`), then Astro 7 (which pulls in Vite 8 / Rolldown), in small independently-revertible PRs.

**Architecture:** The two upgrades are coupled by force — there is **no Astro-7-compatible `@astrojs/tailwind`** (its latest `6.0.2` peer-depends on `astro ^3 || ^4 || ^5`), so reaching Astro 7 requires replacing that integration with `@tailwindcss/vite`, which is **Tailwind 4 only**. They are sequenced — not fused — to isolate the risky, visual-regression-heavy Tailwind 3→4 migration (done first, on the stable Astro 6 compiler) from the mechanical Astro 7 / Vite 8 bump (done second). Portal (smaller surface) leads web at every phase.

**Tech Stack:** Astro, React islands, Tailwind CSS, Vite, `@astrojs/node` (standalone SSR), `@sentry/astro` (web only), `@tailwindcss/forms` + `@tailwindcss/typography`, self-hosted Plus Jakarta Sans via `@fontsource`.

## Global Constraints

- **Node toolchain:** prefix every `pnpm`/`npx`/`vitest`/`astro` command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict; fresh worktrees need `pnpm install`).
- **Isolated worktree:** do ALL work in a dedicated git worktree, never in the shared `/Users/toddhebebrand/breeze` checkout, and verify the base commit before branching (avoids the shared-working-copy branch-drift hazard). Use the `superpowers:using-git-worktrees` skill.
- **`.astro` files are not type-checked by `tsc`:** the build/typecheck gate for any Astro change MUST be `astro check`, not plain `tsc`.
- **Theme is `darkMode: 'class'`** driven by space-separated HSL channels in CSS custom properties (`--background: 220 20% 98%`) consumed as `hsl(var(--background))`. Tailwind 4 defaults dark mode to `prefers-color-scheme`; the class-based toggle MUST be preserved via an explicit `@custom-variant`.
- **Tailwind versions (verified 2026-06-22):** `@tailwindcss/vite` latest `4.3.1`; `@sentry/astro` latest `10.59.0` peer `astro >=7.0.0-beta` (Astro 7 OK); `@astrojs/node@11` peer `astro ^7.0.0-alpha.2` (the v7 adapter).
- **CSP is enforced in both `astro.config.mjs` files.** Portal uses `style-src 'self'` (no `unsafe-inline`); web uses `'unsafe-inline'` for xterm.js. Any styling change MUST be re-validated against CSP — web has a real-browser CSP drift guard at `apps/web/scripts/check-csp-violations.ts`.
- **Merge process:** `gh pr merge --squash --admin`; gate on required-check *conclusions* (Test API/Web/Agent, Integration, Type Check), ignore Trivy/Cargo/doc-verify. User-facing/UI PRs are held for Todd's manual UI test before merge.
- **Each PR must be independently revertible.** Phases 1–2 (Tailwind) land before Phase 3 (Astro 7) is started.

## Verification philosophy for this plan

This is a dependency/CSS migration, not feature work — there is no meaningful "failing unit test" to write first for "upgrade Tailwind." Each task's verification gate is therefore: **(1)** the official codemod / config change applies cleanly, **(2)** `astro check` passes, **(3)** `astro build` succeeds, **(4)** the existing `vitest` suite for that app passes, and **(5)** a Playwright-driven visual smoke of the app's key surfaces shows no regression. Where a behavior is genuinely testable (e.g. dark-mode class toggling), a real assertion is added. New vacuous tests are NOT to be written.

## File Structure (what each phase touches)

| File | Phase | Responsibility after change |
|---|---|---|
| `apps/portal/package.json` | 1 | drop `@astrojs/tailwind`, `tailwindcss@3`, `postcss`, `autoprefixer`; add `tailwindcss@4`, `@tailwindcss/vite@4` |
| `apps/portal/astro.config.mjs` | 1 | remove `tailwind()` integration; add `@tailwindcss/vite` to `vite.plugins` |
| `apps/portal/src/styles/globals.css` | 1 | `@import "tailwindcss"`, `@plugin`, `@theme inline`, `@custom-variant dark`, compat shims |
| `apps/portal/tailwind.config.mjs` | 1 | deleted (config moves into CSS) or retained only as `@config` bridge if needed |
| `apps/web/package.json` | 2 | same dep swap as portal |
| `apps/web/astro.config.mjs` | 2 | same integration→plugin swap; keep Sentry + CSP + proxy untouched |
| `apps/web/src/styles/globals.css` (8,974 lines) | 2 | the large migration: directives, plugins, theme, dark variant, `@layer` audit |
| `apps/web/tailwind.config.mjs` | 2 | deleted / `@config` bridge |
| `apps/web/astro.config.mjs`, `apps/portal/astro.config.mjs` | 3 | `node()` adapter → v11; no other change needed |
| both `package.json` | 3 | `astro@7`, `@astrojs/node@11`, `@astrojs/react@6`, `@sentry/astro@^10.59`, `@astrojs/check` bump |

---

## PHASE 0 — Worktree & baseline

### Task 0: Create isolated worktree and capture a green baseline

**Files:** none (environment only)

- [ ] **Step 1: Create the worktree on a fresh base**

```bash
cd /Users/toddhebebrand/breeze
git fetch origin
git worktree add ../breeze-astro7 -b chore/tailwind4-portal origin/main
cd ../breeze-astro7
git log -1 --oneline   # confirm base == current origin/main HEAD
```

- [ ] **Step 2: Install with the pinned Node**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

- [ ] **Step 3: Capture a baseline build + test for portal and web (must be green BEFORE changing anything)**

```bash
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/portal astro check && pnpm --filter @breeze/portal build
pnpm --filter @breeze/web astro check && pnpm --filter @breeze/web build
pnpm --filter @breeze/web test
```
Expected: all pass. If any fail on a pristine tree, STOP and report — that is a pre-existing breakage, not yours. (Verify the exact pnpm filter names against the `name` field in each `package.json` first.)

- [ ] **Step 4: Capture before-screenshots for visual diffing**

Bring up the stack with the `worktree-stack` skill, then with Playwright (creds `admin@breeze.local` / `BreezeAdmin123!`, `PUBLIC_API_URL=http://localhost`, web on `:4321`) screenshot: dashboard, a data-table page (e.g. Devices), Scripts (Monaco editor), an alerts page, light AND dark mode, plus the portal login + one portal page. Save under `docs/superpowers/spikes/astro7-baseline/`. These are the regression reference for every later phase.

---

## PHASE 1 — Tailwind 4 on `apps/portal` (PR A, on Astro 6)

> Smaller surface; proves the migration recipe before applying it to web's 8,974-line stylesheet.

### Task 1: Swap dependencies and the integration for the Vite plugin

**Files:**
- Modify: `apps/portal/package.json`
- Modify: `apps/portal/astro.config.mjs`

**Interfaces:**
- Produces: a Tailwind-4 build pipeline driven by `@tailwindcss/vite` (consumed by Task 2's CSS).

- [ ] **Step 1: Run the official upgrade codemod (it edits deps, config, and CSS)**

```bash
cd apps/portal
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx @tailwindcss/upgrade
```
This rewrites `globals.css` directives, migrates `tailwind.config.mjs` into CSS where it can, and renames changed utilities across `src/`. Review every file it touched with `git diff` — do NOT trust it blindly.

- [ ] **Step 2: Remove the dead integration + PostCSS stack from `package.json`**

Remove `@astrojs/tailwind`, `postcss`, `autoprefixer` (Tailwind 4 / Lightning CSS handles `@import`, nesting, and vendor prefixing internally). Ensure `tailwindcss` is `^4` and add `@tailwindcss/vite` `^4.3.1`. Keep `@tailwindcss/forms`.

- [ ] **Step 3: Wire the Vite plugin in `astro.config.mjs`**

Remove the `import tailwind from '@astrojs/tailwind'` line and the `tailwind({ applyBaseStyles: false })` entry from `integrations`. Add the plugin to the existing `vite` block:

```js
import tailwindcss from '@tailwindcss/vite';
// ...
export default defineConfig({
  // ...
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: { noExternal: ['@tanstack/react-query'] },
  },
});
```

- [ ] **Step 4: Reinstall and verify the dep graph resolves**

```bash
cd /Users/toddhebebrand/breeze-astro7
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```
Expected: no `@astrojs/tailwind` peer-range warnings; clean install.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/package.json apps/portal/astro.config.mjs pnpm-lock.yaml
git commit -m "build(portal): replace @astrojs/tailwind with @tailwindcss/vite (Tailwind 4)"
```

### Task 2: Port the theme into CSS-first config and preserve class dark mode

**Files:**
- Modify: `apps/portal/src/styles/globals.css`
- Delete: `apps/portal/tailwind.config.mjs` (or keep as a temporary `@config` bridge — see Step 4)

**Interfaces:**
- Consumes: the `@tailwindcss/vite` pipeline from Task 1.
- Produces: the same `hsl(var(--token))` design tokens as Tailwind utilities (`bg-background`, `text-foreground`, `border-border`, etc.) plus a working `.dark` class.

- [ ] **Step 1: Confirm the directive header**

The top of `globals.css` must be a single `@import "tailwindcss";` (replacing the three `@tailwind base/components/utilities` lines). Any `@import` of external CSS must sit ABOVE it.

- [ ] **Step 2: Register plugins via CSS**

Add directly under the import:

```css
@plugin "@tailwindcss/forms";
```

- [ ] **Step 3: Restore class-based dark mode (Tailwind 4 defaults to media-query)**

Add the custom variant so the existing `.dark` class toggling keeps working:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

- [ ] **Step 4: Expose the HSL tokens to Tailwind via `@theme inline`**

The `:root` / `.dark` blocks of raw HSL channels stay as-is (they are how dark mode swaps values). Map them to Tailwind color tokens with `@theme inline` so the `var()` reference stays live at runtime instead of being frozen at build time:

```css
@theme inline {
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));
  --color-destructive-foreground: hsl(var(--destructive-foreground));
  --color-success: hsl(var(--success));
  --color-success-foreground: hsl(var(--success-foreground));
  --color-warning: hsl(var(--warning));
  --color-warning-foreground: hsl(var(--warning-foreground));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
}
```
(Port exactly the tokens present in the portal config — portal has no `info`/`fontFamily.sans` extension; do not invent tokens.) Once every token from `tailwind.config.mjs` is represented here, delete `tailwind.config.mjs`. If the codemod left a `@config "./tailwind.config.mjs";` bridge line and removing the file breaks the build, keep the bridge for this PR and file a cleanup follow-up.

- [ ] **Step 5: Add the Tailwind-3 border-color compatibility shim**

Tailwind 4 changes the default `border`/`divide` color from `gray-200` to `currentColor`. To avoid silently recoloring every borderless `border` utility, add:

```css
@layer base {
  *, ::after, ::before, ::backdrop, ::file-selector-button {
    border-color: var(--color-border, currentColor);
  }
}
```
(The codemod normally inserts this; verify it exists, don't duplicate it.)

- [ ] **Step 6: Build + check**

```bash
cd /Users/toddhebebrand/breeze-astro7
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/portal astro check
pnpm --filter @breeze/portal build
```
Expected: both pass.

- [ ] **Step 7: Visual smoke vs. baseline**

Bring up the stack (`worktree-stack`), Playwright-screenshot the portal login + one authenticated portal page in light AND dark mode, and diff against `docs/superpowers/spikes/astro7-baseline/`. Pay special attention to: borders (currentColor regression), ring focus states, shadow sizes, button radii. Confirm the portal CSP (`style-src 'self'`) shows no console violations — Tailwind 4 output is build-time bundled CSS served from `'self'`, so this should pass; if dev-mode injects inline styles, that is dev-only and does not affect the deployed CSP.

- [ ] **Step 8: Commit**

```bash
git add apps/portal/src/styles/globals.css
git rm apps/portal/tailwind.config.mjs   # only if deleted in Step 4
git commit -m "style(portal): port theme to Tailwind 4 CSS-first config; preserve class dark mode"
```

### Task 3: Open PR A

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin chore/tailwind4-portal
gh pr create --title "build(portal): migrate to Tailwind 4" \
  --body "Replaces deprecated @astrojs/tailwind with @tailwindcss/vite (Tailwind 4) on apps/portal. Staying on Astro 6. CSS-first theme via @theme inline, class dark mode preserved via @custom-variant. Visual smoke vs baseline attached. Prereq for the Astro 7 upgrade (no Astro-7-compatible @astrojs/tailwind exists)."
```

- [ ] **Step 2: Run PR review and hold for Todd's UI test**

Dispatch the `pr-review-toolkit` review. This is a user-facing/UI change → **hold for Todd's manual UI test** before merging per the merge-hold rule. Do not `--admin` merge a visual change without that sign-off.

---

## PHASE 2 — Tailwind 4 on `apps/web` (PR B, on Astro 6)

> The large migration: `globals.css` is 8,974 lines with custom `@layer base`/`@layer components` rules and a critical fontsource `@import` block that must stay first.

### Task 4: Branch from merged PR A and run the web migration

**Files:**
- Modify: `apps/web/package.json`, `apps/web/astro.config.mjs`, `apps/web/src/styles/globals.css`
- Delete: `apps/web/tailwind.config.mjs` (or `@config` bridge)

**Interfaces:**
- Consumes: the recipe validated in Phase 1.
- Produces: web on Tailwind 4, Sentry + CSP + Vite proxy untouched.

- [ ] **Step 1: Branch from up-to-date main (after PR A merges)**

```bash
cd /Users/toddhebebrand/breeze-astro7
git fetch origin && git checkout -b chore/tailwind4-web origin/main
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

- [ ] **Step 2: Run the codemod from `apps/web`**

```bash
cd apps/web
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx @tailwindcss/upgrade
```

- [ ] **Step 3: Manually verify the `globals.css` header order**

The eight `@fontsource/...` `@import` lines MUST remain the very first statements, with `@import "tailwindcss";` immediately after them (Tailwind 4 requires all `@import` at the top; Vite drops any `@import` that is not first). The load-bearing comment block above them documents this — keep it.

- [ ] **Step 4: Apply the same CSS-first changes as portal (Task 2), plus web-only tokens**

`@plugin "@tailwindcss/forms";` AND `@plugin "@tailwindcss/typography";`. Add the `@custom-variant dark` line. Build the `@theme inline` block including the web-only tokens the portal lacked: `--color-info: hsl(var(--info));` and the sans font family `--font-sans: var(--font-sans);` (web's config extends `fontFamily.sans`). Keep the border-color compat shim. Delete `tailwind.config.mjs` once every token is represented.

- [ ] **Step 5: Update deps in `apps/web/package.json`**

Same as portal Task 1 Step 2 (drop `@astrojs/tailwind`, `postcss`, `autoprefixer`; `tailwindcss@^4`; add `@tailwindcss/vite@^4.3.1`; keep `@tailwindcss/forms` + `@tailwindcss/typography`).

- [ ] **Step 6: Wire the Vite plugin without disturbing the existing `vite` block**

Add `import tailwindcss from '@tailwindcss/vite';`, remove the `@astrojs/tailwind` import and integration entry. Add `plugins: [tailwindcss()]` to the EXISTING `vite` block — do not touch `resolve.dedupe`, `optimizeDeps`, `ssr`, or the `/api` proxy. Leave Sentry and the entire `security.csp` block exactly as-is.

- [ ] **Step 7: Reinstall, check, build, test**

```bash
cd /Users/toddhebebrand/breeze-astro7
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm install
pnpm --filter @breeze/web astro check
pnpm --filter @breeze/web build
pnpm --filter @breeze/web test
```
Expected: all pass. (Per the parallel-flakiness note, if a handful of unrelated web test files fail under full run, re-run the affected files single-fork to confirm they are pre-existing, not caused by this change.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/astro.config.mjs apps/web/src/styles/globals.css pnpm-lock.yaml
git rm apps/web/tailwind.config.mjs   # only if deleted
git commit -m "build(web): migrate to Tailwind 4 (@tailwindcss/vite); CSS-first theme, class dark mode"
```

### Task 5: Full visual regression of web

**Files:** none (verification)

- [ ] **Step 1: Stack up and walk the high-risk surfaces**

Using `worktree-stack` + Playwright, screenshot and diff against baseline, in BOTH light and dark mode: dashboard, Devices table, Scripts (Monaco editor — confirm no white-editor regression after view-transition nav), Alerts, a terminal/xterm view (confirm `style-src 'unsafe-inline'` still satisfied — check console for CSP violations), and any chart page. Focus on the documented v4 default changes: border colors, focus rings, shadow scale, rounded corners, removed `*-opacity-*` utilities.

- [ ] **Step 2: Run the CSP drift guard**

```bash
cd /Users/toddhebebrand/breeze-astro7
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec tsx scripts/check-csp-violations.ts
```
(Confirm the exact invocation in `apps/web/package.json` scripts first.) Expected: zero violations.

### Task 6: Open PR B

- [ ] **Step 1: Push, open PR, run review, HOLD for Todd's UI test**

```bash
git push -u origin chore/tailwind4-web
gh pr create --title "build(web): migrate to Tailwind 4" --body "Tailwind 4 on apps/web via @tailwindcss/vite. Sentry/CSP/proxy untouched. Visual regression across dashboard/tables/Monaco/terminal/charts in light+dark attached; CSP drift guard green. Second prereq for Astro 7."
```
Dispatch `pr-review-toolkit`; user-facing → hold for Todd's manual UI test before merge.

---

## PHASE 3 — Astro 7 + Vite 8 on both apps (PR C, after PRs A & B merge)

> Mechanical now that Tailwind no longer blocks. Astro 7 brings Vite 8 / Rolldown automatically.

### Task 7: Upgrade Astro + adapters on portal, then web

**Files:**
- Modify: `apps/portal/package.json`, `apps/web/package.json`
- Modify: `apps/portal/astro.config.mjs`, `apps/web/astro.config.mjs` (adapter only, if needed)

**Interfaces:**
- Consumes: Tailwind-4 apps from Phases 1–2.
- Produces: both apps on `astro@7`, `@astrojs/node@11`, `@astrojs/react@6`, Vite 8.

- [ ] **Step 1: Branch from up-to-date main**

```bash
cd /Users/toddhebebrand/breeze-astro7
git fetch origin && git checkout -b chore/astro7-upgrade origin/main
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

- [ ] **Step 2: Run the Astro upgrade in each app**

```bash
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
cd apps/portal && npx @astrojs/upgrade && cd ../..
cd apps/web && npx @astrojs/upgrade && cd ../..
```
This bumps `astro@7`, `@astrojs/node@11`, `@astrojs/react@6`, `@astrojs/check`. Confirm `@sentry/astro` is `^10.59.0` (peer supports Astro 7) — bump manually if the tool left it at `^10.56.0`.

- [ ] **Step 3: Audit config for graduated experimental flags (expected: none)**

Neither config currently sets an `experimental` block, so nothing to move. Confirm with `grep -n experimental apps/*/astro.config.mjs` → no output. The Rust compiler, queued rendering, and advanced routing are now defaults; no config needed.

- [ ] **Step 4: Reinstall**

```bash
cd /Users/toddhebebrand/breeze-astro7
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
```

- [ ] **Step 5: Commit**

```bash
git add apps/portal/package.json apps/web/package.json apps/portal/astro.config.mjs apps/web/astro.config.mjs pnpm-lock.yaml
git commit -m "build: upgrade to Astro 7 + Vite 8 (node adapter v11, react v6)"
```

### Task 8: Fix Rust-compiler strict-HTML errors and Vite 8 fallout

**Files:** any `.astro` template the build flags (unknown until build runs)

- [ ] **Step 1: Build both apps and collect strict-HTML failures**

```bash
cd /Users/toddhebebrand/breeze-astro7
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/portal astro check && pnpm --filter @breeze/portal build
pnpm --filter @breeze/web astro check && pnpm --filter @breeze/web build
```
Expected risk: the Rust compiler errors on unclosed/non-void tags the old Go compiler silently accepted. Fix each flagged template (add closing tags, correct nesting). It will NOT auto-correct invalid markup — fix at the source. Re-run until both build clean.

- [x] **Step 2: Check `compressHTML` whitespace default change** — DONE

Astro 7 changes `compressHTML` default `true` → `'jsx'` (strips whitespace between inline elements by JSX rules). Neither config sets it. Visually inspect inline-element spacing on text-heavy pages; if spaces collapse, either add explicit `{" "}` at the specific sites or set `compressHTML: true` in both configs to restore prior behavior. Prefer the targeted fix unless many sites are affected.

> **Result:** Confirmed the default is `"jsx"` in the installed Astro 7.0.3 (`@astrojs/compiler-rs` `compact` option). Differential-compiled at-risk inline patterns through the actual Rust compiler under `'jsx'` vs `true`: plain prose wraps (`word\nword`) collapse to a **single space** (safe — the common case), but text-then-inline-element across lines (`Text:\n<code>…`) collapses to **no space**. Scanned all 173 `.astro` files (web + portal); only **one** genuine rendered-text regression: `apps/web/src/pages/500.astro` ("Reference ID:" + `<code>`). Applied the targeted fix (`{' '}`), verified it re-emits a render-time space. All other scanner hits were false positives (JS frontmatter array literals, multi-line JSX attributes). Web build re-run with the fix passes.

- [x] **Step 3: Verify the web Vite proxy + SSR externals still work under Vite 8** — DONE

Run web in dev, confirm the `/api` and `^/s/` proxies still forward (Vite 8 keeps `server.proxy`), and that `@novnc/novnc` (ssr.external) and `@tanstack/react-query` (ssr.noExternal) still load. Confirm Sentry source-map upload config still builds.

> **Result (Vite 8.0.16 / Astro 7.0.3 / @astrojs/node 11):**
> - **Proxy: PASS.** Forwarding verified against a local echo server with the real config — `/api/ping` → `/api/v1/ping` (rewrite applied), `/api/v1/already` (no double-rewrite), `/s/abc` (as-is). Confirmed three ways: pure Vite 8 `createServer`, a minimal Astro 7 config, and the **real full `astro.config.mjs`** dev server. (A first run 404'd, but it was a transient first-boot/`optimizeDeps` race — not reproducible on a clean boot; systematic bisect proved no config element breaks the proxy.)
> - **SSR externals: PASS.** Web prod build succeeds; `@novnc/novnc` stays client-only (no bare SSR import — `external` working), `@tanstack/react-query` not left as a bare SSR import (`noExternal` working — though note it's currently imported nowhere in `src`, so the directive is inert dead config from the initial scaffold). Built `entry.mjs` boots and renders `/login` → HTTP 200 with no module-resolution errors.
> - **Sentry: builds.** With a DSN set, the integration loads and the build completes; `sourceMapsUploadOptions` is not deprecated. ⚠️ New deprecation: `@sentry/astro` 10.62.0 warns that passing `dsn`/`environment`/`release` inline to the integration is deprecated (move to `sentry.client/server.config.ts` in a future major). Non-blocking now.
> - Portal also builds clean under Astro 7 + Vite 8 (no proxy there — served behind Caddy).

- [ ] **Step 4: Run full web test suite**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web test
```
Expected: pass (allow for the known parallel flakiness — confirm any failures are pre-existing via single-fork re-run).

- [ ] **Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve Astro 7 Rust-compiler strict-HTML errors and Vite 8 fallout"
```

### Task 9: Full regression smoke + open PR C

**Files:** none

- [ ] **Step 1: Visual + functional smoke vs. baseline**

Same surface walk as Task 5 (both apps, light+dark, Monaco view-transition nav, terminal, charts, tables). Astro 7 changes the compiler and CSS serialization (named colors → hex) but not visual output — confirm. Run the CSP drift guard again (the compiler change could alter inline-script hashing).

- [ ] **Step 2: Push, open PR, run review, HOLD for Todd's UI test**

```bash
git push -u origin chore/astro7-upgrade
gh pr create --title "build: upgrade to Astro 7 + Vite 8" --body "Astro 7 (Rust compiler, Sätteri), Vite 8 (Rolldown), node adapter v11, react v6, sentry/astro 10.59. Strict-HTML fixes listed. Build/check/test green both apps; CSP guard green; visual smoke attached. Sequenced after the two Tailwind 4 PRs."
```
Dispatch `pr-review-toolkit`; hold for Todd's UI test before merge.

---

## PHASE 4 — Adopt the upside (OPTIONAL, separate PRs, post-upgrade)

> Pure value-capture. Each is independent and can be deferred indefinitely. Do NOT bundle into the upgrade PRs.

### Task 10 (optional): Vite 8 built-in tsconfig paths

- [ ] Set `resolve.tsconfigPaths: true` in both `vite` blocks and remove any path-alias plugin if one exists. Verify `astro check` + build. Commit as its own PR.

### Task 11 (optional): Vite 8 `server.forwardConsole` for agent dev loops

- [ ] Add `server.forwardConsole: true` (dev-only) so browser console output pipes to the terminal during agent-driven Playwright runs. Confirm it is gated to dev and never affects production. Commit as its own PR.

### Task 12 (optional): Tailwind 4 container queries pilot

- [ ] Container queries are now built in (`@container`, `@max-*`). When the mobile-tables work (`ResponsiveTable`, currently on an unmerged branch — NOT on main) lands, refactor its viewport-breakpoint card/table swap to container queries so each table adapts to its own container rather than window width. **Blocked until that component is on main.** Do not create it here.

### Task 13 (optional): Astro 7 advanced routing (`src/fetch.ts`) for the portal base-path guard

- [ ] Evaluate consolidating the portal's `isOutsideBase` guard and auth redirects into a `src/fetch.ts` standard fetch handler. Spike first — this changes the request pipeline and must be re-tested against the `/portal` Caddy carve-out and the node-standalone base-optional serving gotcha. Separate PR, only if it simplifies the existing middleware.

---

## Self-Review

**Spec coverage:** Tailwind 3→4 (Phases 1–2), Astro 6→7 + Vite 8 (Phase 3), the forced coupling and chosen sequencing (Architecture + Phase ordering), the wins the user asked about (Phase 4), portal-before-web ordering (every phase), independent revertibility (separate PRs). Covered.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Concrete commands, file paths, and the full `@theme inline` block are inline. The one genuine unknown — exactly which `.astro` files the Rust compiler will reject — is inherently undiscoverable until the v7 build runs and is handled as a discovery+fix loop in Task 8 (correct framing, not a placeholder).

**Type/name consistency:** `@tailwindcss/vite` import named `tailwindcss` consistently (Tasks 1, 4); token names in `@theme inline` match the `hsl(var(--x))` tokens in the existing `tailwind.config.mjs` files exactly (portal lacks `info`/`font-sans`; web adds both — called out explicitly). Adapter versions consistent (`@astrojs/node@11`, `@astrojs/react@6`).

**Open risks the executor must respect:** (1) web `globals.css` is 8,974 lines — visual review is the real cost, not the codemod; (2) `darkMode: 'class'` REQUIRES the `@custom-variant dark` line or dark mode silently breaks; (3) the fontsource `@import` block must stay first; (4) do not touch web's CSP/Sentry/proxy config during the Tailwind swap.
