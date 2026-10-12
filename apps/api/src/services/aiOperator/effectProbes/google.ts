/**
 * Google arm of the effect-probe registry (Recipe Library E4 #6169, plan
 * Task 10 and D-E4-7).
 *
 * Each probe MIRRORS the write it verifies in `services/aiToolsGoogle.ts`:
 * same org connection (`resolveContextByOrg`), same client getter, same
 * impersonation (Directory/Licensing as the connection's admin, Gmail as the
 * mailbox owner) and the same `canonicalArguments` keys the write consumes.
 * A probe that read a different scope than the write wrote would certify the
 * wrong thing.
 *
 * Contract: a typed result for every "cannot tell" case (missing arguments,
 * 404 on the target, truncated lists); API/network errors propagate and the
 * registry converts them to `unknown`. `unknown` means handoff, never verified.
 *
 * `google_signout` is ALWAYS `unknown`: the Directory user resource exposes no
 * session-validity field (`lastLoginTime` is not one).
 */
import { getDirectoryClient, getGmailClient, getLicensingClient } from '../../googleClient';
import { canonicalizeUserEmail, resolveContextByOrg, type GoogleToolContext } from '../../aiToolsGoogle';
import type { PlannedEffect } from '../recipes/types';
import { registerEffectProbe, type EffectProbe, type EffectProbeResult } from './index';

/** Page size the write-adjacent list reads use; a full page cannot prove absence. */
const LICENSE_PAGE_SIZE = 100;
const GROUP_PAGE_SIZE = 200;

const result = (state: EffectProbeResult['state'], detail: string): EffectProbeResult => ({
  state,
  observedAt: new Date(),
  detail,
});

/** Same trimmed-non-empty-string rule as `requireString` in the write path. */
function arg(effect: PlannedEffect, key: string): string | null {
  const v = effect.canonicalArguments?.[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

const missing = (tool: string, key: string): EffectProbeResult =>
  result('unknown', `${tool}: argument '${key}' is missing or not a string, so the effect cannot be observed`);

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return e?.code === 404 || e?.status === 404 || e?.response?.status === 404;
}

const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

async function ctxForOrg(orgId: string): Promise<GoogleToolContext> {
  // Same resolver the headless write path uses, so a probe can never read
  // through a different connection than the write wrote through.
  const resolved = await resolveContextByOrg(orgId);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved;
}

/** `google_suspend_user` — reads `userEmail`; `users.get({ userKey })`. */
export const probeGoogleSuspendUser: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_suspend_user', 'userEmail');
  const g = await ctxForOrg(ctx.orgId);
  const dir = getDirectoryClient(g.keyJson, g.conn.adminEmail);
  let suspended: boolean;
  try {
    const res = await dir.users.get({ userKey: email });
    suspended = res.data.suspended === true;
  } catch (err) {
    // A deleted account is not evidence that the SUSPEND we were asked for happened.
    if (isNotFound(err)) return result('unknown', `${email} was not found in Google Workspace, so suspension cannot be observed`);
    throw err;
  }
  return suspended
    ? result('satisfied', `${email} is suspended in Google Workspace`)
    : result('unsatisfied', `${email} is NOT suspended in Google Workspace`);
};

/** `google_remove_from_group` — reads `userEmail`, `groupEmail`; `groups.list({ userKey, maxResults: 200 })`. */
export const probeGoogleRemoveFromGroup: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_remove_from_group', 'userEmail');
  const groupEmail = arg(effect, 'groupEmail');
  if (!groupEmail) return missing('google_remove_from_group', 'groupEmail');
  const g = await ctxForOrg(ctx.orgId);
  const dir = getDirectoryClient(g.keyJson, g.conn.adminEmail);
  const res = await dir.groups.list({ userKey: email, maxResults: GROUP_PAGE_SIZE });
  const groups = res.data.groups ?? [];
  if (groups.some((grp) => lc(grp.email) === lc(groupEmail))) {
    return result('unsatisfied', `${email} is still a member of ${groupEmail}`);
  }
  if (res.data.nextPageToken) {
    return result('unknown', `${email}'s group list is truncated and ${groupEmail} was not on the first page; absence is unproven`);
  }
  return result('satisfied', `${email} is not a member of ${groupEmail}`);
};

