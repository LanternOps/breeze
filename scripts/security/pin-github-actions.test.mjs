import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findMutableActionReferences,
  pinWorkflowText,
  resolveActionCommit,
} from "./pin-github-actions.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(
  new URL("./pin-github-actions.mjs", import.meta.url),
);
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

test("findMutableActionReferences returns parsed mutable references with one-based lines", () => {
  const references = findMutableActionReferences(
    "steps:\n  - uses: actions/checkout@v7\n",
  );

  assert.deepEqual(references, [
    {
      owner: "actions",
      repository: "checkout",
      path: "",
      ref: "v7",
      line: 2,
    },
  ]);
});

test("pinWorkflowText pins an action and appends its readable version", async () => {
  const result = await pinWorkflowText(
    "      - uses: actions/checkout@v7\n",
    async () => SHA_A,
  );

  assert.equal(
    result.text,
    `      - uses: actions/checkout@${SHA_A} # v7\n`,
  );
  assert.equal(result.changedReferences.length, 1);
});

test("pinWorkflowText retains a GitHub action subpath", async () => {
  const result = await pinWorkflowText(
    "        uses: github/codeql-action/upload-sarif@v4\n",
    async () => SHA_B,
  );

  assert.equal(
    result.text,
    `        uses: github/codeql-action/upload-sarif@${SHA_B} # v4\n`,
  );
});

test("pinWorkflowText preserves a pre-existing version comment", async () => {
  const result = await pinWorkflowText(
    "        uses: actions/setup-node@v7 # v7\n",
    async () => SHA_A,
  );

  assert.equal(
    result.text,
    `        uses: actions/setup-node@${SHA_A} # v7\n`,
  );
});

test("pinWorkflowText adds the version while preserving a non-version comment", async () => {
  const result = await pinWorkflowText(
    "        uses: actions/setup-node@v7 # retained rationale\n",
    async () => SHA_A,
  );

  assert.equal(
    result.text,
    `        uses: actions/setup-node@${SHA_A} # v7; retained rationale\n`,
  );
});

test("pinWorkflowText leaves a 40-character SHA unchanged", async () => {
  let resolverCalls = 0;
  const input = `        uses: actions/checkout@${SHA_A} # v7\n`;

  const result = await pinWorkflowText(input, async () => {
    resolverCalls += 1;
    return SHA_B;
  });

  assert.equal(result.text, input);
  assert.deepEqual(result.changedReferences, []);
  assert.equal(resolverCalls, 0);
});

test("pinWorkflowText leaves local actions unchanged", async () => {
  let resolverCalls = 0;
  const input = "        uses: ./local-action\n";

  const result = await pinWorkflowText(input, async () => {
    resolverCalls += 1;
    return SHA_A;
  });

  assert.equal(result.text, input);
  assert.equal(resolverCalls, 0);
});

test("pinWorkflowText rejects docker action references", async () => {
  await assert.rejects(
    pinWorkflowText("        uses: docker://alpine:3.22\n", async () => SHA_A),
    /docker:\/\/ action references are unsupported by repository policy/,
  );
});

test("pinWorkflowText deduplicates resolver calls by owner, repository, and ref", async () => {
  const calls = [];
  const input = [
    "      - uses: github/codeql-action/init@v4",
    "      - uses: github/codeql-action/analyze@v4",
    "      - uses: actions/checkout@v7",
    "",
  ].join("\n");

  const result = await pinWorkflowText(input, async (...args) => {
    calls.push(args);
    return args[0] === "github" ? SHA_A : SHA_B;
  });

  assert.deepEqual(calls, [
    ["github", "codeql-action", "v4"],
    ["actions", "checkout", "v7"],
  ]);
  assert.match(result.text, new RegExp(`codeql-action/init@${SHA_A} # v4`));
  assert.match(
    result.text,
    new RegExp(`codeql-action/analyze@${SHA_A} # v4`),
  );
});

test("pinWorkflowText rejects non-lowercase or malformed resolver results", async () => {
  await assert.rejects(
    pinWorkflowText(
      "        uses: actions/checkout@v7\n",
      async () => "ABCDEF",
    ),
    /40-character lowercase hexadecimal commit SHA/,
  );
});

test("resolveActionCommit calls gh api with a URL-encoded ref and no shell", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pin-actions-gh-"));
  const fakeGhPath = path.join(directory, "gh");
  const argumentsPath = path.join(directory, "arguments.txt");
  const priorPath = process.env.PATH;
  const priorArgumentsPath = process.env.GH_ARGS_FILE;

  await writeFile(
    fakeGhPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$GH_ARGS_FILE"\nprintf '%s\\n' '${SHA_A}'\n`,
  );
  await chmod(fakeGhPath, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${priorPath}`;
  process.env.GH_ARGS_FILE = argumentsPath;

  try {
    const result = await resolveActionCommit(
      "actions",
      "checkout",
      "release/v7 candidate",
    );
    assert.equal(result, SHA_A);
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "api",
      "repos/actions/checkout/commits/release%2Fv7%20candidate",
      "--jq",
      ".sha",
    ]);
  } finally {
    process.env.PATH = priorPath;
    if (priorArgumentsPath === undefined) {
      delete process.env.GH_ARGS_FILE;
    } else {
      process.env.GH_ARGS_FILE = priorArgumentsPath;
    }
  }
});

test("--check scans nested yml and yaml files, exits non-zero, and never writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pin-actions-check-"));
  const workflowsDirectory = path.join(directory, ".github", "workflows");
  const nestedDirectory = path.join(workflowsDirectory, "nested");
  const firstPath = path.join(workflowsDirectory, "first.yml");
  const secondPath = path.join(nestedDirectory, "second.yaml");
  const firstText = "steps:\n  - uses: actions/checkout@v7\n";
  const secondText = "steps:\n  - uses: actions/setup-node@v7\n";

  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(firstPath, firstText);
  await writeFile(secondPath, secondText);

  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT_PATH, "--check"], {
      cwd: directory,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /first\.yml:2/);
      assert.match(error.stdout, /nested\/second\.yaml:2/);
      return true;
    },
  );
  assert.equal(await readFile(firstPath, "utf8"), firstText);
  assert.equal(await readFile(secondPath, "utf8"), secondText);
});

test("--write redacts GitHub tokens if the resolver command fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pin-actions-redact-"));
  const workflowsDirectory = path.join(directory, ".github", "workflows");
  const workflowPath = path.join(workflowsDirectory, "workflow.yml");
  const fakeGhPath = path.join(directory, "gh");
  const secretToken = "github_pat_never-print-this-value";
  const workflowText = "steps:\n  - uses: actions/checkout@v7\n";

  await mkdir(workflowsDirectory, { recursive: true });
  await writeFile(workflowPath, workflowText);
  await writeFile(
    fakeGhPath,
    "#!/bin/sh\nprintf '%s\\n' \"$GH_TOKEN\" >&2\nexit 1\n",
  );
  await chmod(fakeGhPath, 0o755);

  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT_PATH, "--write"], {
      cwd: directory,
      env: {
        ...process.env,
        GH_TOKEN: secretToken,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      },
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.doesNotMatch(error.stderr, new RegExp(secretToken));
      assert.match(error.stderr, /\[REDACTED\]/);
      return true;
    },
  );
  assert.equal(await readFile(workflowPath, "utf8"), workflowText);
});
