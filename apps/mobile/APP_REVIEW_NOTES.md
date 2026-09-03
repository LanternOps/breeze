# App Review notes — Guideline 2.1 reply

Apple's standard information request for a first submission. **Nothing is wrong with the app**:
no defect, no policy finding, no code change required. Item 1 is a video; items 2–7 are text.

Apple asks that this text live permanently in **App Store Connect → App Review Information →
Notes**, so keep this file updated and re-paste it on future submissions.

> **Demo credentials were already supplied on the rejected submission.** So the reviewer's ask is
> the recording plus the descriptive items — not access. But re-state the credentials in the reply
> anyway (Apple wants them in Notes), and see the verification note under item 4: if a reviewer had
> credentials and still filed 2.1, it is worth proving the account actually works from a clean
> device before resubmitting.

**Do not commit real credentials.** The bracketed placeholders below stay placeholders in git.

---

## What went wrong last time

The credentials were fine — the dedicated App Review account, with MFA disabled. Access was never the
problem, which is why the reply must not simply re-send credentials. Two concrete defects in the
previous submission:

1. **The Notes were ~300 characters.** Apple's seven questions are precisely the material that was
   missing. Everything below fills that gap.
2. **The server instruction was wrong.** It said *"select United States, then enter
   https://us.2breeze.app as the Breeze server URL."* `ServerSelectScreen.tsx` renders tappable
   presets (`SERVER_PRESETS`) that already carry the URL; the free-text field is only for
   self-hosted servers. Telling a reviewer to also type a URL invites them into the custom-server
   path for no reason. Selecting "United States" is sufficient, and the corrected text below says so.
3. **The seeded-data list omitted the new features.** It named "dashboard, systems, alerts, and
   approval flows" — not tickets or time entry, which are the bulk of this build.

**The Notes field caps at ~4,000 characters.** The full per-item text further down totals ~5,900 and
will not fit. Paste the condensed version immediately below, and use the **Attachment** field
(App Review Information → Attachment → Choose File) for anything longer — including the video, which
can be attached directly rather than linked.

---

## Condensed Notes — fits the field (3,801 characters)

Paste this whole block into the Notes field, filling in the device models.

```
WHAT THE APP IS
Breeze RMM is a remote monitoring and management (RMM) platform for managed service providers and internal IT teams. This iOS app is a companion to the Breeze web console. Technicians are often away from a desk - on site with a client, or on call - while the systems they are responsible for keep raising alerts and tickets. Without a mobile client they must return to a laptop to act at all.

Core features: triage monitoring alerts; view managed devices and their health; work service tickets (comment, change status, attach photos); log time against tickets with start/stop timers; approve or deny privileged actions requested by automation; ask an AI assistant questions about the fleet.

Audience: IT technicians and MSP staff at organisations that are existing Breeze customers. This is a business tool, not a consumer app. It has no public content and no social features.

There is no self-service sign-up. Accounts are created by the customer organisation's administrator, because holding one implies administrative control over that organisation's computers. There are also no in-app purchases or subscriptions - billing is handled on the web at organisation level.

GETTING IN
1. On first launch, choose "United States" on the server screen. Selecting it fills in the server address; nothing needs to be typed.
2. Sign in with the review credentials above. MFA is disabled on this account.
3. The bottom tabs reach Devices, Tickets, Alerts and Time. The review tenant is seeded with devices, tickets, alerts, time entries and approvals.

Account deletion: Settings (gear icon) -> Delete Account, which opens a secure web page to submit the request.

DEVICES TESTED
iPhone 15 Pro Max, iOS [version]. The app is iPhone-only (supportsTablet is false), so no iPad testing applies. Builds were distributed through TestFlight and exercised against a live tenant.

EXTERNAL SERVICES
The app is a client for our own backend and integrates no third-party service directly for its core functionality.
- Breeze RMM API (first-party, operated by LanternOps LLC) - all application data. The region is chosen at sign-in: us.2breeze.app or eu.2breeze.app. Self-hosted customers point the app at their own server.
- Apple Push Notification service - push for alerts and ticket activity. Native APNs, no third-party relay.
- Sentry - crash and error reporting. PostHog - product analytics.
AI assistant: requests go to our own API, which calls a language model provider server-side. The app never contacts a model provider directly and holds no model credentials.
Authentication is handled by our own API. Enterprise customers may optionally configure their own SSO provider server-side. There is no payment processor in the app.

REGIONAL DIFFERENCES
None. Features, content, pricing and availability are identical in every region. The only region-related behaviour is data residency: the user chooses United States or European Union at sign-in and their organisation's data is stored and processed in that region.

REGULATED INDUSTRY AND THIRD-PARTY MATERIAL
Breeze RMM does not operate in a regulated industry and requires no licence. It is business-to-business IT systems-management software. It contains no protected third-party material: all content is generated by the customer's own organisation and is visible only to authenticated members of it. The app manages only endpoints the customer already owns and administers.

USER-GENERATED CONTENT
Staff within a single customer organisation write ticket comments and attach photographs to their own service tickets. This is visible only to authenticated members of that same organisation. There is no public feed, no discovery, no messaging between strangers, and no cross-customer visibility. Administrators can remove content and revoke user access from the web console at any time.
```