/** `google_remove_license` — reads `userEmail` (resolved to primary via `users.get`), `productId`, `skuId`; `licenseAssignments.listForProduct`. */
export const probeGoogleRemoveLicense: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_remove_license', 'userEmail');
  const productId = arg(effect, 'productId');
  if (!productId) return missing('google_remove_license', 'productId');
  const skuId = arg(effect, 'skuId');
  if (!skuId) return missing('google_remove_license', 'skuId');
  const g = await ctxForOrg(ctx.orgId);
  // licenseAssignments carry the user's PRIMARY email as `userId`; `userEmail`
  // may be an alias, so resolve it first (as probeGoogleWipeMobileDevice does)
  // or a still-held license would never match and read as falsely satisfied.
  const dir = getDirectoryClient(g.keyJson, g.conn.adminEmail);
  let primaryEmail: string;
  try {
    const u = await dir.users.get({ userKey: email });
    if (!u.data.primaryEmail) return result('unknown', `could not resolve a primary email for ${email}, so license removal cannot be observed`);
    primaryEmail = u.data.primaryEmail;
  } catch (err) {
    if (isNotFound(err)) return result('unknown', `${email} was not found in Google Workspace, so license removal cannot be observed`);
    throw err;
  }
  const lic = getLicensingClient(g.keyJson, g.conn.adminEmail);
  const res = await lic.licenseAssignments.listForProduct({
    productId,
    customerId: 'my_customer',
    maxResults: LICENSE_PAGE_SIZE,
  });
  const items = res.data.items ?? [];
  if (items.some((a) => lc(a.userId) === lc(primaryEmail) && a.skuId === skuId)) {
    return result('unsatisfied', `${primaryEmail} still holds license ${productId}/${skuId}`);
  }
  if (items.length >= LICENSE_PAGE_SIZE || res.data.nextPageToken) {
    // Absence from a truncated page is not absence.
    return result('unknown', `the license list for ${productId} is full/truncated and ${primaryEmail} was not on it; absence is unproven`);
  }
  return result('satisfied', `${primaryEmail} holds no ${productId}/${skuId} license assignment`);
};

/** `google_set_vacation` — reads `userEmail`, `enable` (default true), `message`; Gmail `getVacation({ userId: 'me' })` as the mailbox. */
export const probeGoogleSetVacation: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_set_vacation', 'userEmail');
  const enable = effect.canonicalArguments?.enable !== false; // write path defaults to enable
  const message = arg(effect, 'message') ?? '';
  const g = await ctxForOrg(ctx.orgId);
  const gmail = getGmailClient(g.keyJson, email);
  const res = await gmail.users.settings.getVacation({ userId: 'me' });
  const on = res.data.enableAutoReply === true;
  if (!enable) {
    return on
      ? result('unsatisfied', `the out-of-office responder for ${email} is still enabled`)
      : result('satisfied', `the out-of-office responder for ${email} is disabled`);
  }
  if (!on) return result('unsatisfied', `the out-of-office responder for ${email} is not enabled`);
  if (message) {
    const bodies = `${res.data.responseBodyPlainText ?? ''}\n${res.data.responseBodyHtml ?? ''}`;
    if (!bodies.includes(message)) {
      return result('unsatisfied', `the out-of-office responder for ${email} is enabled but does not carry the approved message`);
    }
  }
  return result('satisfied', `the out-of-office responder for ${email} is enabled${message ? ' with the approved message' : ''}`);
};

/**
 * `google_set_forwarding` — reads `userEmail`, `forwardTo`; Gmail
 * `getAutoForwarding({ userId: 'me' })` + `forwardingAddresses.get`. Holds the
 * write path's own bar: an unverified destination never delivers.
 */
export const probeGoogleSetForwarding: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_set_forwarding', 'userEmail');
  const forwardTo = arg(effect, 'forwardTo');
  if (!forwardTo) return missing('google_set_forwarding', 'forwardTo');
  const g = await ctxForOrg(ctx.orgId);
  const gmail = getGmailClient(g.keyJson, email);
  const fwd = await gmail.users.settings.getAutoForwarding({ userId: 'me' });
  if (fwd.data.enabled !== true || lc(fwd.data.emailAddress) !== lc(forwardTo)) {
    return result('unsatisfied', `forwarding from ${email} to ${forwardTo} is not enabled`);
  }
  let status: string | null | undefined;
  try {
    const addr = await gmail.users.settings.forwardingAddresses.get({ userId: 'me', forwardingEmail: forwardTo });
    status = addr.data.verificationStatus;
  } catch (err) {
    if (isNotFound(err)) return result('unsatisfied', `${forwardTo} is not a registered forwarding address for ${email}`);
    throw err;
  }
  return status === 'accepted'
    ? result('satisfied', `forwarding from ${email} to ${forwardTo} is enabled and the destination is verified`)
    : result('unsatisfied', `forwarding from ${email} to ${forwardTo} is configured but the destination is not verified (status: ${status ?? 'unknown'}); mail will not forward`);
};

