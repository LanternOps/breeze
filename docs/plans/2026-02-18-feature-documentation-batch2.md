# Feature Documentation — Batch 2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write user-facing documentation for 4 major features that shipped without docs — Deployments, Remote Desktop, Patch Management, and Automations.

**Architecture:** Each task creates one markdown file in `docs/`. Every doc follows the same structure as the existing docs (ADMIN_GUIDE.md tone: numbered sections, bold table labels, code blocks for API examples, horizontal rules between sections). Docs are standalone and cross-referenced where natural.

**Tech Stack:** Markdown. Reference `docs/ADMIN_GUIDE.md` for tone and format baseline.

---

## Documents to create

| File | Features covered |
|---|---|
| `docs/DEPLOYMENTS.md` | Deployment system — staggered rollout, batch control, retry logic |
| `docs/REMOTE_DESKTOP.md` | Remote desktop, terminal sessions, file transfers (WebRTC) |
| `docs/PATCH_MANAGEMENT.md` | Patch scan/approval/deploy/rollback/compliance reports |
| `docs/AUTOMATIONS.md` | Automations — triggers, actions, runs, webhooks |

---

### Task 1: Deployments documentation

**Files:**
- Create: `docs/DEPLOYMENTS.md`

**Context for writer:**

Deployments are the mechanism for rolling out a change (script run, patch install, config update) to a large set of devices in a controlled way. Two rollout modes:
- **Immediate** — all target devices at once
- **Staggered** — devices are split into batches; each batch waits for the previous to complete before starting, with a configurable delay between batches

Target selection supports 4 types: explicit `devices` (UUIDs), `groups` (device group IDs), `filter` (complex filter expression), `all` (every device in org).

Lifecycle: `draft` → `pending` (after initialize) → `downloading`/`installing` (after start) → `completed`/`failed`/`cancelled`

Rollout config shape:
- `type`: `'immediate'` or `'staggered'`
- `staggered.batchSize`: number or "10%"
- `staggered.batchDelayMinutes`: wait between batches
- `staggered.pauseOnFailureCount`: auto-pause if N devices fail
- `staggered.pauseOnFailurePercent`: auto-pause if X% fail
- `respectMaintenanceWindows`: boolean
- `retryConfig.maxRetries`: 0–10
- `retryConfig.backoffMinutes`: array e.g. `[5, 15, 60]`

Progress tracking: `total`, `pending`, `running`, `completed`, `failed`, `skipped`, `currentBatch`, `totalBatches`, `percentComplete`

**Step 1: Create the file skeleton**

```bash
touch docs/DEPLOYMENTS.md
```

Write this skeleton:

```markdown
# Deployments

## Overview
## Key Concepts
### Rollout modes
### Target types
### Lifecycle states
### Retry and failure handling
## Creating a Deployment
## Initializing and Starting
## Monitoring Progress
## Pausing, Resuming, and Cancelling
## Retrying Failed Devices
## API Reference
## Troubleshooting
```

**Step 2: Fill in Overview**

2-3 paragraphs:
- A Deployment is a coordinated rollout of a change (script, patch, config update) across a set of devices. Instead of dispatching commands individually, deployments let you manage the rollout as a unit — controlling pace, handling failures, and tracking progress.
- Deployments are stateful: they move through defined lifecycle stages and can be paused and resumed. Staggered rollouts let you validate each batch before proceeding to the next.

**Step 3: Fill in Key Concepts**

*Rollout modes* — table:
| Mode | Description |
|---|---|
| Immediate | All target devices start at the same time |
| Staggered | Devices split into batches; each batch starts after the previous completes plus a configurable delay. Supports percentage-based batch sizes (e.g., "10%") |

*Target types* — table:
| Type | Description |
|---|---|
| `devices` | Explicit list of device UUIDs |
| `groups` | One or more device group IDs — membership resolved at initialize time |
| `filter` | Filter expression (same syntax as Device Groups dynamic filters) |
| `all` | Every device in the organization |

*Lifecycle states* — diagram:
```
draft → pending → downloading/installing → completed
                                        → failed
                                        → cancelled
```
Describe each state in 1 sentence.

