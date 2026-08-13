# Customer Onboarding Runbook — NU RMM

On-site copy: RMM → **Scripts → "📖 RUNBOOK: Customer Onboarding"** (the script body IS this
document; running it does nothing — it exits immediately).

Everything below happens at https://rmm.nodesunlimited.com logged in as the partner admin.

## 1. Create the customer

1. **Organizations → New Organization** — the customer's company name (e.g. "Genetix Bio").
2. Inside the org: **Sites → New Site** — one per physical location ("HQ", "Lab").
   Devices always enroll into a site.

## 2. Enrollment key

1. **Devices → Add Device** (or Enrollment Keys) → create a key for the right org + site.
2. ⚠️ **Set the expiry generously (e.g. 12–24 h) BEFORE the visit.** The default key
   lifetime is ~15 minutes — a key minted in the office is dead by the time you're on-site,
   and every download link it signs returns "link has expired".
3. One key covers the whole visit; usage count is per-install.

## 3. Install the agent

**Windows** (one x64 MSI: fully NATIVE on normal Intel/AMD PCs — emulation only applies
on the rare ARM64 Windows device, where it still works, just with some CPU overhead):
1. Add Device → Windows → **copy the PowerShell one-liner** (preferred — it downloads,
   installs silently AND enrolls in one paste).
2. **Run it ON THE CUSTOMER'S DEVICE** in an *administrator* PowerShell. This is the one
   and only manual touch a device ever needs — there is no agent yet on a fresh machine,
   the MSI is how the agent gets there. Never run it on your own Mac or the server.
3. Device appears in Devices once the ~58 MB download + install finishes (speed depends
   on their connection). Installed-programs entry: **NU Agent**. The agent only makes
   OUTBOUND https to rmm.nodesunlimited.com — no inbound ports, so corporate firewalls
   rarely interfere; if the server is briefly unreachable the agent retries until
   enrollment succeeds.

**macOS** (Intel + Apple Silicon, one bundle):
1. Add Device → macOS → downloads `breeze-agent-macos.zip` (install.sh + enrollment.json).
2. `cd` into the unzipped folder → `sudo bash install.sh` — it fetches the right-arch
   signed pkg from the server and enrolls.
3. Gatekeeper will warn (self-signed by design) — approve. Then grant the TCC prompts
   (Full Disk Access / Accessibility / Screen Recording) for remote control to work.
   Permissions survive agent updates (stable signing identity).

**Linux** (servers):
1. Add Device → Linux → copy the curl one-liner → run with sudo.

## 4. Remote desktop (RustDesk) — per Windows device

1. Device → **Run Script → "NU RustDesk Install + Configure"**.
   Optional: pass your own password as the `password` parameter; otherwise one is generated.
2. Output prints `rustdesk id: <ID>` and `unattended access code: <CODE>` — **copy both**.
   (The word "password" is redacted in outputs; "access code" is shown on purpose.)
3. Device → Custom Fields → set **`rustdesk_id`** = the printed ID.
4. Connect button on the device now launches RustDesk; use the access code.
   Tech machine needs the RustDesk client configured with server `168.119.184.198`,
   key `uO8AKOvLK6gMlHytgdKUECpSaYliOV2GgA4atS7Aep8=`.

## 5. Verify before leaving site

- Device shows **online**; hardware/software inventory populated.
- Run any library script → completes with output.
- Event Logs / Monitoring / Compliance tabs show the **NU Baseline (All Orgs)** policy
  (partner-wide — applies automatically, nothing to configure per customer).
- Remote desktop connects.

## Troubleshooting quick refs

| Symptom | Cause / fix |
|---|---|
| Download link says expired | Enrollment key expired (15-min default) — mint a new key with a long TTL |
| Windows install rolls back (1603) | Read `C:\Windows\Temp\` MSI log; see docs/nu/known-issues.md (BOM class is guarded now) |
| Script output shows `[REDACTED]` | Agent redacts `password=`-shaped text; NU scripts print "access code" instead |
| macOS agent won't start on new Apple chip | Must be OUR build (CGO off) — stock upstream builds crash; server serves ours |
| Device stuck "updating" | Agent/server version mismatch — binaries VERSION file must equal agent version |
| Remote connect does nothing | RustDesk client missing on tech machine, or `rustdesk_id` custom field empty |
