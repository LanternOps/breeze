/**
 * #10923 — the last CLI token and installer link the Add Device modal minted,
 * remembered per site so reopening the modal does not mint another live key.
 * The server stores enrollment keys hashed, so it cannot show one again.
 *
 * These are live enrollment credentials, which sets the storage rules:
 *
 * - sessionStorage, never localStorage: an entry must not outlive the tab.
 * - The blob is bound to the user who minted its entries. A session that ends
 *   without logout() reaching this tab must not hand them to the next sign-in.
 * - An entry past its expiresAt is removed on the next read, for every site.
 * - auth.ts's logout() calls clearRememberedEnrollmentArtifacts() directly. A
 *   registerLogoutHook would only run on a page that had loaded this module, and
 *   sessionStorage outlives the page. This module imports nothing from auth.ts.
 *
 * AGENT_ENROLLMENT_SECRET is NOT stored. The token route returns it alongside
 * the token and the install command needs it, but it is deployment-wide and
 * does not expire. It stays in module memory, so it survives closing the modal
 * and soft navigation but not a reload. An entry that needs it is dropped when
 * it is gone, because its command could not enroll.
 *
 * Blocked or full storage degrades to remembering nothing.
 */

export const REMEMBERED_ENROLLMENT_ARTIFACTS_KEY = 'breeze.addDevice.remembered';

export type RememberedArtifactKind = 'cli' | 'link';

interface RememberedArtifact {
  value: string;
  expiresAt: string;
  maxUsage: number | null;
  createdAt: string;
}

export interface RememberedCliToken extends RememberedArtifact {
  /** The minted key's id, for GET /enrollment-keys/:id. Null when the API predates #11116 and sent none. */
  childKeyId: string | null;
  serverUrl: string | null;
  secretRequired: boolean;
  /** Present only when secretRequired, and only ever from memory. */
  enrollmentSecret?: string;
}

export interface RememberedInstallerLink extends RememberedArtifact {
  childKeyId: string;
  platform: 'windows' | 'macos';
}

export interface RememberedSiteArtifacts {
  cli?: RememberedCliToken;
  link?: RememberedInstallerLink;
}

interface StoredBlob {
  userId: string;
  sites: Record<string, RememberedSiteArtifacts>;
}

let secretInMemory: { userId: string; secret: string } | null = null;

// Bumped by every clear. A mint captures it before its request and passes it
// back to remember*, which refuses the write if a sign-out happened in between:
// the modal may already be unmounted, so no React state can stop it.
let rememberEpoch = 0;

/** Capture before minting, and pass as `epoch` to rememberCliToken / rememberInstallerLink. */
export function currentRememberEpoch(): number {
  return rememberEpoch;
}

function clearedSince(epoch: number | undefined): boolean {
  return epoch !== undefined && epoch !== rememberEpoch;
}

function isLive(expiresAt: unknown): expiresAt is string {
  if (typeof expiresAt !== 'string') return false;
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

function hasArtifactShape(entry: unknown): entry is RememberedArtifact {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.value === 'string' &&
    e.value.length > 0 &&
    typeof e.expiresAt === 'string' &&
    typeof e.createdAt === 'string' &&
    (e.maxUsage === null || typeof e.maxUsage === 'number')
  );
}

function isCliToken(entry: unknown): entry is RememberedCliToken {
  if (!hasArtifactShape(entry)) return false;
  const e = entry as unknown as Record<string, unknown>;
  return (
    (e.childKeyId === null || typeof e.childKeyId === 'string') &&
    typeof e.secretRequired === 'boolean' &&
    (e.serverUrl === null || typeof e.serverUrl === 'string')
  );
}

function isInstallerLink(entry: unknown): entry is RememberedInstallerLink {
  if (!hasArtifactShape(entry)) return false;
  const e = entry as unknown as Record<string, unknown>;
  return typeof e.childKeyId === 'string' && (e.platform === 'windows' || e.platform === 'macos');
}

function removeBlob(): void {
  try {
    sessionStorage.removeItem(REMEMBERED_ENROLLMENT_ARTIFACTS_KEY);
  } catch {
    // Storage is blocked, so there is nothing to remove.
  }
}