*Retry and failure handling* — explain `retryConfig.maxRetries` and `retryConfig.backoffMinutes` (exponential backoff array). Explain `pauseOnFailureCount` / `pauseOnFailurePercent` — when exceeded, the deployment auto-pauses so an admin can investigate before proceeding.

**Step 4: Fill in Creating a Deployment**

Step-by-step UI walkthrough:
1. Navigate to **Fleet → Deployments**
2. Click **New Deployment**
3. Enter a name
4. Select the payload type (script, patch job, etc.) and configure its settings
5. Choose target type and select targets
6. Choose rollout mode — if Staggered, configure batch size and delay
7. Set retry config if desired
8. Toggle **Respect Maintenance Windows** if applicable
9. Click **Save as Draft** — deployment is saved but not yet running

Also show the POST body shape:
```json
{
  "name": "Monthly Cleanup — Windows Fleet",
  "type": "script",
  "payload": { "scriptId": "uuid", "parameters": {} },
  "targetType": "groups",
  "targetConfig": { "groupIds": ["uuid-1", "uuid-2"] },
  "rolloutConfig": {
    "type": "staggered",
    "staggered": {
      "batchSize": "10%",
      "batchDelayMinutes": 30,
      "pauseOnFailurePercent": 20
    },
    "respectMaintenanceWindows": true,
    "retryConfig": { "maxRetries": 3, "backoffMinutes": [5, 15, 60] }
  }
}
```

**Step 5: Fill in Initializing and Starting**

Two separate steps:
1. **Initialize** (`POST /deployments/:id/initialize`) — resolves the target selection to concrete device IDs, calculates batch assignments, creates per-device records. The deployment moves from `draft` to `pending`. This is a preview step — you can see the full device list before committing.
2. **Start** (`POST /deployments/:id/start`) — begins execution. The deployment transitions to `downloading` or `installing` and commands are dispatched to the first batch of devices.

**Step 6: Fill in Monitoring Progress**

`GET /deployments/:id` returns a `progress` object:
| Field | Description |
|---|---|
| `total` | Total device count |
| `pending` | Not yet started |
| `running` | Currently executing |
| `completed` | Finished (success or failure reported) |
| `failed` | Reported a failure |
| `skipped` | Excluded (offline, maintenance window, etc.) |
| `currentBatch` | Current batch number |
| `totalBatches` | Total number of batches |
| `percentComplete` | 0–100 |

Also: `GET /deployments/:id/devices?status=failed&batchNumber=2` for per-device drill-down.

**Step 7: Fill in Pausing, Resuming, and Cancelling**

- `POST /deployments/:id/pause` — pauses after the current batch finishes. Use when a batch reveals an issue.
- `POST /deployments/:id/resume` — continues to the next batch.
- `POST /deployments/:id/cancel` — cancels all pending devices (marks them `skipped`). Already running/completed devices are not affected.

**Step 8: Fill in Retrying Failed Devices**

`POST /deployments/:id/devices/:deviceId/retry` — queues a retry for a single failed device. The device is moved back to `pending` and will be dispatched again. Retry counts are tracked against `maxRetries`.

**Step 9: Fill in API Reference**

| Method | Path | Description |
|---|---|---|
| GET | `/deployments` | List deployments (`?status=&type=&limit=&offset=`) |
| POST | `/deployments` | Create deployment |
| GET | `/deployments/:id` | Get deployment with progress |
| PUT | `/deployments/:id` | Update deployment (draft only) |
| DELETE | `/deployments/:id` | Delete deployment (draft only) |
| POST | `/deployments/:id/initialize` | Resolve targets and create device records |
| POST | `/deployments/:id/start` | Begin execution |
| POST | `/deployments/:id/pause` | Pause between batches |
| POST | `/deployments/:id/resume` | Resume paused deployment |
| POST | `/deployments/:id/cancel` | Cancel all pending devices |
| GET | `/deployments/:id/devices` | List per-device records (`?status=&batchNumber=&limit=&offset=`) |
| POST | `/deployments/:id/devices/:deviceId/retry` | Retry failed device |

**Step 10: Fill in Troubleshooting**

