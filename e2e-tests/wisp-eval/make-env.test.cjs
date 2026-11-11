// node --test e2e-tests/wisp-eval/make-env.test.cjs
// make-env.sh copies a populated .env for a stack that talks to a real model. It must
// keep the model key and the stack's own local secrets, and blank every credential
// for an outside service, including ones nobody listed by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sh', 'make-env.sh');

// name -> [value in the source file, expected in the output: 'keep' | 'blank']
const SOURCE = {
  ANTHROPIC_API_KEY: ['fake-model-key-1', 'keep'],
  BREEZE_API_IMAGE_REF: ['registry.example/api:1', 'keep'],
  // the local stack's own secrets
  JWT_SECRET: ['local-jwt', 'keep'],
  POSTGRES_PASSWORD: ['local-pg', 'keep'],
  REDIS_PASSWORD: ['local-redis', 'keep'],
  APP_ENCRYPTION_KEY: ['local-enc', 'keep'],
  MFA_ENCRYPTION_KEY: ['local-mfa', 'keep'],
  OAUTH_JWKS_PRIVATE_JWK: ['{"kty":"OKP"}', 'keep'],
  AGENT_ENROLLMENT_SECRET: ['local-enroll', 'keep'],
  TURN_SECRET: ['local-turn', 'keep'],
  E2E_ADMIN_PASSWORD: ['local-admin', 'keep'],
  // settings whose names only look like secrets
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: ['60', 'keep'],
  MCP_MAX_SSE_SESSIONS_PER_KEY: ['5', 'keep'],
  APP_ENCRYPTION_KEY_ID: ['k1', 'keep'],
  TURN_CREDENTIAL_TTL_SECONDS: ['600', 'keep'],
  // named in the fixed list
  STRIPE_SECRET_KEY: ['fake-stripe-2', 'blank'],
  RESEND_API_KEY: ['fake-resend-3', 'blank'],
  EMAIL_PROVIDER: ['resend', 'blank'],
  MSI_SIGNING_CERT_THUMBPRINT: ['fake-msi-4', 'blank'],
  // outside-service credentials nobody listed by name
  SENTRY_DSN: ['https://fake-sentry-5.example/1', 'blank'],
  PUBLIC_SENTRY_DSN_WEB: ['https://fake-sentry-6.example/2', 'blank'],
  TWILIO_AUTH_TOKEN: ['fake-twilio-7', 'blank'],
  MAILGUN_API_KEY: ['fake-mailgun-8', 'blank'],
  XERO_CLIENT_SECRET: ['fake-xero-9', 'blank'],
  CLOUDFLARE_API_TOKEN: ['fake-cf-10', 'blank'],
  OPS_ALERT_WEBHOOK_URL: ['https://fake-hook-11.example/x', 'blank'],
  S3_SECRET_KEY: ['fake-s3-12', 'blank'],
  LENOVO_API_KEY: ['fake-lenovo-13', 'blank'],
  SOME_FUTURE_VENDOR_API_KEY: ['fake-future-14', 'blank'],
  C2C_M365_CERT_PRIVATE_KEY_PATH: ['/fake/cert-15.pem', 'blank'],
};

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-eval-env-'));
  const src = path.join(dir, 'source.env');
  const dest = path.join(dir, 'out', '.env');
  fs.mkdirSync(path.dirname(dest));
  const lines = ['# a comment', ''];
  for (const [k, [v]] of Object.entries(SOURCE)) lines.push(k === 'LENOVO_API_KEY' ? `export ${k}=${v}` : `${k}=${v}`);
  fs.writeFileSync(src, lines.join('\n') + '\n');
  const r = spawnSync('bash', [SCRIPT, src, '48999', '172.31.99.0/24'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, WISP_EVAL_ENV_DEST: dest },
  });
  const out = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  const values = {};
  const seen = {};
  for (const line of out.split('\n')) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2];
    seen[m[1]] = (seen[m[1]] || 0) + 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { r, values, seen, printed: (r.stdout || '') + (r.stderr || '') };
}

test('make-env keeps the model key and local secrets, and blanks outside-service credentials', () => {
  const { r, values, seen } = run();
  assert.equal(r.status, 0, r.stderr);
  for (const [k, [v, want]] of Object.entries(SOURCE)) {
    assert.equal(seen[k], 1, `${k} appears exactly once`);
    assert.equal(values[k], want === 'keep' ? v : '', `${k} should be ${want === 'keep' ? 'kept' : 'blank'}`);
  }
  assert.equal(values.BREEZE_WISP_ENABLED, 'true');
  assert.equal(values.CORS_ALLOWED_ORIGINS, 'http://localhost:48999');
  assert.equal(values.BREEZE_CADDY_IP, '172.31.99.10');
});

test('make-env names what it blanked and never prints a value', () => {
  const { r, printed } = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(printed, /SENTRY_DSN/, 'the operator sees which keys were blanked by pattern');
  for (const [k, [v]] of Object.entries(SOURCE)) {
    if (/^\d+$/.test(v) || v.length < 4) continue;
    assert.ok(!printed.includes(v), `the value of ${k} was printed`);
  }
});
