# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.127.0** (2026-11-08).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)


## Self-Hosting / Upgrade Notes (fold into the release body)


## Features / API


### Portal: invite from contacts (W1)

- The organization **Contacts** tab now has a **Portal** column, a **Give portal access** / **Resend invite** row action, bulk selection ("Give portal access (N)"), and a "Give portal access" checkbox on the create form (partner users only).
- `POST /orgs/organizations/:id/portal-users/invite` accepts an optional `contactId` and binds the login to that contact. The invite email must match the contact's email (`PORTAL_INVITE_EMAIL_MISMATCH`), and a login bound to a different contact is never re-pointed (`PORTAL_INVITE_CONTACT_CONFLICT`).
- New `POST /orgs/organizations/:id/portal-users/invite-contacts` invites up to 100 contacts and returns one outcome per contact (`invited`, `already_has_access`, `no_email`, `email_bound_to_other_contact`, `duplicate_email_in_batch`). A contact outside the organization fails the whole batch with 404 and sends nothing.
- No migration required.

## Migrations

