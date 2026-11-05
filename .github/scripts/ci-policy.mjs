// The one policy manifest (W02, #10746): every file CI job selection reads.
// queue-selection (W4) digests it and checks it at the queue base; the pinned
// gate (W02b+) reads these files from the base revision, never from the head.
// ci-policy.test.mjs closes the list over what selection actually reads, so a
// new selection input fails a test until it is listed here.
export const POLICY_FILES = Object.freeze([
  // W4's selection inputs.
  '.github/scripts/classify-pr-paths.sh',
  '.github/scripts/integration-floor-paths.txt',
  '.github/scripts/path-reader-map.txt',
  '.github/scripts/qemu-gate-paths.txt',
  '.github/scripts/queue-selection.mjs',
  '.github/flaky-tests.json',
  '.github/workflows/ci.yml',
  // This manifest and the pinned gate. The gate files may not exist yet;
  // policyDigest omits absent paths.
  '.github/scripts/ci-policy.mjs',
  '.github/scripts/ci-gate.mjs',
  '.github/workflows/ci-gate.yml',
  // Derives MOBILE_NATIVE_REQUIRED for the iOS build.
  '.github/scripts/mobile-lockfile-closure.mjs',
  // Route a changed own test to the job that runs it (routeOwnTest).
  'apps/api/vitest.integration.config.ts',
  'e2e-tests/playwright.auth-browser-transition.config.ts',
  'e2e-tests/playwright.topology-worker.config.ts',
]);

// Any workflow, script or local action can steer selection, listed or not.
const POLICY_DIRS = ['.github/workflows/', '.github/scripts/', '.github/actions/'];

export function isPolicyPath(path) {
  return typeof path === 'string' && (POLICY_FILES.includes(path) || POLICY_DIRS.some(dir => path.startsWith(dir)));
}
