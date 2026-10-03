import { Hono, type Context } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { VALID_OS, VALID_ARCH } from './schemas';
import { isS3Configured, getPresignedUrl, isS3NotFound } from '../../services/s3Storage';
import { binaryS3Key, binaryStoreDir, type BinaryStore } from '../../services/binaryStores';
import { getBinarySource, getGithubReleaseVersion, getGithubAgentUrl, getGithubUserHelperUrl, getGithubWatchdogUrl, getGithubBackupUrl, getGithubRecoveryIsoUrl, HELPER_FILENAMES } from '../../services/binarySource';
import { getPromotedComponentVersion, getRegisteredComponentVersion, type PromotedComponent } from '../../services/promotedAgentVersion';
import { fetchVerifiedMacosPkg, fetchVerifiedHelperInstaller } from '../../services/installerBuilder';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';

export const downloadRoutes = new Hono();

// This whole route prefix (/api/v1/agents/) is exempted from the global rate
// limiter (it assumes agent-auth's own per-agent limiting applies, which
// does not cover any of these unauthenticated download routes — see
// AGENT_AUTH_SKIP_ID_SEGMENTS) and there is no Caddy rate_limit on it
// either, so every route below must carry its own per-IP bound. Fails
// CLOSED on Redis errors — a Redis outage must not thereby disable the
// limiter on a public endpoint.
//
// One bucket PER ROUTE (keyed on `logTag`, e.g. `agent-download`,
// `install-script-download`), not one shared bucket across every route. A
// single office/site rollout behind one NAT IP legitimately calls several of
// these routes back-to-back (install.sh, then the agent binary, then
// watchdog/backup), so a shared bucket means the busiest route (typically
// install.sh, hit once per machine) uses up capacity meant for every other route's
// legitimate traffic on the same IP. None of these routes carry an
// enrollment/download key or any other form of caller identity to key on
// instead — they are deliberately unauthenticated (see each route's own
// comment for why) — so per-route-per-IP is the finest-grained bucketing
// available without adding auth to routes that intentionally have none.
//
// Sizing: an earlier 120/min shared bucket 429'd a normal single-site mass
// rollout (as few as ~20-60 machines starting installs in the same minute
// already drew 429s; hundreds rejected the vast majority of their requests).
// A realistic large single-site rollout is bounded in the hundreds of machines (not
// unbounded) and a real machine's install traffic for ANY ONE of these
// routes is 1 request, so the target is "a few hundred machines' worth of
// the SAME route from one IP within a few minutes succeeds, sustained
// higher-than-that traffic on that IP+route does not." 600 requests / 300s
// (5 min) per route per IP: comfortably covers a ~500-machine rollout
// bursting through in a few minutes (the limiter is a sliding window, so the
// full 600 can land in the rollout's first seconds), while a sustained flood
// is still capped at an average of 120 req/min indefinitely — an order of
// magnitude above any real single-site rollout's sustained rate, but still a
// hard, non-negotiable ceiling per IP per route.
export const PUBLIC_AGENT_DOWNLOAD_IP_LIMIT = 600;
export const PUBLIC_AGENT_DOWNLOAD_IP_WINDOW_SECONDS = 300;

/**
 * Shared low-level limiter: checks `bucketKey` against `limit`/`windowSeconds`,
 * failing CLOSED (503) on a missing or errored Redis client. Every public,
 * unauthenticated download route below builds its own `bucketKey` (its own
 * namespace, so one route's traffic never shares capacity with another's)
 * and calls this.
 */
