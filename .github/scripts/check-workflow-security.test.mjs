import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  inspectWorkflowDirectory,
  inspectWorkflowText,
} from './check-workflow-security.mjs';

const temporaryDirectories = [];
const pinnedCheckout = 'actions/checkout@0123456789abcdef0123456789abcdef01234567';
const PUBLIC_RESOLVER_SCRIPT = '.github/scripts/resolve-windows-signing-provider.mjs';
const PUBLIC_CONVERGENCE_SCRIPT = '.github/scripts/assert-windows-signing-convergence.mjs';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {
      force: true,
      recursive: true,
    })),
  );
});

async function temporaryWorkflowDirectory(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-security-'));
  temporaryDirectories.push(root);
  const workflowDirectory = path.join(root, '.github', 'workflows');
  await mkdir(workflowDirectory, { recursive: true });

  await Promise.all(
    Object.entries(files).map(([file, text]) => (
      writeFile(path.join(workflowDirectory, file), text)
    )),
  );

  return workflowDirectory;
}

function workflow(body, trigger = 'push') {
  return `name: Test
on: ${trigger}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${body}
`;
}

test('rejects mutable external action references', () => {
  const violations = inspectWorkflowText(
    'mutable.yml',
    workflow('      - uses: actions/checkout@v7'),
  );

  assert.deepEqual(violations, [{
    file: 'mutable.yml',
    line: 7,
    rule: 'external-uses-must-be-sha',
    message: 'external action must use a lowercase 40-character commit SHA: actions/checkout@v7',
  }]);
});

test('accepts a lowercase full action SHA with a version comment', () => {
  const violations = inspectWorkflowText(
    'pinned.yml',
    workflow(`      - uses: ${pinnedCheckout} # v7`),
  );

  assert.deepEqual(violations, []);
});

test('accepts local actions and rejects docker actions', () => {
  const violations = inspectWorkflowText(
    'action-kinds.yml',
    workflow(`      - uses: ./path/to/local-action
      - uses: docker://alpine:latest`),
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 8);
  assert.equal(violations[0].rule, 'external-uses-must-be-sha');
});

test('rejects uppercase action SHAs', () => {
  const violations = inspectWorkflowText(
    'uppercase.yml',
    workflow('      - uses: actions/checkout@0123456789ABCDEF0123456789ABCDEF01234567'),
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'external-uses-must-be-sha');
});

test('parses reusable-workflow job uses values', () => {
  const text = `on: push
jobs:
  reusable:
    uses: example/shared-workflows/.github/workflows/test.yml@main
`;

  assert.deepEqual(
    inspectWorkflowText('reusable.yml', text).map(({ line, rule }) => ({ line, rule })),
    [{ line: 4, rule: 'external-uses-must-be-sha' }],
  );
});

test('ignores uses-like text outside steps and reusable-workflow jobs', () => {
  const text = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      uses: actions/cache@v4
    steps:
      - run: |
          uses: actions/setup-node@v7
`;

  assert.deepEqual(inspectWorkflowText('not-action.yml', text), []);
});

test('rejects a pull_request workflow that checks out code and reads a secret', () => {
  const text = `on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: echo "\${{ secrets.ANTHROPIC_API_KEY }}"
`;

  const violations = inspectWorkflowText('pull-request.yml', text);

  assert.deepEqual(violations, [{
    file: 'pull-request.yml',
    line: 8,
    rule: 'pr-workflow-must-be-secret-free',
    message: 'pull_request workflow checks out repository code and references a secret',
  }]);
});

test('rejects toJSON of the secrets context in a pull_request workflow', () => {
  const text = `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: echo '\${{ toJSON(secrets) }}'
`;

  assert.equal(
    inspectWorkflowText('all-secrets.yml', text)
      .some(({ line, rule }) => (
        line === 7 && rule === 'pr-workflow-must-be-secret-free'
      )),
    true,
  );
});

test('accepts a secret-free pull_request workflow with checkout', () => {
  const violations = inspectWorkflowText(
    'safe-pr.yml',
    workflow(`      - uses: ${pinnedCheckout}`, 'pull_request'),
  );

  assert.deepEqual(violations, []);
});

test('accepts a schedule-only secret-bearing workflow', () => {
  const text = `on:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: echo "\${{ secrets.DEPLOY_TOKEN }}"
`;

  assert.deepEqual(inspectWorkflowText('scheduled.yml', text), []);
});

test('rejects pull_request_target checkout of the pull request head', () => {
  const text = `on: [push, pull_request_target]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;

  const violations = inspectWorkflowText('target.yml', text);

  assert.deepEqual(violations, [{
    file: 'target.yml',
    line: 8,
    rule: 'pr-target-must-not-execute-head',
    message: 'pull_request_target workflow must not check out a pull request head or merge ref',
  }]);
});

test('rejects a pull request head ref in a named checkout step', () => {
  const text = `on: pull_request_target
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout pull request
        uses: ${pinnedCheckout}
        with:
          ref: \${{ github.head_ref }}
`;

  assert.equal(
    inspectWorkflowText('named-target.yml', text)
      .some(({ line, rule }) => line === 9 && rule === 'pr-target-must-not-execute-head'),
    true,
  );
});

test('rejects pull_request_target head checkout performed by a run step', () => {
  const text = `on: pull_request_target
jobs:
  leak:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - env:
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          CRED: \${{ secrets.RELEASE_KEY }}
        run: git fetch origin "$HEAD_SHA" && git checkout "$HEAD_SHA" && ./owned.sh
`;

  assert.equal(
    inspectWorkflowText('run-checkout-target.yml', text)
      .some(({ line, rule }) => (
        line === 10 && rule === 'pr-target-must-not-execute-head'
      )),
    true,
  );
});

