# Release note — Remote Session Consent & Notification (behavior change on upgrade)

**Feature:** Remote Session Consent & End-User Notification  
**Branch:** `feat/remote-session-consent`  
**Affects:** All Helper-equipped devices on upgrade

---

## Behavior change: remote sessions now show a start notice by default

Starting with this release, every device that has the **Breeze Helper** installed will
display a brief "Technician X connected to your computer" notification each time a
remote desktop session starts. A persistent top-center pill ("Remote session active")
is shown for the duration of the session, and a session-ended notice is sent when
the technician disconnects.

This is intentional — `session_prompt_mode` defaults to **`notify`** (privacy-forward)
— but it is a **behavior change** relative to the prior silent behavior.

### Who is affected

- Any managed device running the Breeze Helper (Tauri assist helper).
- Devices **without** the Helper (headless / unattended / login-screen only) are
  unaffected: no Helper means no surfaces, and the consent gate uses
  `consent_unavailable_behavior: proceed` by default, so remote sessions are not
  blocked.

### Operators who want the old silent behavior

Create a `remote_access` configuration policy (Settings → Configuration Policies →
New policy, type `remote_access`) and set:

```json
{
  "session_prompt_mode": "off"
}
```

Apply the policy to the relevant device group(s) or organization(s). Devices that
receive this policy will behave exactly as before: no start notice, no banner, no
session-ended notice.

### Consent mode (opt-in)

`session_prompt_mode: "consent"` is **not** the default. It adds an Allow/Deny
prompt before the technician's view begins. Enable it explicitly per policy if
required by your compliance posture. The `consent_unavailable_behavior` toggle
(default `proceed`) ensures consent mode never locks technicians out of unattended
or headless machines unless you explicitly choose `block`.

### Mixed-version fleet safety

New IPC fields are additive and optional. Older agents and Helpers (without the
consent feature) ignore the `prompt` block in the desktop-start command and behave
as before (silent). Mixed-version fleets are safe to deploy incrementally.
