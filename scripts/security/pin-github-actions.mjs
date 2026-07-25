#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const USES_LINE_PATTERN =
  /^(\s*(?:-\s*)?uses:\s*)(["']?)([^"'#\s]+)\2(\s*(?:#.*)?)$/;

function parseActionReference(target, line) {
  if (target.startsWith("./")) {
    return null;
  }
  if (target.startsWith("docker://")) {
    throw new Error(
      `Line ${line}: docker:// action references are unsupported by repository policy`,
    );
  }

  const atIndex = target.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === target.length - 1) {
    throw new Error(`Line ${line}: unsupported action reference "${target}"`);
  }

  const actionName = target.slice(0, atIndex);
  const ref = target.slice(atIndex + 1);
  const [owner, repository, ...pathParts] = actionName.split("/");
  if (!owner || !repository) {
    throw new Error(`Line ${line}: unsupported action reference "${target}"`);
  }

  return {
    owner,
    repository,
    path: pathParts.join("/"),
    ref,
    line,
  };
}

function parseUsesLine(rawLine, line) {
  const hasCarriageReturn = rawLine.endsWith("\r");
  const lineText = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
  const match = USES_LINE_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }

  const [, prefix, quote, target, suffix] = match;
  return {
    prefix,
    quote,
    target,
    suffix,
    lineEnding: hasCarriageReturn ? "\r" : "",
    reference: parseActionReference(target, line),
  };
}

export function findMutableActionReferences(text) {
  const references = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseUsesLine(lines[index], index + 1);
    if (
      parsed?.reference &&
      !COMMIT_SHA_PATTERN.test(parsed.reference.ref)
    ) {
      references.push(parsed.reference);
    }
  }

  return references;
}

export async function pinWorkflowText(text, resolveCommit) {
  const mutableReferences = findMutableActionReferences(text);
  const resolvedCommits = new Map();

  for (const reference of mutableReferences) {
    const key = `${reference.owner}/${reference.repository}@${reference.ref}`;
    if (!resolvedCommits.has(key)) {
      resolvedCommits.set(
        key,
        await resolveCommit(
          reference.owner,
          reference.repository,
          reference.ref,
        ),
      );
    }
  }

  for (const [key, commit] of resolvedCommits) {
    if (!COMMIT_SHA_PATTERN.test(commit)) {
      throw new Error(
        `Resolver returned invalid commit for ${key}; expected a 40-character lowercase hexadecimal commit SHA`,
      );
    }
  }

  const referencesByLine = new Map(
    mutableReferences.map((reference) => [reference.line, reference]),
  );
  const changedReferences = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const reference = referencesByLine.get(line);
    if (!reference) {
      continue;
    }

    const parsed = parseUsesLine(lines[index], line);
    const key = `${reference.owner}/${reference.repository}@${reference.ref}`;
    const commit = resolvedCommits.get(key);
    const actionPath = reference.path ? `/${reference.path}` : "";
    const comment = versionedComment(parsed.suffix, reference.ref);

    lines[index] =
      `${parsed.prefix}${parsed.quote}` +
      `${reference.owner}/${reference.repository}${actionPath}@${commit}` +
      `${parsed.quote}${comment}${parsed.lineEnding}`;
    changedReferences.push({ ...reference, commit });
  }

  return {
    text: lines.join("\n"),
    changedReferences,
  };
}

export async function resolveActionCommit(owner, repository, ref) {
  const endpoint =
    `repos/${owner}/${repository}/commits/` + encodeURIComponent(ref);
  const { stdout } = await execFileAsync(
    "gh",
    ["api", endpoint, "--jq", ".sha"],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  const commit = stdout.trim();

  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new Error(
      `GitHub returned an invalid commit for ${owner}/${repository}@${ref}; expected a 40-character lowercase hexadecimal commit SHA`,
    );
  }

  return commit;
}

async function listWorkflowFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWorkflowFiles(entryPath)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

function displayPath(filePath, rootDirectory) {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/");
}

function createCachingResolver(resolveCommit) {
  const resolutions = new Map();

  return async (owner, repository, ref) => {
    const key = `${owner}/${repository}@${ref}`;
    if (!resolutions.has(key)) {
      resolutions.set(key, resolveCommit(owner, repository, ref));
    }
    return resolutions.get(key);
  };
}

function versionedComment(suffix, ref) {
  if (!suffix.includes("#")) {
    return ` # ${ref}`;
  }

  const existingComment = suffix.slice(suffix.indexOf("#") + 1).trim();
  if (
    existingComment === ref ||
    existingComment.startsWith(`${ref} `) ||
    existingComment.startsWith(`${ref};`)
  ) {
    return suffix;
  }

  return ` # ${ref}; ${existingComment}`;
}

async function checkWorkflows(rootDirectory, workflowFiles) {
  let mutableCount = 0;

  for (const filePath of workflowFiles) {
    const text = await readFile(filePath, "utf8");
    for (const reference of findMutableActionReferences(text)) {
      const actionPath = reference.path ? `/${reference.path}` : "";
      console.log(
        `${displayPath(filePath, rootDirectory)}:${reference.line}: ` +
          `${reference.owner}/${reference.repository}${actionPath}@${reference.ref}`,
      );
      mutableCount += 1;
    }
  }

  if (mutableCount > 0) {
    console.log(
      `Found ${mutableCount} mutable external action reference(s); no files were changed.`,
    );
    process.exitCode = 1;
  } else {
    console.log("All external GitHub Action references are pinned to commit SHAs.");
  }
}

async function writePinnedWorkflows(rootDirectory, workflowFiles) {
  const resolveCommit = createCachingResolver(resolveActionCommit);
  const pendingWrites = [];
  let changedCount = 0;

  for (const filePath of workflowFiles) {
    const originalText = await readFile(filePath, "utf8");
    const result = await pinWorkflowText(originalText, resolveCommit);
    if (result.changedReferences.length > 0) {
      pendingWrites.push({ filePath, ...result });
    }
  }

  for (const pendingWrite of pendingWrites) {
    await writeFile(pendingWrite.filePath, pendingWrite.text);
    for (const reference of pendingWrite.changedReferences) {
      const actionPath = reference.path ? `/${reference.path}` : "";
      console.log(
        `${displayPath(pendingWrite.filePath, rootDirectory)}:${reference.line}: ` +
          `${reference.owner}/${reference.repository}${actionPath}@${reference.ref} ` +
          `-> ${reference.commit}`,
      );
      changedCount += 1;
    }
  }

  console.log(
    changedCount > 0
      ? `Pinned ${changedCount} external action reference(s) in ${pendingWrites.length} workflow file(s).`
      : "No mutable external GitHub Action references were found.",
  );
}

function redactKnownTokens(message) {
  let redacted = message;
  for (const variableName of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = process.env[variableName];
    if (token) {
      redacted = redacted.split(token).join("[REDACTED]");
    }
  }
  return redacted;
}

async function main() {
  const [mode, ...extraArguments] = process.argv.slice(2);
  if (
    extraArguments.length > 0 ||
    (mode !== "--check" && mode !== "--write")
  ) {
    throw new Error(
      "Usage: node scripts/security/pin-github-actions.mjs --check|--write",
    );
  }

  const rootDirectory = process.cwd();
  const workflowFiles = await listWorkflowFiles(
    path.join(rootDirectory, ".github", "workflows"),
  );

  if (mode === "--check") {
    await checkWorkflows(rootDirectory, workflowFiles);
  } else {
    await writePinnedWorkflows(rootDirectory, workflowFiles);
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactKnownTokens(message));
    process.exitCode = 2;
  }
}