async function enforceDownloadRateLimit(
  c: Context,
  bucketKey: string,
  logTag: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  try {
    const { getRedis } = await import('../../services');
    const { rateLimiter } = await import('../../services/rate-limit');
    const redis = getRedis();
    if (!redis) {
      console.error(`[${logTag}] rate-limit unavailable: redis client missing`);
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const rateResult = await rateLimiter(redis, bucketKey, limit, windowSeconds);
    if (!rateResult.allowed) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }
    return null;
  } catch (err) {
    console.error(
      `[${logTag}] rate-limit check failed (failing closed):`,
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
}

async function enforcePublicAgentDownloadRateLimit(
  c: Context,
  logTag: string,
): Promise<Response | null> {
  const ip = getTrustedClientIp(c, 'unknown');
  return enforceDownloadRateLimit(
    c,
    `public-agent-download:${logTag}:${rateLimitIpKey(ip)}`,
    logTag,
    PUBLIC_AGENT_DOWNLOAD_IP_LIMIT,
    PUBLIC_AGENT_DOWNLOAD_IP_WINDOW_SECONDS,
  );
}

// ============================================
// Shared component-binary download handler
// ============================================
// The agent/helper/watchdog/backup/user-helper routes below are five
// near-verbatim copies of the same ~90-line shape: validate os/arch → GitHub
// redirect (BINARY_SOURCE=github) → S3 presign (404-falls-to-disk,
// non-404→500) → disk stream. registerComponentDownloadRoute hoists that
// shape into one place so a future fix (e.g. stream backpressure) lands
// once. The .pkg and install.sh/uninstall.sh routes have real behavioral
// differences (macOS-only, different validation/response shape) and are
// deliberately NOT folded in here.
interface ComponentDownloadConfig {
  /** Route path registered on downloadRoutes, e.g. '/download/watchdog/:os/:arch'. */
  path: string;
  /** Log-line prefix, e.g. 'watchdog-download' → '[watchdog-download] ...'. */
  logTag: string;
  /** Human label used in the 404 body, e.g. 'Watchdog binary "..." is not available.' */
  entityLabel: string;
  /** Resolves the on-disk filename for a validated (os, arch) pair. */
  filenameFor: (os: string, arch: string) => string | undefined;
  /** 400 message when filenameFor returns undefined (helper's per-OS lookup table). */
  invalidOsMessage?: (os: string) => string;
  /**
   * agent_versions.component value for this route, used to resolve the
   * promoted (isLatest) release the bytes must come from (#3499).
   */
  component: PromotedComponent;
  /**
   * Canonical GitHub release asset URL for BINARY_SOURCE=github. `version`
   * pins the release tag to the promoted agent_versions row; when omitted the
   * builder falls back to the env-resolved BINARY_VERSION/BREEZE_VERSION.
   */
  githubUrlFor: (os: string, arch: string, version?: string) => string;
  /**
   * Binaries directory the file is staged in (non-github mode). It decides
   * BOTH the disk path and the S3 key (binaryS3Key), so the route always
   * reads the object syncBinaries() uploaded for that file (#7515).
   */
  store: BinaryStore;
}

// breeze-{component}-{os}-{arch}[.exe] — the shape shared by agent, watchdog,
// backup, and user-helper (helper uses its own HELPER_FILENAMES lookup instead).
function perArchFilename(component: string) {
  return (os: string, arch: string) =>
    `breeze-${component}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}

function registerComponentDownloadRoute(config: ComponentDownloadConfig): void {
  downloadRoutes.get(config.path, async (c) => {
    // config.path is a runtime string (not a literal), so Hono can't narrow
    // the param keys at the type level the way it does for the inline
    // `.get('/download/:os/:arch', ...)` routes this replaced — every
    // registered path always includes :os/:arch, so this is safe at runtime.
    const rateLimited = await enforcePublicAgentDownloadRateLimit(c, config.logTag);
    if (rateLimited) return rateLimited;

    const os = c.req.param('os') as string;
    const arch = c.req.param('arch') as string;

    if (!VALID_OS.has(os)) {
      return c.json(
        {
          error: 'Invalid OS',
          message: `Supported values: linux, darwin, windows. Got: ${os}`,
        },
        400
      );
    }

    if (!VALID_ARCH.has(arch)) {
      return c.json(
        {
          error: 'Invalid architecture',
          message: `Supported values: amd64, arm64. Got: ${arch}`,
        },
        400
      );
    }

    const filename = config.filenameFor(os, arch);
    if (!filename) {
      return c.json(
        { error: 'Invalid OS', message: config.invalidOsMessage!(os) },
        400
      );
    }

    // GitHub redirect mode — no local binaries needed.
    //
    // #3499: pin the release tag to the same agent_versions isLatest row that
    // GET /agent-versions/latest serves the checksum from. Resolving it from
    // per-process env here instead let the bytes and the checksum drift a full
    // release apart whenever the binary sync stalled, which install.sh reports
    // as "Checksum verification failed for downloaded agent binary".
    //
    // null means "no promoted row at all" — the cold-start state of a
    // deployment that has never synced — so fall back to the env-resolved URL
    // and keep those deployments working exactly as they did. A lookup FAULT
    // is different and throws: serving the env version then would reintroduce
    // the very mismatch this fixes and report a server-side DB fault to the
    // end user as a checksum failure.
    // #5159: an explicit `?version=` pins the redirect to that exact release
    // instead of the promoted one. The heartbeat can legitimately target a
    // pinned/pilot version that is NOT promoted (resolvePinnedUpgradeTarget,
    // #2124); GET /agent-versions/:version/download hands the agent that
    // version's checksum and now points here WITH the version, so the bytes
    // and the checksum come from one release again. Absent the param the
    // route behaves exactly as before (promoted row, #3499).
    const requestedVersion = c.req.query('version')?.trim() || undefined;

    if (getBinarySource() === 'github') {
      let redirectUrl: string;
      try {
        let resolvedVersion: string | null;
        if (requestedVersion) {
          resolvedVersion = await getRegisteredComponentVersion(
            config.component,
            os,
            arch,
            requestedVersion,
          );
          if (!resolvedVersion) {
            // Fail closed. Degrading to the promoted release here would hand
            // back bytes for a DIFFERENT version than the caller asked for —
            // exactly the substitution #5159 is about — and these routes are
            // public, so an unregistered tag must never reach the URL builder.
            console.warn(
              `[${config.logTag}] refusing to serve ${filename}: no registered agent_versions row for requested version`,
              { requestedVersion, os, arch, component: config.component },
            );
            return c.json(
              {
                error: 'Version not found',
                message: `${config.entityLabel} for the requested version is not available.`,
              },
              404,
            );
          }
        } else {
          resolvedVersion = await getPromotedComponentVersion(
            config.component,
            os,
            arch,
          );
        }
        // Inside the try on purpose: the URL builder ALSO throws — on a
        // malformed release tag, which a promoted row can carry because
        // agent_versions.version has no format constraint. That is the same
        // "we cannot determine a release to serve" condition, so it belongs on
        // the same 503 rather than falling through to a bare 500.
        redirectUrl = config.githubUrlFor(os, arch, resolvedVersion ?? undefined);
      } catch (err) {
        console.error(
          `[${config.logTag}] refusing to serve ${filename}: could not resolve a release to redirect to`,
          err,
        );
        return c.json(
          {
            error: 'Service unavailable',
            message:
              'Could not determine the current release. Retry shortly; if this persists, check the API logs.',
          },
          503,
          { 'Retry-After': '30' },
        );
      }
      return c.redirect(redirectUrl, 302);
    }

    // Local mode serves ONE unversioned file per (component, os, arch) — the
    // build baked into the binaries volume, whose version is the env-resolved
    // one. It cannot honour a pin, so refuse rather than stream bytes for a
    // version the caller did not ask for (the #5159 failure mode again, just
    // one layer down). Our own callers only append `?version=` in github mode,
    // so this is a guard against a hand-crafted or future request, not a path
    // the agent takes. When the env version is unresolvable ('latest') we
    // genuinely cannot tell, so serve as before and let the agent's checksum
    // check be the backstop.
    if (requestedVersion) {
      const localVersion = getGithubReleaseVersion();
      if (localVersion === 'latest') {
        // Neither BINARY_VERSION nor BREEZE_VERSION is set, so we cannot say
        // which build is on disk and cannot evaluate the guard. Serving is
        // still the right call (refusing would break a deployment whose disk
        // build IS the requested one), but say so: if the agent then reports a
        // checksum failure, this line is what tells an operator why.
        console.warn(
          `[${config.logTag}] serving ${filename} for a requested version without being able to verify it: set BREEZE_VERSION (or BINARY_VERSION) so this server knows which build it holds — on a server-only release image the baked BREEZE_BINARIES_VERSION does this`,
          { requestedVersion },
        );
      }
      if (localVersion !== 'latest' && localVersion !== requestedVersion) {
        console.warn(
          `[${config.logTag}] refusing to serve ${filename}: local mode has only the ${localVersion} build`,
          { requestedVersion, localVersion },
        );
        return c.json(
          {
            error: 'Version not available',
            message: `${config.entityLabel} for the requested version is not available from this server.`,
          },
          409,
        );
      }
    }

    // Local mode: try S3 presigned redirect first (bandwidth offload). The key
    // comes from the file's store, the same one syncBinaries() uploaded it to.
    if (isS3Configured()) {
      try {
        const s3Key = binaryS3Key(config.store, filename);
        const url = await getPresignedUrl(s3Key);
        return c.redirect(url, 302);
      } catch (err) {
        if (!isS3NotFound(err)) {
          // Real S3 transport/auth fault — surface it instead of masking it as a
          // disk-fallback 404. The binary may well exist in S3; we just couldn't reach it.
          console.error(`[${config.logTag}] S3 presign failed for ${filename}:`, err);
          return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
        }
        console.warn(`[${config.logTag}] S3 object missing for ${filename}, falling back to disk:`, err);
      }
    }

    // Local mode: serve from disk
    const binaryDir = binaryStoreDir(config.store);
    const filePath = join(binaryDir, filename);

    let fileStat: ReturnType<typeof statSync>;
    let stream: ReturnType<typeof createReadStream>;
    try {
      fileStat = statSync(filePath);
      stream = createReadStream(filePath);
    } catch (err) {
      const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isNotFound) {
        console.error(`[${config.logTag}] Failed to read binary ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
      }
      console.warn(`[${config.logTag}] Local binary missing`, { filename });
      return c.json(
        {
          error: 'Binary not found',
          message: `${config.entityLabel} "${filename}" is not available.`,
        },
        404
      );
    }

    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: string | Buffer) => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(bytes));
        });
        stream.on('end', () => {
          controller.close();
        });
        stream.on('error', (err) => {
          console.error(`[${config.logTag}] Stream error while serving ${filename}:`, err);
          controller.error(err);
        });
      },
      cancel() {
        stream.destroy();
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(fileStat.size),
        'Cache-Control': 'no-cache',
      },
    });
  });
}

// ============================================
// Agent Binary Download (public, no auth)
// ============================================

