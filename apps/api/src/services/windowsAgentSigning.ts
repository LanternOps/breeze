import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getBinarySource, getGithubAgentUrl } from './binarySource';
import { getPresignedUrl, isS3Configured, isS3NotFound } from './s3Storage';

/**
 * Whether the public Windows agent binary Quick Support serves is actually
 * Authenticode-signed — a PRESENCE check only (issue #7185).
 *
 * This inspects the served binary's PE header for a non-empty
 * IMAGE_DIRECTORY_ENTRY_SECURITY (Authenticode certificate table). It does NOT
 * validate the certificate chain, timestamp, or trust anchor — same scope
 * limitation `releaseAssetTrust.ts` documents for its label check, except this
 * one actually looks at bytes instead of a filename-derived label. A
 * self-signed or expired certificate still counts as "signed" here; the goal
 * is only to decide which Quick Support copy matches what Windows will show
 * (a named publisher vs. "Unknown publisher"), not to vouch for the signer.
 *
 * Same source resolution as `GET /support/download/windows`
 * (routes/supportPublic.ts): GitHub release asset in `github` mode, else the
 * S3 object with the on-disk file as fallback. Only the PE header is fetched
 * (a small byte range) — never the full ~60 MB binary.
 */

const SUPPORT_AGENT_OS = 'windows';
const SUPPORT_AGENT_ARCH = 'amd64';
/** Mirrors SUPPORT_AGENT_FILENAME in routes/supportPublic.ts. */
const SUPPORT_AGENT_FILENAME = `breeze-agent-${SUPPORT_AGENT_OS}-${SUPPORT_AGENT_ARCH}.exe`;

/**
 * Bytes needed to reach the Optional Header's data directory table. The
 * certificate table itself lives near the end of the file (Authenticode
 * appends it after the last section), but its RVA/size ENTRY is in the header,
 * well within this range for any PE32/PE32+ image regardless of section
 * count.
 */
const HEADER_BYTES = 8192;

/**
 * Re-checking every `/check` request would mean fetching from GitHub/S3 on
 * every anonymous page load. The binary only changes on a release, so a short
 * TTL is enough to pick up a re-signed release without a restart while keeping
 * steady-state traffic to zero extra fetches.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { signed: boolean; expiresAt: number } | null = null;

const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;
const DOS_MAGIC = 0x5a4d; // 'MZ'
const PE_SIGNATURE = 0x00004550; // 'PE\0\0'
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

/**
 * Parse a buffer of PE header bytes and report whether the Authenticode
 * certificate table is present and non-empty.
 *
 * Returns `null` when the buffer does not parse as a recognizable PE header
 * (too short, wrong magic, unrecognized optional-header format) — the caller
 * treats `null` the same as "unsigned" (fail closed to the honest copy, never
 * to the stronger claim).
 */
export function parseHasAuthenticodeSignature(buffer: Buffer): boolean | null {
  if (buffer.length < 0x40) return null;
  if (buffer.readUInt16LE(0) !== DOS_MAGIC) return null;

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 24 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) return null;

  const coffOffset = peOffset + 4;
  const sizeOfOptionalHeader = buffer.readUInt16LE(coffOffset + 16);
  const optHeaderOffset = coffOffset + 20;
  if (sizeOfOptionalHeader < 2 || optHeaderOffset + 2 > buffer.length) return null;

  const magic = buffer.readUInt16LE(optHeaderOffset);
  let dataDirOffset: number;
  if (magic === PE32_MAGIC) {
    dataDirOffset = optHeaderOffset + 96;
  } else if (magic === PE32_PLUS_MAGIC) {
    dataDirOffset = optHeaderOffset + 112;
  } else {
    return null;
  }

  const securityDirOffset = dataDirOffset + IMAGE_DIRECTORY_ENTRY_SECURITY * 8;
  if (securityDirOffset + 8 > buffer.length) return null;

  const size = buffer.readUInt32LE(securityDirOffset + 4);
  return size > 0;
}

/**
 * A 2xx status alone doesn't prove the origin honored the Range request — an
 * origin that ignores Range headers answers with a plain 200 and the FULL
 * body, which for a ~60 MB binary is exactly the download-per-check-request
 * this design exists to avoid. Only 206 Partial Content is trusted; anything
 * else (including a full 200) is treated as a failed fetch.
 */
function isPartialContentResponse(res: Response): boolean {
  return res.status === 206;
}

async function fetchGithubHeaderBytes(): Promise<Buffer | null> {
  try {
    const url = getGithubAgentUrl(SUPPORT_AGENT_OS, SUPPORT_AGENT_ARCH);
    const res = await fetch(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!isPartialContentResponse(res) || !res.body) {
      console.error(`[windows-agent-signing] GitHub header fetch returned non-partial status ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('[windows-agent-signing] GitHub header fetch failed:', err);
    return null;
  }
}

async function fetchS3HeaderBytes(): Promise<Buffer | null> {
  try {
    const url = await getPresignedUrl(`agent/${SUPPORT_AGENT_FILENAME}`);
    const res = await fetch(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
    if (!isPartialContentResponse(res) || !res.body) {
      console.error(`[windows-agent-signing] S3 header fetch returned non-partial status ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (!isS3NotFound(err)) {
      console.error('[windows-agent-signing] S3 header fetch failed:', err);
    }
    return null;
  }
}

function fetchLocalHeaderBytes(): Buffer | null {
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, SUPPORT_AGENT_FILENAME);
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (err) {
    // ENOENT (binary not built/published yet) is the expected steady state on
    // a fresh self-host checkout — anything else (EACCES, EMFILE/ENFILE) is a
    // real host problem worth a log line rather than a silent "unsigned".
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[windows-agent-signing] local header open failed at ${filePath}:`, err);
    }
    return null;
  }
  try {
    const size = statSync(filePath).size;
    const length = Math.min(HEADER_BYTES, size);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer;
  } catch (err) {
    console.error(`[windows-agent-signing] local header read failed at ${filePath}:`, err);
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the Windows agent binary Quick Support currently serves carries an
 * Authenticode certificate table. Cached briefly per process — see
 * CACHE_TTL_MS.
 *
 * Fetch failure, a missing binary, or bytes that don't parse as a PE header
 * all resolve to `false` (unsigned) rather than throwing or leaving the
 * previous cached value — an unreachable source is exactly the state where
 * the page must NOT promise a publisher name it cannot back up.
 */
export async function isWindowsAgentSigned(): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.signed;

  let bytes: Buffer | null;
  if (getBinarySource() === 'github') {
    bytes = await fetchGithubHeaderBytes();
  } else {
    bytes = isS3Configured() ? await fetchS3HeaderBytes() : null;
    if (!bytes) bytes = fetchLocalHeaderBytes();
  }

  const signed = bytes !== null && parseHasAuthenticodeSignature(bytes) === true;
  cache = { signed, expiresAt: now + CACHE_TTL_MS };
  return signed;
}

/** Test-only: clear the module-level cache between test cases. */
export function _resetWindowsAgentSigningCacheForTests(): void {
  cache = null;
}
