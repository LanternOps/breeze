# Task 6 report — Breeze reconstruction inventory

## Scope delivered

- Added `inventory:read` exports for `/device-inventory`, `/device-software`, and `/device-relationships`.
- Device inventory is an explicit durable projection of CPU, memory, firmware, disk capacity, interfaces, IP history, warranty, and Hyper-V definitions. It excludes monitoring state, disk usage, provider/raw JSON, sync errors, VM runtime state, checkpoints, secrets, and event-only peripherals.
- Site inventory preserves approved durable network equipment and network segments even for sites with zero managed devices.
- Relationship batches cover organization→site, site→device, device→interface, interface→address, Hyper-V host→VM, durable topology/VLAN, and link-group peers. Dynamic addresses remain informational and set `reservationEligible: false`; only static addresses set it true.
- Every child collection is SQL-bounded and reports total/included/completeness. Caps are 500 for inventory/relationships and 1,000 for software.
- Device/site union batches use namespace-separated deterministic RFC-valid UUID identities and filter-bound keyset cursors.

## Incremental consistency

- Migration: `apps/api/migrations/2026-07-20-partner-export-reconstruction-material-state.sql`.
- Added forced-RLS direct-org material-state tables for resource-specific device and site timestamps.
- Statement-level transition-table triggers touch each distinct owner once per child statement. Safe-field comparisons ignore volatile/raw fields, while inserts/deletes and durable changes advance the correct inventory/software/relationship watermark under the existing canonical export locks.
- Device site/link-group changes and peer deletion update relationship owners; discovered equipment/baselines update site inventory; topology updates site relationships; network/IP/Hyper-V changes update device inventory and relationships.
- Direct material-state timestamp regression is database-guarded.

## TDD evidence

- RED: 22/22 initial route tests failed against missing endpoints; two empty-site/site-equipment tests and two stable-identity tests were then added before their implementation.
- GREEN: 26/26 focused route/identity tests.
- Real DB: 5/5 migration, watermark, guard, and actual PostgreSQL route-query tests.

## Verification

- Partner API/auth/partner-service-principal regression set: 167/167 passed.
- TypeScript `tsc --noEmit`: passed.
- Focused ESLint: passed.
- API production build: passed.
- Migration applied twice successfully; fresh isolated database applied all 405 migrations.
- Fresh isolated migration ledger drift check: passed.
- Shared RLS coverage contract: 52/53 assertions passed; the sole contract failure is existing shared-DB drift for `pax8_orders` and `pax8_order_lines`. Four unrelated suite cleanup failures expose the pre-existing Task 5 multi-org organization-delete lock-order regression and are intentionally not changed in this task.

## Scope boundary

- Breeze files only. No Weavestream implementation files were changed.
- Untracked `.githooks` files were preserved and excluded.
