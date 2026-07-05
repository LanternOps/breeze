import { Hono } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { signManifest } from '../../services/manifestSigning';

/**
 * Task 8: serves the pinned winget-bootstrap artifact set (the App Installer
 * bundle + its Appx dependencies) to agents whose SYSTEM-context bootstrapper
 * (agent Tasks 6-7) found winget absent on Windows Server and needs to
 * provision it. Mirrors the release-artifact-manifest signing flow
 * (services/manifestSigning.ts) rather than inventing a new signing scheme,
 * and mirrors download.ts's disk-serving shape for the file bytes.
 *
 * Mounted like every other per-agent route in this package — under
 * `/agents/:id/*` — so `agentAuthMiddleware` (applied by the parent
 * `agentRoutes` in index.ts) gates both endpoints. We key off the
 * token-resolved `c.get('agent')` context, not the raw `:id` path param
 * (same convention as unifiTelemetry.ts).
 */
export const wingetBootstrapRoutes = new Hono();

export interface WingetBootstrapArtifactDescriptor {
  /** Logical name used in the manifest and the /file/:name route. */
  name: string;
  /** Filename on disk under WINGET_BOOTSTRAP_ARTIFACT_DIR. */
  filename: string;
  /** Expected SHA-256 hex digest, verified by the agent after download. */
  sha256: string;
}

// Pinned App Installer bundle set. `sha256` values here are placeholders —
// ops populates the real Microsoft-signed binaries + their true digests into
// WINGET_BOOTSTRAP_ARTIFACT_DIR out of band (never committed to the repo).
// Bump WINGET_BOOTSTRAP_VERSION whenever this set changes so agents can tell
// a stale cached manifest apart from a fresh one.
export const WINGET_BOOTSTRAP_VERSION = '1.24.3911.0';

export const WINGET_BOOTSTRAP_ARTIFACTS: readonly WingetBootstrapArtifactDescriptor[] = [
  {
    name: 'desktop-app-installer',
    filename: 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle',
    sha256: '0'.repeat(64),
  },
  {
    name: 'vclibs-x64',
    filename: 'Microsoft.VCLibs.x64.14.00.Desktop.appx',
    sha256: '0'.repeat(64),
  },
  {
    name: 'ui-xaml-x64',
    filename: 'Microsoft.UI.Xaml.2.8.x64.appx',
    sha256: '0'.repeat(64),
  },
];

// SECURITY: the allowlist that /winget-bootstrap/file/:name is served from.
// The raw `:name` param is looked up here and ONLY here is used to select a
// filename — it is never itself interpolated into a filesystem path. Unknown
// names 404 without ever touching disk, which is also what keeps path
// traversal (`../../etc/passwd`) impossible: an attacker-controlled `:name`
// simply won't be a key in this map.
const ARTIFACTS_BY_NAME: ReadonlyMap<string, WingetBootstrapArtifactDescriptor> = new Map(
  WINGET_BOOTSTRAP_ARTIFACTS.map((artifact) => [artifact.name, artifact]),
);

function getArtifactDir(): string {
  return resolve(process.env.WINGET_BOOTSTRAP_ARTIFACT_DIR || './winget-bootstrap');
}

wingetBootstrapRoutes.get('/:id/winget-bootstrap/manifest', async (c) => {
  const agent = c.get('agent') as AgentAuthContext | undefined;
  if (!agent) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const artifacts = WINGET_BOOTSTRAP_ARTIFACTS.map((artifact) => ({
    name: artifact.name,
    path: `/api/v1/agents/${encodeURIComponent(agent.agentId)}/winget-bootstrap/file/${encodeURIComponent(artifact.name)}`,
    sha256: artifact.sha256,
  }));

  const payload = { version: WINGET_BOOTSTRAP_VERSION, artifacts };
  const signature = await signManifest(JSON.stringify(payload));

  return c.json({ ...payload, signature });
});

wingetBootstrapRoutes.get('/:id/winget-bootstrap/file/:name', async (c) => {
  const agent = c.get('agent') as AgentAuthContext | undefined;
  if (!agent) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const name = c.req.param('name');
  const artifact = ARTIFACTS_BY_NAME.get(name);
  if (!artifact) {
    return c.json({ error: 'Artifact not found' }, 404);
  }

  const artifactDir = getArtifactDir();
  const filePath = join(artifactDir, artifact.filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[winget-bootstrap] Failed to read artifact "${artifact.name}":`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read artifact file' }, 500);
    }
    console.warn('[winget-bootstrap] Local artifact missing', { name: artifact.name, filename: artifact.filename });
    return c.json({ error: 'Artifact not found' }, 404);
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
        console.error(`[winget-bootstrap] Stream error while serving "${artifact.name}":`, err);
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
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});