/** `google_add_mail_delegate` — reads `userEmail`, `delegateEmail`; Gmail `delegates.list({ userId: 'me' })` as the mailbox. */
export const probeGoogleAddMailDelegate: EffectProbe = async (effect, ctx) => {
  const email = arg(effect, 'userEmail');
  if (!email) return missing('google_add_mail_delegate', 'userEmail');
  const delegateEmail = arg(effect, 'delegateEmail');
  if (!delegateEmail) return missing('google_add_mail_delegate', 'delegateEmail');
  const g = await ctxForOrg(ctx.orgId);
  const gmail = getGmailClient(g.keyJson, email);
  const res = await gmail.users.settings.delegates.list({ userId: 'me' });
  const match = (res.data.delegates ?? []).find((d) => lc(d.delegateEmail) === lc(delegateEmail));
  if (!match) return result('unsatisfied', `${delegateEmail} is not a delegate of ${email}'s mailbox`);
  return match.verificationStatus === 'accepted'
    ? result('satisfied', `${delegateEmail} is an accepted delegate of ${email}'s mailbox`)
    : result('unsatisfied', `${delegateEmail} is a delegate of ${email}'s mailbox but has not accepted (status: ${match.verificationStatus ?? 'unknown'})`);
};

/** `google_signout` — ALWAYS unknown; makes no API call. */
export const probeGoogleSignout: EffectProbe = async () =>
  result(
    'unknown',
    'google_signout has no observable end state: the Directory user resource exposes no session-validity field '
    + '(lastLoginTime is not one), so session revocation cannot be verified',
  );

/**
 * `google_wipe_mobile_device` — reads `userEmail`. Mirrors `resolveWipeTarget`:
 * canonicalize, `users.get` for the primaryEmail, `mobiledevices.list` with
 * `email:<primaryEmail>`, then local EXACT-match on each device's `email[]`.
 */
export const probeGoogleWipeMobileDevice: EffectProbe = async (effect, ctx) => {
  const raw = arg(effect, 'userEmail');
  if (!raw) return missing('google_wipe_mobile_device', 'userEmail');
  const canonical = canonicalizeUserEmail(raw);
  if (!canonical) {
    return result('unknown', 'google_wipe_mobile_device: userEmail is not a single canonical address, so the device set cannot be resolved');
  }
  const g = await ctxForOrg(ctx.orgId);
  const dir = getDirectoryClient(g.keyJson, g.conn.adminEmail);
  let primaryEmail: string;
  try {
    const u = await dir.users.get({ userKey: canonical });
    if (!u.data.primaryEmail) return result('unknown', `could not resolve a single user for ${canonical}`);
    primaryEmail = u.data.primaryEmail.toLowerCase();
  } catch (err) {
    if (isNotFound(err)) return result('unknown', `${canonical} was not found in Google Workspace, so device wipe cannot be observed`);
    throw err;
  }
  const list = await dir.mobiledevices.list({ customerId: 'my_customer', query: `email:${primaryEmail}` });
  const matched = (list.data.mobiledevices ?? []).filter(
    (d) => d.resourceId && (d.email ?? []).some((e) => lc(e) === primaryEmail),
  );
  if (matched.length === 0) {
    // "No devices" is indistinguishable from "we cannot see the devices".
    return result('unknown', `no mobile devices are enrolled for ${primaryEmail}; a wipe cannot be observed`);
  }
  const pending = matched.filter((d) => d.status !== 'WIPING' && d.status !== 'WIPED');
  return pending.length === 0
    ? result('satisfied', `${matched.length} device(s) for ${primaryEmail} report WIPING or WIPED`)
    : result('unsatisfied', `${pending.length} of ${matched.length} device(s) for ${primaryEmail} have not started wiping`);
};

const GOOGLE_PROBES: ReadonlyArray<readonly [string, EffectProbe]> = [
  ['google_suspend_user', probeGoogleSuspendUser],
  ['google_remove_from_group', probeGoogleRemoveFromGroup],
  ['google_remove_license', probeGoogleRemoveLicense],
  ['google_set_vacation', probeGoogleSetVacation],
  ['google_set_forwarding', probeGoogleSetForwarding],
  ['google_add_mail_delegate', probeGoogleAddMailDelegate],
  ['google_signout', probeGoogleSignout],
  ['google_wipe_mobile_device', probeGoogleWipeMobileDevice],
];

/** Registers the eight Google probes; returns the tool names. The registry refuses duplicates, so call once. */
export function registerGoogleEffectProbes(): string[] {
  for (const [name, probe] of GOOGLE_PROBES) registerEffectProbe(name, probe);
  return GOOGLE_PROBES.map(([name]) => name);
}