registerComponentDownloadRoute({
  path: '/download/:os/:arch',
  logTag: 'agent-download',
  entityLabel: 'Agent binary',
  component: 'agent',
  filenameFor: perArchFilename('agent'),
  githubUrlFor: getGithubAgentUrl,
  store: 'agent',
});

// ============================================
// Raw Agent MSI Download (Windows, public, no auth)
// ============================================
// Serves the staged installer VERBATIM — unlike the enrollment installer
// routes (routes/enrollmentKeys.ts), no per-download bootstrap token is
// embedded, so the bytes have a stable sha256. That stability is the point:
// the automatic edition migration (#4072, services/agentEditionAutoMigrate.ts)
// pins the download to a sha256 it computes from this same file, and the
// migration script verifies before touching the installed agent. A raw MSI
// enrolls nothing on its own (no token, no server config), so like the other
// binary routes above it is safe to serve unauthenticated.
//
// Deliberately DISK-ONLY (no S3 presign, no github redirect): the sha pin is
// computed from the local staged file, and serving any other source could
// hand out bytes that don't match it. BINARY_SOURCE=github deployments get a
// 404 here and auto edition migration stays inert.
downloadRoutes.get('/download/windows/amd64/msi', async (c) => {
  const rateLimited = await enforcePublicAgentDownloadRateLimit(c, 'agent-msi-download');
  if (rateLimited) return rateLimited;

  const binaryDir = binaryStoreDir('agent');
  const filePath = join(binaryDir, 'breeze-agent.msi');

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error('[agent-msi-download] Failed to read breeze-agent.msi:', err);
      return c.json({ error: 'Internal server error', message: 'Failed to read installer file' }, 500);
    }
    console.warn('[agent-msi-download] Staged MSI missing', { filePath });
    return c.json(
      { error: 'Installer not found', message: 'The agent MSI installer is not staged on this server.' },
      404
    );
  }

  // Readable.toWeb (not the hand-rolled bridge the older routes in this file
  // still use) gets backpressure and zero-copy chunk transfer for free — same
  // as the ticket-attachment streams.
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="breeze-agent.msi"',
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Agent .pkg Installer Download (macOS, public, no auth)
// ============================================
// Deliberately NOT version-pinned to the promoted agent_versions row the way
// the five component routes above are (#3499). install.sh's macOS branch never
// sha256-checks the .pkg against /agent-versions/latest — it verifies xar magic
// bytes and Apple notarization via `spctl --assess` instead — so there is no
// checksum/bytes pair here to keep consistent, and no install-time failure to
// prevent. The tradeoff is that a macOS install lands on the env-resolved
// release while Linux lands on the promoted one; the agent reconciles on its
// first heartbeat, which offers the promoted version through the normal
// verified updater path.
downloadRoutes.get('/download/:os/:arch/pkg', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (os !== 'darwin') {
    return c.json({ error: 'Installer packages are only available for macOS (darwin)' }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  // This whole route prefix (/api/v1/agents/) is exempted from the global
  // rate limiter (it assumes agent-auth's own per-agent limiting applies,
  // which does not cover this unauthenticated route — see
  // AGENT_AUTH_SKIP_ID_SEGMENTS) and there is no Caddy rate_limit on it
  // either, so this route must carry its own per-IP bound. Own bucket
  // namespace (`public-pkg-download`, distinct from `public-agent-download`),
  // same re-derived sizing as the other download routes above — a macOS
  // fleet rollout behind shared NAT is exposed to the identical over-block
  // risk the other routes were re-sized for.
  const ip = getTrustedClientIp(c, 'unknown');
  const rateLimited = await enforceDownloadRateLimit(
    c,
    `public-pkg-download:${rateLimitIpKey(ip)}`,
    'pkg-download',
    PUBLIC_AGENT_DOWNLOAD_IP_LIMIT,
    PUBLIC_AGENT_DOWNLOAD_IP_WINDOW_SECONDS,
  );
  if (rateLimited) return rateLimited;

  const filename = `breeze-agent-darwin-${arch}.pkg`;
  try {
    const { buffer, artifact } = await fetchVerifiedMacosPkg(arch as 'amd64' | 'arm64');
    // Stream the cached artifact instead of copying it into a fresh
    // Uint8Array per request — `buffer` is a shared, process-lifetime cache
    // entry (fetchVerifiedMacosPkg), so N concurrent slow readers previously
    // held N full-size duplicate copies in memory for the socket-drain
    // duration. Readable.from(buffer) reads the same underlying memory.
    return new Response(Readable.toWeb(Readable.from(buffer)) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'X-Breeze-Artifact-SHA256': artifact.sha256,
        'X-Breeze-Release': artifact.release,
        'X-Breeze-MacOS-Team-ID': artifact.signingTeamId!,
        'X-Breeze-MacOS-Signing-Identity-Base64': Buffer.from(
          artifact.signingIdentity!,
          'utf8',
        ).toString('base64'),
      },
    });
  } catch (err) {
    console.error(`[pkg-download] Refusing to serve unverified package ${filename}:`, err);
    return c.json(
      {
        error: 'Installer unavailable',
        message: 'The installer package could not be verified. Retry later or contact your administrator.',
      },
      503,
      { 'Retry-After': '30' },
    );
  }
});

// ============================================
// Helper (Tauri desktop app) Installer Download (public, no auth)
// ============================================
// Deliberately NOT folded into registerComponentDownloadRoute like the
// agent/watchdog/backup/user-helper routes below: those binaries are each
// independently checksum- or signature-verified downstream (install.sh, or
// the agent's own Ed25519-pinned self-updater), so a dumb-pipe serve is safe
// there. The Helper installer has no such downstream check — no client-side
// updater/signature-pin mechanism exists for it — so this route is the only
// place its bytes are ever verified. Same shape as the .pkg route above:
// verify against the signed release manifest, refuse to serve on any
// mismatch rather than falling back to unverified bytes.
downloadRoutes.get('/download/helper/:os/:arch', async (c) => {
  // Public and unauthenticated like every other route in this file, so it
  // carries the same per-route-per-IP bound (see
  // enforcePublicAgentDownloadRateLimit). Checked before any verified fetch.
  const rateLimited = await enforcePublicAgentDownloadRateLimit(c, 'helper-download');
  if (rateLimited) return rateLimited;

  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json({ error: 'Invalid OS', message: `Supported values: linux, darwin, windows. Got: ${os}` }, 400);
  }
  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const filename = HELPER_FILENAMES[os];
  if (!filename) {
    return c.json({ error: 'Invalid OS', message: `No helper binary available for OS: ${os}` }, 400);
  }

  try {
    const { buffer, artifact } = await fetchVerifiedHelperInstaller(os);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'X-Breeze-Artifact-SHA256': artifact.sha256,
        'X-Breeze-Release': artifact.release,
      },
    });
  } catch (err) {
    console.error(`[helper-download] Refusing to serve unverified installer ${filename}:`, err);
    return c.json(
      {
        error: 'Installer unavailable',
        message: 'The Helper installer could not be verified. Retry later or contact your administrator.',
      },
      503,
      { 'Retry-After': '30' },
    );
  }
});