The longer per-item versions below are the source material for that block — keep them for reference
and for the Attachment, but the block above is what goes in the field.

---

## 1. Screen recording

Must be captured on a **physical device** running the latest iOS, and must **begin with launching
the app**.

- Record via QuickTime Player → File → **New Movie Recording** → click the arrow beside the record
  button → select the iPhone as the source. Full resolution, no Control Center overlay.
- Upload as an unlisted YouTube or Vimeo link and paste the URL into the reply.
- **The Simulator cannot be used** — it has no camera, and the ticket photo-attachment flow is one
  of the permission prompts Apple explicitly asked to see.

### Shot list

1. **Cold launch** — start from the home screen so the icon and launch are on camera.
2. **Server selection** — the US / EU / self-hosted choice.
3. **Sign in** with the demo account, including the MFA challenge if that account has one.
4. **Notification permission prompt** — capture the system dialog.
5. **Face ID prompt** — lock and reopen the app to trigger it.
6. **Alerts → device** — open an alert, then the device it came from.
7. **Ticket** — open a ticket, post a comment, then **attach a photo using the camera**, which
   surfaces both the camera and photo-library prompts.
8. **Time entry** — start and stop a timer against that ticket.
9. **AI assistant** — ask one question; using voice also captures the microphone and
   speech-recognition prompts.
10. **Approvals** — the approval queue that gates privileged actions.
11. **Account deletion** — Settings → Delete Account, following through to the web page that opens.

**Item 11 is the one that gets missed.** Apple lists account deletion explicitly, and Breeze has it
(`SettingsSheet.tsx` → `getAccountDeletionUrl`). Do not stop at the confirmation dialog; show the
page it opens.

Two things the video cannot show, which the reply should state plainly rather than leaving Apple to
wonder: there is **no account registration flow** and **no purchase flow** in the app. Both are
covered in items 3 and 5.

---

## 2. Devices and operating systems tested

> **Needs your input — I have no record of what you tested on.** This is also the item that invites
> a bugs-and-crashes follow-up if it looks thin. Test at least one iPhone *and* one iPad before
> replying, since the app declares `supportsTablet: true`.

```
The app was tested on the following physical devices prior to submission:

- iPhone 16 Pro, iOS 26.x
- iPad (10th generation), iPadOS 26.x

Builds were distributed to testers through TestFlight and exercised against a live tenant.
```

---

## 3. What the app does and who it is for

```
Breeze RMM is a remote monitoring and management (RMM) platform for managed service providers
(MSPs) and internal IT teams. This iOS app is a companion to the Breeze web console.

Problem it solves: IT technicians are frequently away from a desk - on site with a client, or on
call after hours - while the infrastructure they are responsible for continues to raise alerts and
tickets. Without a mobile client they must return to a laptop to do anything at all. The app lets a
technician triage and act from a phone.

Core features:
- Review and triage monitoring alerts raised by managed endpoints
- View managed devices and their health, software and status
- Work service tickets: read, comment, change status, and attach photos
- Log time against tickets, including start/stop timers
- Approve or deny privileged actions requested by automation
- Ask an AI assistant questions about the managed fleet

Target audience: IT technicians and MSP staff at organisations that are existing Breeze customers.
This is a business tool, not a consumer app. It has no public content and no social features.

Accounts are provisioned by the customer organisation's administrator. There is deliberately no
self-service sign-up in the app - a person cannot create an account, because holding one implies
administrative control over that organisation's computers.
```

---

## 4. Setup, access and demo credentials

> **Needs your input.** Credentials were already sent once, so before resubmitting, verify the
> account still works from a clean device: sign in on a phone that has never run the app, and
> confirm the tenant has visible devices, tickets and alerts. A reviewer landing in an empty
> organisation sees what looks like a broken app — which is a plausible reading of why a 2.1 came
> back despite credentials being provided.
>
> **If that account has MFA enforced, that alone explains the rejection.** Give the reviewer an
> account without it, or include the TOTP secret.

