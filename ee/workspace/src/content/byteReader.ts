// Byte readers for content ingest (per-org content flag).
//
// Design decision (2026-07-18 spike): the primary reader is a server-side SMB
// read with the STORED SOURCE CREDENTIAL (v9u-smb2, NTLMv2). It exercises the
// same credential path the crawler uses and works for any reachable share.
// Caveats, both dev-acceptable and documented in dev/README.md:
//   - NTLM needs MD4 → the API process requires NODE_OPTIONS=--openssl-legacy-provider
//     (set only in the untracked dev compose override).
//   - In-container, the share host may need rewriting (WORKSPACE_CONTENT_SMB_HOST_MAP,
//     e.g. "127.0.0.1=host.docker.internal").
// MountedDirReader is the fallback: map source id → local dir via
// WORKSPACE_CONTENT_MOUNT_MAP for estates whose bytes are locally mounted.
//
// DLP runs downstream in contentIngestService, between extraction and
// persistence; bytes read here flow to the extraction step, whose text is then
// DLP-inspected (redact before store, block before embed) before any storage.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface ContentSourceRef {
  id: string;
  orgId: string;
  kind: string;
  rootPath: string;
}

export interface ContentByteReader {
  read(source: ContentSourceRef, relPath: string): Promise<Buffer>;
}

/** Parse "id=/path,id2=/path2" (WORKSPACE_CONTENT_MOUNT_MAP). */
export function parseMountMap(env: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (env ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Parse "host=replacement,…" (WORKSPACE_CONTENT_SMB_HOST_MAP). */
export function parseHostMap(env: string | undefined): Record<string, string> {
  return parseMountMap(env);
}

/** \\host\share → { host, share }. Throws on anything that is not UNC. */
export function parseUncRoot(rootPath: string): { host: string; share: string } {
  const m = rootPath.match(/^\\\\([^\\]+)\\([^\\]+)\\?$/);
  if (!m) throw new Error(`not a UNC root path: ${rootPath}`);
  // Both groups are structurally guaranteed by the match above.
  return { host: m[1]!, share: m[2]! };
}

export class MountedDirReader implements ContentByteReader {
  constructor(private readonly mountMap: Record<string, string>) {}

  async read(source: ContentSourceRef, relPath: string): Promise<Buffer> {
    const base = this.mountMap[source.id];
    if (!base) throw new Error(`no mount mapping for source ${source.id}`);
    const absBase = await realpath(resolve(base));
    const target = resolve(absBase, relPath);
    if (target !== absBase && !target.startsWith(absBase + sep)) {
      throw new Error(`path traversal outside mount root: ${relPath}`);
    }
    // Re-check after resolving symlinks: a link inside the root pointing
    // outside it must not smuggle bytes in (the crawler indexes names only,
    // but the share contents are not under our control).
    const real = await realpath(target);
    if (real !== absBase && !real.startsWith(absBase + sep)) {
      throw new Error(`path traversal outside mount root (symlink): ${relPath}`);
    }
    return readFile(real);
  }
}

export interface SmbClientLike {
  readFile(path: string): Promise<Buffer>;
  disconnect(): void;
}

export interface SmbConnectOptions {
  share: string;
  domain: string;
  username: string;
  password: string;
}

export interface SmbByteReaderDeps {
  /** Decrypted source credential (credentialService.decryptForContentIngest). */
  getCredential(orgId: string, sourceId: string): Promise<{ username: string; password: string; domain: string | null } | null>;
  hostMap: Record<string, string>;
  /** Injectable for tests; defaults to a v9u-smb2 client. */
  smbFactory?: (opts: SmbConnectOptions) => SmbClientLike;
  /**
   * Bound on a single SMB read (which triggers the lazy connect). A source that
   * becomes unreachable by REFUSING gives a fast socket error, but one that is
   * black-holed (firewall drop / network partition — the common production
   * failure) never answers the SYN, so v9u-smb2 would hang the read forever and
   * wedge the ingest job as 'running'. This cap converts that into a normal
   * transient (`reader: … timed out`), which the runner backs off and retries.
   */
  readTimeoutMs?: number;
}

export const DEFAULT_SMB_READ_TIMEOUT_MS = 8_000;

/**
 * Reject if `promise` has not settled within `ms`. The underlying operation is
 * not cancelable (the SMB socket stays hung), so a swallow-handler is attached
 * to keep a late rejection from surfacing as an unhandledRejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  promise.catch(() => { /* swallow settlement that arrives after the timeout */ });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function defaultSmbFactory(opts: SmbConnectOptions): Promise<SmbClientLike> {
  const mod = await import('v9u-smb2');
  const SMB2 = (mod as { default?: unknown }).default ?? mod;
  const client = new (SMB2 as new (o: object) => {
    readFile(p: string): Promise<Buffer>;
    disconnect(): void;
  })({ ...opts, autoCloseTimeout: 0 });
  return client;
}

