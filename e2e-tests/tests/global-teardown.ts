import { apiClient } from '../helpers/api';

/**
 * Global teardown: clean up any test data created during the E2E run.
 * Runs after all spec files, whether they passed or failed.
 */
async function globalTeardown() {
  try {
    const client = apiClient();
    await client.login();
    await client.cleanupTestData();
    console.log('[teardown] Test data cleaned up.');
  } catch (err) {
    // Best-effort cleanup — don't fail the entire suite if cleanup fails.
    console.warn('[teardown] Cleanup error (non-fatal):', err);
  }
}

export default globalTeardown;