// ============================================
// Watchdog Binary Download (public, no auth)
// ============================================
// Per-arch like the agent (breeze-watchdog-{os}-{arch}[.exe]). The agent's
// reconcileWatchdog and the watchdog's own failover self-update fetch this via
// /agent-versions/:version/download?component=watchdog, which hands back this
// same-origin URL so the downloader's host-match guard passes (see
// buildServerRelativeAgentDownloadUrl + issue #646).
registerComponentDownloadRoute({
  path: '/download/watchdog/:os/:arch',
  logTag: 'watchdog-download',
  entityLabel: 'Watchdog binary',
  component: 'watchdog',
  filenameFor: perArchFilename('watchdog'),
  githubUrlFor: getGithubWatchdogUrl,
  store: 'agent',
});

// ============================================
// Backup Binary Download (public, no auth)
// ============================================
// Per-arch like the agent (breeze-backup-{os}-{arch}[.exe]). install.sh fetches
// this as a non-fatal post-install step, and /agent-versions/:version/download
// hands back this same-origin URL for component=backup so any future verified
// self-heal fetch passes the downloader's host-match guard (see
// buildServerRelativeAgentDownloadUrl). Mirrors the watchdog route exactly.
registerComponentDownloadRoute({
  path: '/download/backup/:os/:arch',
  logTag: 'backup-download',
  entityLabel: 'Backup binary',
  component: 'backup',
  filenameFor: perArchFilename('backup'),
  githubUrlFor: getGithubBackupUrl,
  store: 'agent',
});

// breeze-recovery-linux-<arch>.iso (W04b): the bare-metal recovery media,
// built and released alongside breeze-backup — see agent/recovery-media/.
// Linux only for now (Windows media is W07); the route still takes an :os
// segment (matching every other registerComponentDownloadRoute route) so it
// shares this one handler, but filenameFor rejects anything but "linux".
// GET /backup/bmr/boot-media (routes/backup/bmrRecoveries.ts) is what
// actually advertises this URL to clients.
registerComponentDownloadRoute({
  path: '/download/recovery-iso/:os/:arch',
  logTag: 'recovery-iso-download',
  entityLabel: 'Recovery media',
  component: 'recovery-iso',
  filenameFor: (os, arch) => (os === 'linux' ? `breeze-recovery-linux-${arch}.iso` : undefined),
  invalidOsMessage: (os) => `Recovery media is only available for linux today. Got: ${os}`,
  githubUrlFor: (_os, arch, version) => getGithubRecoveryIsoUrl(arch, version),
  store: 'agent',
});

// breeze-user-helper: the GUI-subsystem sibling of breeze-agent (Windows in
// practice; route stays OS-general like the watchdog route it mirrors),
// spawned by the agent's sessionbroker into the interactive user session. It is
// a distinct binary from the Tauri "helper" app (/download/helper) and is
// fetched by the agent's verified updater (component=user-helper). Without this
// server-relative route the agent-versions response handed back the canonical
// github.com asset URL, which the updater's host-equality check rejects (#1878).
// Mirrors the watchdog route: github redirect / S3 presign / local disk.
registerComponentDownloadRoute({
  path: '/download/user-helper/:os/:arch',
  logTag: 'user-helper-download',
  entityLabel: 'User-helper binary',
  component: 'user-helper',
  filenameFor: perArchFilename('user-helper'),
  githubUrlFor: getGithubUserHelperUrl,
  store: 'agent',
});

// ============================================
// Install Script (public, no auth)
// ============================================

function resolveInstallScriptServerUrl(requestUrl: string): string | null {
  const configured =
    process.env.BREEZE_SERVER ||
    process.env.PUBLIC_API_URL ||
    process.env.API_URL;
  if (configured) return configured.replace(/\/$/, '');

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return new URL(requestUrl).origin.replace(/\/$/, '');
}