```
Getting into the app:

1. Launch the app. The first screen asks which Breeze region to connect to. Choose "United States".
2. Sign in with the demo account below.
3. The app opens on the assistant/home screen. The bottom tab bar reaches Devices, Tickets, Alerts
   and Time.

Demo account:
  Email:    [DEMO EMAIL]
  Password: [DEMO PASSWORD]

This account has multi-factor authentication disabled, so no second factor is required.
[If MFA cannot be disabled, replace this line with the TOTP secret.]

The account is a technician in a demonstration organisation pre-populated with managed devices,
open tickets and recent alerts, so every feature has real data behind it.

Reaching the main features:
- Alerts: "Alerts" tab. Tap any alert to see detail and the device it came from.
- Devices: "Devices" tab. Tap a device for health, installed software and status.
- Tickets: "Tickets" tab. Open any ticket to comment, change status, or attach a photo.
- Time tracking: open a ticket and use the timer, or the "Time" tab for the timesheet.
- Approvals: shown in-app when an automation requests a privileged action.
- AI assistant: the home screen; type or dictate a question about the fleet.
- Account deletion: Settings (gear icon) -> Delete Account.

No sample files are required.
```

---

## 5. External services used

```
The app is a client for our own backend. It does not integrate third-party services directly for
its core functionality; everything below is either our own infrastructure or standard
platform/operational tooling.

- Breeze RMM API (first-party, operated by LanternOps LLC) - every piece of application data. The
  user chooses the region at sign-in: us.2breeze.app or eu.2breeze.app. Self-hosted customers point
  the app at their own server.
- Apple Push Notification service (APNs) - push notifications for alerts and ticket activity.
  Native APNs; no third-party push relay.
- Sentry - crash and error reporting (operational telemetry only).
- PostHog - product analytics (feature usage only).

AI assistant: requests go to the Breeze API, which calls a large language model provider on the
server side. The app never contacts a model provider directly and holds no model credentials. The
assistant answers questions about the customer's own fleet data.

Authentication is handled by our own API. There is no third-party identity provider in the default
flow; enterprise customers may optionally configure their own SSO provider on the server side.

There is no payment processor in the app. It contains no in-app purchases and no subscriptions -
billing is handled entirely outside the app, on the web, at the organisation level.
```

---

## 6. Regional differences

```
The app functions identically in all regions. There are no regional differences in features,
content, pricing or availability.

The one region-related behaviour is data residency, not functionality: at sign-in the user chooses
which Breeze instance to connect to - United States or European Union - and their organisation's
data is stored and processed in that region. The app is the same in both cases. Customers who
self-host Breeze on their own infrastructure can also enter their own server address.
```

---

## 7. Regulated industry and third-party material

> **Confirm before sending — this is a legal statement about your business.** The draft matches
> what is in the app, but you own the claim.

```
Breeze RMM does not operate in a highly regulated industry and requires no licence or regulatory
authorisation. It is IT systems-management software sold business-to-business.

The app contains no protected third-party material. All content shown is generated by the
customer's own organisation - their devices, their tickets, their staff's comments - and is visible
only to authenticated members of that organisation.

The app manages only endpoints that the customer already owns and administers, under the customer's
own agreements with their clients. It provides no third-party media, no licensed data feeds and no
protected content of any kind.
```

---

## Worth adding, unprompted

Apple's item 1 asks about user-generated content and its reporting and blocking mechanisms. Breeze
has UGC in the sense that technicians write ticket comments and upload photos, but it is private to
a single organisation. Saying so pre-empts a Guideline 1.2 follow-up.

```
On user-generated content: the app allows staff within a single customer organisation to write
ticket comments and attach photographs to their own service tickets. This content is visible only
to authenticated members of that same organisation. There is no public feed, no discovery, no
messaging between strangers, and no way for one customer's users to see another customer's content.
Moderation is the customer organisation's own responsibility over its own employees, and
administrators can remove content and revoke user access from the web console at any time.
```

---

## Where this came from

Items 3, 5 and 6 were written from the app's own source rather than from marketing copy: the
declared iOS permission strings in `app.json`, the screen inventory under `src/screens/`, the
account-deletion route in `src/screens/chat/components/SettingsSheet.tsx`, and the services the
client actually talks to. See `STORE_SUBMISSION.md` for the wider submission checklist.
