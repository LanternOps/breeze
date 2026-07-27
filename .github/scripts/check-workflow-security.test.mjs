import assert from 'node:assert/strict';
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

test('community README push uses an ephemeral credential helper', () => {
  const workflowText = readFileSync(
    new URL('../workflows/update-community-readme.yml', import.meta.url),
    'utf8',
  );

  assert.match(
    workflowText,
    /git -c credential\.helper= -c 'credential\.helper=!f\(\).*push origin HEAD:main/su,
  );
  assert.doesNotMatch(workflowText, /persist-credentials:\s*true/u);
});
