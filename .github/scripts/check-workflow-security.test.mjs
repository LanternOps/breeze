import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PINNED_GATE_RULE,
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

function developerSigningWorkflow(signingSteps, { environment = '' } = {}) {
  return `name: Developer signing
on: workflow_dispatch
jobs:
  sign-notarize:
    runs-on: macos-15
${environment ? `    environment: ${environment}\n` : ''}    steps:
${signingSteps}
`;
}

const SSL_ACTION = 'SSLcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b';
// The Azure Artifact Signing lane was retired (account disabled, AZURE_* secrets
// deleted 2026-10-19). Its action must never reappear in the release workflow.
const RETIRED_AZURE_SIGNING_ACTION = 'azure/artifact-signing-action';
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
  // build-viewer names the signed artifact outside the signing job, as the real
  // workflow does, so the public-signing rules stay armed even when a mutation
  // deletes the signing job itself.
  return `on: push
jobs:
  build-viewer:
    runs-on: windows-latest
    permissions:
      contents: read
    steps:
      - uses: ${pinnedCheckout}
      - name: Upload viewer MSI
        uses: actions/upload-artifact@0123456789abcdef0123456789abcdef01234567
        with:
          name: breeze-viewer-windows.msi
          path: staging/breeze-viewer-windows.msi
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
    needs: [resolve-windows-signing-provider, sign-windows-tauri-sslcom]
    if: \${{ !cancelled() && needs.resolve-windows-signing-provider.result != 'skipped' }}
    steps:
      - uses: ${pinnedCheckout}
      - env:
          PROVIDER: \${{ needs.resolve-windows-signing-provider.outputs.provider }}
          SSLCOM_RESULT: \${{ needs.sign-windows-tauri-sslcom.result }}
        run: node ${PUBLIC_CONVERGENCE_SCRIPT} "$PROVIDER" "$SSLCOM_RESULT"
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

test('public resolver executable normalizes empty and accepts only sslcom', () => {
  for (const [input, expected] of [['', 'sslcom'], ['sslcom', 'sslcom']]) {
    const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, [input]);
    assert.equal(result.status, 0, `${input}: ${result.stderr}`);
    assert.equal(result.stdout, `provider=${expected}\n`);
  }

  // Anything else must fail closed and emit nothing that could reach
  // $GITHUB_OUTPUT. Casing, padding and newline injection all land here, and
  // so does the retired Azure provider: a stale repository variable must stop
  // the release rather than select a lane that no longer exists.
  for (const invalid of ['typo', 'azure', 'Azure', 'AZURE', 'SSLCOM', ' sslcom', 'sslcom ', 'sslcom\nprovider=azure']) {
    const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, [invalid]);
    assert.notEqual(result.status, 0, `expected rejection for ${JSON.stringify(invalid)}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /WINDOWS_SIGNING_PROVIDER must be empty or sslcom/u);
  }
});

test('public resolver executable treats a missing argument as the SSL.com default', () => {
  const result = runCredentialFreeScript(PUBLIC_RESOLVER_SCRIPT, []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'provider=sslcom\n');
});

test('public convergence executable accepts only a successful SSL.com signing job', () => {
  // GitHub emits success | failure | cancelled | skipped — never 'failed'.
  const cases = [
    ['sslcom', 'success', true],
    // The signing job was skipped on a full release: fail closed, never ship
    // an unsigned installer under a "signed" release.
    ['sslcom', 'skipped', false],
    ['sslcom', 'failure', false],
    ['sslcom', 'cancelled', false],
    ['sslcom', '', false],
    // The retired provider must not be accepted even with a green job.
    ['azure', 'success', false],
    ['invalid', 'success', false],
    ['', 'success', false],
  ];

  for (const [provider, sslcom, accepted] of cases) {
    const result = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, [provider, sslcom]);
    assert.equal(result.status === 0, accepted, `${provider}/${sslcom}: ${result.stderr}`);
  }
});

