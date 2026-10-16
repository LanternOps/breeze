// `dev` entry for the four Office add-ins (#8375).
//
// office-addin-dev-certs can only install its CA into the Windows or macOS trust store, so on Linux the
// add-in's vite config fails to load. Every package shares one `turbo run dev`, so that failure would
// also stop api, web and the rest. On Linux this skips with a reason and exits 0; elsewhere it runs vite.
import { spawnSync } from 'node:child_process';

/** Why the add-in dev server can't run on this platform, or null if it can. */
export function addinDevSkipReason(platform) {
  return platform === 'linux'
    ? 'office-addin-dev-certs cannot install its CA on Linux; run the add-ins on Windows or macOS'
    : null;
}

export function runAddinDev({ platform = process.platform, cwd = process.cwd(), log = console.log } = {}) {
  const skip = addinDevSkipReason(platform);
  if (skip) {
    log(`[addin-dev] skipped: ${skip}`);
    return 0;
  }
  // `pnpm exec` because vite doesn't export its bin for a direct path and .bin/vite is a .cmd shim on
  // Windows. One command string: passing an args array with shell: true is deprecated (DEP0190).
  const result = spawnSync('pnpm exec vite', { cwd, stdio: 'inherit', shell: true });
  return result.status ?? 1;
}

// Run only when executed directly, so the tests can import the functions.
if (process.argv[1] && process.argv[1].endsWith('addin-dev.mjs')) {
  process.exit(runAddinDev());
}
