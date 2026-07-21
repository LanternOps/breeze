# M365 Mailbox — Plan 4: Settings Web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give partner admins a settings card to connect/disconnect an M365 support mailbox: enter the address, launch admin consent, see status, copy the `New-ApplicationAccessPolicy` PowerShell snippet, re-test after scoping, and disconnect.

**Architecture:** A single React island `M365MailboxCard.tsx` rendered next to `InboundEmailCard` on the ticketing settings surface. All mutations go through `runAction` (per the Web Mutation Handlers rule). The Connect button POSTs to `/tickets/mailbox/connect` and redirects the browser to the returned `authUrl`; the callback redirects back with a `?ticketMailbox=...` status the card reads on mount.

**Tech Stack:** Astro + React islands, `runAction`, `fetchWithAuth`, Vitest + jsdom.

## Global Constraints

- Depends on **Plan 1** routes: `GET /tickets/mailbox/connections`, `POST /tickets/mailbox/connect`, `POST /tickets/mailbox/connections/:id/retest`, `DELETE /tickets/mailbox/connections/:id`.
- Every POST/DELETE wraps in `runAction` (`apps/web/src/lib/runAction.ts`); catch pattern: 401 → let auth redirect; non-401 `ActionError` already toasted by `runAction`; other errors → `showToast`.
- The component path must be added to `no-silent-mutations.test.ts` `TARGET_GLOBS` AND the hardcoded count bumped in the same change.
- Web has NO client-side permission store — render for everyone; the API enforces admin+MFA. (Don't gate buttons on a missing permission store.)
- No internal infra details; the PowerShell snippet uses the Breeze Ticketing app id from a public config value (`PUBLIC_TICKET_MAILBOX_APP_ID`) or is fetched from the connections endpoint — never hardcode a tenant/secret.

## File Structure

- Create `apps/web/src/components/settings/M365MailboxCard.tsx` — the card island.
- Modify the ticketing-settings page/host that renders `InboundEmailCard` (grep `InboundEmailCard`) — mount `M365MailboxCard` beside it.
- Modify `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — add the glob + bump the count.
- Test: `apps/web/src/components/settings/M365MailboxCard.test.tsx`.

## Interface Contract (server shapes consumed)

```typescript
// GET /tickets/mailbox/connections → { connections: MailboxConnectionDTO[] }
interface MailboxConnectionDTO {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  tenantId: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
}
// POST /tickets/mailbox/connect { mailboxAddress, displayName? } → { authUrl, connectionId }
// POST /tickets/mailbox/connections/:id/retest → { ok, error? }
// DELETE /tickets/mailbox/connections/:id → { ok: true }
```

---

### Task 1: The `M365MailboxCard` component

**Files:**
- Create: `apps/web/src/components/settings/M365MailboxCard.tsx`
- Test: `apps/web/src/components/settings/M365MailboxCard.test.tsx`

**Interfaces:**
- Consumes: `runAction`, `fetchWithAuth`, `showToast` (match the imports used by `apps/web/src/components/integrations/QuickbooksIntegration.tsx`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/settings/M365MailboxCard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../lib/fetchWithAuth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
// runAction passthrough that still surfaces thrown errors like the real one.
vi.mock('../../lib/runAction', () => ({
  runAction: async (fn: any) => fn(),
  ActionError: class ActionError extends Error { status = 500; },
}));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { M365MailboxCard } from './M365MailboxCard';

function jsonRes(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('M365MailboxCard', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it('lists existing connections on mount', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [
      { id: 'c1', mailboxAddress: 'support@a.com', displayName: 'Support', status: 'connected', tenantId: 't', lastPolledAt: null, lastError: null },
    ]}));
    render(<M365MailboxCard />);
    expect(await screen.findByText('support@a.com')).toBeTruthy();
    expect(screen.getByText(/connected/i)).toBeTruthy();
  });

  it('Connect posts the address and redirects the browser to authUrl', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ connections: [] }))                                   // initial list
      .mockResolvedValueOnce(jsonRes({ authUrl: 'https://login.microsoftonline.com/x', connectionId: 'c2' })); // connect
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign, href: '', hash: '' }, writable: true });

    render(<M365MailboxCard />);
    fireEvent.change(await screen.findByLabelText(/mailbox address/i), { target: { value: 'support@a.com' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining('/tickets/mailbox/connect'),
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/x'));
  });

  it('Re-test calls the retest endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ connections: [
        { id: 'c1', mailboxAddress: 'support@a.com', displayName: null, status: 'error', tenantId: 't', lastPolledAt: null, lastError: 'Graph returned 403' },
      ]}))
      .mockResolvedValueOnce(jsonRes({ ok: true }))      // retest
      .mockResolvedValueOnce(jsonRes({ connections: [] })); // refresh
    render(<M365MailboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: /re-test/i }));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining('/tickets/mailbox/connections/c1/retest'),
      expect.objectContaining({ method: 'POST' }),
    ));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/M365MailboxCard.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the component**

```tsx
// apps/web/src/components/settings/M365MailboxCard.tsx
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../lib/fetchWithAuth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../../lib/toast';

interface MailboxConnectionDTO {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';
  tenantId: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
}

const STATUS_LABEL: Record<MailboxConnectionDTO['status'], string> = {
  pending_consent: 'Pending consent',
  connected: 'Connected',
  error: 'Needs attention',
  reauth_required: 'Re-auth required',
  disabled: 'Disabled',
};

const APP_ID = (import.meta as unknown as { env?: Record<string, string> }).env?.PUBLIC_TICKET_MAILBOX_APP_ID ?? '<Breeze Ticketing app id>';

function powershellSnippet(mailbox: string): string {
  return [
    '# Run in Exchange Online PowerShell (Connect-ExchangeOnline) as a tenant admin:',
    `New-DistributionGroup -Name "Breeze Ticketing Mailboxes" -Type Security -Members "${mailbox}"`,
    `New-ApplicationAccessPolicy -AppId ${APP_ID} \\`,
    '  -PolicyScopeGroupId "Breeze Ticketing Mailboxes" -AccessRight RestrictAccess \\',
    '  -Description "Restrict Breeze Ticketing to the support mailbox"',
  ].join('\n');
}

export function M365MailboxCard() {
  const [connections, setConnections] = useState<MailboxConnectionDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/tickets/mailbox/connections');
      if (res.ok) {
        const body = await res.json();
        setConnections(body.connections ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleConnect() {
    if (!address.trim()) return;
    setBusy(true);
    try {
      const body = await runAction(async () => {
        const res = await fetchWithAuth('/tickets/mailbox/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mailboxAddress: address.trim(), displayName: displayName.trim() || undefined }),
        });
        return res;
      });
      const json = await body.json();
      if (json.authUrl) window.location.assign(json.authUrl);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Could not start M365 consent' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRetest(id: string) {
    try {
      await runAction(() => fetchWithAuth(`/tickets/mailbox/connections/${id}/retest`, { method: 'POST' }));
      await refresh();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Re-test failed' });
    }
  }

  async function handleDisconnect(id: string) {
    try {
      await runAction(() => fetchWithAuth(`/tickets/mailbox/connections/${id}`, { method: 'DELETE' }));
      await refresh();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Disconnect failed' });
    }
  }

  return (
    <section data-testid="m365-mailbox-card" className="rounded-lg border border-gray-200 p-4">
      <h3 className="text-base font-semibold">Microsoft 365 support mailbox</h3>
      <p className="mt-1 text-sm text-gray-500">
        Connect your shared support mailbox so customer email becomes tickets and replies are sent from it. No MX or forwarding changes required.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-gray-400">Loading…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {connections.filter((c) => c.status !== 'disabled').map((c) => (
            <li key={c.id} data-testid="m365-connection" className="flex flex-col gap-2 rounded border border-gray-100 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{c.mailboxAddress}</span>
                  {c.displayName ? <span className="ml-2 text-sm text-gray-400">{c.displayName}</span> : null}
                </div>
                <span className="text-sm">{STATUS_LABEL[c.status]}</span>
              </div>
              {c.lastError ? <p className="text-xs text-red-600">{c.lastError}</p> : null}
              {(c.status === 'error' || c.status === 'reauth_required' || c.status === 'pending_consent') ? (
                <details className="text-xs">
                  <summary className="cursor-pointer">Scope this mailbox (Application Access Policy)</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-gray-50 p-2">{powershellSnippet(c.mailboxAddress)}</pre>
                </details>
              ) : null}
              <div className="flex gap-2">
                <button type="button" className="text-sm text-blue-600" onClick={() => handleRetest(c.id)}>Re-test</button>
                <button type="button" className="text-sm text-red-600" onClick={() => handleDisconnect(c.id)}>Disconnect</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-col gap-2 border-t border-gray-100 pt-4">
        <label className="text-sm" htmlFor="m365-address">Mailbox address</label>
        <input id="m365-address" className="rounded border border-gray-300 p-2 text-sm" placeholder="support@yourmsp.com"
          value={address} onChange={(e) => setAddress(e.target.value)} />
        <label className="text-sm" htmlFor="m365-name">Display name (optional)</label>
        <input id="m365-name" className="rounded border border-gray-300 p-2 text-sm" placeholder="Support"
          value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <button type="button" disabled={busy || !address.trim()} onClick={handleConnect}
          className="mt-1 self-start rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">
          Connect
        </button>
      </div>
    </section>
  );
}
```

> Match the real import paths and `showToast` signature to `QuickbooksIntegration.tsx` exactly (it may be `showToast(message, type)` positional vs object). Use the repo's existing Card/Button primitives if the integrations page uses them, rather than raw Tailwind, to stay visually consistent. `fetchWithAuth` base path: confirm whether it prefixes `/api/v1` automatically (QuickBooks card shows the convention).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/settings/M365MailboxCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/M365MailboxCard.tsx apps/web/src/components/settings/M365MailboxCard.test.tsx
git commit -m "feat(web): M365 mailbox connection settings card"
```

---

### Task 2: Mount the card + enroll in no-silent-mutations

**Files:**
- Modify: the ticketing-settings host that renders `InboundEmailCard` (grep `InboundEmailCard`).
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:**
- Consumes: `M365MailboxCard` (Task 1).

- [ ] **Step 1: Mount the card**

Run `grep -rn "InboundEmailCard" apps/web/src` to find where it's rendered (a settings page/tab). Import and render `M365MailboxCard` directly beside it:

```tsx
import { M365MailboxCard } from './M365MailboxCard'; // adjust relative path
// ...
<InboundEmailCard />
<M365MailboxCard />
```

If `InboundEmailCard` is rendered inside an Astro page via a client island, add `M365MailboxCard` the same way (`client:load`/`client:visible`) as a sibling, mirroring how `InboundEmailCard` is hydrated.

- [ ] **Step 2: Enroll in `no-silent-mutations`**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS`:

```typescript
  'src/components/settings/M365MailboxCard.tsx',
```

Then bump the hardcoded expected count assertion (search the file for the numeric `TARGET_GLOBS.length` / count expectation and increase it by 1).

- [ ] **Step 3: Run the guard test**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (all mutations in `M365MailboxCard` are `runAction`-wrapped; count matches).

- [ ] **Step 4: Typecheck/build + commit**

Run:
```bash
cd apps/web && npx astro check
```
Expected: no new errors in the touched files.

```bash
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts <settings-host-file>
git commit -m "feat(web): mount M365 mailbox card + enroll in no-silent-mutations"
```

---

### Task 3: Status banner on redirect-back (optional polish)

**Files:**
- Modify: `apps/web/src/components/settings/M365MailboxCard.tsx`

**Interfaces:**
- Consumes: the `?ticketMailbox=connected|needs_policy|error` query the callback redirects with (Plan 1).

- [ ] **Step 1: Read the redirect status on mount and toast once**

Add to `M365MailboxCard`, inside the mount effect (after `refresh()`):

```typescript
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('ticketMailbox');
    if (!status) return;
    if (status === 'connected') showToast({ type: 'success', message: 'Mailbox connected' });
    else if (status === 'needs_policy') showToast({ type: 'warning', message: 'Consent granted — scope the mailbox with the Application Access Policy, then Re-test' });
    else if (status === 'error') showToast({ type: 'error', message: 'M365 connection failed' });
    // Clean the query so a refresh doesn't re-toast.
    params.delete('ticketMailbox');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }, []);
```

> Adjust the `showToast` call signature to the repo's (object vs positional). This is non-mutating UI, so no `runAction` needed.

- [ ] **Step 2: Run the component tests again**

Run: `cd apps/web && npx vitest run src/components/settings/M365MailboxCard.test.tsx`
Expected: PASS (existing tests still green; jsdom `window.location.search` defaults to empty so the banner effect no-ops).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/M365MailboxCard.tsx
git commit -m "feat(web): surface M365 consent redirect status as a toast"
```

---

## Self-Review (Plan 4)

- **Spec coverage:** connect (address → admin consent redirect), status display, PowerShell `New-ApplicationAccessPolicy` guidance, re-test, disconnect, redirect-back status (Tasks 1–3). ✅
- **runAction discipline:** every POST/DELETE wrapped; catch pattern follows the CLAUDE.md template; enrolled in `no-silent-mutations` with count bump. ✅
- **No permission-store gating:** buttons render for all; API enforces admin+MFA. ✅
- **No infra leakage:** app id from `PUBLIC_TICKET_MAILBOX_APP_ID`, no tenant/secret in the snippet. ✅
- **Implementer verifications flagged inline:** exact `showToast`/`fetchWithAuth` signatures + base path, the `InboundEmailCard` host file, the existing repo Card/Button primitives, and the `no-silent-mutations` count location.

---

## Cross-Plan Wrap-Up

Suggested PR sequence (stacked, mirroring Phase 4): **Plan 1 → Plan 2 → Plan 3 → Plan 4**, each off the prior. Plan 1 ships the table + consent (verifiable in isolation: connect a mailbox, see `connected`). Plan 2 ships inbound (mail becomes tickets). Plan 3 ships outbound (replies from the mailbox). Plan 4 ships the UI. Each plan's RLS/test gates must be green before stacking the next.

**Env to add across deploys** (`/opt/breeze/.env` + the `api` service `environment:` block): `TICKET_MAILBOX_M365_CLIENT_ID`, `TICKET_MAILBOX_M365_CLIENT_SECRET`, and `PUBLIC_TICKET_MAILBOX_APP_ID` (web). The Azure "Breeze Ticketing" app needs `Mail.ReadWrite` + `Mail.Send` (application) and the callback `…/api/v1/tickets/mailbox/callback` registered as a redirect URI.
