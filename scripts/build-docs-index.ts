import { promises as fs } from 'node:fs';
import path from 'node:path';

type DocsSection =
  | 'getting-started'
  | 'deploy'
  | 'agents'
  | 'security'
  | 'features'
  | 'monitoring'
  | 'reference';

interface DocsIndexEntry {
  path: string;
  title: string;
  description: string;
  headings: string[];
  section: DocsSection;
}

const docsRoot = path.resolve('apps/docs/src/content/docs');
const outputPath = path.resolve('apps/api/src/data/docsIndex.json');
const allowedSections = new Set<DocsSection>([
  'getting-started',
  'deploy',
  'agents',
  'security',
  'features',
  'monitoring',
  'reference'
]);

async function collectMdxFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      return collectMdxFiles(entryPath);
    }

    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      return [entryPath];
    }

    return [];
  }));

  return files.flat();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseFrontmatter(source: string): { metadata: Record<string, string>; body: string } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, body: source };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { metadata: {}, body: source };
  }

  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    if (!line || /^\s/.test(line)) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (!key) continue;
    metadata[key] = stripQuotes(value);
  }

  return {
    metadata,
    body: lines.slice(closingIndex + 1).join('\n')
  };
}

function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  let inCodeFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) continue;

    const match = line.match(/^###?\s+(.+?)\s*$/);
    if (!match) continue;

    const heading = match[1].replace(/\s+#+\s*$/, '').trim();
    if (heading) headings.push(heading);
  }

  return headings;
}

function buildDocPath(filePath: string): { routePath: string; section: DocsSection | null } {
  const relativePath = path.relative(docsRoot, filePath);
  const normalized = relativePath.split(path.sep).join('/');
  const withoutExtension = normalized.replace(/\.mdx$/, '');
  const segments = withoutExtension.split('/');
  const firstSegment = segments[0];

  if (!firstSegment || !allowedSections.has(firstSegment as DocsSection)) {
    return { routePath: `/${withoutExtension}/`, section: null };
  }

  return {
    routePath: `/${withoutExtension}/`,
    section: firstSegment as DocsSection
  };
}

async function main(): Promise<void> {
  const mdxFiles = await collectMdxFiles(docsRoot);
  const docsEntries: DocsIndexEntry[] = [];

  for (const filePath of mdxFiles) {
    const basename = path.basename(filePath);
    if (basename === 'index.mdx' || basename === '404.mdx') {
      continue;
    }

    const raw = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(raw);
    const { routePath, section } = buildDocPath(filePath);

    if (!section) {
      console.warn(`[build-docs-index] Skipping ${filePath}: section not in allowedSections`);
      continue;
    }

    if (!metadata.title) {
      console.warn(`[build-docs-index] Warning: ${filePath} has no title in frontmatter`);
    }

    docsEntries.push({
      path: routePath,
      title: metadata.title ?? '',
      description: metadata.description ?? '',
      headings: extractHeadings(body),
      section
    });
  }

  docsEntries.sort((left, right) => left.path.localeCompare(right.path));

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(docsEntries, null, 2)}\n`, 'utf8');

  const totalMdx = mdxFiles.filter((f) => !['index.mdx', '404.mdx'].includes(path.basename(f))).length;
  console.log(`Indexed ${docsEntries.length} of ${totalMdx} docs into ${outputPath}`);
  if (docsEntries.length === 0) {
    console.error('[build-docs-index] WARNING: Zero docs indexed — search_documentation will not return results');
  }
}

main().catch((error) => {
  console.error('Failed to build docs index:', error);
  process.exitCode = 1;
});
