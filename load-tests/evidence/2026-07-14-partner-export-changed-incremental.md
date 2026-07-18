# Partner export changed-incremental evidence — 2026-07-14

This evidence was captured on a disposable local stack through the
unprivileged application database role with forced partner RLS context. No
credential, host, network address, tenant identifier, or cursor is retained.
The machine credential was inherited from the process environment and deleted
with the fixture.

## Fixture and two-phase procedure

The fixture contained one partner, two organizations, two sites, 10,000
devices, 10,000 rows each of hardware, disk, network, and software material,
12,000 approved printers, two configuration records of each exported kind,
and two scalar custom-field values. The full-only run captured a separate
database snapshot checkpoint for every resource.

After every checkpoint had been captured, two organizations, sites, devices,
hardware rows, software rows, network rows, policies, assignments, scripts,
automations, backup configurations, custom-field definitions, and scalar
custom-field values were changed. The incremental-only run consumed the full
summary's checkpoint object, used a page limit of one, and required at least
two records from every resource. This makes a passing result exercise both
the first page and a cursor-bearing late page for all 13 resources.

## k6 results

| Phase | Limit | Duration | Pages | Records | Bytes |
|---|---:|---:|---:|---:|---:|
| Full | 500 | 98.860 s | 91 | 40,022 | 34,882,643 |
| Changed incremental | 1 | 11.018 s | 28 | 28 | 28,348 |

Every resource returned at least two changed records on at least two pages.
Device inventory returned four records on four pages because both device and
site material clocks advanced. Both phases recorded zero retries, HTTP 429s,
HTTP 5xx responses, pool-saturation signals, contract failures, duplicate
identities, and snapshot changes. The slowest incremental traversal was the
two-page device traversal at 2.210 seconds.

## Sanitized query-plan evidence

Each row is from `EXPLAIN (ANALYZE, BUFFERS)` using the changed window. “Late”
includes the exact timestamp/id/organization cursor predicate used after the
first result. Counts combine the relevant plan filters; identifiers and
predicate literals have been removed.

| Predicate | Page | Principal nodes | Rows removed | Buffers hit/read | Sort | Execution |
|---|---|---|---:|---:|---|---:|
| Organization entity | First | Index Scan → Sort → Limit | 0 | 2 / 0 | quicksort, 25 kB | 5.560 ms |
| Organization entity | Late | Index Scan → Sort → Limit | 1 | 2 / 0 | quicksort, 25 kB | 0.079 ms |
| Approved printer | First | primary-key Index Scan → Limit | 473 | 815 / 161 | none | 20.033 ms |
| Approved printer | Late | Bitmap Index/Heap Scan → Sort → Limit | 0 | 190 / 12 | quicksort, 48 kB | 8.914 ms |
| Device `GREATEST` watermark | First | sequential scans → Hash Left Join → Sort → Limit | 9,998 | 1,313 / 0 | quicksort, 25 kB | 143.320 ms |
| Device `GREATEST` watermark | Late | sequential scans → Hash Left Join → Sort → Limit | 9,999 | 1,313 / 0 | quicksort, 25 kB | 157.324 ms |
| Device material watermark | First | sequential scan + indexed state probes → Sort → Limit | 9,996 | 30,950 / 0 | quicksort, 25 kB | 142.317 ms |
| Device material watermark | Late | sequential scan + indexed state probes → Sort → Limit | 9,997 | 30,950 / 0 | quicksort, 25 kB | 130.830 ms |
| Configuration material state | First | state scan + policy Index Scan → Sort → Limit | 16 | 5 / 0 | quicksort, 25 kB | 0.174 ms |
| Configuration material state | Late | state scan + policy Index Scan → Sort → Limit | 16 | 5 / 0 | quicksort, 25 kB | 0.168 ms |
| Scalar custom-field value | First | state/definition scans + device Index Scan → Sort → Limit | 10,014 | 339 / 0 | quicksort, 25 kB | 89.528 ms |
| Scalar custom-field value | Late | state/definition scans + device Index Scan → Sort → Limit | 10,015 | 339 / 0 | quicksort, 25 kB | 74.629 ms |

## Index decision

No index was added. The changed incremental pass consumed about 1.2% of the
15-minute cadence, no measured sort spilled to disk, and the slowest isolated
predicate plan completed in 157.324 ms. The device/material predicates do scan
the 10,000-device fixture, so they remain the first candidates to reassess if
tenant cardinality or per-cycle change density grows materially. The printer
predicate's partial-index mismatch likewise remains worth rechecking on sites
with substantially more approved network assets.

Machine-readable totals and sanitized plan fields are retained in
`2026-07-14-partner-export-changed-incremental.json`.