test('public convergence executable rejects missing and surplus arguments', () => {
  for (const args of [[], ['sslcom']]) {
    const result = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, args);
    assert.notEqual(result.status, 0, `expected rejection for ${JSON.stringify(args)}`);
  }
  // A third argument must not be ignored: it means the caller is passing
  // something the script does not model (for example the retired Azure
  // result, which the old three-argument form carried).
  const surplus = runCredentialFreeScript(PUBLIC_CONVERGENCE_SCRIPT, ['sslcom', 'success', 'skipped']);
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
  ['sslcom job deleted', (t) => dropJob(t, 'sign-windows-tauri-sslcom'), 'sslcom-signing-must-pin-certificate'],
  ['convergence gate deleted', (t) => dropJob(t, 'sign-windows-tauri'), 'windows-signing-provider-must-converge'],
  ['integrity gate deleted', (t) => dropJob(t, 'release-integrity-gate'), 'windows-signing-gate-must-block-release'],
  ['sslcom gains OIDC', (t) => replaceOnce(t, "  sign-windows-tauri-sslcom:\n    needs:", "  sign-windows-tauri-sslcom:\n    permissions:\n      id-token: write\n    needs:"), 'windows-signing-provider-least-privilege'],
  ['resolver gains OIDC', (t) => replaceOnce(t, '  resolve-windows-signing-provider:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read', '  resolve-windows-signing-provider:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write'), 'windows-signing-provider-least-privilege'],
  ['gate gains OIDC', (t) => replaceOnce(t, '  sign-windows-tauri:\n    needs:', '  sign-windows-tauri:\n    permissions:\n      id-token: write\n    needs:'), 'windows-signing-provider-least-privilege'],
  ['sslcom skips the shared verifier', (t) => replaceOnce(t, SHARED_VERIFIER, './unreviewed-verify.ps1'), 'windows-signing-must-require-timestamp'],
  ['sslcom drops the publisher assertion', (t) => replaceOnce(t, '-ExpectedSubject $env:EXPECTED_SUBJECT', '-Verbose:$false'), 'windows-signing-must-assert-publisher'],
  ['sslcom drops the certificate pin', (t) => replaceOnce(t, '            -ExpectedThumbprintSha256 $env:SSLCOM_CERT_SHA256', '            -Verbose:$false'), 'sslcom-signing-must-pin-certificate'],
  ['sslcom opts out of pinning', (t) => replaceOnce(t, '            -ExpectedThumbprintSha256 $env:SSLCOM_CERT_SHA256', '            -AllowUnpinnedLeaf'), 'sslcom-signing-must-pin-certificate'],
  ['sslcom action unpinned', (t) => t.split(SSL_ACTION).join('SSLcom/esigner-codesign@v1'), 'sslcom-signing-must-pin-certificate'],
  ['sslcom drops the environment label guard', (t) => replaceOnce(t, 'if ($env:SSLCOM_ENVIRONMENT_LABEL -ne $env:EXPECTED_ENVIRONMENT) {', 'if ($false) {'), 'sslcom-signing-must-pin-certificate'],
  ['CodeSignTool digest guard removed', (t) => replaceOnce(t, 'if ($actual -ne $env:CODESIGNTOOL_SHA256) {', 'if ($false) {'), 'sslcom-signing-must-pin-toolchain'],
  ['CodeSignTool hashing removed', (t) => replaceOnce(t, 'Get-FileHash', 'Get-Item'), 'sslcom-signing-must-pin-toolchain'],
  ['CODESIGNTOOL_PATH not exported', (t) => replaceOnce(t, '"CODESIGNTOOL_PATH=$target"', '"UNUSED=$target"'), 'sslcom-signing-must-pin-toolchain'],
  ['JAVA_VERSION not pinned', (t) => replaceOnce(t, '"JAVA_VERSION=17"', '"UNUSED=17"'), 'sslcom-signing-must-pin-toolchain'],
  ['sslcom batch-signs a directory', (t) => replaceOnce(t, '          command: sign\n          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi', '          command: batch_sign\n          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi'), 'sslcom-signing-must-not-touch-agent'],
  ['sslcom stops signing the helper', (t) => replaceOnce(t, '          file_path: ${{ github.workspace }}/staging/breeze-helper-windows.msi', '          file_path: ${{ github.workspace }}/staging/breeze-viewer-windows.msi'), 'windows-signing-providers-must-cover-same-artifacts'],
  ['gate loses !cancelled()', (t) => replaceOnce(t, '!cancelled() && ', ''), 'windows-signing-provider-must-converge'],
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
}

