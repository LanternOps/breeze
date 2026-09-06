# RMM-QA-221: site-scoped software and SentinelOne summaries

Refs #4060. Implementation scope only; candidate verification and QA closure remain separate.

## Evidence and design

At base `0fc5464a858c9882d9c6ba138a2d79931d156720`, software-policy overview counts use only the organization predicate. SentinelOne status lacks `devices:read` and every count uses only organization scope. Both retain site-scope ratchet exemptions. The QA closure brief and backlog require denied-site facts to have no effect, restricted-empty counts to be zero, and mounted summaries to reconcile sibling lists.

Apply `devices:read` to SentinelOne status, matching threats and software-policy reads. Existing partner/system role permission resolution remains authoritative. Narrow organization-context callers with an explicit site allowlist; preserve unrestricted callers, including partner/system roles with the required permission.

Software overview adds the same device-site predicate as violations before grouping worst status per device. Empty allowlists return all-zero counts. Overview counts devices, while violations lists policy-device rows; parity means identical eligible devices, not equating totals when devices have multiple policies or non-violation status.

The current schema differs from the brief: threats and actions have their own nullable `deviceId` and no agent foreign key. Use each table's direct device relationship and an organization/site-constrained device subquery. Exclude NULL/unmapped devices for restricted readers. Do not join through an invented agent relation or materialize a fleet-sized ID list for aggregate counts.

The sibling SentinelOne threats route currently retains NULL device rows even for an empty allowlist. Align this restricted list with the same direct-device scope predicate, preserving explicit denied-device rejection. Remove exactly the two relevant ratchet exemptions. No migration or external SentinelOne access is required.

## Executable verification plan

1. Create a private stack with `pnpm test-stack up`; use Node from `.node-version` and verify the request pool is `breeze_app` with neither superuser nor BYPASSRLS.
2. Add real-database mounted-route acceptance using real auth and custom roles. Seed allowed/denied sites, another organization/partner, NULL-mapped security rows, multiple software policies and statuses. Prove denied-site additions cannot change any summary, restricted-empty returns zeros and empty threats, and allowed rows remain visible. Exercise missing permission, cross-org selection, live site changes, unrestricted organization, partner and system roles.
3. Run `caffeinate -i pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/siteAggregateScope.integration.test.ts` against the private stack, plus site-scope and relevant RLS contracts. Confirm regression failures before handler edits.
4. Run affected route unit suites, API typecheck and the required full API unit suite with at most two workers, coordinating heavy work with the other implementation worker.
5. Obtain independent review of the exact commit, address findings, publish one draft PR and monitor exact-head CI. Stop at an open reviewed PR; no merge, deployment or finding closure.
