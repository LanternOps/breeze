# Built-in YARA pack pipeline (operator notes)

Builds the read-only built-in detection-rule set (#6263 W03b) that every Breeze
API upserts at boot as the `yara_rule_sets` row `00000000-0000-4000-8000-00000000b001`.
Not a docs page; it records how the pipeline works and how to change it.

## Files

| File | Role |
|---|---|
| `forge.sha256` | The pinned YARA Forge **core** release: `<sha256>  <tag>/yara-forge-rules-core.zip`. The build refuses any other tag or bytes. |
| `LICENSES.allow` | SPDX ids the pack may ship. `filter.go` caps this list at Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause and CC0-1.0. |
| `denylist.txt` | Rules excluded by name, each with a reason. This is how a false positive gets fixed. |
| `pack.lock` | `version` (the integer the API compares) + `inputs_sha256` (a hash of every input file). |
| `filter.go` | The filter: parse, licence, module and score filters, selection, `breeze-yarac validate` loop, canonical bundle, report. Stdlib only. |
| `build-pack.sh` | Downloads and verifies the Forge release, builds `breeze-yarac` from `agent/`, runs the filter. |

## What gets kept

Each Forge rule is kept only if all of these pass:

- **Licence.** YARA Forge embeds each source repository's LICENSE text. The filter classifies it, and any per-rule `meta: license`, to an SPDX id. Both must be on `LICENSES.allow`. These are always dropped: no licence, DRL, any GPL/LGPL/AGPL, Elastic License, CC-BY, non-commercial, share-alike, and unrecognised text. Restrictive markers are checked before permissive ones, because the DRL reuses MIT's "Permission is hereby granted" wording.
- **Standalone.** The rule must not be private or global. A rule that references another rule fails `validate` and is dropped, because each bundle source must hold exactly one rule (W02 §C2).
- **Modules.** The rule may only use modules the agent engine has: `pe`, `elf`, `hash`, `math` (W02 Task 1 spike), plus `dotnet`, where `validate` decides. Each kept rule's source gets its own `import` lines.
- **Score.** The Forge score must be at least 75 (`-min-score`). The built-in pack auto-quarantines (spec D7), so hunting-grade rules stay out.
- **Compile.** `breeze-yarac validate` must accept the rule. That is the agent's compiler and compile policy: no `console` module, no includes, slow-pattern and slow-loop errors on.

Selection then orders rules by quality (descending), score (descending) and name (ascending). It fills greedily up to the W02 §C5 caps of 500 rules and 10 000 strings, and records everything beyond the caps as `not_selected`.

Rule ids are UUIDv5(namespace = built-in set id, name = rule name), so a rule keeps its id across pack versions.

Each source starts with an attribution comment naming the repository, its licence and its copyright line. The full licence texts ship in `breeze-yara-builtin-report.json`.

## Outputs

- **`breeze-yara-builtin.json`** — the W02 §C2 bundle, with `autoQuarantine: true` and `version = pack.lock version`.
  - It is serialised exactly as the TypeScript `buildYaraBundleJson` would serialise it. At boot the API re-derives these bytes and refuses a pack that differs.
  - It is a release asset, and the signed `release-artifact-manifest.json` covers it.
- **`breeze-yara-builtin-report.json`** — every rule with its keep or drop reason, plus each repository's licence and licence text. It is a release asset.
- **`breeze-yara-builtin.json.sha256`** — a convenience copy. The signed manifest is the trust anchor.

The build is deterministic. The same inputs and the same `breeze-yarac` produce the same bytes.

## Changing the pack

Any change to an input file needs a version bump. Input files include `forge.sha256`, `denylist.txt`, `LICENSES.allow`, `filter.go` and `build-pack.sh`.

1. Edit the input.
2. Bump `version` in `pack.lock` by at least 1.
3. Set `inputs_sha256` to the output of `build-pack.sh --print-inputs-hash`.

`build-pack.sh --check-lock` runs in the blocking CI security job, and `build-pack.sh` runs in the release. Both fail until the lock matches. This matters because the boot upsert only replaces the built-in set with a **strictly newer** version. A content change that kept the old version would never reach the fleet.

To move the Forge pin:

1. Pick a release at least two weeks old.
2. Put its sha256 in `forge.sha256`. Use `gh api repos/YARAHQ/yara-forge/releases --jq '.[] | {tag_name, assets: [.assets[] | {name, digest}]}'`, or download it and hash it.
3. Bump the version as above.

## False positives

The `YARA Pack FP` workflow (`.github/workflows/yara-pack.yml`) builds the pack and scans a clean corpus: an `ubuntu-latest` runner's `/usr` and a `windows-latest` runner's `C:\Windows\System32`. It runs when this directory changes, nightly, and on dispatch. It is not a required check.

Any match fails the job and prints the rule and the file. To fix it, add `RULE_NAME  matched <file> on <runner>` to `denylist.txt`, then bump the version.

## Boot upsert

`apps/api/src/services/yaraBuiltinPack.ts`:

- Fetches `breeze-yara-builtin.json`. With `BINARY_SOURCE=github` it comes from the pinned GitHub release. With `BINARY_SOURCE=local` it comes from the binaries volume, next to the staged signed manifest pair.
- Verifies the asset's sha256 and size against the Ed25519-signed release manifest.
- Re-derives the canonical bytes.
- Runs the same `breeze-yarac validate` pre-check as custom rule sets.
- Upserts the row only when the pack version is newer than the published one.
