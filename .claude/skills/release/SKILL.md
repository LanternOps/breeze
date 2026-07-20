---
name: release
description: Use when cutting, shipping, or announcing a Breeze RMM release — "cut a release", "ship vX.Y.Z", "release notes for X", "what do self-hosters need to know", "draft the release announcement", "do the release write-up". Orchestrates the whole release-comms pass: a self-hoster-focused GitHub Release body (breaking changes, required env vars, migrations), then /update-breeze-release-notes (marketing site), /update-breeze-docs (technical docs), and a Discord announcement. Also covers the post-release deploy + agent-fleet promote steps that the tag alone does NOT do.
---

# Breeze Release

This skill drives the **communication and rollout** pass for a release: the GitHub Release body (especially the self-hoster section), the marketing release notes, the technical docs, and the Discord announcement — plus the post-release deploy/promote steps the tag alone doesn't handle.

It assumes the **code is already merged to `main` and green**. Tagging is the trigger; this skill is about everything that surrounds it.

> **Infra specifics live in `internal/ops/release-infra.md`** (gitignored; read it from the
> MAIN checkout at `~/breeze/internal/ops/release-infra.md` when working in a worktree).
> This skill refers to those values as `$EU_IP`, `$US_IP`, `$EU_FW`, `$US_FW`, `$JUMP`.
> Read that file FIRST when you reach Step 6 — do not guess or reconstruct the values.

## How a release actually fires

`.github/workflows/release.yml` triggers on **`push: tags: v*`**. The tag's *contents are whatever commit it points at*, and the version is the tag minus the `v`. There is no VERSION file — cutting a release **is** pushing the tag.

- CI builds + pushes GHCR images (api/web/portal/binaries) and creates the GitHub Release with `generate_release_notes: true` — i.e. an **auto-generated commit list** ("What's Changed" + Full Changelog). It does **not** write the curated Summary / Added / Improved / Fixed / Security / Self-Hosting sections. **You add those afterward** via `gh release edit`.
- Versions are bare semver everywhere except git tags. The git **tag** is `v0.84.0`; the agent version string, `BREEZE_VERSION`, and ldflags are `0.84.0`.

## Step 0 — Know the blast radius BEFORE tagging

A tag off `main` HEAD ships **all accumulated merged-but-unreleased work**, not just "the latest thing", and **auto-runs every pending migration** on prod via `autoMigrate` on API boot. This has surprised us (the 0.83.1→0.83.2 "hotfix" carried 327 files + 10 migrations). So always look first:

```bash
PREV=v0.83.3            # the last released tag
NEW=v0.84.0             # the tag you're about to cut
git -C ~/breeze fetch --tags
git -C ~/breeze diff $PREV..HEAD --stat | tail -1          # total churn
git -C ~/breeze diff $PREV..HEAD --name-only -- apps/api/migrations/   # migrations that will auto-run on prod
git -C ~/breeze log --oneline $PREV..HEAD                  # everything that will ship
```

- **Full release of everything on main** (the normal case): tag off `main` HEAD.
- **True surgical hotfix**: branch + tag off `$PREV`, cherry-pick *only* the fix. Do **not** tag off main HEAD if you don't intend to ship all of main.

If migrations are listed, you're committing prod to those migrations the moment the new API boots. Read them; confirm there are no large-table rewrites/backfills before you proceed (call those out in the upgrade notes if present).

