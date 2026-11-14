// node --test "e2e-tests/wisp-eval/*.test.cjs"
// make-env.sh turns a populated .env into one for a throwaway stack that talks to a real
// model. The model key is the only secret it carries over. The stack's own secrets are
// generated fresh (and reused when it rewrites its own output), secrets the stack boots
// without are blanked, and every credential for an outside service is blanked, including
// ones nobody listed by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sh', 'make-env.sh');
const HEX32 = /^[0-9a-f]{64}$/;
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

// name -> [value in the source file, expected in the output]
//   'copy'  the source value, unchanged     'blank'  empty
//   HEX32 / B64_32  generated: matches the format, differs from the source value
const SOURCE = {
  // the one secret carried over
  ANTHROPIC_API_KEY: ['fake-model-key-1', 'copy'],
  // non-secret settings, image refs and a public key list
  BREEZE_API_IMAGE_REF: ['registry.example/api:1', 'copy'],
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: ['fake-public-key-list', 'copy'],
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: ['60', 'copy'],
  MCP_MAX_SSE_SESSIONS_PER_KEY: ['5', 'copy'],
  APP_ENCRYPTION_KEY_ID: ['k1', 'copy'],
  TURN_CREDENTIAL_TTL_SECONDS: ['600', 'copy'],
  REDIS_URL: ['redis://redis:6379', 'copy'],
  // the stack's own secrets: generated for this stack
  JWT_SECRET: ['source-jwt-secret', HEX32],
  APP_ENCRYPTION_KEY: ['source-app-enc-key', HEX32],
  MFA_ENCRYPTION_KEY: ['source-mfa-enc-key', HEX32],
  MFA_RECOVERY_CODE_PEPPER: ['source-mfa-pepper', HEX32],
  ENROLLMENT_KEY_PEPPER: ['source-enroll-pepper', HEX32],
  AGENT_ENROLLMENT_SECRET: ['source-agent-enroll', HEX32],
  PARTNER_API_CURSOR_SIGNING_KEY: ['source-cursor-key', B64_32],
  POSTGRES_PASSWORD: ['source-pg-password', HEX32],
  REDIS_PASSWORD: ['source-redis-password', HEX32],
  BREEZE_APP_DB_PASSWORD: ['source-app-db-password', HEX32],
  TURN_SECRET: ['source-turn-secret', HEX32],
  SESSION_SECRET: ['source-session-secret', HEX32],
  METRICS_SCRAPE_TOKEN: ['source-metrics-token', HEX32],
  // secrets the stack boots without
  JWT_SIGNING_KEYRING: ['{"k1":"source-keyring-secret-000000000000"}', 'blank'],
  JWT_ACTIVE_KID: ['k1', 'blank'],
  OAUTH_COOKIE_SECRET: ['source-oauth-cookie', 'blank'],
  OAUTH_JWKS_PRIVATE_JWK: ['{"kty":"OKP","d":"source-private"}', 'blank'],
  OAUTH_JWKS_PUBLIC_JWK: ['{"kty":"OKP","x":"source-public"}', 'blank'],
  AUDIT_ANCHOR_SIGNING_KEY: ['source-audit-anchor', 'blank'],
  BREEZE_BOOTSTRAP_ADMIN_PASSWORD: ['source-bootstrap-admin', 'blank'],
  E2E_ADMIN_PASSWORD: ['source-e2e-admin', 'blank'],
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
  // a password inside a URL, under a name that does not look like a credential
  DATABASE_URL: ['postgresql://breeze:fake-url-pw-16@localhost:5432/breeze', 'blank'],
  AUDIT_ADMIN_DATABASE_URL: ['postgresql://audit:fake-url-pw-17@db.example:5432/breeze', 'blank'],
};
const GENERATED = Object.keys(SOURCE).filter((k) => SOURCE[k][1] instanceof RegExp);

function sourceText(overrides = {}) {
  const lines = ['# a comment', ''];
  for (const [k, [v]] of Object.entries(SOURCE)) {
    const value = k in overrides ? overrides[k] : v;
    lines.push(k === 'LENOVO_API_KEY' ? `export ${k}=${value}` : `${k}=${value}`);
  }
  return lines.join('\n') + '\n';
}

function parse(text) {
  const values = {};
  const seen = {};
  for (const line of text.split('\n')) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2];
    seen[m[1]] = (seen[m[1]] || 0) + 1;
  }
  return { values, seen };
}

// A sandbox: source.env, out/.env (the destination) and tmp/ (TMPDIR for the script).
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-eval-env-'));
  const s = {
    dir,
    src: path.join(dir, 'source.env'),
    dest: path.join(dir, 'out', '.env'),
    tmp: path.join(dir, 'tmp'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  fs.mkdirSync(path.dirname(s.dest));
  fs.mkdirSync(s.tmp);
  fs.writeFileSync(s.src, sourceText());
  return s;
}

function run(s, extraEnv = {}) {
  const r = spawnSync('bash', [SCRIPT, s.src, '48999', '172.31.99.0/24'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TMPDIR: s.tmp, WISP_EVAL_ENV_DEST: s.dest, ...extraEnv },
  });
  const out = fs.existsSync(s.dest) ? fs.readFileSync(s.dest, 'utf8') : '';
  return { r, out, ...parse(out), printed: (r.stdout || '') + (r.stderr || '') };
}