downloadRoutes.get('/install.sh', async (c) => {
  const rateLimited = await enforcePublicAgentDownloadRateLimit(c, 'install-script-download');
  if (rateLimited) return rateLimited;

  const serverUrl = resolveInstallScriptServerUrl(c.req.url);
  if (!serverUrl) {
    return c.json(
      { error: 'Installer script unavailable: server URL is not configured' },
      503
    );
  }

  const script = generateInstallScript(serverUrl);

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

downloadRoutes.get('/uninstall.sh', async (c) => {
  const rateLimited = await enforcePublicAgentDownloadRateLimit(c, 'uninstall-script-download');
  if (rateLimited) return rateLimited;

  return new Response(generateUninstallScript(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

function generateUninstallScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

AGENT_BINARY="/usr/local/bin/breeze-agent"
AGENT_BINARY_TRUSTED="/Library/Breeze/bin/breeze-agent"
WATCHDOG_BINARY="/usr/local/bin/breeze-watchdog"
BACKUP_BINARY="/usr/local/bin/breeze-backup"

fatal() {
  echo "Error: $*" >&2
  exit 1
}

warn() {
  echo "Warning: $*" >&2
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fatal "must run as root (sudo $0)"
  fi
}

# Package-owned macOS teardown. Embedded in Go; copied into download scripts.
# BEGIN BREEZE MACOS UNINSTALL FUNCTIONS
breeze_bootout() {
  target="$1"
  command -v launchctl >/dev/null 2>&1 || return 1
  if launchctl bootout "$target" 2>/dev/null; then
    return 0
  fi
  # An absent job is already stopped; a job that remains loaded is a failure.
  status=0
  launchctl print "$target" >/dev/null 2>&1 || status=$?
  # launchctl uses 113 (service not found) for an absent service target.
  if [ "$status" -ne 113 ]; then
    echo "Error: could not confirm $target stopped (launchctl status $status)" >&2
    return 1
  fi
}

breeze_stop_watchdog() {
  breeze_bootout system/com.breeze.watchdog
}

breeze_stop_helpers() {
  # Include fast-user-switched sessions, not just the foreground console user.
  sessions="$(ps -axo pid=,uid=,comm=)" || return 1
  uids="$(printf '%s\\n' "$sessions" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $2 >= 500 && $NF ~ /(^|\\/)loginwindow$/ {print $2}' | sort -u)"
  for uid in $uids; do
    breeze_bootout "gui/$uid/com.breeze.desktop-helper-user" || return 1
  done
  # LoginWindow is a session type, not a launchctl domain name. Address each
  # actual loginwindow process's domain, including the root login-screen session.
  pids="$(printf '%s\\n' "$sessions" | awk '$1 ~ /^[0-9]+$/ && $1 > 0 && $2 ~ /^[0-9]+$/ && $NF ~ /(^|\\/)loginwindow$/ {print $1}' | sort -u)"
  for pid in $pids; do
    breeze_bootout "pid/$pid/com.breeze.desktop-helper-loginwindow" || return 1
  done
}

# Callers stop every job and remove the live agent binary first. This removes
# every Breeze binary from BOTH install directories: an agent relocated to
# /Library/Breeze/bin can still leave a pre-relocation copy in /usr/local/bin.
# Logs in /Library/Logs/Breeze are kept on purpose (they record the uninstall).
breeze_remove_auxiliary() {
  rm -f /Library/LaunchDaemons/com.breeze.watchdog.plist \\
    /Library/LaunchAgents/com.breeze.desktop-helper-user.plist \\
    /Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist \\
    /usr/local/bin/breeze-agent /usr/local/bin/breeze-watchdog \\
    /usr/local/bin/breeze-desktop-helper /usr/local/bin/breeze-backup \\
    /Library/Breeze/bin/breeze-agent /Library/Breeze/bin/breeze-watchdog \\
    /Library/Breeze/bin/breeze-desktop-helper /Library/Breeze/bin/breeze-backup \\
    /Library/Breeze/pkg-staging/breeze-agent \\
    /Library/Breeze/pkg-staging/breeze-watchdog \\
    /Library/Breeze/pkg-staging/breeze-backup \\
    "/Library/Application Support/Breeze/agent.sock" || return 1
  # Remove the tree only while empty: anything else in it is not ours to delete.
  rmdir /Library/Breeze/pkg-staging /Library/Breeze/bin /Library/Breeze 2>/dev/null || true
  if [ -d /Library/Breeze ]; then
    echo "Note: left /Library/Breeze in place because it is not empty" >&2
  fi
  # self_uninstall disables the agent label so a reboot mid-teardown cannot
  # restart it. With the plists gone that is no longer needed, and a label left
  # disabled makes the next install's bootstrap fail with EIO 5 (#7831).
  # POSIX sh has no \`local\`: prefixed names keep these out of callers' way.
  for _breeze_label in com.breeze.agent com.breeze.watchdog; do
    _breeze_out="$(launchctl enable "system/$_breeze_label" 2>&1)" ||
      echo "Warning: could not clear the launchd disable for $_breeze_label ($_breeze_out); the .pkg and 'breeze-agent service install' re-enable it" >&2
  done
  # Only forget this package's receipt; configuration and logs retain their policy.
  receipts="$(pkgutil --pkgs)" || return 1
  # Consume all input: grep -q can SIGPIPE printf under Bash pipefail.
  if printf '%s\\n' "$receipts" | grep -Fx com.breeze.agent >/dev/null; then
    pkgutil --forget com.breeze.agent || return 1
  fi
}
# END BREEZE MACOS UNINSTALL FUNCTIONS

uninstall_macos() {
  echo "Uninstalling Breeze Agent for macOS..."
  breeze_stop_watchdog || return 1
  breeze_stop_helpers || return 1
  breeze_bootout system/com.breeze.agent || return 1
  rm -f /Library/LaunchDaemons/com.breeze.agent.plist "$AGENT_BINARY" "$AGENT_BINARY_TRUSTED" || return 1
  breeze_remove_auxiliary || return 1

  echo "Breeze Agent uninstalled."
  echo "Config at /Library/Application Support/Breeze/ was preserved."
  echo "To remove config: sudo rm -rf '/Library/Application Support/Breeze'"
  echo "Logs at /Library/Logs/Breeze/ were kept. To remove them: sudo rm -rf /Library/Logs/Breeze"
}

uninstall_linux() {
  local agent_service="/etc/systemd/system/breeze-agent.service"
  local watchdog_service="/etc/systemd/system/breeze-watchdog.service"
  local user_service="/usr/lib/systemd/user/breeze-agent-user.service"
  local xdg_autostart="/etc/xdg/autostart/breeze-agent-user.desktop"
  local ipc_dir="/var/run/breeze"

  echo "Uninstalling Breeze Agent for Linux..."

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet breeze-agent 2>/dev/null; then
      systemctl stop breeze-agent
      echo "Service stopped."
    fi
    if systemctl is-enabled --quiet breeze-agent 2>/dev/null; then
      systemctl disable breeze-agent
    fi
    if systemctl is-active --quiet breeze-watchdog 2>/dev/null; then
      systemctl stop breeze-watchdog
      echo "Watchdog service stopped."
    fi
    if systemctl is-enabled --quiet breeze-watchdog 2>/dev/null; then
      systemctl disable breeze-watchdog
    fi
  else
    warn "systemctl not found; skipping service stop and disable"
  fi

  rm -f "$agent_service"
  rm -f "$watchdog_service"
  rm -f "$user_service"
  rm -f "$xdg_autostart"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"
  rm -f "$BACKUP_BINARY"
  rmdir "$ipc_dir" 2>/dev/null || true

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi

  echo "Breeze Agent uninstalled."
  echo "Config at /etc/breeze/ was preserved."
  echo "To remove config: sudo rm -rf /etc/breeze"
}

require_root

uname_s="$(uname -s)"
case "$uname_s" in
  Darwin*) uninstall_macos ;;
  Linux*) uninstall_linux ;;
  *) fatal "unsupported operating system: $uname_s. Only Linux and macOS are supported by this uninstaller." ;;
esac
`;
}

function generateInstallScript(serverUrl: string): string {
  return `#!/usr/bin/env bash
# ============================================
# Breeze RMM Agent - One-Line Installer
# ============================================
# Usage (enrollment token from the Add Device dialog):
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --token YOUR_ENROLLMENT_TOKEN
#
# The enrollment token is REQUIRED — it identifies the org/site to enroll into.
# An org enrollment secret (--enrollment-secret) is an OPTIONAL extra gate that
# the server can require IN ADDITION to the token; it is never a substitute for
# it. Pass both when your server is configured with AGENT_ENROLLMENT_SECRET:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --token YOUR_ENROLLMENT_TOKEN \\
#     --enrollment-secret YOUR_SECRET
#
# Or with environment variables — pass them through sudo, since a plain
# \`export\` is stripped by sudo's env_reset:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | \\
#     sudo BREEZE_SERVER="${serverUrl}" BREEZE_ENROLL_TOKEN="YOUR_ENROLLMENT_TOKEN" bash
# ============================================

set -euo pipefail

# ----- Colors -----
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m' # No Color

info()    { echo -e "\${BLUE}[INFO]\${NC}  $*"; }
success() { echo -e "\${GREEN}[OK]\${NC}    $*"; }
warn()    { echo -e "\${YELLOW}[WARN]\${NC}  $*"; }
error()   { echo -e "\${RED}[ERROR]\${NC} $*" >&2; }
fatal()   { error "$*"; exit 1; }

# ----- Parse arguments -----
BREEZE_SERVER="\${BREEZE_SERVER:-}"
BREEZE_ENROLL_TOKEN="\${BREEZE_ENROLL_TOKEN:-}"
BREEZE_ENROLLMENT_SECRET="\${BREEZE_ENROLLMENT_SECRET:-}"
BREEZE_SITE_ID="\${BREEZE_SITE_ID:-}"
BREEZE_DEVICE_ROLE="\${BREEZE_DEVICE_ROLE:-}"

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --server)
      BREEZE_SERVER="\$2"; shift 2 ;;
    --token)
      BREEZE_ENROLL_TOKEN="\$2"; shift 2 ;;
    --enrollment-secret)
      BREEZE_ENROLLMENT_SECRET="\$2"; shift 2 ;;
    --site-id)
      BREEZE_SITE_ID="\$2"; shift 2 ;;
    --device-role)
      BREEZE_DEVICE_ROLE="\$2"; shift 2 ;;
    *)
      warn "Unknown argument: \$1"; shift ;;
  esac
done

# ----- Validate required parameters -----
if [[ -z "\$BREEZE_SERVER" ]]; then
  fatal "BREEZE_SERVER is required. Pass --server URL or export BREEZE_SERVER."
fi

