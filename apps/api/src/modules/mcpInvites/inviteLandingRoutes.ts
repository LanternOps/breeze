import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deploymentInvites } from '../../db/schema';
import {
  peekShortCode,
  redeemShortCode,
} from '../../routes/enrollmentKeys';
import {
  buildMacosInstallerZip,
  buildWindowsInstallerZip,
  fetchMacosPkg,
  fetchRegularMsi,
} from '../../services/installerBuilder';

/**
 * OS-detecting invite landing route for MCP-provisioned deployments.
 *
 * Pairs with `send_deployment_invites`:
 *   1. That tool emails recipients a link to `/i/:shortCode`.
 *   2. Here we detect the recipient's OS from the User-Agent and show a
 *      one-button landing page that downloads a pre-configured installer
 *      for that OS (with Windows/macOS/Linux fallback links).
 *   3. `/i/:shortCode/download/:os` mints a fresh single-use child
 *      enrollment key and serves the signed installer zip with the token
 *      baked in.
 *
 * Mounted only when `IS_HOSTED=true`.
 */

type DetectedOs = 'win' | 'mac' | 'linux' | 'unknown';
type DownloadOs = 'win' | 'mac' | 'linux';

function detectOs(ua: string | null | undefined): DetectedOs {
  if (!ua) return 'unknown';
  // Order matters: "X11" catches most Linux UAs and must run before the
  // Mac check (some Linux browsers include "Mac OS" in X11 strings).
  if (/Linux|X11|Android/i.test(ua)) return 'linux';
  if (/Win/i.test(ua)) return 'win';
  if (/Mac/i.test(ua)) return 'mac';
  return 'unknown';
}