**Smoke-test privileged migrations as a NON-SUPERUSER role (learned the hard way, v0.95.0→v0.95.1).** CI and the local docker-compose test DB both migrate as the Postgres **superuser** (`POSTGRES_USER=breeze`), which silently passes statements a least-privilege role would be *denied*. Prod is DO-managed **`doadmin` — NOT a superuser**, so a migration that only a superuser can run passes every test and then **crash-loops the API on deploy** (this is exactly what took EU down on v0.95.0: `ALTER FUNCTION ... OWNER TO <role>` requires the *new owner* to hold `CREATE` on the schema; a superuser bypasses that check, doadmin does not → `permission denied for schema public`). So: any migration in the range that does `CREATE ROLE`, `ALTER ... OWNER TO`, `GRANT`/`REVOKE` on a schema, `CREATE EXTENSION`, or a `SECURITY DEFINER` function — **run it against a non-superuser role before tagging.** Two ways: pipe the migration to a real managed DB (or a droplet's `doadmin`) inside `BEGIN; ...; ROLLBACK;` with `ON_ERROR_STOP=1`, or `SET ROLE <nosuperuser-createrole-role>` on a local DB that already has the full schema. If it only works as a superuser, fix it forward (grant the owning role the privilege for the one statement, then revoke) **before** it reaches prod.

## Step 0.5 — After tagging: WAIT for the build, confirm ALL artifacts exist

Pushing the tag kicks off `release.yml`, which is a **long, multi-job build** (~20–40 min): api/web/portal GHCR images, agent binaries for every platform, the **signed** Windows MSI, the **notarized** macOS agent/viewer/helper, watchdog + user-helper, and the signed `release-artifact-manifest.json` (+ `.ed25519`/`.minisig`) and `checksums.txt`. The GitHub Release is created by the **final** job — you cannot `gh release edit` the body until then, and **you must not roll out until every artifact is present**.

A partial or half-failed build can still publish a Release with **missing binaries** — installers and agent auto-update would then 404 in prod. So gate explicitly:

```bash
# Block until the run finishes (re-invokes you on completion):
RUN=$(gh run list --repo lanternops/breeze --workflow Release --branch $NEW --limit 1 -q '.[0].databaseId' --json databaseId)
gh run watch "$RUN" --repo lanternops/breeze --exit-status

# Then confirm success AND a full asset set — compare the count to the previous release:
gh release view $NEW  --repo lanternops/breeze --json assets -q '.assets | length'
gh release view $PREV --repo lanternops/breeze --json assets -q '.assets | length'   # expected baseline (~40)
gh release view $NEW  --repo lanternops/breeze --json assets -q '.assets[].name' | sort
```

Before proceeding, verify the new release has the **same asset families** as the prior one — in particular the signed `breeze-agent.msi`, the macOS `.pkg`/`.dmg`/`.app.tar.gz`, the viewer/helper installers, and `release-artifact-manifest.json` + `.ed25519` + `.minisig` + `checksums.txt`. A short asset list = signing or notarization failed midway.

- **If the run failed**, re-run just the failed jobs (`gh run rerun "$RUN" --failed`) and re-watch. Don't hand-publish a release off a red build, and don't roll out.
- **`gh run watch` can exit non-zero while the run is still in progress** (seen 2026-07-02) — before treating a watch failure as a build failure, check `gh run view $RUN --json status`: `in_progress` means keep waiting (a `status`-polling loop is more reliable than `gh run watch`).
- You *can* draft the release body and the Discord message (Steps 1–5) while the build runs — just don't **publish** the body or **deploy** until this gate is green.

## Step 1 — Source the content (PRs + git only)

Release content comes from **merged PRs and git history only** — never blog posts, design docs, or product docs (those describe *planned*, not *shipped*, work).

```bash
git -C ~/breeze log --oneline $PREV..$NEW
gh pr view <N> --repo lanternops/breeze --json title,body
git -C ~/breeze log --format="%B" -1 <SHA>   # expand a squash-merge body
```

Skip from user-facing notes: `chore(deps):`, `chore:`, `ci:`/`fix(ci):`, internal `refactor:`, internal `docs:`/`test:`. Keep anything a self-hoster or operator would notice.

## Step 2 — Write the GitHub Release body

The GitHub Release is the **operator/self-hoster source of truth**. Model the body on the most recent release for structure and tone:

```bash
gh release view $PREV --repo lanternops/breeze   # reference template
```

Structure (omit empty sections):

```markdown
Breeze RMM **vX.Y.Z** — one-line theme of the release.

## Summary
- **Area** — what shipped, in operator language (#PR).

## Added
- **Feature** — what it does for the user (#PR)

## Improved
- ... (#PR)

## Fixed
- ... (#PR)

## Security
- Hardening summary; "Self-hosters are encouraged to upgrade." (#PRs)

## Self-Hosting / Upgrade Notes
<the most important section — see below>
```

### The Self-Hosting / Upgrade Notes section (do not skip)

Self-hosters run their own droplets and read this section to decide whether an upgrade is safe and what they must touch. Always answer these four questions explicitly, even when the answer is "nothing required" — silence reads as "I don't know":

1. **Upgrade command.** The standard line is: bump `BREEZE_VERSION`, then `docker compose pull api web portal && docker compose up -d` (and `pnpm install` if they build from source). Include `portal` — it is a separate container and was silently left behind for 11 days (stuck on 0.94.0 while api/web ran 0.98.1) back when the line pulled only `api web`.
2. **Database / migrations.** State the count and that they're idempotent and auto-apply on boot via `autoMigrate` (unless `AUTO_MIGRATE=false`). **Explicitly flag any large-table rewrite or backfill** — that's the difference between a 2-second upgrade and a stalled boot. If nothing: "**Database — nothing required.**"
3. **New required environment variables.** Anything the config validator now refuses to boot without (e.g. past examples: `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, `IS_HOSTED`). A new required env var must *also* be mapped in the `api`/`web` `environment:` block of their compose, not just `.env` — say so. If none: "**No new required environment variables.**"
4. **Behavior changes & feature flags.** Anything whose default changed (call out grandfathering of existing orgs), and any feature gated behind a flag (e.g. `PUBLIC_ENABLE_EDR_INTEGRATIONS`) — name the flag and its default.

End with the compare link: `**Full Changelog:** https://github.com/LanternOps/breeze/compare/$PREV...$NEW`

### Breaking changes

If there are any, set the tone up front (a bolded **⚠️ Breaking changes** callout near the top *and* its own bullet in upgrade notes). Be concrete: what breaks, who is affected, what action they must take, and whether there's a grandfather/opt-out. If there are none, say "No breaking changes." somewhere in the upgrade notes — self-hosters look for that reassurance. Most Breeze releases are non-breaking; behavior-default changes (like the PAM UAC opt-in flip) are the usual "soft" breaking case and must be flagged.

### Publishing the body

CI already created the release with the auto-generated "What's Changed". **Preserve that** — append your curated sections above it rather than clobbering:

```bash
gh release view $NEW --repo lanternops/breeze --json body -q .body > /tmp/auto-notes.md
# Write curated sections to /tmp/curated.md, then:
cat /tmp/curated.md /tmp/auto-notes.md > /tmp/release-body.md
gh release edit $NEW --repo lanternops/breeze --notes-file /tmp/release-body.md
```

## Step 3 — Marketing release notes

Invoke **`/update-breeze-release-notes`**. That skill owns the breezermm.com content schema, the dev→user language translation, and the `categories` grouping for major releases. Don't duplicate its rules here — hand it the version range and let it work. (Its notes are for MSP owners/technicians; tone is lighter and more marketing than the GitHub body.) Remember the site only publishes via its deploy script (`npm run deploy:notify`) — a commit alone changes nothing live.

## Step 4 — Technical docs

Invoke **`/update-breeze-docs`** in diff mode for the version range (e.g. "update docs since $PREV"). It maps changed code → affected docs pages, filters by audience, and bumps its review tracker. Required env vars, new feature workflows, and behavior changes from this release should land in the Starlight docs.

## Step 5 — Discord announcement

Draft a short, friendly announcement for the community Discord. Keep it scannable — highlights, not the full changelog — and **always** include the self-hoster upgrade line and any breaking/behavior change. Show it to Todd before posting; don't post it yourself unless asked.

Template:

```
🚀 **Breeze vX.Y.Z is out**

<one-line theme>

**Highlights**
• <feature 1>
• <feature 2>
• <feature 3>
• <security note, if any>

**Self-hosting:** <one line — "standard upgrade, N idempotent migrations, no new env vars" OR the specific action needed>
<⚠️ one line if there's a breaking/behavior-default change>

📝 Full notes: https://github.com/LanternOps/breeze/releases/tag/vX.Y.Z
```

Tone: operator-to-operator, not corporate. Lead with what people can do now. If a release is mostly internal/security, say so plainly ("mostly hardening + reliability — recommended upgrade").

## Step 6 — Roll it out

The tag built images and registered binaries; it does **not** deploy prod or update the agent fleet on its own. The intent **is** for cutting a release to flow straight into rollout — but **always confirm with Todd before touching prod**, then proceed. Three parts, per region: **back up the DB → deploy the droplet → (later) promote the agent fleet**.

**Read `internal/ops/release-infra.md` now** (main checkout: `~/breeze/internal/ops/release-infra.md`) for the real droplet IPs (`$EU_IP`/`$US_IP`), firewall IDs (`$EU_FW`/`$US_FW`), and jump-host name (`$JUMP`) used below.

### Prerequisite — get SSH access to the droplets

Two access paths, in order of preference:

1. **Jump host** `ssh -J $JUMP root@<ip>` — works when the bastion is up **and you can complete its browser re-auth**; the bastion's SSH is posture-gated with an interactive check, so **headless sessions usually cannot use it** — if it prompts with a login URL or hangs, don't burn time, fall back to (2).
2. **Direct SSH + a temporary DO firewall exception.** Each droplet sits behind a DO cloud firewall that only allows port 22 from an allowlisted IP. Add your current IP, deploy, then **remove it afterward** to restore posture:

```bash
MYIP=$(curl -s4 ifconfig.me)
for fw in $EU_FW $US_FW; do
  doctl compute firewall add-rules $fw --inbound-rules "protocol:tcp,ports:22,address:$MYIP/32"
done
# ... do the rollout via  ssh root@$EU_IP  /  ssh root@$US_IP ...
# then restore:
for fw in $EU_FW $US_FW; do
  doctl compute firewall remove-rules $fw --inbound-rules "protocol:tcp,ports:22,address:$MYIP/32"
done
```

`add-rules`/`remove-rules` are additive/surgical — they won't touch the existing allowlisted IP. Remove your exception once both regions are healthy and promoted (an RMM's prod SSH shouldn't stay open to a residential IP). If the fleet-promote step is deferred pending Todd's go-ahead, remove the exception anyway and re-add it when he approves — it's two commands.

### Back up the managed DB FIRST — before each region's deploy

Migrations auto-run the moment the new API boots (`autoMigrate`), so the only safe rollback artifact is a snapshot taken **immediately before** deploying that region. Prod uses **DigitalOcean managed Postgres** (no `breeze-postgres` container on the droplet) — back it up with the on-demand encrypted off-region wrapper, which sources `backup.env`, `pg_dump -Fc`s the live DB, gpg-encrypts it, and uploads off-region:

```bash
# On the region's droplet (do this right before you deploy that region):
ssh root@<droplet> "bash /opt/breeze-backup/run-backup.sh"
```

- The entrypoint is **`/opt/breeze-backup/run-backup.sh`** (the same cron wrapper) — it `set -a; . backup.env` then runs the encrypted-offsite script. Don't call the inner script directly (it needs the env sourced); dumps are timestamp-named (`db_YYYYMMDD_HHMMSS.dump`).
- **`defaultdb` gotcha:** the backup must target the live `breeze` DB via the `DATABASE_URL` in `/opt/breeze/.env`, **not** `doctl databases connection` (that points at an empty `defaultdb`, ~4K dump). `backup.env` is already configured for the right DB — just run the wrapper.
- **Confirm the dump is real** before deploying: the log prints `Database backup complete: …/db_*.dump (NNM)` and ends with `Off-region encrypted backup complete`. Real sizes are tens-to-hundreds of MB — per-region baselines are in `internal/ops/release-infra.md`. A ~4K dump means you hit the `defaultdb` trap; stop and fix `backup.env`.
- This is *belt-and-suspenders* on top of DO's own daily managed backups + PITR, but the explicit pre-deploy dump is the artifact you actually want when a migration goes wrong — don't skip it.
- The backup GPG passphrases live only on the droplets and must already be vaulted offline; without them a backup is unrecoverable. (Full infra specifics: `internal/ops/off-region-backup-runbook.md`, gitignored.)

Do this **per region, in the night-first order below** — back up region 1, deploy region 1, verify, then back up region 2, deploy region 2.

Two parts after backup: deploy the droplets, then promote the agent fleet.

### Region order — deploy the *sleeping* region first

EU and US are separate droplets/DBs. **Deploy whichever region is in the middle of its local night first**, verify it, then do the other. The point is to let any bad upgrade surface against the smallest live audience.

- Roughly: deploy **EU first** during US daytime/evening (EU is overnight); deploy **US first** during EU daytime (US is overnight). Check the current UTC hour and pick the region whose local clock is deepest into the small hours.
- Per region: **back up its DB → deploy → confirm `/health` 200 and spot-check** → only then move to the other region.

**Auto-detect the night region** (DST-aware — EU droplet ≈ Amsterdam time, US ≈ NYC time). Run this and deploy the region it prints first:

```bash
# Picks whichever region's local time is closest to 3 AM (deepest into the night).
eu=$(TZ="Europe/Amsterdam" date +%H); us=$(TZ="America/New_York" date +%H)
# circular distance from 03:00, in hours
d(){ h=$((10#$1)); a=$(( (h-3+24)%24 )); b=$(( (3-h+24)%24 )); echo $(( a<b ? a : b )); }
if [ "$(d "$eu")" -le "$(d "$us")" ]; then
  echo "Deploy EU first (Amsterdam ${eu}:00, NYC ${us}:00), then US"
else
  echo "Deploy US first (NYC ${us}:00, Amsterdam ${eu}:00), then EU"
fi
```

Per droplet:
```bash
ssh root@<droplet> "cd /opt/breeze && \
  cp .env .env.bak-pre-$NEW && \
  sed -i 's/^BREEZE_VERSION=.*/BREEZE_VERSION=0.X.Y/' .env && \
  docker compose pull api web portal && \
  docker compose up -d binaries-init api web portal"
# then verify:
curl -sf https://<region>.2breeze.app/health     # 200 = healthy; check "version" in the JSON
# portal is a SEPARATE container — /health does NOT cover it. Assert its image too:
ssh root@<droplet> "docker ps --filter name=portal --format '{{.Image}}'"   # must be :0.X.Y, not an older tag
# and confirm migrations applied cleanly:
ssh root@<droplet> "docker logs breeze-api 2>&1 | grep -aE 'auto-migrate' | tail -5"
# expect "[auto-migrate] Applied N migration(s)" and the unprivileged app-user line
```

### Rolling back is NOT clean if a migration failed mid-set — the partial-migration trap

`autoMigrate` applies each migration file in its own transaction and records success per file. If migration #7 of 10 fails, files #1–6 have **already committed**. Rolling `BREEZE_VERSION` back to `$PREV` restores the old *code* but the DB is now on a **newer-than-$PREV schema**, and the old code can choke on it. This bit us on v0.95.0: the auth-epochs migration committed a `NOT NULL`-no-default column (`refresh_token_families.absolute_expires_at`) before a *later* migration failed; after rolling back, the old version could not `INSERT` a refresh-token family (the column it doesn't know about is `NOT NULL`), so **new logins silently failed while `/health` stayed green**.

So after any rollback that followed a mid-set failure:
1. **`/health` is not proof of recovery.** Test the real write paths — especially minting a refresh-token family (login) — against the actual DB (`INSERT ... ` in a `BEGIN; ... ROLLBACK;`).
2. **Scan for forward columns the old code can't satisfy:** `NOT NULL` columns with no default, or new CHECK constraints, added by the committed-but-newer migrations on tables the old version writes (`users`, `refresh_token_families`, `oauth_*`, `devices`, `audit_logs`).
3. **Un-break minimally:** `ALTER COLUMN <col> SET DEFAULT <sane value>` (keeps `NOT NULL`, lets the old code insert) is the lightest fix; it's inert on the new version (which sets the value explicitly). Note the divergence and **drop the DEFAULT once you're forward again** so the schema matches a fresh install.
4. **The clean alternative is to roll *forward*** to a fixed build rather than back — completing the migration set makes code and schema match. Prefer this when the fix is understood; the pre-deploy dump is the fallback if it isn't.

### Promote the agent fleet — via a DB row change

Prod sets `AGENT_AUTO_PROMOTE=false`, so deploying registers the new binaries in `agent_versions` (`is_latest` stays on the prior version) and devices don't update until you promote. **Promote with a direct DB row change** — this is the method precisely because it **does not require an MFA session**. The API `/promote` endpoint is gated on a platform-admin MFA session (which we can't drive headlessly), so editing `agent_versions` directly is the authorized, MFA-free path. Confirm with Todd first, then run it per region (US and EU have **separate DBs — promote each**).

The droplets have `psql` installed; run against the region's live DB:
```bash
ssh root@<droplet> 'set -a; . /opt/breeze/.env; set +a; psql "$DATABASE_URL" -f /tmp/promote.sql'
```

The promotion is **slot-aware**: it's per `(component, platform, architecture)` and must only demote slots the target version actually covers — a naive `SET is_latest=false WHERE is_latest=true` strands any platform/arch the new version lacks. Correct SQL, single transaction:

```sql
BEGIN;
UPDATE agent_versions a SET is_latest=false
  WHERE a.is_latest=true
    AND EXISTS (SELECT 1 FROM agent_versions t
                WHERE t.version='0.X.Y'
                  AND t.component=a.component
                  AND t.platform=a.platform
                  AND t.architecture=a.architecture);
UPDATE agent_versions SET is_latest=true WHERE version='0.X.Y';
COMMIT;
```

Caveats:
- **Omitting `component`** in the SQL above promotes everything (agent + helper + watchdog + user-helper). Narrow with `AND component='agent'` etc. if doing a partial roll.
- The DB path **skips the `audit_logs` row** the API endpoint would write. The table is hash-chained — do **not** hand-forge an audit row (a bad row corrupts the chain). Just note the audit gap; re-running the real `/promote` endpoint later is idempotent on the version rows and writes the audit entry.
- Verify after: `select component,platform,architecture,version,is_latest from agent_versions where is_latest;` — expect the new version across all covered slots, and no slot left with zero `is_latest`. (A full release currently covers 15 slots across agent/helper/user-helper/watchdog.)

Rolling the fleet is a user-facing change — get Todd's go-ahead before promoting, and don't promote until both regions are deployed and healthy.

**Security releases:** publish the GHSA advisory **after** rollout completes, never before (fix → quiet release → roll out → then publish). Internal cadence docs: `internal/security-hardening-tracker.md`, `internal/pending-release-notes-security.md`.

## Quick checklist

- [ ] `git diff $PREV..HEAD --stat` + migrations reviewed — blast radius understood
- [ ] Tag pushed (off main for full release / off $PREV for surgical hotfix)
- [ ] **Build finished green + ALL artifacts present** (signed MSI, notarized macOS, manifest+sigs, checksums) — asset count matches prior release; do not publish/roll out before this
- [ ] GitHub Release body written — Summary/Added/Improved/Fixed/Security + **Self-Hosting/Upgrade Notes** (env vars, migrations, behavior changes, breaking changes), appended above auto "What's Changed"
- [ ] `/update-breeze-release-notes` (marketing site) — published via the site's deploy script, not just committed
- [ ] `/update-breeze-docs` (technical docs)
- [ ] Discord announcement drafted, shown to Todd
- [ ] Confirmed rollout with Todd
- [ ] DB backed up per region (encrypted off-region dump) **immediately before that region's deploy** — verified non-trivial dump size (not the `defaultdb` 4K trap)
- [ ] Droplets deployed — **night region first** (back up → deploy → verify), then the other + `/health` green
- [ ] Agent fleet promoted via slot-aware DB row change (both DBs) — only with Todd's go-ahead
- [ ] Firewall exception removed (if the doctl fallback was used)
- [ ] GHSA published *after* rollout (security releases only)

## Notes & gotchas

- **Version format:** tag `v0.84.0`; everywhere else `0.84.0` (bare semver).
- **Don't touch `CHANGELOG.md`** — it's abandoned at 0.67.1. GitHub Releases are the changelog.
- **`gh` repo is `lanternops/breeze`** (canonical remote is LanternOps/breeze). Push and PR there.
- **Reference, don't reinvent:** `gh release view <prev-tag>` is the best style guide for the body. Match its section order and tone.
- **Operator language vs marketing language differ:** the GitHub body is for self-hosters/operators (precise about env vars, flags, migrations); the marketing notes (`/update-breeze-release-notes`) are for MSP buyers (benefit-led). Don't copy-paste between them.
- **A release is comms + rollout, not just a tag.** Cutting the release is meant to flow into rollout, but deploy + agent-promote are **confirm-with-Todd-first** and still manual (the tag only built images + registered binaries). Deploy the night region first; promote the fleet via the slot-aware DB row change once both regions are healthy.
- **No infra literals in this file.** Droplet IPs, firewall IDs, bastion names, bucket names, and dump-size baselines belong in `internal/ops/release-infra.md` (gitignored) — this skill is committed to a public repo. Keep it that way when editing.