for (const secret of SSLCOM_SECRET_NAMES) {
  PUBLIC_SIGNING_MUTATIONS.push([
    `sslcom stops reading ${secret}`,
    (t) => {
      const mutated = t.split(`secrets.${secret}`).join('secrets.REMOVED');
      assert.notEqual(mutated, t, `secret mutation for ${secret} did not apply`);
      return mutated;
    },
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

// Renaming the signing jobs used to disable every rule above, silently and
// with CI green. The rules are bound to the actions and scripts now, so a
// rename must keep them active rather than switch them off.
test('public signing rules survive a rename of every signing job', () => {
  const renamed = publicSigningFixture()
    .split(PUBLIC_RESOLVER_SCRIPT).join('@@RESOLVER@@')
    .split(PUBLIC_CONVERGENCE_SCRIPT).join('@@CONVERGENCE@@')
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
  const releaseWorkflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
  assert.deepEqual([...publicSigningRules(releaseWorkflow)], []);
  for (const marker of [
    'resolve-windows-signing-provider:',
    'sign-windows-tauri-sslcom:',
    'sign-windows-tauri:',
    SHARED_VERIFIER,
  ]) {
    assert.equal(releaseWorkflow.includes(marker), true, `release.yml lost ${marker}`);
  }
  // The retired lane stays retired: its secrets no longer exist, so a job that
  // used them could only ever produce an unsigned or failed release.
  for (const retired of [
    RETIRED_AZURE_SIGNING_ACTION,
    'sign-windows-tauri-azure',
    'secrets.AZURE_',
    '-AllowUnpinnedLeaf',
  ]) {
    assert.equal(releaseWorkflow.includes(retired), false, `release.yml reintroduced ${retired}`);
  }
});

// The verifier is the single place the signing job asserts publisher identity,
// so a guard downgraded from `throw` to a warning would silently accept any
// signer.
test('the shared signature verifier enforces every check it performs', () => {
  const verifier = readFileSync(new URL('./Verify-WindowsSignature.ps1', import.meta.url), 'utf8');
  const enforced = [
    [/\$signature\.Status -ne 'Valid'[\s\S]{0,200}throw/u, 'signature status'],
    [/-not \$signature\.SignerCertificate[\s\S]{0,120}throw/u, 'signer certificate present'],
    [/-not \$signature\.TimeStamperCertificate[\s\S]{0,120}throw/u, 'RFC 3161 timestamp present'],
    [/NotAfter[\s\S]{0,160}throw/u, 'certificate not expired'],
    [/ExpectedSubject[\s\S]{0,200}throw/u, 'publisher subject'],
    [/\$expectedPins -notcontains \$actualPin[\s\S]{0,200}throw/u, 'certificate pin'],
    [/\$expectedPins\.Count -eq 0 -and -not \$AllowUnpinnedLeaf[\s\S]{0,200}throw/u, 'refuses an unpinned run by default'],
    [/\$expectedPins\.Count -eq 0\)\s*\{[\s\S]{0,1500}throw "Unpinned signature/u, 'requires a trusted chain when unpinned'],
    [/-notmatch '\^\[0-9a-f\]\{64\}\$'[\s\S]{0,160}throw/u, 'thumbprint format'],
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
`, { environment: 'signing-production' });

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
    environment: signing-production
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

// Signing material is scoped to the protected signing environments, whose
// deployment policy only admits v* tags. A job that names one of these secrets
// must declare one of those environments, or it would resolve a repository-level
// copy instead.
const SIGNING_ENVIRONMENT_RULE = 'signing-secrets-must-use-signing-environment';
const PROTECTED_SIGNING_SECRET_NAMES = [
  'RELEASE_MANIFEST_ED25519_PRIVATE_KEY',
  'RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_INSTALLER_IDENTITY',
  'SSLCOM_PASSWORD',
  'SSLCOM_TOTP_SECRET',
];
const SIGNING_ENVIRONMENT_SELECTOR = "${{ contains(github.ref_name, '-') && 'signing-prerelease' || 'signing-production' }}";

function signingJobWorkflow({ environment = '', secretLine }) {
  return `name: Signing
on:
  push:
    tags:
      - 'v*'
jobs:
  sign:
    runs-on: ubuntu-latest
${environment}    steps:
      - name: Use signing material
        env:
          ${secretLine}
        run: echo signing
`;
}

function signingEnvironmentViolations(file, text) {
  return inspectWorkflowText(file, text)
    .filter(({ rule }) => rule === SIGNING_ENVIRONMENT_RULE);
}

for (const secret of PROTECTED_SIGNING_SECRET_NAMES) {
  test(`signing environment rule rejects ${secret} outside a signing environment`, () => {
    const violations = signingEnvironmentViolations('sign.yml', signingJobWorkflow({
      secretLine: `VALUE: \${{ secrets.${secret} }}`,
    }));
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0].line, 12);
    assert.match(violations[0].message, new RegExp(`job "sign"[\\s\\S]*\\b${secret}\\b`, 'u'));
  });
}

test('signing environment rule accepts each protected-environment spelling', () => {
  const spellings = [
    '    environment: signing-production\n',
    '    environment: signing-prerelease\n',
    "    environment: 'signing-production'\n",
    '    environment:\n      name: signing-production\n',
    '    environment:\n      name: "signing-prerelease"\n',
    `    environment:\n      name: ${SIGNING_ENVIRONMENT_SELECTOR}\n`,
    `    environment: ${SIGNING_ENVIRONMENT_SELECTOR}\n`,
    '    environment: { name: signing-prerelease }\n',
  ];
  for (const environment of spellings) {
    for (const secret of PROTECTED_SIGNING_SECRET_NAMES) {
      assert.deepEqual(
        signingEnvironmentViolations('sign.yml', signingJobWorkflow({
          environment,
          secretLine: `VALUE: \${{ secrets.${secret} }}`,
        })),
        [],
        `${JSON.stringify(environment)} / ${secret}`,
      );
    }
  }
});

test('signing environment rule rejects any other environment', () => {
  const spellings = [
    '    environment: macos-signing\n',
    '    environment: production\n',
    '    environment: signing-production-copy\n',
    '    environment: ${{ inputs.environment }}\n',
    "    environment: ${{ github.event_name == 'push' && 'signing-production' || 'scratch' }}\n",
    '    environment:\n      name: scratch\n      url: https://example.invalid/signing-production\n',
    '    environment:\n      url: https://example.invalid\n',
    '    environment: { name: scratch }\n',
    '    # environment: signing-production\n',
  ];
  for (const environment of spellings) {
    assert.equal(
      signingEnvironmentViolations('sign.yml', signingJobWorkflow({
        environment,
        secretLine: 'VALUE: ${{ secrets.APPLE_CERTIFICATE }}',
      })).length,
      1,
      JSON.stringify(environment),
    );
  }
});

test('signing environment rule only counts the job-level environment key', () => {
  const text = `name: Signing
on: workflow_dispatch
jobs:
  sign:
    runs-on: ubuntu-latest
    steps:
      - name: Looks like an environment
        uses: ./local-action
        with:
          environment: signing-production
      - name: Use signing material
        env:
          VALUE: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
        run: echo signing
`;
  assert.equal(signingEnvironmentViolations('nested.yml', text).length, 1);
});

test('signing environment rule scopes the environment to its own job', () => {
  const text = `name: Signing
on:
  push:
    tags:
      - 'v*'
jobs:
  protected:
    runs-on: ubuntu-latest
    environment: signing-production
    steps:
      - run: echo protected
  unprotected:
    runs-on: ubuntu-latest
    steps:
      - name: Use signing material
        env:
          VALUE: \${{ secrets.RELEASE_MANIFEST_ED25519_PRIVATE_KEY }}
        run: echo signing
`;
  const violations = signingEnvironmentViolations('siblings.yml', text);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /job "unprotected"/u);
});

test('signing environment rule sees bracket, folded and run-script references', () => {
  const cases = [
    "VALUE: ${{ secrets['APPLE_PASSWORD'] }}",
    'VALUE: ${{ secrets["SSLCOM_PASSWORD"] }}',
    'VALUE: >-\n            ${{ secrets\n            .TAURI_SIGNING_PRIVATE_KEY }}',
  ];
  for (const secretLine of cases) {
    assert.equal(
      signingEnvironmentViolations('variants.yml', signingJobWorkflow({ secretLine })).length,
      1,
      secretLine,
    );
  }

  const runScript = `name: Signing
on: workflow_dispatch
jobs:
  sign:
    runs-on: ubuntu-latest
    steps:
      - run: |
          printf '%s' "\${{ secrets.RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY }}" > key
`;
  assert.equal(signingEnvironmentViolations('run.yml', runScript).length, 1);
});

test('signing environment rule matches secret names case-insensitively, as GitHub does', () => {
  for (const [secretLine, name] of [
    ['VALUE: ${{ secrets.apple_id }}', 'APPLE_ID'],
    ['VALUE: ${{ secrets.Tauri_Signing_Private_Key }}', 'TAURI_SIGNING_PRIVATE_KEY'],
    ["VALUE: ${{ secrets['release_manifest_ed25519_private_key'] }}", 'RELEASE_MANIFEST_ED25519_PRIVATE_KEY'],
  ]) {
    const violations = signingEnvironmentViolations('case.yml', signingJobWorkflow({ secretLine }));
    assert.equal(violations.length, 1, secretLine);
    assert.match(violations[0].message, new RegExp(`\\b${name}\\b`, 'u'), secretLine);
  }
  assert.deepEqual(
    signingEnvironmentViolations('case.yml', signingJobWorkflow({
      secretLine: 'VALUE: ${{ secrets.release_manifest_ed25519_public_key }}',
    })),
    [],
  );
});

test('signing environment rule rejects whole-context and dynamic secret access outside the environment', () => {
  for (const secretLine of [
    'VALUE: ${{ toJSON(secrets) }}',
    'VALUE: ${{ secrets.* }}',
    "VALUE: ${{ join(secrets.*, ',') }}",
    "VALUE: ${{ secrets[format('{0}_KEY', 'TAURI_SIGNING_PRIVATE')] }}",
    'VALUE: ${{ secrets[env.NAME] }}',
  ]) {
    assert.equal(
      signingEnvironmentViolations('dynamic.yml', signingJobWorkflow({ secretLine })).length,
      1,
      secretLine,
    );
  }

  const inherit = `name: Signing
on: workflow_dispatch
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    secrets: inherit
`;
  assert.equal(signingEnvironmentViolations('inherit.yml', inherit).length, 1);
});

test('signing environment rule rejects signing material in workflow-level env', () => {
  const text = `name: Signing
on:
  push:
    tags:
      - 'v*'
env:
  APPLE_ID: \${{ secrets.APPLE_ID }}
jobs:
  sign:
    runs-on: ubuntu-latest
    environment: signing-production
    steps:
      - run: echo signing
`;
  const violations = signingEnvironmentViolations('top-level.yml', text);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 7);
});

test('signing environment rule leaves public keys and unrelated secrets alone', () => {
  for (const secret of [
    'RELEASE_MANIFEST_ED25519_PUBLIC_KEY',
    'RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY',
    'GITHUB_TOKEN',
    'AI_TOOL_EVAL_KEY',
  ]) {
    assert.deepEqual(
      signingEnvironmentViolations('public.yml', signingJobWorkflow({
        secretLine: `VALUE: \${{ secrets.${secret} }}`,
      })),
      [],
      secret,
    );
  }
});

test('every workflow in the repository keeps signing material inside the signing environments', () => {
  assert.deepEqual(
    inspectWorkflowDirectory(fileURLToPath(new URL('../workflows/', import.meta.url)))
      .filter(({ rule }) => rule === SIGNING_ENVIRONMENT_RULE),
    [],
  );
});

test('the developer agent build carries no signing material', () => {
  const workflowText = readFileSync(
    new URL('../workflows/dev-build-agent.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(workflowText, /\bsecrets\s*[.[]/u);
  assert.doesNotMatch(workflowText, /^\s*environment:/mu);
});

// ── The pinned CI Gate (W02, #10746) ─────────────────────────────────────

const PINNED_GATE = readFileSync(new URL('../workflows/ci-gate.yml', import.meta.url), 'utf8');
const gateViolations = (text, file = 'ci-gate.yml') => inspectWorkflowText(file, text)
  .filter(({ rule }) => rule === PINNED_GATE_RULE);
const VERIFY_STEP = '        run: node .github/scripts/ci-gate.mjs verify\n';
const CHECKOUT_REF = '          ref: ${{ github.workflow_sha }}\n';
const SETUP_NODE_INPUTS = "          node-version: '22.23.4'\n          package-manager-cache: false\n";
const JOB_HEADER = '    name: CI Gate\n    runs-on: ubuntu-latest\n    timeout-minutes: 145\n';
const addStep = (step) => (text) => text.replace(VERIFY_STEP, `${VERIFY_STEP}\n${step}`);

// W05a (#10749): the select step, the selection upload, and the kill switch.
const SELECT_STEP = '        run: node .github/scripts/ci-gate.mjs select\n';
const THIN_QUEUE_LINE = '          THIN_QUEUE: ${{ vars.CI_THIN_QUEUE }}\n';
const VERIFY_HEAD_REF = '          HEAD_REF: ${{ github.event.merge_group.head_ref }}\n        run: node .github/scripts/ci-gate.mjs verify\n';
// One step's text, from its `- name:` line to the next step or the end of the file.
const stepText = (text, name) => text.match(new RegExp(`^      - name: ${name}\\n[\\s\\S]*?(?=^      - |(?![\\s\\S]))`, 'm'))?.[0] ?? assert.fail(`no ${name} step`);
const moveAfter = (name, after) => (text) => {
  const moved = stepText(text, name);
  const without = text.replace(moved, '');
  const anchor = stepText(without, after);
  return without.replace(anchor, `${anchor}${moved}`);
};
const inStep = (name, from, to) => (text) => {
  const step = stepText(text, name);
  assert.ok(step.includes(from), `${name} has no ${from.trim()}`);
  return text.replace(step, step.replace(from, to));
};
const SELECTION_UPLOAD = 'Upload the queue selection';
const ANCHOR_UPLOAD = 'Upload the PR anchor';
const SELECT = "Select the queue entry's jobs";
const JUDGE = 'Judge the queue entry';

// Each mutation breaks exactly one invariant and must be reported as such.
const GATE_MUTATIONS = [
  ['checkout of the candidate', (t) => t.replace(CHECKOUT_REF, '          ref: ${{ github.sha }}\n'), /must set ref: \$\{\{ github\.workflow_sha \}\}/u],
  ['checkout with no ref', (t) => t.replace(CHECKOUT_REF, ''), /must set ref: \$\{\{ github\.workflow_sha \}\}/u],
  ['checkout keeping credentials', (t) => t.replace('persist-credentials: false', 'persist-credentials: true'), /must set persist-credentials: false/u],
  ['a second checkout without the pins', addStep('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'), /actions\/checkout must set ref: \$\{\{ github\.workflow_sha \}\}/u],
  ['checkout of another repository', (t) => t.replace(CHECKOUT_REF, `${CHECKOUT_REF}          repository: someone/else\n`), /input repository is not allowed/u],
  ['shallow checkout', (t) => t.replace('fetch-depth: 0', 'fetch-depth: 1'), /must set fetch-depth: 0/u],
  ['checkout of the whole tree', (t) => t.replace('          sparse-checkout: |\n            .github/scripts\n', ''), /must set sparse-checkout: \.github\/scripts/u],
  ['pnpm install', addStep('      - run: pnpm install --frozen-lockfile\n'), /run must be exactly one of/u],
  ['npm ci', addStep('      - run: npm ci\n'), /run must be exactly one of/u],
  ['go build', addStep('      - run: go build ./...\n'), /run must be exactly one of/u],
  ['docker run', addStep('      - run: docker run --rm alpine true\n'), /run must be exactly one of/u],
  ['a docker action', addStep('      - uses: docker://alpine:3\n'), /uses docker:\/\/alpine:3 is not allowed/u],
  ['a second command hidden in a block scalar', (t) => t.replace(VERIFY_STEP, '        run: |\n          node .github/scripts/ci-gate.mjs verify\n'), /run must be exactly one of/u],
  ['a setup-node cache', (t) => t.replace(SETUP_NODE_INPUTS, `${SETUP_NODE_INPUTS}          cache: pnpm\n`), /cache is not allowed/u],
  ['automatic package-manager caching', (t) => t.replace('package-manager-cache: false', 'package-manager-cache: true'), /must set package-manager-cache: false/u],
  ['the cache action', addStep('      - uses: actions/cache@0123456789abcdef0123456789abcdef01234567\n'), /uses actions\/cache@.* is not allowed/u],
  ['a secret', (t) => t.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GH_PAT }}'), /secrets are not allowed/u],
  ['concurrency with cancel-in-progress', (t) => t.replace('jobs:\n', 'concurrency:\n  group: gate\n  cancel-in-progress: true\n\njobs:\n'), /cancel-in-progress is not allowed/u],
  ['concurrency at all', (t) => t.replace(JOB_HEADER, `${JOB_HEADER}    concurrency: gate\n`), /concurrency is not allowed/u],
  ['continue-on-error on a step', (t) => t.replace(VERIFY_STEP, `${VERIFY_STEP}        continue-on-error: true\n`), /continue-on-error is not allowed/u],
  ['continue-on-error on the job', (t) => t.replace(JOB_HEADER, `${JOB_HEADER}    continue-on-error: true\n`), /continue-on-error is not allowed/u],
  ['a job-level if', (t) => t.replace(JOB_HEADER, `${JOB_HEADER}    if: github.event_name == 'merge_group'\n`), /job-level if: is not allowed/u],
  ['a paths filter', (t) => t.replace('  pull_request:\n    branches: [ci-gate-ruleset-only]\n', "  pull_request:\n    branches: [ci-gate-ruleset-only]\n    paths: ['apps/**']\n"), /paths is not allowed/u],
  ['a paths-ignore filter', (t) => t.replace('  merge_group:\n    branches: [ci-gate-ruleset-only]\n', "  merge_group:\n    branches: [ci-gate-ruleset-only]\n    paths-ignore: ['docs/**']\n"), /paths-ignore is not allowed/u],
  ['a matching branch filter', (t) => t.replace('  merge_group:\n    branches: [ci-gate-ruleset-only]', '  merge_group:\n    branches: [main]'), /merge_group must be filtered to exactly branches: \[ci-gate-ruleset-only\]/u],
  ['an unfiltered trigger', (t) => t.replace('  pull_request:\n    branches: [ci-gate-ruleset-only]\n', '  pull_request:\n'), /pull_request must be filtered to exactly/u],
  ['a third trigger', (t) => t.replace('  merge_group:\n', '  workflow_dispatch:\n  merge_group:\n'), /triggers must be exactly pull_request and merge_group/u],
  ['a missing trigger', (t) => t.replace('  merge_group:\n    branches: [ci-gate-ruleset-only]\n', ''), /triggers must be exactly pull_request and merge_group/u],
  ['write permission', (t) => t.replace('  contents: read\n', '  contents: write\n'), /permissions must be exactly contents: read and actions: read/u],
  ['an extra permission', (t) => t.replace('  actions: read\n', '  actions: read\n  pull-requests: write\n'), /permissions must be exactly/u],
  ['read-all permissions', (t) => t.replace('permissions:\n  contents: read\n  actions: read\n', 'permissions: read-all\n'), /permissions must be exactly/u],
  ['job-level permissions', (t) => t.replace(JOB_HEADER, `${JOB_HEADER}    permissions:\n      contents: write\n`), /job-level permissions are not allowed/u],
  ['a top-level env', (t) => t.replace('jobs:\n', 'env:\n  NODE_OPTIONS: --require ./x.js\n\njobs:\n'), /top-level env is not allowed/u],
  ['an extra step env', (t) => t.replace(VERIFY_HEAD_REF, `          NODE_OPTIONS: --require ./x.js\n${VERIFY_HEAD_REF}`), /the verify step env must be exactly/u],
  ['verify on the wrong event', inStep(JUDGE, "if: github.event_name == 'merge_group'", "if: github.event_name == 'pull_request'"), /the verify step must have if: github\.event_name == 'merge_group'/u],
  ['a step shell', (t) => t.replace(VERIFY_STEP, `${VERIFY_STEP}        shell: bash\n`), /step key shell is not allowed/u],
  ['a container', (t) => t.replace(JOB_HEADER, `${JOB_HEADER}    container: node:22\n`), /container is not allowed/u],
  ['a self-hosted runner', (t) => t.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'), /runs-on must be ubuntu-latest/u],
  ['a different timeout', (t) => t.replace('timeout-minutes: 145', 'timeout-minutes: 360'), /timeout-minutes must be 145/u],
  ['a renamed job', (t) => t.replace('    name: CI Gate\n', '    name: Gate\n'), /the job name must be exactly CI Gate/u],
  ['uploading the whole checkout', (t) => t.replace('path: ci-gate-anchor.json', 'path: .'), /must set path: ci-gate-anchor\.json/u],
  ['a longer artifact retention', inStep(ANCHOR_UPLOAD, 'retention-days: 7', 'retention-days: 90'), /must set retention-days: 7/u],
  ['failing the PR when there is no anchor', inStep(ANCHOR_UPLOAD, 'if-no-files-found: ignore', 'if-no-files-found: error'), /must set if-no-files-found: ignore/u],
  ['an artifact name W05 would not find', (t) => t.replace('name: ci-gate-anchor-attempt-${{ github.run_attempt }}', 'name: anchor'), /must set name: ci-gate-anchor-attempt-/u],
  ['cone-mode sparse checkout', (t) => t.replace('sparse-checkout-cone-mode: false', 'sparse-checkout-cone-mode: true'), /must set sparse-checkout-cone-mode: false/u],
  ['a second job', (t) => `${t}\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`, /there must be exactly one job/u],
  ['no verify step', (t) => t.replace(VERIFY_STEP, '        run: node .github/scripts/ci-gate.mjs anchor\n'), /the gate must run node \.github\/scripts\/ci-gate\.mjs verify/u],
  ['select on the wrong event', inStep(SELECT, "if: github.event_name == 'merge_group'", "if: github.event_name == 'pull_request'"), /the select step must have if: github\.event_name == 'merge_group'/u],
  ['select without the kill switch', (t) => t.replace(THIN_QUEUE_LINE, ''), /the select step env must be exactly/u],
  ['the kill switch from another variable', (t) => t.replace('vars.CI_THIN_QUEUE', 'vars.OTHER'), /vars are allowed only as THIN_QUEUE: \$\{\{ vars\.CI_THIN_QUEUE \}\} in the select step/u],
  ['a variable in a step name', inStep('Setup Node.js', '- name: Setup Node.js', '- name: Setup Node.js ${{ vars.NODE }}'), /vars are allowed only as THIN_QUEUE/u],
  ['a variable in the verify env', (t) => t.replace(VERIFY_HEAD_REF, `          THIN_QUEUE: \${{ vars.CI_THIN_QUEUE }}\n${VERIFY_HEAD_REF}`), /vars are allowed only as THIN_QUEUE/u],
  ['every variable at once', (t) => t.replace('vars.CI_THIN_QUEUE', 'toJSON(vars)'), /vars are allowed only as THIN_QUEUE/u],
  ['no select step', (t) => t.replace(stepText(t, SELECT), ''), /the gate must run node \.github\/scripts\/ci-gate\.mjs select/u],
  ['a second select step', (t) => t.replace(stepText(t, SELECT), `${stepText(t, SELECT)}${stepText(t, SELECT)}`), /the select step must appear once/u],
  ['select after verify', moveAfter(SELECT, JUDGE), /the merge_group steps must run in order: select, upload-selection, verify/u],
  ['the selection upload after verify', moveAfter(SELECTION_UPLOAD, JUDGE), /must run in order: select, upload-selection, verify/u],
  ['no selection upload', (t) => t.replace(stepText(t, SELECTION_UPLOAD), ''), /must run in order: select, upload-selection, verify/u],
  ['a hard selection upload', inStep(SELECTION_UPLOAD, '        continue-on-error: true\n', ''), /actions\/upload-artifact must set continue-on-error: true/u],
  ['a selection upload that fails the gate', inStep(SELECTION_UPLOAD, 'continue-on-error: true', 'continue-on-error: false'), /must set continue-on-error: true/u],
  ['a longer selection upload timeout', inStep(SELECTION_UPLOAD, 'timeout-minutes: 2', 'timeout-minutes: 10'), /must set timeout-minutes: 2/u],
  ['no selection upload timeout', inStep(SELECTION_UPLOAD, '        timeout-minutes: 2\n', ''), /must set timeout-minutes: 2/u],
  ['continue-on-error on the anchor upload', inStep(ANCHOR_UPLOAD, "        if: github.event_name == 'pull_request'\n", "        if: github.event_name == 'pull_request'\n        continue-on-error: true\n"), /step key continue-on-error is not allowed/u],
  ['continue-on-error on the select step', (t) => t.replace(SELECT_STEP, `${SELECT_STEP}        continue-on-error: true\n`), /continue-on-error is not allowed/u],
  ['a timeout on the judge step', inStep(JUDGE, "        if: github.event_name == 'merge_group'\n", "        if: github.event_name == 'merge_group'\n        timeout-minutes: 30\n"), /step key timeout-minutes is not allowed/u],
  ['uploading the whole checkout as the selection', inStep(SELECTION_UPLOAD, 'path: ci-gate-selection.json', 'path: .'), /must set path: ci-gate-selection\.json/u],
  ['a selection artifact name CI would not find', inStep(SELECTION_UPLOAD, 'name: ci-gate-selection-attempt-${{ github.run_attempt }}', 'name: selection'), /must set name: ci-gate-selection-attempt-/u],
  ['a longer selection retention', inStep(SELECTION_UPLOAD, 'retention-days: 7', 'retention-days: 90'), /must set retention-days: 7/u],
  ['the selection upload on pull_request', inStep(SELECTION_UPLOAD, "if: github.event_name == 'merge_group'", "if: github.event_name == 'pull_request'"), /step key continue-on-error is not allowed/u],
  ['a second selection upload', (t) => t.replace(stepText(t, SELECTION_UPLOAD), `${stepText(t, SELECTION_UPLOAD)}${stepText(t, SELECTION_UPLOAD)}`), /the upload-selection step must appear once/u],
  ['an extra select env', inStep(SELECT, THIN_QUEUE_LINE, `${THIN_QUEUE_LINE}          NODE_OPTIONS: --require ./x.js\n`), /the select step env must be exactly/u],
  ['a variable in bracket form', inStep(JUDGE, "if: github.event_name == 'merge_group'", "if: github.event_name == 'merge_group' && vars['X'] == '1'"), /vars are allowed only as THIN_QUEUE/u],
  ['a variable in an if', inStep(ANCHOR_UPLOAD, "if: github.event_name == 'pull_request'", "if: github.event_name == 'pull_request' && vars.X"), /vars are allowed only as THIN_QUEUE/u],
  ['an upload with no if', inStep(SELECTION_UPLOAD, "        if: github.event_name == 'merge_group'\n", ''), /actions\/upload-artifact must have if: github\.event_name == 'pull_request' or if: github\.event_name == 'merge_group'/u],
];

test('the pinned CI Gate exists and satisfies every pinned-gate invariant', () => {
  assert.deepEqual(gateViolations(PINNED_GATE), []);
  assert.deepEqual(inspectWorkflowText('ci-gate.yml', PINNED_GATE), []);
});

for (const [name, mutate, message] of GATE_MUTATIONS) {
  test(`pinned CI Gate: ${name} is a violation`, () => {
    const mutated = mutate(PINNED_GATE);
    assert.notEqual(mutated, PINNED_GATE, 'the mutation must apply');
    const found = gateViolations(mutated);
    assert.ok(found.some((violation) => message.test(violation.message)),
      `expected ${message}, got:\n${found.map((violation) => violation.message).join('\n') || '(none)'}`);
  });
}

test('the pinned-gate rule is keyed on ci-gate.yml and leaves other workflows alone', () => {
  const mutated = GATE_MUTATIONS[0][1](PINNED_GATE);
  assert.ok(gateViolations(mutated).length > 0);
  assert.deepEqual(gateViolations(mutated, 'other.yml'), []);
});

test('every workflow in the repository satisfies the pinned-gate rule', () => {
  const directory = fileURLToPath(new URL('../workflows/', import.meta.url));
  assert.ok(readdirSync(directory).includes('ci-gate.yml'), 'ci-gate.yml must exist: the org ruleset requires it');
  assert.deepEqual(inspectWorkflowDirectory(directory).filter(({ rule }) => rule === PINNED_GATE_RULE), []);
});