# The enrollment token is mandatory end-to-end: the agent's \`enroll\` command
# takes it as a required positional arg, and the server resolves the org/site
# from it. --enrollment-secret is only a supplementary gate, never a standalone
# credential — accepting it alone here used to pass validation and then die at
# the very last step with cobra's "accepts 1 arg(s), received 0". Fail at the
# first step instead, with actionable guidance.
if [[ -z "\$BREEZE_ENROLL_TOKEN" ]]; then
  fatal "An enrollment token is required. Pass --token TOKEN (or BREEZE_ENROLL_TOKEN through sudo). Generate one from the Add Device dialog. --enrollment-secret is an optional extra gate, not a replacement for the token."
fi

# Strip trailing slash from server URL
BREEZE_SERVER="\${BREEZE_SERVER%/}"

# ----- Detect OS -----
detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "\$uname_s" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)       fatal "Unsupported operating system: \$uname_s. Only Linux and macOS are supported by this installer." ;;
  esac
}

# ----- Detect Architecture -----
detect_arch() {
  local uname_m
  uname_m="$(uname -m)"
  case "\$uname_m" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *)               fatal "Unsupported architecture: \$uname_m. Only amd64 and arm64 are supported." ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
if [[ "\$OS" == "darwin" ]]; then
  case "\$BREEZE_SERVER" in
    https://*|http://127.0.0.1:*|http://localhost:*) ;;
    *) fatal "macOS privileged installer downloads require HTTPS. Refusing insecure transport." ;;
  esac
fi
INSTALL_DIR="/usr/local/bin"
if [[ "\$OS" == "darwin" ]]; then
  CONFIG_DIR="/Library/Application Support/Breeze"
else
  CONFIG_DIR="/etc/breeze"
fi
BINARY_NAME="breeze-agent"
DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}"
PKG_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}/pkg"
VERSION_METADATA_URL="\${BREEZE_SERVER}/api/v1/agent-versions/latest?platform=\${OS}&arch=\${ARCH}&component=agent"
BACKUP_DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/backup/\${OS}/\${ARCH}"
BACKUP_VERSION_METADATA_URL="\${BREEZE_SERVER}/api/v1/agent-versions/latest?platform=\${OS}&arch=\${ARCH}&component=backup"

info "Breeze RMM Agent Installer"
info "  Server:       \$BREEZE_SERVER"
info "  OS:           \$OS"
info "  Architecture: \$ARCH"
info "  Download URL: \$DOWNLOAD_URL"
echo ""

# ----- Check root -----
if [[ "\$(id -u)" -ne 0 ]]; then
  fatal "This installer must be run as root (use sudo)."
fi

# ----- Check for curl -----
if ! command -v curl &>/dev/null; then
  fatal "curl is required but not installed. Install it and try again."
fi

# ----- Pre-flight: verify this machine can actually reach the Breeze API -----
# Catches split-connectivity setups (guest VLANs, no NAT hairpinning, web
# filters) up front, instead of letting a later step fail with a cryptic
# OS-level error after downloading garbage.
#
# Probe the version-metadata endpoint — an /api/* path the install genuinely
# depends on (it is re-fetched below for the checksum) — NOT the apex /health.
# A reverse proxy that forwards /api/* to the API but not bare /health is a
# common self-hosted setup; probing /health there returns the web app's 404 and
# aborts an install that would otherwise succeed (issue #1470).
info "Checking connectivity to \$BREEZE_SERVER..."
PREFLIGHT_FILE="$(mktemp)"
trap 'rm -f "\$PREFLIGHT_FILE"' EXIT
CURL_RC=0
PREFLIGHT_CODE="$(curl -fsSL -m 20 -w '%{http_code}' -o "\$PREFLIGHT_FILE" "\$VERSION_METADATA_URL" 2>/dev/null)" || CURL_RC=\$?
PREFLIGHT_CODE="\${PREFLIGHT_CODE:-000}"

if [[ "\$PREFLIGHT_CODE" != "200" ]]; then
  # curl's exit code names the transport failure precisely — branch on the
  # ones whose remediation differs from generic "check your network".
  case "\$CURL_RC" in
    35|60)
      fatal "TLS problem connecting to \$BREEZE_SERVER — the server certificate could not be verified, or something is intercepting HTTPS on this network." ;;
    28)
      fatal "Connection to \$BREEZE_SERVER timed out. Verify this machine has network access to the server — check DNS, firewall rules, and VLAN restrictions." ;;
  esac
  if [[ "\$PREFLIGHT_CODE" == "000" ]]; then
    # No HTTP status line came back. Distinguish "connected, but the server gave
    # an empty/garbled reply" (API down/crashing behind a working proxy) from a
    # true network-layer failure — the remediation points at different layers.
    case "\$CURL_RC" in
      52|56|18|55)
        fatal "\$BREEZE_SERVER accepted the connection but returned no valid HTTP response (curl error \$CURL_RC). The API may be down or crashing behind your reverse proxy — check the API service logs." ;;
      *)
        fatal "Cannot reach the Breeze server at \$BREEZE_SERVER (no response, curl error \$CURL_RC). Verify this machine has network access to the server — check DNS, firewall rules, and VLAN restrictions." ;;
    esac
  fi
  fatal "Cannot reach the Breeze API at \$BREEZE_SERVER (HTTP \$PREFLIGHT_CODE). Verify the server URL is correct, the API is running, and your reverse proxy forwards /api/* to it (not just the web app)."
fi

# A 200 whose body is HTML means a middlebox answered for the API endpoint
# instead of the Breeze server. Same interception guard as the metadata download
# below (the .pkg path checks xar magic bytes instead).
if grep -qiE '<html|<!doctype' "\$PREFLIGHT_FILE"; then
  fatal "Got a web page instead of an API response from \$BREEZE_SERVER — a captive portal, router, or web filter may be intercepting traffic on this network."
fi

# Positively confirm the Breeze API answered — not merely "not HTML". The
# agent-versions metadata always carries a "version" field; a 200 without it is
# a wrong responder (proxy stub, auth gateway), so don't claim "reachable".
if ! grep -q '"version"[[:space:]]*:' "\$PREFLIGHT_FILE"; then
  fatal "Reached \$BREEZE_SERVER but the agent-versions API returned an unexpected response — something other than the Breeze server may be answering on this network."
fi

rm -f "\$PREFLIGHT_FILE"
trap - EXIT
success "Breeze server is reachable"

sha256_file() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  fatal "sha256sum or shasum is required but not installed. Install one and try again."
}

extract_checksum() {
  grep -oE '"checksum"[[:space:]]*:[[:space:]]*"[a-fA-F0-9]{64}"' "$1" | head -1 | sed -E 's/.*"([a-fA-F0-9]{64})".*/\\1/' | tr 'A-F' 'a-f'
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual

  if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
    fatal "Release metadata did not include a valid SHA-256 checksum for \$OS/\$ARCH."
  fi

  actual="$(sha256_file "$file" | tr 'A-F' 'a-f')"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$file"
    fatal "Checksum verification failed for downloaded agent binary. Expected \$expected, got \$actual."
  fi
}