function osLabel(os: DownloadOs): string {
  return os === 'win' ? 'Windows' : os === 'mac' ? 'macOS' : 'Linux';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLanding(args: {
  primaryOs: DownloadOs;
  shortCode: string;
}): string {
  const { primaryOs, shortCode } = args;
  const primaryHref = `/i/${escapeHtml(shortCode)}/download/${primaryOs}`;
  const primaryLabel = `Download for ${osLabel(primaryOs)}`;
  const safeShort = escapeHtml(shortCode);

  // Token values mirrored from apps/web/src/styles/globals.css so this
  // server-rendered page matches the rest of the auth surface (Plus
  // Jakarta Sans, warm slate-blue primary, warm-tinted neutrals).
  const FONT_STACK = '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const PAGE_BG = 'hsl(220 20% 98%)';
  const CARD_BG = 'hsl(220 20% 99%)';
  const BORDER = 'hsl(220 16% 90%)';
  const FG = 'hsl(224 28% 14%)';
  const MUTED = 'hsl(220 10% 46%)';
  const PRIMARY = 'hsl(225 62% 48%)';
  const PRIMARY_FG = '#ffffff';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Install Breeze</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="color-scheme" content="light">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: ${PAGE_BG}; color: ${FG}; font-family: ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
    .shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 3rem 1rem; }
    .container { width: 100%; max-width: 28rem; }
    .brand { text-align: center; margin-bottom: 2rem; }
    .logo { width: 2.25rem; height: 2.25rem; margin: 0 auto; display: flex; align-items: center; justify-content: center; background: hsl(225 62% 48% / 0.15); border-radius: 0.5rem; }
    .brand-name { margin: 0.75rem 0 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand-tag { margin: 0.25rem 0 0; font-size: 0.875rem; color: ${MUTED}; }
    .card { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 0.5rem; padding: 1.5rem; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
    .card h1 { margin: 0 0 0.5rem; font-size: 1.125rem; font-weight: 600; line-height: 1.3; }
    .card p { margin: 0 0 1rem; font-size: 0.875rem; line-height: 1.55; color: ${MUTED}; }
    .btn-primary { display: flex; align-items: center; justify-content: center; height: 2.75rem; width: 100%; background: ${PRIMARY}; color: ${PRIMARY_FG}; border-radius: 0.375rem; text-decoration: none; font-size: 0.875rem; font-weight: 500; transition: opacity 0.15s ease; }
    .btn-primary:hover { opacity: 0.9; }
    .alts { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid ${BORDER}; font-size: 0.8125rem; color: ${MUTED}; text-align: center; }
    .alts-label { display: block; margin-bottom: 0.5rem; }
    .alts a { color: ${PRIMARY}; text-decoration: none; font-weight: 500; }
    .alts a:hover { text-decoration: underline; }
    .alts a + a::before { content: '·'; margin: 0 0.5rem; color: ${BORDER}; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="container">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 64 64" fill="none" style="color: ${PRIMARY};">
            <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h1 class="brand-name">Breeze</h1>
        <p class="brand-tag">Remote Monitoring &amp; Management</p>
      </div>

      <div class="card">
        <h1>Install Breeze on this device</h1>
        <p>Your IT administrator has invited you to install the Breeze agent. The installer will configure itself automatically. Your device password will be required.</p>
        <a href="${primaryHref}" class="btn-primary">${primaryLabel}</a>
        <div class="alts">
          <span class="alts-label">Different operating system?</span>
          <a href="/i/${safeShort}/download/win">Windows</a><a href="/i/${safeShort}/download/mac">macOS</a><a href="/i/${safeShort}/download/linux">Linux</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function mountInviteLandingRoutes(app: Hono): void {
  // Landing page — does NOT consume a slot on the parent short-link row.
  // That happens on `/download/:os` so a user who loads the page but
  // never clicks doesn't burn their invite.
  app.get('/i/:shortCode', async (c) => {
    const shortCode = c.req.param('shortCode');
    const peeked = await peekShortCode(shortCode);
    if (!peeked) {
      return c.text('This install link is invalid or has already been used.', 404);
    }

    // Best-effort invite-click tracking. A short code may exist without a
    // matching deployment_invites row (e.g. legacy admin-created links
    // that happen to be reached through `/i/`), so a no-op update is fine.
    try {
      // Wrap in system DB context — /i/:shortCode is unauthenticated and
      // has no request-scoped tenant context, so RLS on deployment_invites
      // would otherwise match zero rows and silently drop the update.
      await withSystemDbAccessContext(async () => {
        await db
          .update(deploymentInvites)
          .set({ status: 'clicked', clickedAt: new Date() })
          .where(eq(deploymentInvites.enrollmentKeyId, peeked.id));
      });
    } catch (err) {
      // Don't fail the landing page over an audit-side update.
      console.error('[invite-landing] Failed to mark invite clicked:', err instanceof Error ? err.message : err);
    }

    const detected = detectOs(c.req.header('user-agent'));
    // Unknown UAs default to Windows — the most common enterprise client.
    const primaryOs: DownloadOs = detected === 'unknown' ? 'win' : detected;
    return c.html(renderLanding({ primaryOs, shortCode }));
  });

  // Download endpoint — mints a fresh single-use child key, claims a slot
  // on the parent, and serves a pre-configured installer zip.
  app.get('/i/:shortCode/download/:os', async (c) => {
    const shortCode = c.req.param('shortCode');
    const osParam = c.req.param('os') as string;

    if (osParam !== 'win' && osParam !== 'mac' && osParam !== 'linux') {
      return c.text('Unsupported operating system.', 400);
    }

    if (osParam === 'linux') {
      // Linux installer isn't pre-built today. Point the recipient at
      // manual-install docs rather than 500ing or silently failing.
      return c.text(
        'Linux installers are not yet available via invite links. '
          + 'Contact your administrator for manual install instructions.',
        501,
      );
    }

    const redeemed = await redeemShortCode(shortCode);
    if (!redeemed) {
      return c.text('This install link is invalid, expired, or already used.', 404);
    }

    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.text('Server URL not configured.', 500);
    }
    const enrollmentSecret = process.env.AGENT_ENROLLMENT_SECRET || '';

    try {
      let buf: Buffer;
      let filename: string;
      if (osParam === 'win') {
        const msi = await fetchRegularMsi();
        buf = await buildWindowsInstallerZip(msi, {
          serverUrl,
          enrollmentKey: redeemed.rawKey,
          enrollmentSecret,
          siteId: redeemed.siteId,
        });
        filename = 'breeze-agent-windows.zip';
      } else {
        const pkg = await fetchMacosPkg();
        buf = await buildMacosInstallerZip(pkg, {
          serverUrl,
          enrollmentKey: redeemed.rawKey,
          enrollmentSecret,
          siteId: redeemed.siteId,
        });
        filename = 'breeze-agent-macos.zip';
      }

      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', `attachment; filename="${filename}"`);
      c.header('Content-Length', String(buf.length));
      c.header('Cache-Control', 'no-store');
      return c.body(buf as unknown as ArrayBuffer);
    } catch (err) {
      console.error('[invite-landing] Installer build failed:', err instanceof Error ? err.message : err);
      return c.text('Failed to build installer.', 500);
    }
  });
}
