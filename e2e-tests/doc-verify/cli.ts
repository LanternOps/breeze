// e2e-tests/doc-verify/cli.ts
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import {
  extractAssertions,
  listDocPages,
  loadManifest,
  saveManifest,
} from './extractor';
import { runAssertions } from './runner';
import { printSummary, saveJsonReport, saveHtmlReport } from './report';
import { seedViaApi } from './fixtures/seed';

const MANIFEST_PATH = resolve(import.meta.dirname, 'assertions.json');
const REPORT_DIR = resolve(import.meta.dirname, 'reports');

// Initial scope: getting-started + agents docs
const DOC_SCOPE = ['getting-started', 'agents'];

function getEnv(): Record<string, string> {
  return {
    ENROLLMENT_SECRET: process.env.AGENT_ENROLLMENT_SECRET || 'test-enrollment-secret',
    ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local',
    ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!',
    AUTH_TOKEN: '',
  };
}

async function extract(incremental: boolean) {
  console.log('Extracting assertions from documentation...');
  const docPaths = await listDocPages(DOC_SCOPE);
  console.log(`Found ${docPaths.length} doc pages in scope.`);

  const existing = incremental ? await loadManifest(MANIFEST_PATH) : undefined;
  const manifest = await extractAssertions(docPaths, existing, incremental);

  await saveManifest(manifest, MANIFEST_PATH);

  const totalAssertions = manifest.pages.reduce((sum, p) => sum + p.assertions.length, 0);
  console.log(`\nExtracted ${totalAssertions} assertions across ${manifest.pages.length} pages.`);
  console.log(`Manifest saved to ${MANIFEST_PATH}`);
}

async function run(pageFilter?: string) {
  const manifest = await loadManifest(MANIFEST_PATH);
  if (!manifest) {
    console.error('No assertions.json found. Run "doc-verify extract" first.');
    process.exit(1);
  }

  const apiUrl = process.env.DOC_VERIFY_API_URL || 'http://localhost:3001';
  const baseUrl = process.env.DOC_VERIFY_BASE_URL || 'http://localhost:4321';
  const dbUrl =
    process.env.DOC_VERIFY_DB_URL ||
    'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

  // Seed test data
  console.log('Seeding test data...');
  const seedData = await seedViaApi(apiUrl);
  const env = {
    ...getEnv(),
    ORG_ID: seedData.orgId,
    SITE_ID: seedData.siteId,
    ENROLLMENT_KEY: seedData.enrollmentKey,
  };

  // Login to get auth token
  const loginRes = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    }),
  });
  if (loginRes.ok) {
    const loginData = await loginRes.json() as Record<string, unknown>;
    env.AUTH_TOKEN = (loginData.token || loginData.accessToken || '') as string;
  }

  const report = await runAssertions(manifest, {
    apiUrl,
    baseUrl,
    dbUrl,
    env,
    page: pageFilter,
  });

  printSummary(report);

  // Save reports
  mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await saveJsonReport(report, resolve(REPORT_DIR, `report-${timestamp}.json`));
  await saveHtmlReport(report, resolve(REPORT_DIR, `report-${timestamp}.html`));

  // Exit with error code if any failures
  if (report.failed > 0 || report.errors > 0) {
    process.exit(1);
  }
}

async function main() {
  const command = process.argv[2] || 'all';
  const flags = process.argv.slice(3);
  const incremental = flags.includes('--incremental');
  const pageFlag = flags.find((f) => f.startsWith('--page='));
  const page = pageFlag?.split('=')[1];

  switch (command) {
    case 'extract':
      await extract(incremental);
      break;
    case 'run':
      await run(page);
      break;
    case 'all':
      await extract(incremental);
      await run(page);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: doc-verify [extract|run|all] [--incremental] [--page=path]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