export class SmbByteReader implements ContentByteReader {
  private clients = new Map<string, SmbClientLike | Promise<SmbClientLike>>();
  private readonly readTimeoutMs: number;

  constructor(private readonly deps: SmbByteReaderDeps) {
    this.readTimeoutMs = deps.readTimeoutMs ?? DEFAULT_SMB_READ_TIMEOUT_MS;
  }

  /** Drop (and best-effort disconnect) the cached client for a source so the
   *  next read reconnects fresh instead of reusing a wedged/dead socket. */
  private evict(sourceId: string): void {
    const c = this.clients.get(sourceId);
    this.clients.delete(sourceId);
    if (c && !(c instanceof Promise)) {
      try { c.disconnect(); } catch { /* best effort */ }
    }
  }

  private async clientFor(source: ContentSourceRef): Promise<SmbClientLike> {
    const existing = this.clients.get(source.id);
    if (existing) return existing;
    const pending = (async () => {
      const cred = await this.deps.getCredential(source.orgId, source.id);
      if (!cred) throw new Error(`no credential stored for source ${source.id}`);
      const { host, share } = parseUncRoot(source.rootPath);
      const mappedHost = this.deps.hostMap[host] ?? host;
      const opts: SmbConnectOptions = {
        share: `\\\\${mappedHost}\\${share}`,
        domain: cred.domain ?? 'WORKGROUP',
        username: cred.username,
        password: cred.password,
      };
      return this.deps.smbFactory ? this.deps.smbFactory(opts) : defaultSmbFactory(opts);
    })();
    this.clients.set(source.id, pending);
    try {
      const client = await pending;
      this.clients.set(source.id, client);
      return client;
    } catch (error) {
      this.clients.delete(source.id);
      throw error;
    }
  }

  async read(source: ContentSourceRef, relPath: string): Promise<Buffer> {
    const client = await this.clientFor(source);
    try {
      return await withTimeout(
        client.readFile(relPath.replace(/\//g, '\\')),
        this.readTimeoutMs,
        `smb read timed out after ${this.readTimeoutMs}ms`,
      );
    } catch (err) {
      // A failed or timed-out read may have wedged the cached connection; drop it
      // so the retry reconnects fresh. The throw propagates to contentIngest,
      // which wraps it as a `reader:` transient (source-down → back off + retry).
      this.evict(source.id);
      throw err;
    }
  }

  disconnectAll(): void {
    for (const c of this.clients.values()) {
      if (c instanceof Promise) continue;
      try { c.disconnect(); } catch { /* best effort */ }
    }
    this.clients.clear();
  }
}

/**
 * Default reader wiring: mounted-dir when WORKSPACE_CONTENT_MOUNT_MAP is set
 * (dev fallback), otherwise SMB with the stored source credential (primary).
 */
export function buildContentReader(
  getCredential: SmbByteReaderDeps['getCredential'],
): ContentByteReader {
  const mountMap = parseMountMap(process.env.WORKSPACE_CONTENT_MOUNT_MAP);
  if (Object.keys(mountMap).length > 0) return new MountedDirReader(mountMap);
  const timeoutEnv = Number(process.env.WORKSPACE_CONTENT_SMB_TIMEOUT_MS);
  return new SmbByteReader({
    getCredential,
    hostMap: parseHostMap(process.env.WORKSPACE_CONTENT_SMB_HOST_MAP),
    readTimeoutMs: Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : undefined,
  });
}