- *Deployment stuck in `pending`* — Initialize was called but Start was never called. Call `POST /:id/start`.
- *Deployment auto-paused* — `pauseOnFailureCount` or `pauseOnFailurePercent` threshold was reached. Check the failed devices (`GET /:id/devices?status=failed`) before resuming.
- *Device skipped unexpectedly* — Device may have been inside an active maintenance window with `respectMaintenanceWindows: true`, or the device was offline at dispatch time.
- *Retry failing repeatedly* — Check device status and agent connectivity. If `maxRetries` is exhausted, the device record will not auto-retry further; use the per-device retry endpoint manually.

**Step 11: Commit**

```bash
git add docs/DEPLOYMENTS.md
git commit -m "docs: add Deployments documentation"
```

---

### Task 2: Remote Desktop documentation

**Files:**
- Create: `docs/REMOTE_DESKTOP.md`

**Context for writer:**

Remote Desktop provides interactive access to managed devices via WebRTC. Three session types:
- **terminal** — interactive shell (rendered in browser via xterm.js)
- **desktop** — full desktop control (mouse, keyboard, video stream)
- **file_transfer** — bi-directional file movement

**Session lifecycle:** `pending` → `connecting` → `active` → `disconnected`/`failed`

**Rate limits:** max 5 concurrent sessions/org, 2/user. Max 10 transfers/org, 5/user.

**WebRTC signaling flow:** Client sends offer → relayed to device via WS → device sends answer back → ICE candidate exchange → P2P established.

**File transfers:** chunked upload/download, max 5 GB per transfer, progress tracked as 0–100%. Direction is from the device's perspective: `upload` = device → user (user downloads a file), `download` = user → device (user uploads a file).

**File transfer status:** `pending` → `transferring` → `completed`/`failed`

**Step 1: Create the file skeleton**

```markdown
# Remote Desktop

## Overview
## Session Types
## Starting a Session
### Terminal
### Desktop control
### File transfer
## Session Lifecycle
## File Transfers
### Initiating a transfer
### Tracking progress
### Downloading a completed file
### Cancelling
## Rate Limits
## Security
## API Reference
## Troubleshooting
```

**Step 2: Fill in Overview**

2 paragraphs covering:
- Remote Desktop gives technicians direct access to managed devices without requiring VPN or third-party tools. All sessions use WebRTC for peer-to-peer data transfer; the Breeze server acts as a signaling relay only — device data does not transit the server after the connection is established.
- Three access modes for different workflows. MFA is required for all remote access.

**Step 3: Fill in Session Types**

| Type | Description | Use case |
|---|---|---|
| `terminal` | Interactive shell session | Run commands, inspect logs, troubleshoot |
| `desktop` | Full desktop control with mouse/keyboard | GUI application support, visual troubleshooting |
| `file_transfer` | Bi-directional file movement | Pull logs or crash dumps, push scripts or patches |

**Step 4: Fill in Starting a Session**

UI walkthrough for each type. For all three:
1. Navigate to a device's detail page
2. Click **Connect** in the top right, then choose the session type

*Terminal:*
3. A browser terminal opens (xterm.js)
4. Wait for the `connected` indicator before typing — the browser waits for the server's confirmation before sending input
5. Type commands normally; resize the window to adjust the PTY dimensions

*Desktop:*
3. A fullscreen viewer opens (the Breeze Viewer app or in-browser)
4. Mouse and keyboard events are captured and relayed to the device

*File Transfer:*
3. Choose direction: **Download from device** or **Upload to device**
4. For download: Enter the remote file path
5. For upload: Select the local file and enter the destination path

**Step 5: Fill in Session Lifecycle**

```
pending     — session created, waiting for device to acknowledge
connecting  — device acknowledged, WebRTC negotiation in progress
active      — P2P connection established, data flowing
disconnected — session ended normally
failed      — connection could not be established
```

Session metadata recorded on end: `durationSeconds`, `bytesTransferred`.

**Step 6: Fill in File Transfers**

*Initiating:*
```bash
POST /remote/transfers
{
  "deviceId": "uuid",
  "direction": "upload",          # "upload" = device→user, "download" = user→device
  "remotePath": "/var/log/app.log",
  "localFilename": "app.log",
  "sizeBytes": 1048576
}
```

