# Perf baselines

One file per profile, named for the profile: `nightly-200.json`. The file is the `kpi.json` record (`breeze.perf.kpi/v1`) from one measured run on the dedicated perf runner. A later PR commits it, once the runner exists. Until then the nightly workflow fails with "no committed baseline" after uploading its candidate record as an artifact.

## Rules

- A baseline changes only by pull request. The workflow never commits.
- The PR cites the workflow run URL and adds nothing but the `kpi.json` from that run's artifact, copied unchanged. Do not edit values or reformat the file.
- The baseline carries the hardware fingerprint (`cpuModel`, `cpus`, `memGiB`), `baselineGrade`, and the stack profile and role. The comparator refuses a candidate that differs in any of them, so a baseline from another machine, or from macOS (`baselineGrade: false`), cannot be compared by accident.

## When to re-baseline

1. After an intentional, reviewed change in cost. Say in the PR which change and why the new figure is acceptable.
2. After a runner hardware change. The comparator refuses the old baseline anyway.
3. After three consecutive nightly runs print `consider re-baselining` (a gated KPI is more than 15% better than the baseline).

Never re-baseline to silence a red without a linked issue that explains the regression.

## Checking a new baseline

```bash
node load-tests/perf/cli.mjs compare \
  --baseline load-tests/perf/baselines/nightly-200.json \
  --candidate load-tests/perf/baselines/nightly-200.json
```

This must exit 0. Operator guide: [`../README.md`](../README.md).