# ----- macOS: use .pkg installer -----
if [[ "\$OS" == "darwin" ]]; then
  info "Downloading macOS installer package..."
  TMPPKG_DIR="$(mktemp -d)"
  TMPPKG="\$TMPPKG_DIR/breeze-agent.pkg"
  PKG_HEADERS="\$TMPPKG_DIR/headers"
  trap 'rm -rf "$(dirname "\$TMPPKG")"' EXIT

  HTTP_CODE="$(curl -fsSL -D "\$PKG_HEADERS" -w '%{http_code}' -o "\$TMPPKG" "\$PKG_URL" 2>/dev/null)" || true

  if [[ "\$HTTP_CODE" != "200" ]]; then
    fatal "Failed to download installer package (HTTP \$HTTP_CODE). Check that the server URL is correct."
  fi

  if [[ ! -s "\$TMPPKG" ]]; then
    fatal "Downloaded package is empty. The installer may not be available for \$ARCH."
  fi

  success "Downloaded installer package ($(wc -c < "\$TMPPKG" | tr -d ' ') bytes)"

  header_value() {
    grep -i "^\$1:" "\$PKG_HEADERS" | tail -1 | cut -d ':' -f 2- | sed -e 's/^[[:space:]]*//' -e 's/\r$//' || true
  }
  EXPECTED_PKG_SHA256="$(header_value X-Breeze-Artifact-SHA256)"
  EXPECTED_TEAM_ID="$(header_value X-Breeze-MacOS-Team-ID)"
  EXPECTED_SIGNING_IDENTITY_B64="$(header_value X-Breeze-MacOS-Signing-Identity-Base64)"
  # BSD base64 (real macOS /usr/bin/base64) only accepts -D for decode; GNU
  # base64 (e.g. this script's darwin branch exercised under test on a Linux
  # runner) only accepts -d. Try both so decoding works on either, without
  # weakening the authenticated-metadata check below on a genuine failure.
  EXPECTED_SIGNING_IDENTITY="$(printf '%s' "\$EXPECTED_SIGNING_IDENTITY_B64" | /usr/bin/base64 -D 2>/dev/null || printf '%s' "\$EXPECTED_SIGNING_IDENTITY_B64" | /usr/bin/base64 -d 2>/dev/null || true)"
  if ! [[ "\$EXPECTED_PKG_SHA256" =~ ^[a-f0-9]{64}$ ]] ||
     ! [[ "\$EXPECTED_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] ||
     [[ -z "\$EXPECTED_SIGNING_IDENTITY" ]]; then
    fatal "Server did not provide authenticated installer metadata. Refusing to install."
  fi
  verify_sha256 "\$TMPPKG" "\$EXPECTED_PKG_SHA256"

  # A path-selective middlebox can pass the connectivity pre-flight and still
  # intercept the download path. macOS .pkg files are xar archives — anything
  # else (typically a portal's HTML) must be blamed on the network, not on
  # Gatekeeper below.
  if [[ "$(head -c 4 "\$TMPPKG")" != 'xar!' ]]; then
    fatal "Downloaded file is not a macOS installer package — something on this network may be intercepting requests to \$BREEZE_SERVER (captive portal, proxy, or web filter)."
  fi

  # Bind the Apple signer to the exact publisher identity recorded in the signed
  # release manifest. Gatekeeper alone accepts any Apple-approved installer.
  SIGNATURE_DETAILS="$(pkgutil --check-signature "\$TMPPKG" 2>&1)" ||
    fatal "Installer package signature is invalid. Refusing to install."
  ACTUAL_SIGNING_IDENTITY="$(printf '%s\n' "\$SIGNATURE_DETAILS" | sed -n 's/^[[:space:]]*1\. //p' | head -1)"
  if [[ "\$ACTUAL_SIGNING_IDENTITY" != "\$EXPECTED_SIGNING_IDENTITY" ]] ||
     [[ "\$ACTUAL_SIGNING_IDENTITY" != *" (\$EXPECTED_TEAM_ID)" ]]; then
    fatal "Installer package publisher identity does not match the signed release policy. Refusing to install."
  fi

  # Verify Apple notarization/signature before installing as root — the installer
  # CLI does not enforce Gatekeeper on its own, so a tampered/MITM'd download
  # would otherwise be installed with full privileges.
  info "Verifying installer package signature..."
  if ! spctl --assess --type install "\$TMPPKG" >/dev/null 2>&1; then
    fatal "Installer package failed Gatekeeper notarization assessment. Refusing to install."
  fi
  success "Verified installer package notarization"

  info "Installing Breeze Agent..."
  installer -pkg "\$TMPPKG" -target /
  success "Package installed (binary, launchd service, directories)"

  rm -rf "$(dirname "\$TMPPKG")"
  trap - EXIT

  # Enroll agent
  info "Enrolling agent with Breeze server..."
  ENROLL_ARGS=(enroll --server "\$BREEZE_SERVER")
  if [[ -n "\$BREEZE_SITE_ID" ]]; then
    ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
  fi
  if [[ -n "\$BREEZE_DEVICE_ROLE" ]]; then
    ENROLL_ARGS+=(--device-role "\$BREEZE_DEVICE_ROLE")
  fi

  # The enrollment token and secret are handed to the agent through its
  # environment rather than its command line: any other local account can
  # read a process's argv (e.g. /proc/*/cmdline on Linux, ps on macOS), but
  # not another user's environment. Scoped with a VAR=value prefix so it only
  # applies to this one invocation, never exported into this shell.
  if ! BREEZE_AGENT_ENROLLMENT_KEY="\$BREEZE_ENROLL_TOKEN" BREEZE_AGENT_ENROLLMENT_SECRET="\$BREEZE_ENROLLMENT_SECRET" \
      "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
    fatal "Enrollment failed. Check the server URL and that the enrollment token is valid and not expired (plus the enrollment secret, if your server requires one)."
  fi
  success "Agent enrolled successfully"

  # Restart the service so it picks up the new enrollment config. Surface a
  # failure instead of swallowing it — otherwise an enrolled device that never
  # starts looks like a success to the operator.
  if ! launchctl kickstart -k system/com.breeze.agent 2>/dev/null; then
    warn "Could not restart the agent service automatically; it will start on next login or reboot."
  fi

  echo ""
  success "Breeze agent installation complete!"
  info "The device should appear in your Breeze dashboard within 60 seconds."
  info "  Check status:  sudo launchctl list | grep breeze"
  info "  View logs:     tail -f /Library/Logs/Breeze/agent.log"
  exit 0
fi

# ----- Linux: download binary directly -----
info "Fetching release integrity metadata..."
METADATA_FILE="$(mktemp)"
trap 'rm -f "\$METADATA_FILE"' EXIT

METADATA_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$METADATA_FILE" "\$VERSION_METADATA_URL" 2>/dev/null)" || true
if [[ "\$METADATA_HTTP_CODE" != "200" ]]; then
  fatal "Failed to fetch release integrity metadata (HTTP \$METADATA_HTTP_CODE). Refusing to install without a trusted checksum."
fi

# Same path-selective interception guard as the macOS branch: a 200 whose
# body is HTML is a middlebox answering for the metadata endpoint.
if grep -qiE '<html|<!doctype' "\$METADATA_FILE"; then
  fatal "Got a web page instead of release metadata from \$BREEZE_SERVER — something on this network may be intercepting requests (captive portal, proxy, or web filter)."
fi

EXPECTED_SHA256="$(extract_checksum "\$METADATA_FILE")"
if [[ -z "\$EXPECTED_SHA256" ]]; then
  fatal "Release integrity metadata did not include a valid checksum. Refusing to install."
fi
success "Release checksum metadata fetched"

info "Downloading agent binary..."
TMPFILE="$(mktemp)"
trap 'rm -f "\$TMPFILE" "\$METADATA_FILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$TMPFILE" "\$DOWNLOAD_URL" 2>/dev/null)" || true

if [[ "\$HTTP_CODE" != "200" ]]; then
  fatal "Failed to download agent binary (HTTP \$HTTP_CODE). Check that the server URL is correct and the binary is available."
fi

if [[ ! -s "\$TMPFILE" ]]; then
  fatal "Downloaded file is empty. The agent binary may not be built for \$OS/\$ARCH."
fi

success "Downloaded agent binary ($(wc -c < "\$TMPFILE" | tr -d ' ') bytes)"

info "Verifying agent binary checksum..."
verify_sha256 "\$TMPFILE" "\$EXPECTED_SHA256"
success "Verified agent binary checksum"

# ----- Stop existing service before replacing binary (safe for upgrades) -----
if command -v systemctl &>/dev/null && systemctl is-active --quiet breeze-agent 2>/dev/null; then
  info "Stopping existing Breeze Agent service..."
  if ! systemctl stop breeze-agent 2>&1; then
    warn "Failed to stop existing service cleanly — continuing anyway"
  fi
fi

# ----- Install binary -----
info "Installing to \$INSTALL_DIR/\$BINARY_NAME..."
mv "\$TMPFILE" "\$INSTALL_DIR/\$BINARY_NAME"
chmod 755 "\$INSTALL_DIR/\$BINARY_NAME"
# On SELinux-enforcing hosts (Fedora family) the binary inherits the mktemp
# file's user_tmp_t label through the mv, so systemd/init is denied execute
# (203/EXEC) after a reboot. Restore the default context for the install path.
# Guarded by command existence so it is a no-op on non-SELinux systems.
if command -v restorecon &>/dev/null; then
  restorecon -v "\$INSTALL_DIR/\$BINARY_NAME" 2>/dev/null || true
fi
trap - EXIT
success "Installed \$INSTALL_DIR/\$BINARY_NAME"

# ----- Install breeze-backup (non-fatal) -----
# breeze-backup runs scheduled backup jobs; it is a separate release asset from
# the agent and its absence does not block enrollment or monitoring. The whole
# step runs in a subshell so \`fatal\` (which calls exit) only aborts backup
# installation, not the rest of this script — reuses the same
# fetch/extract_checksum/verify_sha256 helpers as the agent binary above.
info "Fetching breeze-backup..."
if (
  BACKUP_METADATA_FILE="$(mktemp)"
  trap 'rm -f "\$BACKUP_METADATA_FILE"' EXIT

  BACKUP_METADATA_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$BACKUP_METADATA_FILE" "\$BACKUP_VERSION_METADATA_URL" 2>/dev/null)" || true
  if [[ "\$BACKUP_METADATA_HTTP_CODE" != "200" ]]; then
    fatal "Failed to fetch breeze-backup release metadata (HTTP \$BACKUP_METADATA_HTTP_CODE)."
  fi

  BACKUP_EXPECTED_SHA256="$(extract_checksum "\$BACKUP_METADATA_FILE")"
  if [[ -z "\$BACKUP_EXPECTED_SHA256" ]]; then
    fatal "breeze-backup release metadata did not include a valid checksum."
  fi

  BACKUP_TMPFILE="$(mktemp)"
  trap 'rm -f "\$BACKUP_TMPFILE" "\$BACKUP_METADATA_FILE"' EXIT

  BACKUP_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$BACKUP_TMPFILE" "\$BACKUP_DOWNLOAD_URL" 2>/dev/null)" || true
  if [[ "\$BACKUP_HTTP_CODE" != "200" ]]; then
    fatal "Failed to download breeze-backup binary (HTTP \$BACKUP_HTTP_CODE)."
  fi
  if [[ ! -s "\$BACKUP_TMPFILE" ]]; then
    fatal "Downloaded breeze-backup binary is empty."
  fi

  verify_sha256 "\$BACKUP_TMPFILE" "\$BACKUP_EXPECTED_SHA256"

  # This subshell is the test of an \`if\`, so \`set -e\` is ignored inside it —
  # mv/chmod failures would otherwise be silently swallowed instead of tripping
  # the subshell's exit status. Check each explicitly and route through fatal
  # (an unconditional \`exit\`, unaffected by -e) so a real failure here is
  # reported as "could not be installed", not a false success.
  if ! mv "\$BACKUP_TMPFILE" "\$INSTALL_DIR/breeze-backup"; then
    fatal "Failed to install breeze-backup binary to \$INSTALL_DIR/breeze-backup."
  fi
  if ! chmod 755 "\$INSTALL_DIR/breeze-backup"; then
    fatal "Failed to set permissions on \$INSTALL_DIR/breeze-backup."
  fi
  if command -v restorecon &>/dev/null; then
    restorecon -v "\$INSTALL_DIR/breeze-backup" 2>/dev/null || true
  fi
  trap - EXIT
); then
  success "Installed \$INSTALL_DIR/breeze-backup"
else
  warn "breeze-backup helper could not be installed; backups will not run until it is present"
fi

# ----- Create config directory -----
info "Creating config directory \$CONFIG_DIR..."
mkdir -p "\$CONFIG_DIR"
chmod 0700 "\$CONFIG_DIR"
success "Config directory ready"

# ----- Enroll agent -----
info "Enrolling agent with Breeze server..."
ENROLL_ARGS=(enroll --server "\$BREEZE_SERVER")
if [[ -n "\$BREEZE_SITE_ID" ]]; then
  ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
fi
if [[ -n "\$BREEZE_DEVICE_ROLE" ]]; then
  ENROLL_ARGS+=(--device-role "\$BREEZE_DEVICE_ROLE")
fi

# The enrollment token and secret are handed to the agent through its
# environment rather than its command line: any other local account can read
# a process's argv (e.g. /proc/*/cmdline, world-readable on Linux) but not
# another user's environment. Scoped with a VAR=value prefix so it only
# applies to this one invocation, never exported into this shell.
if ! BREEZE_AGENT_ENROLLMENT_KEY="\$BREEZE_ENROLL_TOKEN" BREEZE_AGENT_ENROLLMENT_SECRET="\$BREEZE_ENROLLMENT_SECRET" \
    "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
  fatal "Enrollment failed. Check the server URL and that the enrollment token is valid and not expired (plus the enrollment secret, if your server requires one)."
fi
success "Agent enrolled successfully"

# ----- Install service -----
if command -v systemctl &>/dev/null; then
  info "Installing systemd service..."
  cat > /etc/systemd/system/breeze-agent.service <<SERVICEEOF
[Unit]
Description=Breeze RMM Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/$BINARY_NAME run
Restart=always
RestartSec=10
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent

# Security hardening
NoNewPrivileges=false
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
SERVICEEOF

  systemctl daemon-reload
  systemctl enable breeze-agent
  systemctl start breeze-agent
  success "systemd service installed and started"
else
  warn "systemd not found. Please configure the agent to start on boot manually."
  info "Run: $INSTALL_DIR/$BINARY_NAME run"
fi

echo ""
success "Breeze agent installation complete!"
info "The device should appear in your Breeze dashboard within 60 seconds."
info "  Check status:  sudo systemctl status breeze-agent"
info "  View logs:     sudo journalctl -u breeze-agent -f"
`;
}
