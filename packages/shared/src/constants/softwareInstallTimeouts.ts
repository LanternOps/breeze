/**
 * Software-install time budgets (#3578) — the single source for the API and
 * web layers.
 *
 * The agent's two ceilings are authoritative in Go
 * (`downloadTimeout` / `installTimeout` in
 * agent/internal/remote/tools/software_install.go) and pinned to the values
 * here by `TestInstallTimeoutsMatchSharedConstants`
 * (agent/internal/remote/tools/software_install_timeouts_test.go), so a
 * one-sided edit fails CI.
 *
 * The web deployment view uses them to tell a healthy long install from one
 * the agent has gone quiet on ("no update from the agent for N min"); the
 * server's stale-result reaper uses the server timeout.
 */

/** Agent gives up on a package download after this long. */
export const SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Agent kills a direct (URL/upload) installer after this long. Package-manager
 * installs (winget/brew) run under their own, shorter limit, so this is the
 * upper bound for any install stage.
 */
export const SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The server marks a delivered-but-silent install failed once this long has
 * passed since the command was sent (jobs/staleCommandReaper.ts). Deliberately
 * above the agent's own combined ceilings (download + installer = 45 min), so
 * the server only times out after the agent has provably stopped.
 */
export const SOFTWARE_INSTALL_SERVER_TIMEOUT_MS = 55 * 60 * 1000;