Note the direction convention: `upload` means the device is uploading to the server (you are retrieving a file from the device). `download` means you are pushing a file to the device.

*Tracking progress:* Poll `GET /remote/transfers/:id` — check `progressPercent` (0–100) and `status`.

*Downloading a completed file:* For `upload` transfers (device → user), once status is `completed`, call `GET /remote/transfers/:id/download` to retrieve the file.

*Cancelling:* `POST /remote/transfers/:id/cancel` — works while status is `pending` or `transferring`.

**Step 7: Fill in Rate Limits**

| Resource | Per-org limit | Per-user limit |
|---|---|---|
| Active sessions | 5 | 2 |
| Active file transfers | 10 | 5 |
| Max file transfer size | 5 GB | 5 GB |

When limits are reached, new session/transfer creation returns 429.

**Step 8: Fill in Security**

- MFA is required for all remote access sessions (enforced at the route level).
- The Breeze server acts as a WebRTC signaling relay only. After the P2P connection is established, device data does not transit the server.
- All sessions are audit logged with actor, device, start/end time, duration, and bytes transferred.
- Session history is available at `GET /remote/sessions/history`.

**Step 9: Fill in API Reference**

Sessions:
| Method | Path | Description |
|---|---|---|
| POST | `/remote/sessions` | Create session (body: `deviceId`, `type`) |
| GET | `/remote/sessions` | List sessions (`?deviceId=&status=&type=&includeEnded=`) |
| GET | `/remote/sessions/history` | Session statistics (total, avg/min/max duration, peak concurrent) |
| DELETE | `/remote/sessions/stale` | Clean up stuck sessions (`?deviceId=` optional) |
| POST | `/remote/sessions/:id/webrtc-offer` | Send SDP offer |
| POST | `/remote/sessions/:id/webrtc-answer` | Relay device's SDP answer |
| POST | `/remote/sessions/:id/ice-candidates` | Exchange ICE candidates |

File Transfers:
| Method | Path | Description |
|---|---|---|
| POST | `/remote/transfers` | Initiate transfer |
| GET | `/remote/transfers` | List transfers (`?deviceId=&status=&direction=`) |
| GET | `/remote/transfers/:id` | Get transfer details and progress |
| POST | `/remote/transfers/:id/cancel` | Cancel pending/active transfer |
| POST | `/remote/transfers/:id/chunks` | Upload chunk (multipart: `chunkIndex`, `data`) |
| GET | `/remote/transfers/:id/download` | Download completed file (upload transfers only) |

**Step 10: Fill in Troubleshooting**

- *Session stuck in `connecting`* — WebRTC negotiation failed. Check that the device has network connectivity and the agent WebSocket is active. ICE candidate exchange may fail if the device is behind symmetric NAT without a TURN server configured.
- *Session limit hit (429)* — Another user may have left a session open. Admins can call `DELETE /remote/sessions/stale` to clean up inactive sessions, or close sessions via the active sessions list.
- *Terminal shows garbled output after resize* — The browser sent a resize event before the session was fully established. This is a race condition fixed by waiting for the server `connected` message before sending events (the UI handles this automatically in recent builds).
- *File transfer stuck at 0%* — The device must be online and the agent WebSocket connected. If the device goes offline mid-transfer, cancel and retry once the device reconnects.
- *"Access denied" on remote session* — Remote access requires the `remote_access` permission. Check the user's role in **Settings → Roles**.

**Step 11: Commit**

```bash
git add docs/REMOTE_DESKTOP.md
git commit -m "docs: add Remote Desktop documentation"
```

---

### Task 3: Patch Management documentation

**Files:**
- Create: `docs/PATCH_MANAGEMENT.md`

**Context for writer:**

Patch Management handles the full lifecycle of software updates: discover → approve → deploy → verify → rollback.

**Patch sources:** `microsoft` (Windows Update), `apple` (macOS), `linux` (apt/yum/etc.), `third_party`, `custom`

**Severity levels:** `critical`, `important`, `moderate`, `low`, `unknown`

**Approval workflow:** `pending` → `approved` / `rejected` / `deferred` (with `deferUntil` date)

