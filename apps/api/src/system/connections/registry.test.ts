/**
 * Registry shape + invariant 3 (secret-name guard) + docsUrl existence.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTION_REGISTRY, SECRET_NAME_EXCEPTIONS, SECRET_NAME_PATTERN } from './registry';
import { CONNECTION_GROUPS } from './types';

const DOCS_CONTENT_DIR = join(__dirname, '..', '..', '..', '..', 'docs', 'src', 'content', 'docs');
const allVars = CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => ({ entry: entry.id, ...v })));

describe('connection registry shape', () => {
  it('has unique kebab-case ids, known groups and non-empty labels', () => {
    const ids = CONNECTION_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONNECTION_REGISTRY) {
      expect(entry.id, entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(CONNECTION_GROUPS, entry.id).toContain(entry.group);
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.vars.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('lists every env var in at most one entry', () => {
    const names = allVars.map((v) => v.name);
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    expect(dupes).toEqual([]);
  });

  it('covers every group at least once', () => {
    for (const group of CONNECTION_GROUPS) {
      expect(CONNECTION_REGISTRY.some((e) => e.group === group), group).toBe(true);
    }
  });

  it('every docsUrl points at a page that exists under apps/docs', () => {
    for (const entry of CONNECTION_REGISTRY) {
      if (!entry.docsUrl) continue;
      expect(entry.docsUrl, entry.id).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/(#[a-z0-9-]+)?$/);
      const pagePath = entry.docsUrl.split('#')[0]!.replace(/^\/|\/$/g, '');
      const candidates = [join(DOCS_CONTENT_DIR, `${pagePath}.mdx`), join(DOCS_CONTENT_DIR, `${pagePath}.md`), join(DOCS_CONTENT_DIR, pagePath, 'index.mdx')];
      expect(candidates.some((p) => existsSync(p)), `${entry.id} → ${entry.docsUrl}`).toBe(true);
    }
  });
});

describe('invariant 3: secret-name guard', () => {
  it('a secret-looking name stays secret unless SECRET_NAME_EXCEPTIONS explains why it is not', () => {
    const offenders = allVars
      .filter((v) => v.secret === false && SECRET_NAME_PATTERN.test(v.name) && !(v.name in SECRET_NAME_EXCEPTIONS))
      .map((v) => `${v.entry}:${v.name}`);
    expect(offenders).toEqual([]);
  });

  it('every exception is a live secret:false registry var with a reason (no stale exceptions)', () => {
    for (const [name, reason] of Object.entries(SECRET_NAME_EXCEPTIONS)) {
      const v = allVars.find((candidate) => candidate.name === name);
      expect(v, `${name} is not in the registry`).toBeDefined();
      expect(v?.secret, `${name} is excepted but not secret:false`).toBe(false);
      expect(SECRET_NAME_PATTERN.test(name), `${name} does not need an exception`).toBe(true);
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });

  it('the pattern catches the spec-named traps', () => {
    for (const name of ['DATABASE_URL_APP', 'FIREBASE_SERVICE_ACCOUNT', 'PLAY_INTEGRITY_SERVICE_ACCOUNT', 'CSP_REPORT_URI', 'TWILIO_ACCOUNT_SID', 'SENSITIVE_DATA_ENCRYPTION_KEY_B64']) {
      expect(SECRET_NAME_PATTERN.test(name), name).toBe(true);
      expect(allVars.find((v) => v.name === name)?.secret, name).not.toBe(false);
    }
  });
});

/**
 * Every secret:false var, pinned. The canary (report.test.ts) only seeds vars
 * the registry marks secret, and the name guard above only sees secret-looking
 * names, so flipping an innocuously named secret (e.g. SMTP_USER) to
 * secret:false would pass both. This list makes every such flip a second,
 * reviewable edit in a test file. Only add a name here after checking that its
 * value is safe to show to platform admins (spec D2, D8).
 */