function writeBlob(blob: StoredBlob): void {
  if (Object.keys(blob.sites).length === 0) {
    removeBlob();
    return;
  }
  try {
    sessionStorage.setItem(REMEMBERED_ENROLLMENT_ARTIFACTS_KEY, JSON.stringify(blob));
  } catch (err) {
    // Never log the blob itself: it holds live credentials.
    console.warn('[rememberedEnrollmentArtifacts] could not store the entry; forgetting all of them', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    // The old blob may still hold an entry this write was meant to drop (a
    // replaced, expired or left-behind credential). Remembering nothing is the
    // safe way to fail.
    removeBlob();
  }
}

/**
 * The live, well-formed entries belonging to `userId`. Anything else found in
 * storage (another user's blob, corrupt JSON, expired or malformed entries) is
 * removed before this returns.
 */
function loadBlob(userId: string): StoredBlob {
  const empty: StoredBlob = { userId, sites: {} };

  let raw: string | null;
  try {
    raw = sessionStorage.getItem(REMEMBERED_ENROLLMENT_ARTIFACTS_KEY);
  } catch {
    return empty;
  }
  if (raw === null) return empty;

  let parsed: Partial<StoredBlob> | null;
  try {
    parsed = JSON.parse(raw) as Partial<StoredBlob> | null;
  } catch {
    removeBlob();
    return empty;
  }
  if (!parsed || parsed.userId !== userId || !parsed.sites || typeof parsed.sites !== 'object') {
    removeBlob();
    return empty;
  }

  const secretAvailable = secretInMemory?.userId === userId;
  const sites: StoredBlob['sites'] = {};
  for (const [siteId, stored] of Object.entries(parsed.sites)) {
    const kept: RememberedSiteArtifacts = {};
    if (isCliToken(stored?.cli) && isLive(stored.cli.expiresAt) && (!stored.cli.secretRequired || secretAvailable)) {
      kept.cli = stored.cli;
    }
    if (isInstallerLink(stored?.link) && isLive(stored.link.expiresAt)) {
      kept.link = stored.link;
    }
    if (kept.cli || kept.link) sites[siteId] = kept;
  }

  const blob: StoredBlob = { userId, sites };
  if (JSON.stringify(blob.sites) !== JSON.stringify(parsed.sites)) writeBlob(blob);
  return blob;
}

export function rememberCliToken(
  userId: string,
  siteId: string,
  token: {
    value: string;
    expiresAt: string;
    maxUsage: number | null;
    serverUrl: string | null;
    childKeyId?: string | null;
    epoch?: number;
  },
  enrollmentSecret?: string,
): void {
  if (clearedSince(token.epoch)) return;
  if (enrollmentSecret) secretInMemory = { userId, secret: enrollmentSecret };
  if (!isLive(token.expiresAt)) return;
  const blob = loadBlob(userId);
  blob.sites[siteId] = {
    ...blob.sites[siteId],
    cli: {
      value: token.value,
      expiresAt: token.expiresAt,
      maxUsage: token.maxUsage,
      serverUrl: token.serverUrl,
      childKeyId: token.childKeyId ?? null,
      secretRequired: Boolean(enrollmentSecret),
      createdAt: new Date(Date.now()).toISOString(),
    },
  };
  writeBlob(blob);
}

export function rememberInstallerLink(
  userId: string,
  siteId: string,
  link: {
    value: string;
    expiresAt: string;
    maxUsage: number | null;
    childKeyId: string;
    platform: 'windows' | 'macos';
    epoch?: number;
  },
): void {
  if (clearedSince(link.epoch) || !isLive(link.expiresAt)) return;
  const blob = loadBlob(userId);
  blob.sites[siteId] = {
    ...blob.sites[siteId],
    link: {
      value: link.value,
      expiresAt: link.expiresAt,
      maxUsage: link.maxUsage,
      childKeyId: link.childKeyId,
      platform: link.platform,
      createdAt: new Date(Date.now()).toISOString(),
    },
  };
  writeBlob(blob);
}

export function readRememberedEnrollmentArtifacts(userId: string, siteId: string): RememberedSiteArtifacts {
  const site = loadBlob(userId).sites[siteId];
  if (!site) return {};
  if (!site.cli?.secretRequired) return site;
  return { ...site, cli: { ...site.cli, enrollmentSecret: secretInMemory?.secret } };
}

export function forgetEnrollmentArtifact(userId: string, siteId: string, kind: RememberedArtifactKind): void {
  const blob = loadBlob(userId);
  const site = blob.sites[siteId];
  if (!site?.[kind]) return;
  const remaining: RememberedSiteArtifacts = { ...site };
  delete remaining[kind];
  if (remaining.cli || remaining.link) blob.sites[siteId] = remaining;
  else delete blob.sites[siteId];
  writeBlob(blob);
}

export function forgetSiteEnrollmentArtifacts(userId: string, siteId: string): void {
  const blob = loadBlob(userId);
  if (!blob.sites[siteId]) return;
  delete blob.sites[siteId];
  writeBlob(blob);
}

/** Sign-out: called from auth.ts's logout(). */
export function clearRememberedEnrollmentArtifacts(): void {
  rememberEpoch += 1;
  secretInMemory = null;
  removeBlob();
}