**Device patch status:** `pending` (detected, not installed), `installed`, `failed`, `skipped`, `missing`

**Patch job status:** `scheduled` → `running` → `completed` / `failed` / `cancelled`

**Rollback:** Can target specific devices or all devices with status `installed`. Status: `pending` → `running` → `completed` / `failed` / `cancelled`

**Compliance reports:** Generate CSV or PDF reports of patch status across the org. Background job, async — poll status then download.

**Integration with Configuration Policies:** The Configuration Policy system can define auto-approval rules and patch schedules. Legacy `patchPolicies` table also exists but new deployments should use Configuration Policies.

**Step 1: Create file skeleton**

```markdown
# Patch Management

## Overview
## Key Concepts
### Patch sources
### Severity levels
### Approval states
### Device patch status
## Scanning for Patches
## Reviewing and Approving Patches
### Approving
### Rejecting
### Deferring
### Bulk approval
## Deploying Patches
### Patch jobs
### Patch job status
## Rollback
## Compliance Reporting
### Generating a report
### Downloading a report
## Automating with Configuration Policies
## API Reference
## Troubleshooting
```

**Step 2: Fill in Overview**

3 short paragraphs:
- Patch Management gives you full control over software updates across your fleet — from discovering what patches are available, to approving or deferring them, deploying to groups of devices, and rolling back if something goes wrong.
- Every patch goes through an approval workflow before it can be deployed. Approvals are per-organization, so you can manage different customers' patch policies independently.
- Compliance reports give you a snapshot of patch coverage for audits and customer reporting.

**Step 3: Fill in Key Concepts**

*Patch sources* — table of 5 sources with descriptions.

*Severity levels* — table: critical (security-critical, immediate), important (high-priority), moderate (standard), low (minor), unknown (unclassified).

*Approval states* — table:
| State | Meaning |
|---|---|
| `pending` | Not yet reviewed |
| `approved` | Cleared for deployment |
| `rejected` | Explicitly declined — will not be installed |
| `deferred` | Temporarily postponed until `deferUntil` date |

*Device patch status* — table:
| Status | Meaning |
|---|---|
| `pending` | Patch detected by scan, not yet installed |
| `installed` | Successfully installed |
| `failed` | Installation attempted but failed |
| `skipped` | Not applicable (OS mismatch, policy exclusion, etc.) |
| `missing` | Expected but not found after post-install scan |

**Step 4: Fill in Scanning for Patches**

Trigger a patch scan on a set of devices:

```bash
POST /patches/scan
{
  "deviceIds": ["uuid-1", "uuid-2"],
  "source": "microsoft"  # optional — omit to scan all sources
}
```

Response includes `jobId`, dispatched device counts, and any devices that couldn't be reached (`failedDeviceIds`, `skipped.inaccessibleDeviceIds`).

Scan results are processed asynchronously. Once complete, the patches appear in `GET /patches` and approval records are created (status: `pending`).

**Step 5: Fill in Reviewing and Approving Patches**

*Approving:*
```bash
POST /patches/:id/approve
{ "orgId": "uuid", "note": "Reviewed and approved for production fleet" }
```

*Rejecting:*
```bash
POST /patches/:id/decline
{ "orgId": "uuid", "note": "Known conflict with legacy app — do not install" }
```
Rejection is not destructive — it creates an audit record. Rejected patches can be approved later.

*Deferring:*
```bash
POST /patches/:id/defer
{ "orgId": "uuid", "deferUntil": "2026-03-01T00:00:00Z", "note": "Wait for Q1 change window" }
```
The patch returns to `pending` automatically after `deferUntil`.

*Bulk approval:*
```bash
POST /patches/bulk-approve
{ "orgId": "uuid", "patchIds": ["uuid-1", "uuid-2", "uuid-3"], "note": "Batch approval — March cycle" }
```
Response: `{ "approved": [...], "failed": [...] }` — partial success is possible.

**Step 6: Fill in Deploying Patches**