test('rejects pull_request_target head reset performed by a run step', () => {
  const text = `on: pull_request_target
jobs:
  leak:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - env:
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: git fetch origin "$HEAD_SHA" && git reset --hard "$HEAD_SHA" && ./owned.sh
`;

  assert.equal(
    inspectWorkflowText('run-reset-target.yml', text)
      .some(({ line, rule }) => (
        line === 9 && rule === 'pr-target-must-not-execute-head'
      )),
    true,
  );
});

test('recognizes scalar and inline-list pull request triggers', () => {
  const scalar = workflow(`      - uses: ${pinnedCheckout}
      - run: echo "\${{ secrets.TOKEN }}"`, 'pull_request');
  const inlineList = workflow(`      - uses: ${pinnedCheckout}
      - run: echo "\${{ secrets.TOKEN }}"`, '[push, pull_request]');

  assert.equal(
    inspectWorkflowText('scalar.yml', scalar)
      .some(({ rule }) => rule === 'pr-workflow-must-be-secret-free'),
    true,
  );
  assert.equal(
    inspectWorkflowText('inline.yml', inlineList)
      .some(({ rule }) => rule === 'pr-workflow-must-be-secret-free'),
    true,
  );
});

test('recognizes scalar pull_request_target head and merge refs', () => {
  for (const ref of [
    '${{ github.head_ref }}',
    'refs/pull/${{ github.event.pull_request.number }}/merge',
  ]) {
    const text = workflow(`      - uses: ${pinnedCheckout}
        with:
          ref: ${ref}`, 'pull_request_target');

    assert.equal(
      inspectWorkflowText('target.yml', text)
        .some(({ rule }) => rule === 'pr-target-must-not-execute-head'),
      true,
      ref,
    );
  }
});

test('ignores blank lines and comment-only uses and trigger lines', () => {
  const text = `on:
  push:
  # pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # - uses: actions/checkout@v7
      - run: echo "\${{ secrets.TOKEN }}"
`;

  assert.deepEqual(inspectWorkflowText('comments.yml', text), []);
});

test('reports the source filename, line, and stable rule ID', () => {
  const violations = inspectWorkflowText(
    'source.yaml',
    workflow('      - uses: actions/checkout@v7'),
  );

  assert.equal(violations[0].file, 'source.yaml');
  assert.equal(violations[0].line, 7);
  assert.equal(violations[0].rule, 'external-uses-must-be-sha');
});

test('scans both yml and yaml files and sorts violations', async () => {
  const workflowDirectory = await temporaryWorkflowDirectory({
    'z-last.yml': workflow('      - uses: actions/upload-artifact@v7'),
    'a-first.yaml': workflow(`      - uses: actions/setup-node@v7
      - uses: docker://alpine:latest`),
    'ignored.txt': workflow('      - uses: actions/checkout@v7'),
  });

  const violations = inspectWorkflowDirectory(workflowDirectory);

  assert.deepEqual(
    violations.map(({ file, line, rule }) => ({ file, line, rule })),
    [
      { file: 'a-first.yaml', line: 7, rule: 'external-uses-must-be-sha' },
      { file: 'a-first.yaml', line: 8, rule: 'external-uses-must-be-sha' },
      { file: 'z-last.yml', line: 7, rule: 'external-uses-must-be-sha' },
    ],
  );
});

test('only the root on key activates pull request policy', () => {
  const text = `name: Nested on
jobs:
  test:
    on: pull_request
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: echo "\${{ secrets.TOKEN }}"
`;

  assert.deepEqual(inspectWorkflowText('nested-on.yml', text), []);
});

test('accepts quoted on, trigger, uses, and ref keys', () => {
  const secretText = `"on":
  'pull_request':
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - "uses": ${pinnedCheckout}
      - run: echo "\${{ secrets.TOKEN }}"
`;
  const targetText = `'on': 'pull_request_target'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - 'uses': ${pinnedCheckout}
        with:
          "ref": \${{ github.event.pull_request.head.sha }}
`;

  assert.equal(
    inspectWorkflowText('quoted-pr.yml', secretText)
      .some(({ rule }) => rule === 'pr-workflow-must-be-secret-free'),
    true,
  );
  assert.equal(
    inspectWorkflowText('quoted-target.yml', targetText)
      .some(({ rule }) => rule === 'pr-target-must-not-execute-head'),
    true,
  );
});

test('recognizes dash-only and flow-style action and reusable-workflow uses', () => {
  const cases = [
    {
      name: 'dash-only.yml',
      text: `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      -
        uses: actions/cache@v4
`,
    },
    {
      name: 'flow-step.yml',
      text: `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - { uses: actions/cache@v4 }
`,
    },
    {
      name: 'flow-reusable.yml',
      text: `on: push
jobs:
  reusable: { uses: example/workflows/.github/workflows/test.yml@main }
`,
    },
  ];

  for (const { name, text } of cases) {
    assert.equal(
      inspectWorkflowText(name, text)
        .some(({ rule }) => rule === 'external-uses-must-be-sha'),
      true,
      name,
    );
  }
});

test('finds dot and bracket secret access inside block scalars including hash lines', () => {
  const text = `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: |
          # \${{ secrets.DOT_KEY }}
          echo "\${{ secrets['SINGLE_KEY'] }}"
          echo '\${{ secrets["DOUBLE_KEY"] }}'
`;

  assert.deepEqual(
    inspectWorkflowText('block-secrets.yml', text)
      .filter(({ rule }) => rule === 'pr-workflow-must-be-secret-free')
      .map(({ line }) => line),
    [8, 9, 10],
  );
});

