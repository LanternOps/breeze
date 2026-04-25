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
- **Package**: `ip` (installed version in our tree: `1.1.9`, marked `optional: true`)
- **Advisory**: https://github.com/advisories/GHSA-2p57-rm9w-gvfp
- **Upstream status**: maintainer has not shipped a fix. The GitHub advisory
  records "Patched versions: `<0.0.0`", i.e. there is no patched release and
  none is planned. The package is effectively unmaintained.

### Dep chain

All paths originate from `apps/mobile`, which is a React Native / Expo app:

```
apps/mobile
  └── react-native@0.83.2
        └── @react-native/community-cli-plugin@0.83.2
              └── @react-native-community/cli@12.1.1
                    ├── @react-native-community/cli-doctor@12.1.1      (no direct `require('ip')`)
                    └── @react-native-community/cli-hermes@12.1.1      (requires `ip`)
                          └── ip@1.1.9
```

`ip@1.1.9` is pulled in exclusively by `@react-native-community/cli-hermes`.
`ip` is flagged `optional: true` in `pnpm-lock.yaml` — it is developer tooling
that only materialises on platforms where Hermes profiling is possible.

### How `ip` is used in our tree

The only import site in any installed package is
`@react-native-community/cli-hermes/build/profileHermes/sourcemapUtils.js`
(source: `src/profileHermes/sourcemapUtils.ts`). The relevant excerpt:

```ts
import ip from 'ip';
// ...
const IP_ADDRESS = ip.address();
const requestURL = `http://${IP_ADDRESS}:${port}/index.map?platform=...`;
```

This code runs on the **developer's laptop** when the developer invokes
`react-native profile-hermes` to fetch a sourcemap from a locally-running
Metro bundler. It uses `ip.address()` to discover the developer's own LAN IP
so it can build a `http://<lan-ip>:<port>/index.map` URL.

### Why the CVE is not exploitable in our deployment

The advisory describes a bypass of `ip.isPublic()` / `ip.isPrivate()` when
given unusual IPv4/IPv6 string forms (`0.0.0.0`, IPv4-mapped-IPv6, etc.).
The exploitation path requires:

1. An application that calls `isPublic()` or `isPrivate()` as a **security
   gate** (typically to prevent SSRF against internal network ranges), **and**
2. Attacker-controlled input that is passed into that gate.

In Breeze's tree neither condition holds:

- **Vulnerable API not used.** Our single call site uses `ip.address()`, which
  reads `os.networkInterfaces()` on the local host. `isPublic` and `isPrivate`
  are never called by `cli-hermes`, and `ip` is not imported anywhere else in
  our workspace (verified by grep over `node_modules/.pnpm`).
- **No user input.** The input to `ip.address()` is the developer's own OS
  network configuration. There is no attacker-controlled string path.
- **Build-time / developer-tooling only.** `@react-native-community/cli-hermes`
  runs as part of `react-native` CLI commands on a developer machine. It is
  not shipped inside the mobile app bundle that ends up on end-user devices.
  An Expo production build of `apps/mobile` does not contain `ip` in the JS
  bundle delivered to iOS/Android.
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
# Confirm `ip` is still only pulled in via @react-native-community/cli-hermes:
pnpm audit --json | jq '.advisories | to_entries[]
  | select(.value.github_advisory_id == "GHSA-2p57-rm9w-gvfp")
  | .value.findings[].paths'

# Confirm no first-party code imports `ip`:
grep -rn "from 'ip'\|require('ip')\|require(\"ip\")" apps packages || echo "no direct imports"
```