const REVIEWED_PUBLIC_VARS: readonly string[] = [
  'ABUSE_SIGNALS_ENABLED',
  'AGENT_AUTO_PROMOTE',
  'AGENT_BACKUP_SERVER_URL',
  'AGENT_MTLS_BINDING_MODE',
  'AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED',
  'AI_OPERATOR_TASKS_ENABLED',
  'AI_WORKSPACE_BACKEND',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'API_URL',
  'APNS_BUNDLE_ID',
  'APNS_ENVIRONMENT',
  'APNS_TEAM_ID',
  'APPLE_APP_ATTEST_APP_ID',
  'APPLE_APP_ATTEST_ENVIRONMENT',
  'ARTIFACT_BLOB_BACKEND',
  'ARTIFACT_S3_BUCKET_EU',
  'ARTIFACT_S3_BUCKET_US',
  'ARTIFACT_S3_ENDPOINT_EU',
  'ARTIFACT_S3_ENDPOINT_US',
  'ARTIFACT_S3_REGION_EU',
  'ARTIFACT_S3_REGION_US',
  'ARTIFACT_S3_SSE',
  'BILLING_SERVICE_URL',
  'BILLING_URL',
  'BINARY_EDITION',
  'BINARY_GITHUB_REPOSITORY',
  'BINARY_SOURCE',
  'BINARY_VERSION',
  'BREEZE_AI_AGENTS_ENABLED',
  'BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED',
  'BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED',
  'BREEZE_AI_SCRIPT_AUTHORING_ENABLED',
  'BREEZE_AI_SCRIPT_REVIEWER_MODEL',
  'BREEZE_AI_WORKSPACE_ENABLED',
  'BREEZE_ALLOW_UNAUTH_REDIS',
  'BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED',
  'BREEZE_BILLING_URL',
  'BREEZE_SERVER',
  'BREEZE_VERSION',
  'BREEZE_WORKSPACE_ENABLED',
  'C2C_M365_CLIENT_ID',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_TRUSTS_MFA',
  'CF_ACCESS_TRUST_ENABLED',
  'CLIENT_AI_ENTRA_CLIENT_ID',
  'CORS_ALLOWED_ORIGINS',
  'CORS_INCLUDE_DEFAULT_ORIGINS',
  'DASHBOARD_URL',
  'DELEGANT_BASE_URL',
  'EMAIL_DOMAINS_PROVIDER',
  'EMAIL_DOMAINS_REGION',
  'EMAIL_DOMAINS_STATIC_ALLOWED',
  'EMAIL_FROM',
  'EMAIL_PROVIDER',
  'EMAIL_SUPPORT_ADDRESS',
  'ENROLLMENT_SECRET_ENFORCEMENT_MODE',
  'FORCE_HTTPS',
  'GITHUB_REPO',
  'GOOGLE_WORKSPACE_ENABLED',
  'HP_WARRANTY_ENABLED',
  'IP_CLASSIFY_PROVIDER',
  'LENOVO_WARRANTY_ENABLED',
  'LLM_PROVIDER_CATALOG_ENABLED',
  'M365_COMMS_CLIENT_ID',
  'M365_COMMS_EXECUTOR_AUDIENCE',
  'M365_COMMS_ONBOARDING_ENABLED',
  'M365_COMMS_ONBOARDING_USER_IDS',
  'M365_COMMS_TOOLS_ENABLED',
  'M365_COMMS_TOOLS_USER_IDS',
  'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID',
  'M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED',
  'M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS',
  'M365_CUSTOMER_GRAPH_READ_CLIENT_ID',
  'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED',
  'M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS',
  'M365_ENABLED',
  'M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE',
  'M365_GRAPH_ACTIONS_TOOLS_ENABLED',
  'M365_GRAPH_ACTIONS_TOOLS_ORG_IDS',
  'M365_GRAPH_READ_EXECUTOR_AUDIENCE',
  'M365_GRAPH_READ_TOOLS_ENABLED',
  'M365_GRAPH_READ_TOOLS_ORG_IDS',
  'M365_TENANT_SYNC_ENABLED',
  'MAILGUN_BASE_URL',
  'MAILGUN_DOMAIN',
  'MAILGUN_FROM',
  'MAILGUN_TIMEOUT_MS',
  'MCP_LLM_BASE_URL',
  'MCP_LLM_MODEL',
  'MCP_LLM_PRICE_INPUT_PER_M_USD',
  'MCP_LLM_PRICE_OUTPUT_PER_M_USD',
  'MCP_LLM_PROVIDER',
  'MCP_OAUTH_ENABLED',
  'METRICS_SCRAPE_IP_ALLOWLIST',
  'OAUTH_CONSENT_URL_BASE',
  'OAUTH_DCR_ALLOW_ANONYMOUS',
  'OAUTH_DCR_ENABLED',
  'OAUTH_DCR_REQUIRE_IAT',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OPS_ALERT_EMAIL',
  'OPS_ALERT_LABEL',
  'PORTAL_BASE_PATH',
  'PUBLIC_ACTIVATION_BASE_URL',
  'PUBLIC_API_URL',
  'PUBLIC_APP_URL',
  'PUBLIC_PORTAL_URL',
  'PUBLIC_URL',
  'PUBLIC_WEB_URL',
  'QBO_CLIENT_ID',
  'QBO_ENVIRONMENT',
  'QBO_REDIRECT_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'RELEASE_ARTIFACT_MANIFEST_VERIFICATION',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'SENTRY_ENVIRONMENT',
  'SENTRY_PROFILES_SAMPLE_RATE',
  'SENTRY_TRACES_SAMPLE_RATE',
  'SMTP_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_TIMEOUT_MS',
  'STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED',
  'STRIPE_SESSION_REVOCATION_MODE',
  'TICKETS_INBOUND_DOMAIN',
  'TICKET_MAILBOX_M365_CLIENT_ID',
  'TOOL_SOURCES_ALLOW_PRIVATE_EGRESS',
  'TOOL_SOURCES_ENABLED',
  'TRUSTED_PROXY_CIDRS',
  'TRUST_CF_CONNECTING_IP',
  'TRUST_PROXY_HEADERS',
  'TURN_HOST',
  'TURN_PORT',
  'TURN_TLS_DIR',
  'TURN_TLS_HOST',
  'TURN_TLS_PORT',
  'TWILIO_PHONE_NUMBER',
  'VERCEL_SANDBOX_IMAGE',
  'VERCEL_SANDBOX_REGION_EU',
  'VERCEL_SANDBOX_REGION_US',
  'WEBAUTHN_ORIGIN',
  'WEBAUTHN_RP_ID',
  'WEBAUTHN_RP_NAME',
];

describe('reviewed secret:false vars', () => {
  it('the set of secret:false vars matches the reviewed list exactly', () => {
    const actual = allVars.filter((v) => v.secret === false).map((v) => v.name).sort();
    expect(actual).toEqual([...REVIEWED_PUBLIC_VARS].sort());
  });
});