test('finds pull request target head and merge refs in all supported forms', () => {
  const cases = [
    {
      name: 'quoted-ref.yml',
      body: `      - uses: ${pinnedCheckout}
        with:
          'ref': \${{ github.event.pull_request.head.sha }}`,
    },
    {
      name: 'flow-with.yml',
      body: `      - { uses: ${pinnedCheckout}, with: { ref: "\${{ github['head_ref'] }}" } }`,
    },
    {
      name: 'folded-ref.yml',
      body: `      - uses: ${pinnedCheckout}
        with:
          ref: >-
            refs/pull/
            \${{ github.event.pull_request.number }}
            /merge`,
    },
    {
      name: 'bracket-ref.yml',
      body: `      - uses: ${pinnedCheckout}
        with:
          ref: \${{ github['event']['pull_request']['head']['sha'] }}`,
    },
  ];

  for (const { body, name } of cases) {
    assert.equal(
      inspectWorkflowText(name, workflow(body, 'pull_request_target'))
        .some(({ rule }) => rule === 'pr-target-must-not-execute-head'),
      true,
      name,
    );
  }
});

test('sorts filenames by code point rather than host locale', async () => {
  const workflowDirectory = await temporaryWorkflowDirectory({
    'a-lower.yml': workflow('      - uses: actions/cache@v4'),
    'Z-upper.yml': workflow('      - uses: actions/cache@v4'),
  });

  assert.deepEqual(
    inspectWorkflowDirectory(workflowDirectory).map(({ file }) => file),
    ['Z-upper.yml', 'a-lower.yml'],
  );
});

test('rejects unsupported root and multiline security-relevant flow collections', () => {
  const cases = [
    {
      name: 'root-flow.yml',
      text: `{"on": push, jobs: {test: {"runs-on": ubuntu-latest, steps: [{uses: actions/checkout@v4}]}}}
`,
    },
    {
      name: 'multiline-flow-step.yml',
      text: `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - {
          uses: actions/checkout@v4
        }
`,
    },
    {
      name: 'multiline-flow-reusable.yml',
      text: `on: push
jobs:
  reusable: {
    uses: example/workflows/.github/workflows/test.yml@main
  }
`,
    },
  ];

  for (const { name, text } of cases) {
    assert.equal(
      inspectWorkflowText(name, text)
        .some(({ rule }) => rule === 'unsupported-workflow-syntax'),
      true,
      name,
    );
  }
});

test('rejects escape-bearing security-relevant YAML', () => {
  const cases = [
    {
      name: 'escaped-on.yml',
      text: `"o\\u006e": pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
`,
    },
    {
      name: 'escaped-trigger.yml',
      text: `on:
  "pull_\\u0072equest":
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
`,
    },
    {
      name: 'escaped-secret.yml',
      text: `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: "echo \${{ secr\\u0065ts.TOKEN }}"
`,
    },
    {
      name: 'escaped-head.yml',
      text: `on: pull_request_target
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
        with:
          ref: "\${{ github.event.pull_request.h\\u0065ad.sha }}"
`,
    },
  ];

  for (const { name, text } of cases) {
    assert.equal(
      inspectWorkflowText(name, text)
        .some(({ rule }) => rule === 'unsupported-workflow-syntax'),
      true,
      name,
    );
  }
});

test('reconstructs folded and literal block scalars for pull request secret checks', () => {
  for (const indicator of ['>-', '|']) {
    const text = `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
      - run: ${indicator}
          echo "\${{ secrets
          .TOKEN }}"
`;

    assert.equal(
      inspectWorkflowText(`split-secret-${indicator}.yml`, text)
        .some(({ rule }) => rule === 'pr-workflow-must-be-secret-free'),
      true,
      indicator,
    );
  }
});

test('rejects every dynamic checkout ref under pull_request_target', () => {
  const text = `on: pull_request_target
env:
  PR_HEAD: refs/heads/main
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedCheckout}
        with:
          ref: \${{ env.PR_HEAD }}
`;

  assert.equal(
    inspectWorkflowText('dynamic-ref.yml', text)
      .some(({ rule }) => rule === 'pr-target-must-not-execute-head'),
    true,
  );
});

function developerSigningWorkflow(signingSteps) {
  return `name: Developer signing
on: workflow_dispatch
jobs:
  sign-notarize:
    runs-on: macos-15
    steps:
${signingSteps}
`;
}

const SSL_ACTION = 'SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b';
const AZURE_ACTION = 'azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82';
const SHARED_VERIFIER = '.github/scripts/Verify-WindowsSignature.ps1';
const PUBLIC_AGENT_WINDOWS_ASSETS = [
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
  'breeze-agent.msi',
];
const SSLCOM_SECRET_NAMES = [
  'SSLCOM_USERNAME',
  'SSLCOM_PASSWORD',
  'SSLCOM_CREDENTIAL_ID',
  'SSLCOM_TOTP_SECRET',
  'SSLCOM_CERT_SHA256',
  'SSLCOM_ENVIRONMENT_LABEL',
];
const PUBLIC_SIGNING_RULES = [
  'windows-signing-provider-must-fail-closed',
  'windows-signing-provider-least-privilege',
  'sslcom-signing-must-pin-certificate',
  'sslcom-signing-must-pin-toolchain',
  'windows-signing-must-require-timestamp',
  'windows-signing-must-assert-publisher',
  'sslcom-signing-must-not-touch-agent',
  'windows-signing-provider-must-converge',
  'windows-signing-gate-must-block-release',
  'windows-signing-providers-must-cover-same-artifacts',
];

