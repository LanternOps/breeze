# Known Unresolved Advisories

This document tracks third-party advisories that `pnpm audit` flags in the Breeze
dependency tree but which we have consciously decided not to patch, along with
the threat-model justification and the conditions under which the decision
should be revisited.

The goal is honest bookkeeping: every unresolved advisory has an owner, a
rationale, and a trigger for re-evaluation.

---

## GHSA-2p57-rm9w-gvfp — `ip` package SSRF via `isPublic`/`isPrivate` bypass

- **First documented**: 2026-04-24
- **Package**: `ip` (currently resolved in our tree as `2.0.1`)
- **Advisory**: https://github.com/advisories/GHSA-2p57-rm9w-gvfp
- **Upstream status**: maintainer has not shipped a fix. The GitHub advisory
  records "Patched versions: `<0.0.0`", i.e. there is no patched release and
  none is planned. The package is effectively unmaintained.

### Dep chain

All paths originate from `apps/mobile`, which is a React Native / Expo app.
The current `pnpm audit --prod --audit-level=high` path is:

```
apps/mobile
  └── react-native@0.83.2
        └── @react-native/community-cli-plugin@0.83.2
              └── @react-native-community/cli@12.1.1
                    └── @react-native-community/cli-doctor@12.1.1
                          └── ip@2.0.1
```

`pnpm why ip --recursive` also shows the same `ip@2.0.1` version reachable
through `@react-native-community/cli-hermes@12.1.1`. Both are React Native CLI
tooling dependencies, not Breeze API/web/agent runtime dependencies.

### How `ip` is used in our tree

This is not imported by first-party Breeze code. The dependency is pulled by
React Native CLI packages used for mobile development diagnostics/profiling.
Those packages run on developer or CI machines during mobile development and
are not shipped in the API, web app, portal/viewer/helper, or Go agent.

### Why the CVE is not exploitable in our deployment

The advisory describes a bypass of `ip.isPublic()` / `ip.isPrivate()` when
given unusual IPv4/IPv6 string forms (`0.0.0.0`, IPv4-mapped-IPv6, etc.).
The exploitation path requires:

1. An application that calls `isPublic()` or `isPrivate()` as a **security
   gate** (typically to prevent SSRF against internal network ranges), **and**
2. Attacker-controlled input that is passed into that gate.

In Breeze's tree neither condition holds:

- **No first-party use.** Breeze code does not import `ip`, and the API/web/agent
  launch surfaces do not depend on the React Native CLI packages that pull it.
- **Build-time / developer-tooling only.** `@react-native-community/cli-hermes`
  and `@react-native-community/cli-doctor` run as part of React Native CLI
  workflows. They are not shipped inside the mobile app bundle that ends up on
  end-user devices.
- **Not on the API / web / agent path.** The `ip` package does not appear in
  the dependency graphs of `apps/api`, `apps/web`, `apps/agent`,
  `apps/helper`, `apps/portal`, or `apps/viewer`. The advisory therefore has
  no bearing on any internet-exposed Breeze surface.

To exploit the SSRF in our context an attacker would need to:

1. Compromise a developer workstation or CI runner that has `apps/mobile`
   dependencies installed, **and**
2. Induce a React Native CLI command that routes attacker-controlled strings
   through `ip.isPublic`/`ip.isPrivate` — a function that isn't actually
   invoked by any installed package.

That is not a meaningfully-reachable attack path.

### Decision — Option D: document and accept

- **Customer launch scope (2026-05-24):** `apps/mobile` is excluded from the
  initial MSP customer launch artifact and from the customer-launch audit gate.
  The shipping launch surfaces are API, web, portal/viewer/helper where
  applicable, and the Go agent. Re-open this gate before mobile is offered to
  customers, or when the React Native CLI chain drops `ip`.
- We are **not** applying a `pnpm.overrides` alias: no vouched, drop-in safe
  fork of `ip` exists on npm. Redirecting a transitive dep to an unaudited
  third-party package would add more supply-chain risk than the CVE itself
  presents.
- We are **not** vendoring a `pnpm.patchedDependencies` patch: the vulnerable
  surface (`isPublic`/`isPrivate`) is not reached in our tree, so a patch
  would be maintenance burden with zero real mitigation.
- We are **not** bumping `react-native` to drop the transitive: React Native
  0.84+ is a major-class upgrade for an Expo app and out of scope for a
  security hygiene PR. The React Native community has already migrated away
  from the `ip` package in newer `@react-native-community/cli` releases
  (post-`12.x`), so a future RN bump will drop this dep organically.

### Revisit when any of the following become true

- `apps/mobile` bumps to React Native 0.84+ (or any RN release that updates
  `@react-native-community/cli` to a version that no longer depends on `ip`).
  At that point, this advisory should disappear from `pnpm audit` and the
  entry can be removed from this document.
- Any workspace (API, web, agent, helper, viewer, portal) starts importing
  `ip` directly, or starts calling `ip.isPublic()` / `ip.isPrivate()` on any
  input. That would re-open the threat model and likely require a vendored
  patch or a safer alternative (`netmask`, `ipaddr.js`, Node's built-in
  `net.isIP`).
- The upstream `ip` package ships a patched release, or a community fork
  becomes the consensus replacement and is adopted by the React Native CLI.

### Verification commands

```bash
# Confirm `ip` is still only pulled in through the React Native CLI chain:
pnpm audit --json | jq '.advisories | to_entries[]
  | select(.value.github_advisory_id == "GHSA-2p57-rm9w-gvfp")
  | .value.findings[].paths'

# Confirm no first-party code imports `ip`:
grep -rn "from 'ip'\|require('ip')\|require(\"ip\")" apps packages || echo "no direct imports"
```