Describe patch jobs:
- Created automatically when a patch job is triggered (from Configuration Policy, from UI, or from `POST /configuration-policies/:id/patch-job`)
- Job targets a set of devices; each device's approved patches are sent as the `install_patches` command
- Devices must be online (WebSocket connected) to receive the command
- `GET /patches/jobs?status=running` lists all active jobs

Job status progression: `scheduled` → `running` → `completed`/`failed`/`cancelled`

Per-job counters: `devicesTotal`, `devicesCompleted`, `devicesFailed`, `devicesPending`.

**Step 7: Fill in Rollback**

```bash
POST /patches/:id/rollback
{
  "reason": "Causing boot failures on Intel systems",
  "scheduleType": "immediate",
  "deviceIds": ["uuid-1"]  # optional — omit to target all devices with status: installed
}
```

- Sends `rollback_patches` command to agent
- Agent executes the patch's `uninstallCommand`
- `devicePatches.status` is reset
- If `scheduleType: "scheduled"`, provide `scheduledTime` (ISO 8601)

Rollback status: `pending` → `running` → `completed`/`failed`/`cancelled`

**Step 8: Fill in Compliance Reporting**

*Generating:*
```bash
GET /patches/compliance/report?orgId=uuid&source=microsoft&severity=critical&format=csv
```
Returns `{ "reportId": "uuid", "status": "queued" }` immediately. The report is generated in the background.

*Checking status:*
```bash
GET /patches/compliance/report/:id
# Returns: { status, rowCount, summary, startedAt, completedAt, errorMessage }
```

*Downloading:*
```bash
GET /patches/compliance/report/:id/download
# Returns: file stream (CSV or PDF) — only works when status is "completed"
```

Also: `GET /patches/compliance` for a real-time summary (no file, just aggregated counts + `compliancePercent`).

**Step 9: Fill in Automating with Configuration Policies**

Cross-reference: See [Configuration Policies](./CONFIGURATION_POLICIES.md) → Patch Management section. Configuration Policies can define:
- Auto-approval rules (e.g., auto-approve all `critical` patches from `microsoft`)
- Patch schedules (when to install approved patches)
- Reboot policy (never / if_required / always / scheduled)

These are the recommended way to automate patching at scale.

**Step 10: Fill in API Reference**

Full endpoint table:
| Method | Path | Description |
|---|---|---|
| GET | `/patches` | List patches with approval status (`?source=&severity=&os=&orgId=`) |
| GET | `/patches/sources` | List available patch sources (`?os=`) |
| GET | `/patches/:id` | Get full patch details |
| POST | `/patches/scan` | Trigger patch scan on devices |
| GET | `/patches/approvals` | List approval records (`?status=&patchId=&orgId=`) |
| POST | `/patches/:id/approve` | Approve patch |
| POST | `/patches/:id/decline` | Reject patch |
| POST | `/patches/:id/defer` | Defer patch to date |
| POST | `/patches/bulk-approve` | Approve multiple patches |
| GET | `/patches/jobs` | List patch deployment jobs (`?status=`) |
| POST | `/patches/:id/rollback` | Roll back installed patch |
| GET | `/patches/compliance` | Real-time compliance summary |
| GET | `/patches/compliance/report` | Request compliance report generation |
| GET | `/patches/compliance/report/:id` | Check report generation status |
| GET | `/patches/compliance/report/:id/download` | Download completed report |

**Step 11: Fill in Troubleshooting**

- *Scan results not appearing* — Scan is async. Wait a few minutes after the scan job is dispatched. Check that the device was online and returned a `command_result`. If the device was offline, it will run the scan on next connection.
- *Patch approved but not deploying* — Approval doesn't trigger deployment automatically. A patch job must be explicitly created or scheduled via a Configuration Policy.
- *Rollback failed* — The patch's `uninstallCommand` returned a non-zero exit code. Check `errorMessage` on the rollback record for details. Some patches do not support programmatic uninstall.
- *Compliance percentage lower than expected* — Check for devices with `failed` or `missing` status. Also check whether all relevant patches have been approved — unapproved patches are not deployed and show as `pending`.
- *Report stuck in `running`* — Check the BullMQ worker status. The compliance report worker is separate from the main worker. Restart it if needed.

**Step 12: Commit**