function publicSigningFixture() {
  return `on: push
jobs:
  resolve-windows-signing-provider:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      provider: \${{ steps.provider.outputs.provider }}
    steps:
      - uses: ${pinnedCheckout}
      - id: provider
        env:
          RAW_PROVIDER: \${{ vars.WINDOWS_SIGNING_PROVIDER }}
        run: node ${PUBLIC_RESOLVER_SCRIPT} "$RAW_PROVIDER" >> "$GITHUB_OUTPUT"
  sign-windows-tauri-azure:
    needs: [resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'azure'
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: ${pinnedCheckout}
      - name: Sign viewer MSI
        uses: ${AZURE_ACTION}
        with:
          files: \${{ github.workspace }}/staging/breeze-viewer-windows.msi
      - name: Sign helper MSI
        uses: ${AZURE_ACTION}
        with:
          files: \${{ github.workspace }}/staging/breeze-helper-windows.msi
      - name: Verify signatures
        shell: pwsh
        env:
          EXPECTED_SUBJECT: \${{ env.WINDOWS_SIGNING_EXPECTED_SUBJECT }}
        run: |
          & ${SHARED_VERIFIER} \`
            -Path "staging/breeze-viewer-windows.msi", "staging/breeze-helper-windows.msi" \`
            -ExpectedSubject $env:EXPECTED_SUBJECT
  sign-windows-tauri-sslcom:
    needs: [resolve-windows-signing-provider]
    if: needs.resolve-windows-signing-provider.outputs.provider == 'sslcom'
    permissions:
      contents: read
    steps:
      - uses: ${pinnedCheckout}
      - name: Validate signing configuration
        shell: pwsh
        env:
          SSLCOM_USERNAME: \${{ secrets.SSLCOM_USERNAME }}
          SSLCOM_PASSWORD: \${{ secrets.SSLCOM_PASSWORD }}
          SSLCOM_CREDENTIAL_ID: \${{ secrets.SSLCOM_CREDENTIAL_ID }}
          SSLCOM_TOTP_SECRET: \${{ secrets.SSLCOM_TOTP_SECRET }}
          SSLCOM_CERT_SHA256: \${{ secrets.SSLCOM_CERT_SHA256 }}
          SSLCOM_ENVIRONMENT_LABEL: \${{ secrets.SSLCOM_ENVIRONMENT_LABEL }}
          EXPECTED_ENVIRONMENT: signing-production
        run: |
          if ($env:SSLCOM_ENVIRONMENT_LABEL -ne $env:EXPECTED_ENVIRONMENT) {
            throw "wrong signing environment"
          }
      - name: Stage CodeSignTool
        shell: pwsh
        env:
          CODESIGNTOOL_SHA256: e22094505decbe622afe5b0c27abc618ed2ba179bd94f3450490352399d5ef2a
        run: |
          $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($actual -ne $env:CODESIGNTOOL_SHA256) {
            throw "CodeSignTool digest mismatch"
          }
          "CODESIGNTOOL_PATH=$target" | Out-File -FilePath $env:GITHUB_ENV -Append
          "JAVA_VERSION=17" | Out-File -FilePath $env:GITHUB_ENV -Append
      - name: Sign viewer MSI
        uses: ${SSL_ACTION}
        with:
          command: sign
          file_path: \${{ github.workspace }}/staging/breeze-viewer-windows.msi
      - name: Sign helper MSI
        uses: ${SSL_ACTION}
        with:
          command: sign
          file_path: \${{ github.workspace }}/staging/breeze-helper-windows.msi
      - name: Verify signatures
        shell: pwsh
        env:
          EXPECTED_SUBJECT: \${{ env.WINDOWS_SIGNING_EXPECTED_SUBJECT }}
          SSLCOM_CERT_SHA256: \${{ secrets.SSLCOM_CERT_SHA256 }}
        run: |
          & ${SHARED_VERIFIER} \`
            -Path "staging/breeze-viewer-windows.msi", "staging/breeze-helper-windows.msi" \`
            -ExpectedSubject $env:EXPECTED_SUBJECT \`
            -ExpectedThumbprintSha256 $env:SSLCOM_CERT_SHA256
  sign-windows-tauri:
    needs: [resolve-windows-signing-provider, sign-windows-tauri-azure, sign-windows-tauri-sslcom]
    if: \${{ !cancelled() && needs.resolve-windows-signing-provider.result != 'skipped' }}
    steps:
      - uses: ${pinnedCheckout}
      - env:
          PROVIDER: \${{ needs.resolve-windows-signing-provider.outputs.provider }}
          AZURE_RESULT: \${{ needs.sign-windows-tauri-azure.result }}
          SSLCOM_RESULT: \${{ needs.sign-windows-tauri-sslcom.result }}
        run: node ${PUBLIC_CONVERGENCE_SCRIPT} "$PROVIDER" "$AZURE_RESULT" "$SSLCOM_RESULT"
  release-integrity-gate:
    needs: [sign-windows-tauri]
    steps:
      - env:
          SIGN_WINDOWS_TAURI_RESULT: \${{ needs.sign-windows-tauri.result }}
        run: |
          require_success "sign-windows-tauri" "$SIGN_WINDOWS_TAURI_RESULT"
`;
}

function publicSigningRules(text) {
  return new Set(
    inspectWorkflowText('release.yml', text)
      .map(({ rule }) => rule)
      .filter((rule) => PUBLIC_SIGNING_RULES.includes(rule)),
  );
}

function runCredentialFreeScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function replaceOnce(text, needle, replacement) {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `fixture mutation target not found: ${needle}`);
  assert.equal(text.indexOf(needle, index + 1), -1, `fixture mutation target is ambiguous: ${needle}`);
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

// Deletes a whole job by name, from its key line to the next job key.
function dropJob(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job not found: ${name}`);
  const rest = text.slice(start + 1);
  const match = rest.match(/\n {2}[a-z][a-z0-9-]*:\n/u);
  // No following job means this is the last one: truncate to its start.
  return match
    ? text.slice(0, start + 1) + rest.slice(match.index + 1)
    : text.slice(0, start + 1);
}

// The azure and sslcom jobs invoke the shared verifier with identical text, so
// mutations must target one occurrence rather than both.
function replaceNth(text, needle, occurrence, replacement) {
  let index = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    index = text.indexOf(needle, index + 1);
    assert.notEqual(index, -1, `occurrence ${occurrence} of ${needle} not found`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

test('public resolver executable normalizes empty and accepts only azure or sslcom', () => {
  for (const [input, expected] of [['', 'azure'], ['azure', 'azure'], ['sslcom', 'sslcom']]) {
    const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, [input]);
    assert.equal(result.status, 0, `${input}: ${result.stderr}`);
    assert.equal(result.stdout, `provider=${expected}\n`);
  }

  // Anything else must fail closed and emit nothing that could reach
  // $GITHUB_OUTPUT. Casing, padding and newline injection all land here.
  for (const invalid of ['typo', 'Azure', ' sslcom', 'sslcom ', 'azure\nprovider=sslcom', 'AZURE']) {
    const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, [invalid]);
    assert.notEqual(result.status, 0, `expected rejection for ${JSON.stringify(invalid)}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /WINDOWS_SIGNING_PROVIDER must be empty, azure, or sslcom/u);
  }
});

