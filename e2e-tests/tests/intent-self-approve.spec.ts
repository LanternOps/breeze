import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import type { CDPSession, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

/** Seeds one sole-operator, intent-backed Tier-3 approval; returns its id. */
function seedSoleOperatorApproval(): string {
  const sqlPath = path.resolve(__dirname, '..', 'seed-sole-operator-intent.sql');
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(sqlPath, 'utf8') },
  );
  const id = /APPROVAL_ID=([0-9a-f-]{36})/.exec(out)?.[1];
  if (!id) throw new Error(`seed did not report an APPROVAL_ID:\n${out}`);
  return id;
}

/**
 * Inline sole-operator self-approve — the one link nothing else verifies.
 *
 * Unit and integration tests already cover the fan-out (who gets an approval
 * row), the tier tables, and the React card's rendering. What none of them can
 * cover is the assumption the whole feature rests on: that a REAL browser
 * WebAuthn ceremony produces an assertion the server accepts as assurance
 * level 3, clearing the sole-operator self-approve gate in routes/approvals.ts.
 * Everything below exists to prove exactly that, against a real API and a real
 * Postgres, using Chrome's virtual authenticator via CDP.
 *
 * Deliberately NOT driven through a live AI chat turn: that would need an LLM
 * key and an online agent, and would race the 5-minute chat expiry. The DB
 * fixture (seed-sole-operator-intent.sql) reproduces the exact state the
 * sole-operator branch produces, which intentFanout.integration.test.ts already
 * proves is the state that branch produces.
 */

