// e2e-tests/doc-verify/extractor.ts
import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AssertionManifest, PageAssertions, Assertion } from './types';

const DOCS_DIR = resolve(import.meta.dirname, '../../apps/docs/src/content/docs');

export function computeContentHash(content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

const EXTRACTION_PROMPT = `You are a test assertion extractor. Given documentation for an RMM (Remote Monitoring and Management) platform, extract testable assertions.

For each claim the documentation makes, create a structured assertion. Categorize each as:
- "api": Claims about HTTP endpoints (status codes, response shapes, headers). These will be tested with direct HTTP requests.
- "sql": Claims about data storage (what gets stored, how it's hashed, permissions). These will be tested with DB queries.
- "ui": Claims about what users see in the dashboard (pages, elements, behavior). These will be tested by an AI navigating the browser.

Rules:
- Only extract claims that are concretely testable against a running instance
- Skip claims about external systems (Let's Encrypt, Cloudflare, etc.)
- Skip platform-specific claims that require a specific OS (Windows registry, systemd, etc.)
- For API assertions, include the exact method, path, expected status, and key response fields
- For UI assertions, include the page to navigate to and what to verify in natural language
- Give each assertion a unique ID like "pagename-NNN"
- Set severity: "critical" for auth/security/enrollment, "warning" for core features, "info" for nice-to-haves

Respond with a JSON array of assertions. Each assertion must match one of these shapes:

API assertion:
{
  "id": "string",
  "type": "api",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "method": "GET|POST|PUT|DELETE",
    "path": "/api/v1/...",
    "body": {},
    "headers": {},
    "expect": {
      "status": 200,
      "bodyContains": ["field1", "field2"],
      "contentType": "application/json"
    }
  }
}

SQL assertion:
{
  "id": "string",
  "type": "sql",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "query": "description of what to check",
    "expect": { "description": "expected result" }
  }
}

UI assertion:
{
  "id": "string",
  "type": "ui",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "navigate": "/page-path",
    "verify": "natural language description of what to verify on the page"
  }
}

Return ONLY the JSON array, no markdown fencing.`;

export async function extractAssertions(
  docPaths: string[],
  existingManifest?: AssertionManifest,
  incremental = false,
): Promise<AssertionManifest> {
  const client = new Anthropic();
  const pages: PageAssertions[] = [];

  for (const docPath of docPaths) {
    const fullPath = resolve(DOCS_DIR, docPath);
    const content = await readFile(fullPath, 'utf-8');
    const contentHash = computeContentHash(content);

    // Skip if content hasn't changed (incremental mode)
    if (incremental && existingManifest) {
      const existingPage = existingManifest.pages.find((p) => p.source === docPath);
      if (existingPage && existingPage.contentHash === contentHash) {
        pages.push(existingPage);
        console.log(`  [skip] ${docPath} (unchanged)`);
        continue;
      }
    }

    console.log(`  [extract] ${docPath}...`);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Extract testable assertions from this documentation page (source: ${docPath}):\n\n${content}`,
        },
      ],
      system: EXTRACTION_PROMPT,
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    let assertions: Assertion[];
    try {
      assertions = JSON.parse(text);
    } catch {
      console.error(`  [error] Failed to parse assertions for ${docPath}`);
      console.error(`  Response: ${text.slice(0, 200)}`);
      assertions = [];
    }

    pages.push({ source: docPath, contentHash, assertions });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    pages,
  };
}

export async function listDocPages(scope: string[]): Promise<string[]> {
  const paths: string[] = [];

  for (const dir of scope) {
    const fullDir = resolve(DOCS_DIR, dir);
    try {
      const files = await readdir(fullDir);
      for (const file of files) {
        if (file.endsWith('.mdx')) {
          paths.push(`${dir}/${file}`);
        }
      }
    } catch {
      console.error(`  [warn] Directory not found: ${dir}`);
    }
  }

  return paths;
}

export async function loadManifest(path: string): Promise<AssertionManifest | undefined> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export async function saveManifest(manifest: AssertionManifest, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2));
}