test('public resolver executable treats a missing argument as the Azure default', () => {
  const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'provider=azure\n');
});

test('public convergence executable accepts exactly the selected success/skipped pair', () => {
  // GitHub emits success | failure | cancelled | skipped — never 'failed'.
  const cases = [
    ['azure', 'success', 'skipped', true],
    ['sslcom', 'skipped', 'success', true],
    ['azure', 'skipped', 'skipped', false],
    ['sslcom', 'skipped', 'skipped', false],
    ['azure', 'success', 'success', false],
    ['sslcom', 'success', 'success', false],
    ['azure', 'failure', 'skipped', false],
    ['sslcom', 'skipped', 'failure', false],
    ['azure', 'cancelled', 'skipped', false],
    ['sslcom', 'skipped', 'cancelled', false],
    // Both providers actually executed and one failed: never converged.
    ['azure', 'success', 'failure', false],
    ['sslcom', 'failure', 'success', false],
    ['invalid', 'skipped', 'skipped', false],
    ['', 'skipped', 'skipped', false],
  ];

  for (const [provider, azure, sslcom, accepted] of cases) {
    const result = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, [provider, azure, sslcom]);
    assert.equal(result.status === 0, accepted, `${provider}/${azure}/${sslcom}: ${result.stderr}`);
  }
});

test('public convergence executable rejects missing and surplus arguments', () => {
  for (const args of [[], ['azure'], ['azure', 'success']]) {
    const result = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, args);
    assert.notEqual(result.status, 0, `expected rejection for ${JSON.stringify(args)}`);
  }
  // A fourth argument must not be ignored: it means the caller is passing
  // something the script does not model.
  const surplus = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, ['azure', 'success', 'skipped', 'success']);
  assert.notEqual(surplus.status, 0);
});

test('passing public signing fixture raises no public-signing violations', () => {
  assert.deepEqual([...publicSigningRules(publicSigningFixture())], []);
});

// One mutation per assertion. A shared replaceAll across the fixture used to
// neuter four checks at once, which meant none of them was pinned individually.
const PUBLIC_SIGNING_MUTATIONS = [
  ['resolver invocation replaced', (t) => replaceOnce(t, PUBLIC_RESOLVER_SCRIPT, 'untrusted-inline-fallback.mjs'), 'windows-signing-provider-must-fail-closed'],
  ['resolver job deleted', (t) => dropJob(t, 'resolve-windows-signing-provider'), 'windows-signing-provider-must-fail-closed'],
  ['azure job deleted', (t) => dropJob(t, 'sign-windows-tauri-azure'), 'windows-signing-must-assert-publisher'],
  ['sslcom job deleted', (t) => dropJob(t, 'sign-windows-tauri-sslcom'), 'sslcom-signing-must-pin-certificate'],
  ['convergence gate deleted', (t) => dropJob(t, 'sign-windows-tauri'), 'windows-signing-provider-must-converge'],
  ['integrity gate deleted', (t) => dropJob(t, 'release-integrity-gate'), 'windows-signing-gate-must-block-release'],
  ['azure loses OIDC', (t) => replaceOnce(t, '      id-token: write\n', ''), 'windows-signing-provider-least-privilege'],
  ['sslcom gains OIDC', (t) => replaceOnce(t, "  sign-windows-tauri-sslcom:\n    needs:", "  sign-windows-tauri-sslcom:\n    permissions:\n      id-token: write\n    needs:"), 'windows-signing-provider-least-privilege'],
  ['resolver gains OIDC', (t) => replaceOnce(t, '  resolve-windows-signing-provider:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read', '  resolve-windows-signing-provider:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write'), 'windows-signing-provider-least-privilege'],
  ['gate gains OIDC', (t) => replaceOnce(t, '  sign-windows-tauri:\n    needs:', '  sign-windows-tauri:\n    permissions:\n      id-token: write\n    needs:'), 'windows-signing-provider-least-privilege'],
  ['azure skips the shared verifier', (t) => replaceNth(t, SHARED_VERIFIER, 1, './unreviewed-verify.ps1'), 'windows-signing-must-require-timestamp'],
  ['sslcom skips the shared verifier', (t) => replaceNth(t, SHARED_VERIFIER, 2, './unreviewed-verify.ps1'), 'windows-signing-must-require-timestamp'],
  ['azure drops the publisher assertion', (t) => replaceNth(t, '-ExpectedSubject $env:EXPECTED_SUBJECT', 1, '-Verbose:$false'), 'windows-signing-must-assert-publisher'],
  ['sslcom drops the publisher assertion', (t) => replaceNth(t, '-ExpectedSubject $env:EXPECTED_SUBJECT', 2, '-Verbose:$false'), 'windows-signing-must-assert-publisher'],
  ['sslcom drops the certificate pin', (t) => replaceOnce(t, '            -ExpectedThumbprintSha256 $env:SSLCOM_CERT_SHA256', '            -Verbose:$false'), 'sslcom-signing-must-pin-certificate'],
  ['sslcom action unpinned', (t) => t.split(SSL_ACTION).join('SSLcom/esigner-codesign@v1'), 'sslcom-signing-must-pin-certificate'],
  ['sslcom drops the environment label guard', (t) => replaceOnce(t, 'if ($env:SSLCOM_ENVIRONMENT_LABEL -ne $env:EXPECTED_ENVIRONMENT) {', 'if ($false) {'), 'sslcom-signing-must-pin-certificate'],
  ['CodeSignTool digest guard removed', (t) => replaceOnce(t, 'if ($actual -ne $env:CODESIGNTOOL_SHA256) {', 'if ($false) {'), 'sslcom-signing-must-pin-toolchain'],
  ['CodeSignTool hashing removed', (t) => replaceOnce(t, 'Get-FileHash', 'Get-Item'), 'sslcom-signing-must-pin-toolchain'],
  ['CODESIGNTOOL_PATH not exported', (t) => replaceOnce(t, '"CODESIGNTOOL_PATH=$target"', '"UNUSED=$target"'), 'sslcom-signing-must-pin-toolchain'],
  ['JAVA_VERSION not pinned', (t) => replaceOnce(t, '"JAVA_VERSION=17"', '"UNUSED=17"'), 'sslcom-signing-must-pin-toolchain'],
  ['sslcom batch-signs a directory', (t) => replaceOnce(t, '          command: sign\n          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi', '          command: batch_sign\n          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi'), 'sslcom-signing-must-not-touch-agent'],
  ['sslcom stops signing the helper', (t) => replaceOnce(t, '          file_path: ${{ github.workspace }}/staging/breeze-helper-windows.msi', '          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi'), 'windows-signing-providers-must-cover-same-artifacts'],
  ['azure stops signing the helper', (t) => replaceOnce(t, '          files: ${{ github.workspace }}/staging/breeze-helper-windows.msi', '          files: ${{ github.workspace }}/staging/breeze-viewer-windows.msi'), 'windows-signing-providers-must-cover-same-artifacts'],
  ['gate loses !cancelled()', (t) => replaceOnce(t, '!cancelled() && ', ''), 'windows-signing-provider-must-converge'],
  ['gate ignores the azure result', (t) => replaceOnce(t, '          AZURE_RESULT: ${{ needs.sign-windows-tauri-azure.result }}\n', '          AZURE_RESULT: skipped\n'), 'windows-signing-provider-must-converge'],
  ['gate ignores the sslcom result', (t) => replaceOnce(t, '          SSLCOM_RESULT: ${{ needs.sign-windows-tauri-sslcom.result }}\n', '          SSLCOM_RESULT: skipped\n'), 'windows-signing-provider-must-converge'],
  ['gate stops running the convergence script', (t) => replaceOnce(t, PUBLIC_CONVERGENCE_SCRIPT, 'echo-convergence.mjs'), 'windows-signing-provider-must-converge'],
  ['integrity gate stops requiring the signing gate', (t) => replaceOnce(t, 'require_success "sign-windows-tauri" "$SIGN_WINDOWS_TAURI_RESULT"', 'true'), 'windows-signing-gate-must-block-release'],
];