test('make-env carries over only the model key, generates the stack secrets and blanks the rest', () => {
  const s = sandbox();
  try {
    const { r, values, seen } = run(s);
    assert.equal(r.status, 0, r.stderr);
    for (const [k, [v, want]] of Object.entries(SOURCE)) {
      assert.equal(seen[k], 1, `${k} appears exactly once`);
      if (want === 'copy') assert.equal(values[k], v, `${k} should be copied`);
      else if (want === 'blank') assert.equal(values[k], '', `${k} should be blank`);
      else {
        assert.match(values[k], want, `${k} should be generated in the stack's format`);
        assert.notEqual(values[k], v, `${k} must not be the source value`);
      }
    }
    assert.notEqual(values.APP_ENCRYPTION_KEY, values.MFA_ENCRYPTION_KEY, 'each secret is generated separately');
    assert.equal(values.BREEZE_WISP_ENABLED, 'true');
    assert.equal(values.MCP_OAUTH_ENABLED, 'false');
    assert.equal(values.CORS_ALLOWED_ORIGINS, 'http://localhost:48999');
    assert.equal(values.BREEZE_CADDY_IP, '172.31.99.10');
    assert.equal(fs.statSync(s.dest).mode & 0o777, 0o600, 'the destination is mode 600');
  } finally {
    s.cleanup();
  }
});

test('make-env reuses the secrets it generated when it rewrites its own output', () => {
  const s = sandbox();
  try {
    const first = run(s);
    assert.equal(first.r.status, 0, first.r.stderr);
    const second = run(s);
    assert.equal(second.r.status, 0, second.r.stderr);
    for (const k of GENERATED) {
      assert.equal(second.seen[k], 1, `${k} appears exactly once after a rewrite`);
      assert.equal(second.values[k], first.values[k], `${k} is reused on a rewrite`);
    }
    // A new source model key still comes through on a rewrite.
    fs.writeFileSync(s.src, sourceText({ ANTHROPIC_API_KEY: 'fake-model-key-2' }));
    const third = run(s);
    assert.equal(third.r.status, 0, third.r.stderr);
    assert.equal(third.values.ANTHROPIC_API_KEY, 'fake-model-key-2');
    assert.equal(third.values.JWT_SECRET, first.values.JWT_SECRET);
  } finally {
    s.cleanup();
  }
});

test('make-env never reuses a value that came from the source', () => {
  const s = sandbox();
  try {
    // An output written by an earlier version of the script, which copied the source's
    // secrets: the marker is there, and so are the source values.
    fs.writeFileSync(s.dest, '# generated by e2e-tests/wisp-eval/sh/make-env.sh\n' + sourceText());
    const { r, values } = run(s);
    assert.equal(r.status, 0, r.stderr);
    for (const k of GENERATED) {
      assert.match(values[k], SOURCE[k][1], `${k} is generated`);
      assert.notEqual(values[k], SOURCE[k][0], `${k} must not reuse the source value`);
    }
  } finally {
    s.cleanup();
  }
});

test('make-env leaves no working file behind', () => {
  const s = sandbox();
  try {
    const { r } = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(path.dirname(s.dest)), ['.env'], 'only the destination is beside it');
    assert.deepEqual(fs.readdirSync(s.tmp), [], 'the private working directory is removed');
  } finally {
    s.cleanup();
  }
});

test('while it runs, nothing beside the destination has a name git would stage', () => {
  // An interrupted run leaves whatever is on disk at that moment. Snapshot the
  // destination's directory at the final move, which is the latest point of the run.
  const s = sandbox();
  try {
    const shim = path.join(s.dir, 'shim');
    const snap = path.join(s.dir, 'snapshot.txt');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'mv'), '#!/bin/sh\nls -A "$SNAP_DIR" >> "$SNAP_OUT"\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const { r } = run(s, { PATH: `${shim}:${process.env.PATH}`, SNAP_DIR: path.dirname(s.dest), SNAP_OUT: snap });
    assert.equal(r.status, 0, r.stderr);
    const names = fs.readFileSync(snap, 'utf8').split('\n').filter(Boolean);
    assert.ok(names.length > 0, 'the script moved a file into place');
    // `.env` is ignored by name; `.tmp-*` is covered by the repo's .gitignore.
    for (const n of names) assert.match(n, /^(\.env|\.tmp-.*)$/, `working file ${n} beside the destination is not under an ignored name`);
  } finally {
    s.cleanup();
  }
});

test('make-env names what it blanked and never prints a value', () => {
  const s = sandbox();
  try {
    const { r, values, printed } = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(printed, /SENTRY_DSN/, 'the operator sees which keys were blanked by pattern');
    for (const [k, [v]] of Object.entries(SOURCE)) {
      if (/^\d+$/.test(v) || v.length < 4) continue;
      assert.ok(!printed.includes(v), `the source value of ${k} was printed`);
    }
    for (const k of GENERATED) assert.ok(!printed.includes(values[k]), `the generated value of ${k} was printed`);
  } finally {
    s.cleanup();
  }
});