```bash
git add docs/PATCH_MANAGEMENT.md
git commit -m "docs: add Patch Management documentation"
```

---

### Task 4: Automations documentation

**Files:**
- Create: `docs/AUTOMATIONS.md`

**Context for writer:**

Automations are rules that run one or more actions when a trigger fires. Four trigger types:
- **schedule** — cron expression + timezone
- **event** — fires on a platform event (alert created, device offline, etc.) with optional filter
- **webhook** — receives an inbound HTTP POST to a generated URL, protected by a secret
- **manual** — only runs when explicitly triggered via the API or UI

Four action types:
- **run_script** — execute a script from the library on target devices
- **send_notification** — send to a notification channel
- **create_alert** — create a Breeze alert record
- **execute_command** — run a shell command on target devices

Automation runs have status: `running`, `completed`, `failed`, `partial`

`onFailure` policy: `stop` (abort remaining actions), `continue` (execute all actions regardless), `notify` (continue + send notification)

The `automationWebhookRoutes` handles inbound webhook triggers at `POST /automations/webhook/:id` — this is the public endpoint external systems call.

**Step 1: Create file skeleton**

```markdown
# Automations

## Overview
## Key Concepts
### Trigger types
### Action types
### Run status and failure policy
## Creating an Automation
## Trigger Configuration
### Schedule trigger
### Event trigger
### Webhook trigger
### Manual trigger
## Action Configuration
### Run Script
### Send Notification
### Create Alert
### Execute Command
## Viewing Runs
## Triggering Manually
## Inbound Webhooks
## API Reference
## Troubleshooting
```

**Step 2: Fill in Overview**

2-3 paragraphs:
- Automations let you define rules that execute automatically when something happens — a device goes offline, an alert fires, a schedule is reached, or an external system calls a webhook. Each automation can run one or more actions: execute a script, send a notification, create an alert, or run a shell command.
- Automations are per-organization and fully audited. Every run is recorded with its trigger, actions, targets, and result.

**Step 3: Fill in Key Concepts**

*Trigger types* — table:
| Type | Fires when |
|---|---|
| `schedule` | A cron expression matches (e.g., every Sunday at 2am) |
| `event` | A platform event occurs (e.g., `alert.created`, `device.offline`) |
| `webhook` | An HTTP POST is received at the automation's webhook URL |
| `manual` | An admin explicitly triggers the run via the UI or API |

*Action types* — table:
| Type | What it does |
|---|---|
| `run_script` | Executes a script from the library on target devices |
| `send_notification` | Sends a message to a notification channel (email, Slack, webhook) |
| `create_alert` | Creates a Breeze alert with a configured severity and message |
| `execute_command` | Runs an arbitrary shell command on target devices |

*Run status* — table:
| Status | Meaning |
|---|---|
| `running` | Actions are currently executing |
| `completed` | All actions finished successfully |
| `failed` | One or more actions failed and `onFailure: stop` was set |
| `partial` | Some actions completed, some failed (`onFailure: continue` was set) |

*onFailure policy* — `stop` aborts remaining actions; `continue` executes all actions regardless; `notify` is like `continue` but also sends a notification when any action fails.

**Step 4: Fill in Creating an Automation**

UI walkthrough:
1. Navigate to **Automations** in the sidebar
2. Click **New Automation**
3. Enter a name and optional description
4. Choose a trigger type and configure it (see next section)
5. Add one or more actions
6. Set the `onFailure` policy
7. Toggle **Enabled** on or off
8. Click **Save**

**Step 5: Fill in Trigger Configuration**

*Schedule:*
```json
{
  "type": "schedule",
  "cronExpression": "0 2 * * 0",
  "timezone": "America/Denver"
}
```
Standard cron format (5 fields). Timezone is required and uses IANA timezone names.

*Event:*
```json
{
  "type": "event",
  "eventType": "alert.created",
  "filter": { "severity": "critical" }
}
```
Common event types: `alert.created`, `alert.resolved`, `device.offline`, `device.enrolled`, `patch.failed`. Filter is optional and matches against the event payload.

*Webhook:*
```json
{
  "type": "webhook",
  "secret": "optional-hmac-secret"
}
```
The automation's webhook URL is generated on creation: `POST /automations/webhook/:id`. External systems call this URL with a POST body. If `secret` is set, the request must include a valid HMAC signature header.