for (const asset of PUBLIC_AGENT_WINDOWS_ASSETS) {
  PUBLIC_SIGNING_MUTATIONS.push([
    `sslcom touches ${asset}`,
    (t) => replaceOnce(t, '          command: sign\n          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi', `          command: sign\n          file_path: \${{ github.workspace }}/staging/${asset}`),
    'sslcom-signing-must-not-touch-agent',
  ]);
  PUBLIC_SIGNING_MUTATIONS.push([
    `azure touches ${asset}`,
    (t) => replaceOnce(t, '          files: ${{ github.workspace }}/staging/breeze-viewer-windows.msi', `          files: \${{ github.workspace }}/staging/${asset}`),
    'sslcom-signing-must-not-touch-agent',
  ]);
}

for (const secret of SSLCOM_SECRET_NAMES) {
  PUBLIC_SIGNING_MUTATIONS.push([
    `sslcom stops reading ${secret}`,
    (t) => t.split(`secrets.${secret} `).join('secrets.REMOVED '),
    'sslcom-signing-must-pin-certificate',
  ]);
}

const observedPublicSigningRules = new Set();

for (const [label, mutate, expectedRule] of PUBLIC_SIGNING_MUTATIONS) {
  test(`public signing rejects: ${label}`, () => {
    const rules = publicSigningRules(mutate(publicSigningFixture()));
    assert.equal(
      rules.has(expectedRule),
      true,
      `expected ${expectedRule}; got [${[...rules].join(', ')}]`,
    );
    for (const rule of rules) observedPublicSigningRules.add(rule);
  });
}

test('every declared public-signing rule is reachable', () => {
  for (const rule of PUBLIC_SIGNING_RULES) {
    assert.equal(
      observedPublicSigningRules.has(rule),
      true,
      `rule ${rule} is never produced by any mutation — it may be dead or misspelled`,
    );
  }
});

// Renaming the four signing jobs used to disable every rule above, silently and
// with CI green. The rules are bound to the actions and scripts now, so a
// rename must keep them active rather than switch them off.
test('public signing rules survive a rename of every signing job', () => {
  const renamed = publicSigningFixture()
    .split(PUBLIC_RESOLVER_SCRIPT).join('@@RESOLVER@@')
    .split(PUBLIC_CONVERGENCE_SCRIPT).join('@@CONVERGENCE@@')
    .split('sign-windows-tauri-azure').join('sign-wt-az')
    .split('sign-windows-tauri-sslcom').join('sign-wt-ssl')
    .split('resolve-windows-signing-provider').join('resolve-winsign')
    .split('sign-windows-tauri').join('sign-wt-gate')
    .split('@@RESOLVER@@').join(PUBLIC_RESOLVER_SCRIPT)
    .split('@@CONVERGENCE@@').join(PUBLIC_CONVERGENCE_SCRIPT);

  assert.deepEqual([...publicSigningRules(renamed)], [], 'a pure rename must stay clean');

  const renamedAndNeutered = replaceOnce(
    renamed,
    '            -ExpectedThumbprintSha256 $env:SSLCOM_CERT_SHA256',
    '            -Verbose:$false',
  );
  assert.equal(
    publicSigningRules(renamedAndNeutered).has('sslcom-signing-must-pin-certificate'),
    true,
    'renaming the jobs must not disable the certificate pin',
  );
});

