# Provider fixtures — `identity_offboarding` effect contracts

These files feed `../../effectContracts.test.ts`, the per-effect contract suite for spec §9(a) of the Operator Recipe Library (wave #6171, R1c). There is one file per tool in `IDENTITY_OFFBOARDING_EFFECT_TOOLS`, named `<toolName>.json`. The suite fails if a catalog tool has no file, or if a file has no catalog tool.

## The rule

**A fixture is a provider response *shape*. It is never a live credential and never real customer data.**

- Every identifier is a stable synthetic value. The suite builds the planned effects from the real recipe with these same values, so they must match:

  | What | Value |
  |---|---|
  | Google user | `dana@customer.example`, id `101` |
  | Google group | `all@customer.example` |
  | Google licence | product `Google-Apps`, SKU `1010020020` |
  | Mail destination (forward / delegate) | `manager@customer.example` |
  | Google connection admin | `admin@customer.example` |
  | M365 user (Entra object id) | `00000000-0000-4000-8000-0000000a0001` |
  | M365 group | `00000000-0000-4000-8000-0000000b0001` |
  | M365 licence SKU | `00000000-0000-4000-8000-0000000c0001` |
  | Intune managed device | `00000000-0000-4000-8000-0000000d0001` |
  | Auto-reply message | `Dana has left the organization. Please contact office@customer.example for help.` |

- Never commit a real tenant id, a real domain, a token, a key or an address that resolves. Only `*.example` domains are allowed (`scripts/security/check-customer-pii.sh` enforces this).
- Fixtures are checked in so that the gate runs in CI without provider credentials.

## Shape

```jsonc
{
  "_source": "reference",            // or "lab-run-YYYY-MM-DD"
  "_recordedFrom": "reference: <API doc section>",  // or the same "lab-run-YYYY-MM-DD"
  "_notes": "optional",
  "toolName": "google_suspend_user",
  "provider": "google",              // or "m365"
  "preSatisfied":   { "<call>": <response> },  // or null, with preSatisfiedUnreachable
  "preSatisfiedUnreachable": "why the real probe can never certify this before a write",
  "preUnsatisfied": { ... },         // also what a post-probe sees when a 200 write did not take
  "writeOk":        { ... },         // the write call(s) the executor makes, and any reads it does first
  "postSatisfied":  { ... },
  "writeRefusal":   { ... }          // optional: a typed refusal or a provider error
}
```

Each phase is a map from a **call key** to the response that call returns in that phase. The mocked clients answer only from the phase in play. A call the phase does not record throws, and the suite fails if a probe swallowed that throw.

| Provider | Call key | Response |
|---|---|---|
| Google | `directory.users.get`, `directory.users.update`, `directory.users.signOut`, `directory.groups.list`, `directory.members.delete`, `directory.mobiledevices.list`, `directory.mobiledevices.action`, `licensing.licenseAssignments.listForProduct`, `licensing.licenseAssignments.delete`, `gmail.settings.getVacation`, `gmail.settings.updateVacation`, `gmail.settings.getAutoForwarding`, `gmail.settings.updateAutoForwarding`, `gmail.settings.forwardingAddresses.get`, `gmail.settings.forwardingAddresses.create`, `gmail.settings.delegates.list`, `gmail.settings.delegates.create` | `{ "data": … }` (the googleapis response body), or `{ "error": { "code": <HTTP status>, "message": … } }`, which is thrown the way googleapis throws it |
| M365 | `read:<read action id>` (`read:m365.user.get`, `read:m365.group.member.get`, `read:m365.intune.device.get`) | an `executeM365ReadActionByOrg` result: `{ ok: true, kind: "resource", resource }`, `{ ok: true, kind: "collection", items, truncated }` or `{ ok: false, code, message }` |
| M365 | `write:<write action id>` (including the probe arm `write:m365.user.mailbox.auto_reply.state`) | an `executeM365WriteActionByOrg` result: `{ ok: true, result }` (validated against `writeActionResultSchema`) or `{ ok: false, code, message }` |

The suite builds the effects (and so every argument a probe or executor sees) from the real `buildIdentityOffboardingPlan`, and runs the real probes and the real headless executors over these shapes. A fixture cannot make a property pass by asserting itself.

## Provenance: `reference` vs `lab-run-<date>`

**Every fixture in this directory today is `"_source": "reference"`.** Each was authored from the public API reference named in its `_recordedFrom`, not recorded against a tenant. Three facts are known to be unconfirmed and are lab-run checklist rows:

- whether a device that received `admin_account_wipe` reports `WIPING` / `WIPED` (`google_account_wipe_mobile_device.json`);
- how Google mail-settings reads behave for a suspended user;
- the exact error bodies of each refusal.

A fixture still marked `reference` at sign-off is a gate failure. The tripwire for it runs only in gate mode, because a permanently red case in `test-api` would block the merge queue:

```sh
cd apps/api
npx vitest run src/services/aiOperator/effectContracts.test.ts                          # CI: tripwire reported as skipped
BREEZE_GATE_SIGNOFF=1 npx vitest run src/services/aiOperator/effectContracts.test.ts    # gate: tripwire RED until re-recorded
```

**Do not edit `_source` to turn the tripwire green.** Only a lab run that re-recorded the shapes may change it.

## Recording procedure (lab run, `docs/superpowers/qa/2026-09-17-identity-offboarding-lab-run.md` §9)

There is no automatic recorder. The contract suite runs against mocked clients, so it has nothing real to record. Recording is a manual capture during the lab run:

1. Print the capture plan. It lists every call key each property makes, per tool and per phase:
   ```sh
   cd apps/api && BREEZE_RECORD_PROVIDER_FIXTURES=1 npx vitest run src/services/aiOperator/effectContracts.test.ts
   ```
2. Against the lab's M365 developer tenant and Google Workspace test domain, issue each listed read **before** the write (`preUnsatisfied`) and **after** it (`postSatisfied`). Issue the same reads against a second synthetic leaver that has already been processed (`preSatisfied`). Capture each write's response (`writeOk`). Use the provider's own API explorer or the lab rig's request log.
3. Replace every identifier with the synthetic value in the table above. Keep field names, types and the provider's own enum values exactly as returned.
4. Set `_source` and `_recordedFrom` to `lab-run-YYYY-MM-DD`, re-run the suite, and confirm that it is green and that the gate-mode tripwire is green.
5. List the replaced files in the lab-run doc's §9.

`BREEZE_RECORD_PROVIDER_FIXTURES`, `BREEZE_GATE_SIGNOFF` and `BREEZE_EVAL_LIVE` are read **only** in `*.test.ts` files. The suite asserts this, and `envInventory.test.ts` would flag a non-test read.

## Which lab run produced these

None yet. Clause (e) of the gate (the lab run) has not been performed.