async function addVirtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',        // platform authenticator (Touch ID / Hello)
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,         // auto-satisfy UV so no human touch is needed
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('inline sole-operator self-approve', () => {
  test('a browser WebAuthn assertion satisfies the L3 self-approve gate', async ({ cleanPage }) => {
    test.setTimeout(180_000);

    // Self-seeding so the spec is rerunnable: each run gets a fresh pending
    // sole-operator intent (the previous run's row is terminal once approved).
    const approvalId = process.env.E2E_APPROVAL_ID ?? seedSoleOperatorApproval();
    expect(psql(`SELECT status FROM approval_requests WHERE id = '${approvalId}'`)).toBe('pending');

    // Virtual authenticator must exist BEFORE any navigator.credentials call.
    const { cdp, authenticatorId } = await addVirtualAuthenticator(cleanPage);

    const auth = new AuthPage(cleanPage);
    await cleanPage.goto(`${auth.url}?next=${encodeURIComponent('/dashboard')}`);
    await auth.page_().waitFor();
    await cleanPage.waitForFunction(() => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
    });
    await auth.signIn(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!, /\/dashboard(\?|$|#)/);

    // ---- 1. Register an approver device through the real API, in the real
    // browser, against the virtual authenticator. This is the registration
    // half of the claim "a desktop browser can reach L3 with no mobile app".
    const registered = await cleanPage.evaluate(async (adminPassword: string) => {
      // Access tokens live in memory only (auth.ts persists just the user; the
      // refresh cookie restores tokens). Mint one the same way the app does so
      // these calls carry a real Bearer header.
      // /auth/refresh is CSRF-protected via the double-submit cookie the app
      // echoes back in x-breeze-csrf (stores/auth.ts).
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
      (window as unknown as { __e2eToken: string }).__e2eToken = accessToken;

      const api = (path: string, body?: unknown) =>
        fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          credentials: 'include',
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      // Registering an approver device is password step-up gated
      // (routes/authenticator.ts) — same as passkey registration.
      const optRes = await api('/authenticator/devices/webauthn/options', {
        currentPassword: adminPassword,
      });
      if (!optRes.ok) return { ok: false, stage: 'options', status: optRes.status, body: await optRes.text() };
      const optJson = await optRes.json();
      const options = optJson.options ?? optJson.optionsJSON ?? optJson;

      // Minimal WebAuthn create() — base64url helpers inline so the page needs
      // no bundle access.
      const b64uToBuf = (s: string) => {
        const pad = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      };
      const bufToB64u = (b: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const cred = (await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64uToBuf(options.challenge),
          user: { ...options.user, id: b64uToBuf(options.user.id) },
          excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string }) => ({
            ...c, id: b64uToBuf(c.id),
          })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) return { ok: false, stage: 'create', status: 0, body: 'null credential' };

      const att = cred.response as AuthenticatorAttestationResponse;
      const verifyRes = await api('/authenticator/devices/webauthn/verify', {
        label: 'E2E Virtual Platform Authenticator',
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
    }, process.env.E2E_ADMIN_PASSWORD!);

    expect(registered, `approver-device registration failed: ${JSON.stringify(registered)}`).toMatchObject({ ok: true });

    // ---- 2. Decide the seeded sole-operator intent WITH a real assertion,
    // mirroring exactly what decideIntentApproval does in the app.
    const decided = await cleanPage.evaluate(async (id) => {
      const b64uToBuf = (s: string) => {
        const pad = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      };
      const bufToB64u = (b: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(b)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const accessToken = (window as unknown as { __e2eToken: string }).__e2eToken;
      const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

      const chRes = await fetch(`/api/v1/mobile/approvals/${id}/assertion-challenge`, {
        method: 'POST', headers: authHeaders, credentials: 'include',
      });
      if (!chRes.ok) return { stage: 'challenge', status: chRes.status, body: await chRes.text() };
      const chJson = await chRes.json();
      const opts = chJson.options ?? chJson.optionsJSON ?? chJson;
      if (!opts.allowCredentials?.length) {
        return { stage: 'challenge', status: 200, body: 'no allowCredentials — device not visible to challenge' };
      }

      const assertion = (await navigator.credentials.get({
        publicKey: {
          ...opts,
          challenge: b64uToBuf(opts.challenge),
          allowCredentials: opts.allowCredentials.map((c: { id: string }) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      })) as PublicKeyCredential | null;
      if (!assertion) return { stage: 'assert', status: 0, body: 'null assertion' };

      const asr = assertion.response as AuthenticatorAssertionResponse;
      const approveRes = await fetch(`/api/v1/mobile/approvals/${id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        credentials: 'include',
        body: JSON.stringify({
          proof: {
            type: 'webauthn_platform',
            credentialId: assertion.id,
            authenticatorData: bufToB64u(asr.authenticatorData),
            clientDataJSON: bufToB64u(asr.clientDataJSON),
            signature: bufToB64u(asr.signature),
            userHandle: asr.userHandle ? bufToB64u(asr.userHandle) : null,
          },
        }),
      });
      return { stage: 'approve', status: approveRes.status, body: await approveRes.text() };
    }, approvalId);

    // The whole point: NOT 403 step_up_required, NOT 401 assertion_failed.
    expect(
      decided,
      `self-approve did not clear the L3 gate: ${JSON.stringify(decided)}`,
    ).toMatchObject({ stage: 'approve', status: 200 });

    const decidedBody = JSON.parse((decided as { body: string }).body);
    expect(decidedBody.approval?.status).toBe('approved');

    // The HTTP 200 alone only proves "not rejected". The gate's own threshold
    // lives in the DB — serialize() does not expose it — so assert there that
    // the server genuinely recorded L3 via the platform authenticator, and that
    // the linked intent was released. Without this, a future regression that
    // downgraded the recorded assurance (or accepted a proofless approve) would
    // still return 200 and this test would still pass.
    const [level, via, deviceBound, intentStatus, selfDecided] = psql(
      `SELECT ar.decided_assurance_level, ar.decided_via,
              (ar.authenticator_device_id IS NOT NULL)::text,
              ai.status, (ai.decided_by_user_id = ar.user_id)::text
         FROM approval_requests ar
         JOIN action_intents ai ON ai.id = ar.intent_id
        WHERE ar.id = '${approvalId}'`,
    ).split('|');

    expect(Number(level), 'server must record assurance level >= 3').toBeGreaterThanOrEqual(3);
    expect(via).toBe('webauthn_platform');
    expect(deviceBound, 'decision must be bound to the registered authenticator').toBe('true');
    expect(intentStatus, 'the linked intent must be released').toBe('approved');
    expect(selfDecided, 'this must be the sole-operator self-approve path').toBe('true');

    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  });
});
