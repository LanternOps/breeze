import type { CDPSession, Page } from '@playwright/test';

/**
 * Chrome virtual-authenticator helpers for specs that must clear the L3
 * approval gate in a real browser.
 *
 * The approvals inbox NEVER submits an approve without a WebAuthn assertion
 * (`apps/web/src/lib/intentApprovals.ts` — "we do NOT submit without a proof:
 * the self-approve gate requires L3"), so any spec that clicks Approve in the
 * UI needs a registered approver device and an authenticator that can sign for
 * it. Extracted from `tests/intent-self-approve.spec.ts`, which proved the
 * recipe end to end and remains the spec that tests the gate ITSELF; callers
 * here just need the ceremony to succeed so they can test something else.
 */

export type VirtualAuthenticator = { cdp: CDPSession; authenticatorId: string };

/** Must be installed BEFORE the page makes any navigator.credentials call. */
export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal', // platform authenticator (Touch ID / Hello)
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true, // auto-satisfy UV so no human touch is needed
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

export async function removeVirtualAuthenticator(auth: VirtualAuthenticator): Promise<void> {
  await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth.authenticatorId });
}

/**
 * The credentials the virtual authenticator currently holds.
 *
 * A virtual authenticator belongs to ONE browser context, so a key enrolled in
 * one context cannot sign in another — the same as a real laptop's platform
 * key. Exporting and re-importing is what lets a spec enrol in one session and
 * assert in the next without pretending the key travelled by magic.
 */
export async function exportCredentials(auth: VirtualAuthenticator): Promise<unknown[]> {
  const { credentials } = await auth.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: auth.authenticatorId,
  });
  return credentials as unknown[];
}

export async function importCredentials(auth: VirtualAuthenticator, credentials: unknown[]): Promise<void> {
  for (const credential of credentials) {
    await auth.cdp.send('WebAuthn.addCredential', {
      authenticatorId: auth.authenticatorId,
      credential: credential as never,
    });
  }
}

export type RegistrationOutcome = { ok: boolean; stage: string; status: number; body: string };

/**
 * Registers an approver device for the logged-in user, in the page, against
 * whatever authenticator is installed.
 *
 * Runs inside `page.evaluate` because the ceremony must happen in the browser:
 * `navigator.credentials.create` is what the virtual authenticator answers.
 * The access token is minted the same way the app does (access tokens live in
 * memory only; the refresh cookie restores them), so these calls carry a real
 * Bearer header.
 */
export async function registerApproverDevice(page: Page, password: string, label: string): Promise<RegistrationOutcome> {
  return page.evaluate(
    async ({ adminPassword, deviceLabel }) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('breeze_csrf_token='))
        ?.split('=')[1];
      const refreshRes = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-breeze-csrf': decodeURIComponent(csrf) } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!refreshRes.ok) {
        return { ok: false, stage: 'refresh', status: refreshRes.status, body: await refreshRes.text() };
      }
      const { tokens } = await refreshRes.json();
      const accessToken: string = tokens?.accessToken;
      if (!accessToken) return { ok: false, stage: 'refresh', status: 200, body: 'no accessToken in refresh body' };

      const api = (path: string, body?: unknown) =>
        fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          credentials: 'include',
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      // #2707: approver-device registration is GRANT-gated, not
      // password-per-call. Without a `registerGrantId` the options route
      // answers 403 `register_step_up_required`, whatever else the body says.
      const grantRes = await api('/authenticator/register-grant', { currentPassword: adminPassword });
      if (!grantRes.ok) return { ok: false, stage: 'register-grant', status: grantRes.status, body: await grantRes.text() };
      const { registerGrantId } = await grantRes.json();
      if (!registerGrantId) return { ok: false, stage: 'register-grant', status: 200, body: 'no registerGrantId in body' };

      const optRes = await api('/authenticator/devices/webauthn/options', {
        currentPassword: adminPassword,
        registerGrantId,
      });
      if (!optRes.ok) return { ok: false, stage: 'options', status: optRes.status, body: await optRes.text() };
      const optJson = await optRes.json();
      const options = optJson.options ?? optJson.optionsJSON ?? optJson;

      const b64uToBuf = (s: string) => {
        const pad = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      };
      const bufToB64u = (b: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

      const cred = (await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64uToBuf(options.challenge),
          user: { ...options.user, id: b64uToBuf(options.user.id) },
          excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string }) => ({
            ...c,
            id: b64uToBuf(c.id),
          })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) return { ok: false, stage: 'create', status: 0, body: 'null credential' };

      const att = cred.response as AuthenticatorAttestationResponse;
      const verifyRes = await api('/authenticator/devices/webauthn/verify', {
        label: deviceLabel,
        registerGrantId,
        response: {
          id: cred.id,
          rawId: bufToB64u(cred.rawId),
          type: cred.type,
          clientExtensionResults: cred.getClientExtensionResults(),
          response: {
            clientDataJSON: bufToB64u(att.clientDataJSON),
            attestationObject: bufToB64u(att.attestationObject),
          },
        },
      });
      return { ok: verifyRes.ok, stage: 'verify', status: verifyRes.status, body: await verifyRes.text() };
    },
    { adminPassword: password, deviceLabel: label },
  );
}