*Manual:* No configuration needed — the automation only runs when explicitly triggered.

**Step 6: Fill in Action Configuration**

For each action type, show the shape:

*run_script:*
```json
{
  "type": "run_script",
  "scriptId": "uuid",
  "parameters": { "param1": "value" },
  "runAs": "system"
}
```
`runAs` options: `system`, `user`, `elevated`

*send_notification:*
```json
{
  "type": "send_notification",
  "notificationChannelId": "uuid",
  "title": "Automation fired",
  "message": "Device {{device.hostname}} triggered the automation",
  "severity": "high"
}
```

*create_alert:*
```json
{
  "type": "create_alert",
  "alertSeverity": "critical",
  "alertTitle": "Disk space critical",
  "alertMessage": "Device {{device.hostname}} has less than 5GB free"
}
```

*execute_command:*
```json
{
  "type": "execute_command",
  "command": "systemctl restart nginx",
  "shell": "bash"
}
```
`shell` options: `bash`, `powershell`, `cmd`

**Step 7: Fill in Viewing Runs**

- `GET /automations/:id/runs` — list all runs for an automation, newest first
- `GET /automations/runs/:runId` — full run detail including per-action logs
- Runs include: `status`, `trigger`, `startedAt`, `completedAt`, `logs` (action-level output)

**Step 8: Fill in Triggering Manually**

```bash
POST /automations/:id/trigger
```
Creates a run immediately with `trigger.type: "manual"`. Returns the run ID. The run executes asynchronously — poll `GET /automations/runs/:runId` for status.

**Step 9: Fill in Inbound Webhooks**

External systems can trigger an automation by POSTing to its webhook URL:

```
POST /automations/webhook/:automationId
Content-Type: application/json
X-Breeze-Signature: sha256=<hmac>  # if secret is configured

{ "any": "payload" }
```

The payload is passed to the automation's actions as the event context. To get the webhook URL, check the automation's detail page or call `GET /automations/:id`.

If a secret is configured, compute the HMAC-SHA256 of the raw request body using the secret, then send it as the `X-Breeze-Signature` header.

**Step 10: Fill in API Reference**

| Method | Path | Description |
|---|---|---|
| GET | `/automations` | List automations (`?enabled=true/false&orgId=`) |
| POST | `/automations` | Create automation |
| GET | `/automations/:id` | Get automation |
| GET | `/automations/:id/runs` | List runs for automation |
| GET | `/automations/runs/:runId` | Get run detail |
| PUT | `/automations/:id` | Replace automation |
| PATCH | `/automations/:id` | Partial update |
| POST | `/automations/:id/trigger` | Manually trigger a run |
| POST | `/automations/:id/enable` | Enable automation |
| POST | `/automations/webhook/:id` | (Public) Inbound webhook trigger |

**Step 11: Fill in Troubleshooting**

- *Schedule automation not firing* — Verify the cron expression is valid and the timezone is a valid IANA name. Verify the automation is enabled. The scheduler runs on the API server — check server logs if the job is missing.
- *Event automation not firing* — Verify the `eventType` matches exactly (case-sensitive). Check whether the event filter is too restrictive. Use `POST /:id/trigger` to confirm the actions work before waiting for the event.
- *Webhook not being received* — Ensure the external system is sending to the correct URL (`/automations/webhook/:id`). If a secret is configured, verify the HMAC signature header is present and correctly computed.
- *Run status `partial`* — Some actions succeeded and some failed. Check the run logs (`GET /automations/runs/:runId`) for per-action error output. The `onFailure: continue` policy was active.
- *Script action failing* — The script must exist in the library and be accessible to the automation's organization. Check that the `scriptId` is valid and the target devices are online.

**Step 12: Commit**

```bash
git add docs/AUTOMATIONS.md
git commit -m "docs: add Automations documentation"
```

---

## Execution options

**Plan complete and saved to `docs/plans/2026-02-18-feature-documentation-batch2.md`.**

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** — Open a new session pointing at the plan file, runs with checkpoints.

Which approach?