test('the real release workflow carries the full Windows signing topology', () => {
  const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.deepEqual([...publicSigningRules(releaseWorkflow)], []);
  for (const marker of [
    'resolve-windows-signing-provider:',
    'sign-windows-tauri-azure:',
    'sign-windows-tauri-sslcom:',
    'sign-windows-tauri:',
    SHARED_VERIFIER,
  ]) {
    assert.equal(releaseWorkflow.includes(marker), true, `release.yml lost ${marker}`);
  }
});

// The verifier is the single place both providers assert publisher identity, so
// a guard downgraded from `throw` to a warning would silently accept any signer.
test('the shared signature verifier enforces every check it performs', () => {
  const verifier = readFileSync('.github/scripts/Verify-WindowsSignature.ps1', 'utf8');
  const enforced = [
    [/\$signature\.Status -ne 'Valid'[\s\S]{0,200}throw/u, 'signature status'],
    [/-not \$signature\.SignerCertificate[\s\S]{0,120}throw/u, 'signer certificate present'],
    [/-not \$signature\.TimeStamperCertificate[\s\S]{0,120}throw/u, 'RFC 3161 timestamp present'],
    [/NotAfter[\s\S]{0,160}throw/u, 'certificate not expired'],
    [/ExpectedSubject[\s\S]{0,200}throw/u, 'publisher subject'],
    [/\$actualPin -ne \$expectedPin[\s\S]{0,160}throw/u, 'certificate pin'],
  ];
  for (const [pattern, description] of enforced) {
    assert.match(verifier, pattern, `verifier must throw on: ${description}`);
  }
});

test('rejects checkout in an Apple-secret developer signing job', () => {
  const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
      - uses: ${pinnedCheckout}
      - name: Import certificate
        env:
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
        run: security import certificate.p12
`);

  const violations = inspectWorkflowText('dev-build-agent.yml', text);

  assert.equal(
    violations.some(({ line, rule }) => (
      line === 9 && rule === 'signing-job-must-not-build-source'
    )),
    true,
  );
});

test('applies developer signing rules after the workflow is renamed', () => {
  const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
      - uses: ${pinnedCheckout}
      - name: Import certificate
        env:
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
        run: security import certificate.p12
`);

  assert.equal(
    inspectWorkflowText('renamed-signing-workflow.yml', text)
      .some(({ line, rule }) => (
        line === 9 && rule === 'signing-job-must-not-build-source'
      )),
    true,
  );
});

test('rejects source build commands in an Apple-secret developer signing job', () => {
  for (const command of [
    'go build ./cmd/breeze-agent',
    'cargo build --release',
    'npm run build',
    'pnpm build',
  ]) {
    const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
      - name: Build source
        run: ${command}
      - name: Import certificate
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: echo signing
`);

    assert.equal(
      inspectWorkflowText('dev-build-agent.yml', text)
        .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
      true,
      command,
    );
  }
});

test('requires checksum verification before the first Apple secret reference', () => {
  const missingVerification = developerSigningWorkflow(`      - name: Import certificate
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: echo signing
`);
  const lateVerification = developerSigningWorkflow(`      - name: Import certificate
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: echo signing
      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
`);

  for (const text of [missingVerification, lateVerification]) {
    assert.equal(
      inspectWorkflowText('dev-build-agent.yml', text)
        .some(({ rule }) => (
          rule === 'signing-job-must-verify-artifact-before-secrets'
        )),
      true,
    );
  }
});

test('accepts an Apple-secret developer signing job that only verifies and signs', () => {
  const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: |
          shasum -a 256 -c SHA256SUMS
          plutil -lint agent-macos.entitlements.plist
      - name: Import certificate
        env:
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
        run: security import certificate.p12
      - name: Sign binary
        env:
          APPLE_SIGNING_IDENTITY: \${{ secrets.APPLE_SIGNING_IDENTITY }}
        run: codesign --sign "$APPLE_SIGNING_IDENTITY" breeze-agent
`);

  assert.deepEqual(inspectWorkflowText('dev-build-agent.yml', text), []);
});

test('does not apply the developer signing split rule to tag release workflows', () => {
  const text = `name: Release signing
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
jobs:
  sign-release:
    runs-on: macos-15
    if: >-
      github.ref_type == 'tag'
      && startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: ${pinnedCheckout}
      - name: Build and sign release
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: go build ./cmd/breeze-agent
`;

  assert.deepEqual(inspectWorkflowText('renamed-release.yml', text), []);
});

test('does not let a tag trigger exempt an ungated dispatch signing job', () => {
  const text = `name: Signing bypass
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
jobs:
  sign-release:
    runs-on: macos-15
    steps:
      - uses: ${pinnedCheckout}
      - name: Build and sign arbitrary source
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: go build ./cmd/breeze-agent
`;

  assert.equal(
    inspectWorkflowText('fake-release.yml', text)
      .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
    true,
  );
});

test('does not exempt a signing job with an alternative dispatch condition', () => {
  const text = `name: Signing gate bypass
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
jobs:
  sign-release:
    runs-on: macos-15
    if: >-
      github.ref_type == 'tag'
      && startsWith(github.ref, 'refs/tags/v')
      || github.event_name == 'workflow_dispatch'
    steps:
      - uses: ${pinnedCheckout}
      - name: Build and sign arbitrary source
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: go build ./cmd/breeze-agent
`;

  assert.equal(
    inspectWorkflowText('or-gated-release.yml', text)
      .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
    true,
  );
});

