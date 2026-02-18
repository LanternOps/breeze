// e2e-tests/doc-verify/cli.ts
import { resolve } from 'path';
import { extractAssertions, listDocPages, loadManifest, saveManifest } from './extractor';
import { runAssertions } from './runner';
import { printSummary, saveJsonReport, saveHtmlReport } from './report';
import { seedViaApi } from './fixtures/seed';

const DOC_SCOPE = ['getting-started', 'agents'];
const MANIFEST_PATH = resolve(import.meta.dirname, 'assertions.json');
const REPORT_DIR = resolve(import.meta.dirname, 'reports');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const WEB_URL = process.env.WEB_URL || 'http://localhost:4322';
const DB_URL = process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

const command = process.argv[2] || 'all';
const args = process.argv.slice(3);
const incremental = args.includes('--incremental');
const pageFilter = args.find((a) => a.startsWith('--page='))?.split('=')[1];
const typeFilter = args.find((a) => a.startsWith('--type='))?.split('=')[1] as 'api' | 'sql' | 'ui' | undefined;

async function doExtract() {
  console.log('Extracting assertions from docs...');
  const docPaths = await listDocPages(DOC_SCOPE);
  console.log(`Found ${docPaths.length} doc pages in scope: ${DOC_SCOPE.join(', ')}`);

  const existing = incremental ? await loadManifest(MANIFEST_PATH) : undefined;
  const manifest = await extractAssertions(docPaths, existing, incremental);

  const totalAssertions = manifest.pages.reduce((sum, p) => sum + p.assertions.length, 0);
  console.log(`Extracted ${totalAssertions} assertions from ${manifest.pages.length} pages`);

  await saveManifest(manifest, MANIFEST_PATH);
  console.log(`Manifest saved to ${MANIFEST_PATH}`);
  return manifest;
}

async function doRun() {
  console.log('Running assertions...');
  const manifest = await loadManifest(MANIFEST_PATH);
  if (!manifest) {
    console.error('No assertions.json found. Run "extract" first.');
    process.exit(1);
  }

  const totalAssertions = manifest.pages.reduce((sum, p) => sum + p.assertions.length, 0);
  console.log(`Loaded ${totalAssertions} assertions from manifest`);

  // Seed test data
  console.log('Seeding test data...');
  let env: Record<string, string> = {};
  try {
    const seed = await seedViaApi(API_URL);
    env = {
      ORG_ID: seed.orgId,
      SITE_ID: seed.siteId,
      ENROLLMENT_KEY: seed.enrollmentKey,
      ADMIN_EMAIL: seed.adminEmail,
      ADMIN_PASSWORD: seed.adminPassword,
    };

    // Login to get auth token for API assertions
    const loginRes = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: seed.adminEmail, password: seed.adminPassword }),
    });
    if (loginRes.ok) {
      const loginData = (await loginRes.json()) as Record<string, unknown>;
      env.AUTH_TOKEN = (loginData.token || loginData.accessToken || '') as string;
    }
    console.log(`Seeded: org=${env.ORG_ID}, site=${env.SITE_ID}, token=${env.AUTH_TOKEN ? 'yes' : 'no'}`);
  } catch (err) {
    console.warn(`Seed failed (continuing with empty env): ${err instanceof Error ? err.message : String(err)}`);
  }

  const report = await runAssertions(manifest, {
    apiUrl: API_URL,
    webUrl: WEB_URL,
    dbUrl: DB_URL,
    env,
    filterPage: pageFilter,
    filterType: typeFilter,
  });

  printSummary(report);

  // Save reports
  const { mkdirSync } = await import('fs');
  try { mkdirSync(REPORT_DIR, { recursive: true }); } catch { /* exists */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await saveJsonReport(report, resolve(REPORT_DIR, `report-${ts}.json`));
  await saveHtmlReport(report, resolve(REPORT_DIR, `report-${ts}.html`));

  // Exit with non-zero if any failures
  if (report.failed > 0 || report.errors > 0) {
    process.exit(1);
  }
}

async function main() {
  switch (command) {
    case 'extract':
      await doExtract();
      break;
    case 'run':
      await doRun();
      break;
    case 'all':
      await doExtract();
      await doRun();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: doc-verify [extract|run|all]');
      console.error('Flags: --incremental --page=<filter> --type=api|sql|ui');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
