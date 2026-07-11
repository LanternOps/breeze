/**
 * Encoding of the public API host for installer download filenames.
 *
 * The Windows portal-download MSI carries its bootstrap enrollment token in
 * the download filename — `Breeze Agent (TOKEN@HOST).msi` — and the agent's
 * bootstrap custom action parses it back out. `:` is illegal in Windows
 * filenames, so a raw `URL.host` with a nonstandard port (`host:8443`) gets
 * silently rewritten by the browser at save time (Chromium-based browsers
 * substitute `_`), the agent parser stops matching, and the device installs
 * unenrolled with no visible error (#2341).
 *
 * A nonstandard port is therefore carried as `host_PORT` — underscore never
 * appears in a hostname, and it matches the Chromium sanitization of the old
 * colon form, so files downloaded from pre-fix servers decode identically.
 * The agent-side decoder lives in
 * `agent/internal/agentapp/installer_filename.go`.
 *
 * Kept free of other imports so route tests exercise the real logic without
 * mocking (`installerBuilder` is mocked wholesale in route tests).
 */

/** Hostname shapes the agent-side filename parser accepts. */
const FILENAME_SAFE_HOSTNAME_RE = /^[A-Za-z0-9.-]+$/;

/** Full encoded form as it appears in the filename: `host` or `host_port`. */
const ENCODED_FILENAME_HOST_RE = /^[A-Za-z0-9.-]+(_\d{1,5})?$/;

/**
 * The public server URL cannot be carried in an installer download filename
 * that the agent would be able to redeem. Routes surface the message to the
 * downloader as a 400.
 */
export class InstallerFilenameHostError extends Error {}

/**
 * Encode the public server URL's host for a Windows filename-token download.
 * Returns `host` or `host_PORT`.
 *
 * Throws {@link InstallerFilenameHostError} when the download could never
 * enroll: non-https scheme (the agent always promotes the parsed host to
 * `https://`) or a hostname outside `[A-Za-z0-9.-]` (e.g. bracketed IPv6),
 * which the agent parser rejects. Callers must fail the download with the
 * error message instead of serving an MSI that installs unenrolled.
 */
export function windowsFilenameApiHost(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "https:") {
    throw new InstallerFilenameHostError(
      "The filename-token installer requires an https server URL — the agent always redeems the token over https. " +
        "Set an https PUBLIC_API_URL, or install with explicit MSI properties (SERVER_URL and ENROLLMENT_KEY).",
    );
  }
  if (!FILENAME_SAFE_HOSTNAME_RE.test(url.hostname)) {
    throw new InstallerFilenameHostError(
      `The server URL host "${url.hostname}" cannot be carried in a Windows installer filename. ` +
        "Install with explicit MSI properties (SERVER_URL and ENROLLMENT_KEY) instead.",
    );
  }
  return url.port ? `${url.hostname}_${url.port}` : url.hostname;
}

/**
 * True when `apiHost` is already in the encoded filename form emitted by
 * {@link windowsFilenameApiHost}. Used as a defense-in-depth assertion at the
 * single point that writes the Content-Disposition filename.
 */
export function isEncodedWindowsFilenameApiHost(apiHost: string): boolean {
  return ENCODED_FILENAME_HOST_RE.test(apiHost);
}

/**
 * Host for the macOS app-bundle installer (bundle filename / bootstrap.json
 * payload), or `null` when the server URL is not expressible there.
 *
 * The macOS installer app validates the host against `[A-Za-z0-9.-]+`
 * (FilenameTokenParser.swift) and its bootstrap client always talks https
 * (BootstrapClient.swift) — there is no port encoding, so a nonstandard
 * port, non-https scheme, or unsafe hostname cannot ride the app-bundle
 * path at all. Callers fall back to the legacy zip installer, which embeds
 * the full server URL and handles all of these.
 */
export function macosBundleApiHost(serverUrl: string): string | null {
  const url = new URL(serverUrl);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    !FILENAME_SAFE_HOSTNAME_RE.test(url.hostname)
  ) {
    return null;
  }
  return url.hostname;
}