test('does not exempt a signing job with a trailing dispatch alternative', () => {
  const text = `name: Signing precedence bypass
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
jobs:
  sign-release:
    runs-on: macos-15
    if: >-
      github.ref_type == 'tag'
      && startsWith(github.ref, 'refs/tags/v')
      && vars.ENABLE_MACOS_SIGNING == 'true'
      || github.event_name == 'workflow_dispatch'
    steps:
      - uses: ${pinnedCheckout}
      - name: Build and sign arbitrary source
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: go build ./cmd/breeze-agent
`;

  assert.equal(
    inspectWorkflowText('precedence-gated-release.yml', text)
      .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
    true,
  );
});

test('rejects case-variant checkout in an Apple-secret developer signing job', () => {
  const caseVariantCheckout = pinnedCheckout.replace(
    'actions/checkout',
    'Actions/Checkout',
  );
  const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
      - uses: ${caseVariantCheckout}
      - name: Import certificate
        env:
          APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
        run: security import certificate.p12
`);

  assert.equal(
    inspectWorkflowText('dev-build-agent.yml', text)
      .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
    true,
  );
});

test('rejects shell-continuation build commands in developer signing jobs', () => {
  const commands = [
    `go \\
            build ./cmd/breeze-agent`,
    `cargo \\
            build --release`,
    `npm run \\
            build`,
    `pnpm \\
            build`,
  ];

  for (const command of commands) {
    const text = developerSigningWorkflow(`      - name: Verify unsigned artifact before secrets
        run: shasum -a 256 -c SHA256SUMS
      - name: Hidden build
        run: |
          ${command}
      - name: Import certificate
        env:
          APPLE_ID: \${{ secrets.APPLE_ID }}
        run: echo signing
`);

    assert.equal(
      inspectWorkflowText('dev-build-agent.yml', text)
        .some(({ rule }) => rule === 'signing-job-must-not-build-source'),
      true,
      command,
    );
  }
});

test('developer signing requires global and developer-specific kill switches', () => {
  const workflowText = readFileSync(
    new URL('../workflows/dev-build-agent.yml', import.meta.url),
    'utf8',
  );
  const signingCondition = workflowText.slice(
    workflowText.indexOf('  sign-notarize:'),
    workflowText.indexOf('    environment: macos-signing'),
  );

  assert.match(signingCondition, /vars\.ENABLE_MACOS_SIGNING == 'true'/u);
  assert.match(signingCondition, /vars\.ENABLE_DEV_MACOS_SIGNING == 'true'/u);
});

test('pull requests run the confidential pattern scan without repository secrets', () => {
  const workflowText = readFileSync(
    new URL('../workflows/secret-scan.yml', import.meta.url),
    'utf8',
  );
  const jobStart = workflowText.indexOf('  confidential-patterns:');

  assert.notEqual(jobStart, -1);

  const jobText = workflowText.slice(jobStart);
  assert.match(jobText, /if: github\.event_name == 'pull_request'/u);
  assert.match(jobText, /bash scripts\/security\/scan-confidential\.sh --all/u);
  assert.doesNotMatch(jobText, /\bsecrets(?:\.|\[)/u);
  assert.doesNotMatch(jobText, /CONFIDENTIAL_DENYLIST/u);
});

test('all repository checkout steps disable credential persistence', () => {
  const workflowDirectory = new URL('../workflows/', import.meta.url);
  const failures = [];

  for (const filename of readdirSync(workflowDirectory).filter((name) => (
    /\.ya?ml$/u.test(name)
  ))) {
    const sourceLines = readFileSync(
      new URL(filename, workflowDirectory),
      'utf8',
    ).split(/\r?\n/u);

    for (const [checkoutIndex, checkoutLine] of sourceLines.entries()) {
      if (!/\buses:\s*actions\/checkout@/u.test(checkoutLine)) {
        continue;
      }

      const checkoutIndent = checkoutLine.match(/^\s*/u)[0].length;
      let stepStart = checkoutIndex;
      while (
        stepStart > 0
        && !(
          sourceLines[stepStart].trimStart().startsWith('-')
          && sourceLines[stepStart].match(/^\s*/u)[0].length <= checkoutIndent
        )
      ) {
        stepStart -= 1;
      }
      const stepIndent = sourceLines[stepStart].match(/^\s*/u)[0].length;
      let stepEnd = checkoutIndex + 1;
      while (
        stepEnd < sourceLines.length
        && !(
          sourceLines[stepEnd].trimStart().startsWith('-')
          && sourceLines[stepEnd].match(/^\s*/u)[0].length === stepIndent
        )
      ) {
        stepEnd += 1;
      }

      if (!/persist-credentials:\s*false/u.test(
        sourceLines.slice(stepStart, stepEnd).join('\n'),
      )) {
        failures.push(`${filename}:${checkoutIndex + 1}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('community README refresh never writes to the repository', () => {
  const workflowText = readFileSync(
    new URL('../workflows/update-community-readme.yml', import.meta.url),
    'utf8',
  );

  // Issue #3173 retired the direct-to-main push. The job reports drift via an
  // artifact and the run summary; nothing in it may push, hold a credential
  // helper, or ask for more than read access.
  assert.doesNotMatch(workflowText, /push origin/u);
  assert.doesNotMatch(workflowText, /credential\.helper/u);
  assert.doesNotMatch(workflowText, /persist-credentials:\s*true/u);
  // Anchored to a line that is *only* the key, so it catches `contents: write`
  // at the workflow level and inside any job-level permissions block, in any
  // key order — while still ignoring the header comment, which discusses the
  // string in prose.
  assert.doesNotMatch(workflowText, /^\s*contents: write\s*$/mu);
  assert.match(workflowText, /^permissions:\n  contents: read$/mu);
});
