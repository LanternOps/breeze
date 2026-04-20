import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
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
 * Mounted only when `MCP_BOOTSTRAP_ENABLED=true`.
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Install Breeze Agent</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem;color:#111;line-height:1.5">
  <h1 style="margin-bottom:0.5rem;font-size:1.5rem">Install Breeze</h1>
  <p style="color:#555;margin-top:0">Click below to download and install the Breeze monitoring agent for your device. The installer will auto-enroll this machine.</p>
  <a href="${primaryHref}" style="display:inline-block;background:#111;color:#fff;padding:0.75rem 1.5rem;border-radius:6px;text-decoration:none;font-weight:500;margin-top:0.5rem">${primaryLabel}</a>
  <p style="margin-top:2.5rem;color:#666;font-size:0.9rem">
    Other operating systems:
    <a href="/i/${safeShort}/download/win" style="margin-left:0.25rem">Windows</a> ·
    <a href="/i/${safeShort}/download/mac" style="margin-left:0.25rem">macOS</a> ·
    <a href="/i/${safeShort}/download/linux" style="margin-left:0.25rem">Linux</a>
  </p>
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
      await db
        .update(deploymentInvites)
        .set({ status: 'clicked', clickedAt: new Date() })
        .where(eq(deploymentInvites.enrollmentKeyId, peeked.id));
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
