#!/usr/bin/env node

/**
 * AI-powered documentation review script.
 * Reads a PR diff, maps changed files to affected docs via mapping.json,
 * and calls the Claude API to check if docs need updating.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const DOCS_ROOT = resolve(REPO_ROOT, "apps/docs/src/content/docs");
const MAX_DIFF_CHARS = 32_000; // ~8K tokens

function loadMapping() {
  const raw = readFileSync(resolve(__dirname, "mapping.json"), "utf-8");
  return JSON.parse(raw).mappings;
}

function extractChangedFiles(diff) {
  const files = new Set();
  for (const line of diff.split("\n")) {
    // Match unified diff headers: diff --git a/path b/path
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) files.add(match[2]);
  }
  return [...files];
}

function globToRegex(pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (except * and ?)
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${re}$`);
}

function matchFiles(changedFiles, mappings) {
  const docSet = new Map(); // docPath -> Set<changedFile>

  for (const mapping of mappings) {
    const re = globToRegex(mapping.pattern);
    const matched = changedFiles.filter((f) => re.test(f));
    if (matched.length === 0) continue;

    for (const doc of mapping.docs) {
      if (!docSet.has(doc)) docSet.set(doc, new Set());
      for (const f of matched) docSet.get(doc).add(f);
    }
  }

  return docSet;
}

function extractRelevantDiff(fullDiff, relevantFiles) {
  const chunks = fullDiff.split(/^(?=diff --git )/m);
  const relevant = chunks.filter((chunk) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    return match && relevantFiles.has(match[2]);
  });

  let combined = relevant.join("\n");
  if (combined.length > MAX_DIFF_CHARS) {
    combined = combined.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]";
  }
  return combined;
}

async function callClaude(apiKey, diff, docPath, docContent, prTitle) {
  const prompt = `You are a technical documentation reviewer for Breeze RMM.

## Code Changes (from PR: "${prTitle}")
\`\`\`diff
${diff}
\`\`\`

## Current Documentation
File: ${docPath}
${docContent}

## Instructions
Compare the code changes against the documentation. If the documentation
is now inaccurate, outdated, or missing information based on these code
changes, provide the complete updated documentation file.

If no changes are needed, respond with exactly: NO_CHANGES_NEEDED

Rules:
- Only update content that is affected by the code changes
- Preserve the existing writing style and Starlight component usage
- Do not add unnecessary content or restructure sections that aren't affected
- Keep frontmatter intact
- Use the same Astro component imports pattern`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const diffFile = process.env.DIFF_FILE;
  if (!diffFile) {
    console.error("DIFF_FILE is required");
    process.exit(1);
  }

  const prNumber = process.env.PR_NUMBER || "unknown";
  const prTitle = process.env.PR_TITLE || "";

  const diff = readFileSync(diffFile, "utf-8");
  const changedFiles = extractChangedFiles(diff);

  console.log(`PR #${prNumber}: ${changedFiles.length} files changed`);

  // Skip if PR only touches docs (avoid infinite loop)
  const nonDocFiles = changedFiles.filter(
    (f) => !f.startsWith("apps/docs/")
  );
  if (nonDocFiles.length === 0) {
    console.log("Docs-only PR, skipping review");
    return;
  }

  const mappings = loadMapping();
  const affectedDocs = matchFiles(changedFiles, mappings);

  if (affectedDocs.size === 0) {
    console.log("No docs affected by these changes");
    return;
  }

  console.log(`${affectedDocs.size} doc(s) to review`);
  let updatedCount = 0;

  for (const [docRelPath, triggerFiles] of affectedDocs) {
    const docFullPath = resolve(DOCS_ROOT, docRelPath);
    if (!existsSync(docFullPath)) {
      console.warn(`  SKIP: ${docRelPath} does not exist`);
      continue;
    }

    const docContent = readFileSync(docFullPath, "utf-8");
    const relevantDiff = extractRelevantDiff(diff, triggerFiles);

    if (!relevantDiff.trim()) {
      console.log(`  SKIP: ${docRelPath} — no relevant diff content`);
      continue;
    }

    console.log(`  Reviewing: ${docRelPath} (triggered by ${triggerFiles.size} file(s))`);

    try {
      const result = await callClaude(
        apiKey,
        relevantDiff,
        docRelPath,
        docContent,
        prTitle
      );

      if (result.trim() === "NO_CHANGES_NEEDED") {
        console.log(`    -> No changes needed`);
      } else {
        writeFileSync(docFullPath, result);
        console.log(`    -> Updated`);
        updatedCount++;
      }
    } catch (err) {
      console.error(`    -> Error: ${err.message}`);
      // Continue with remaining docs
    }
  }

  console.log(
    `\nDone: ${updatedCount} doc(s) updated out of ${affectedDocs.size} reviewed`
  );
}

main();
