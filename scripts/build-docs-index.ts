import { promises as fs } from 'node:fs';
import path from 'node:path';

type DocsSection =
  | 'getting-started'
  | 'deploy'
  | 'agents'
  | 'security'
  | 'features'
  | 'backup'
  | 'monitoring'
  | 'reference';

interface DocsIndexSection {
  /** Raw `##`/`###` heading text; '' for the intro before the first heading. */
  heading: string;
  /** Rendered heading id (github-slugger, as Starlight emits it); '' for the intro. */
  anchor: string;
  /** Section body with MDX imports/components stripped; code fences kept verbatim. */
  text: string;
}

interface DocsIndexEntry {
  path: string;
  title: string;
  description: string;
  headings: string[];
  section: DocsSection;
  sections: DocsIndexSection[];
}

const docsRoot = path.resolve('apps/docs/src/content/docs');
const outputPath = path.resolve('apps/api/src/data/docsIndex.json');
const allowedSections = new Set<DocsSection>([
  'getting-started',
  'deploy',
  'agents',
  'security',
  'features',
  'backup',
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

const FENCE_RE = /^\s*(```|~~~)/;
const SECTION_HEADING_RE = /^###?\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

function cleanHeading(raw: string): string {
  return raw.replace(/\s+#+\s*$/, '').trim();
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

    const match = line.match(SECTION_HEADING_RE);
    if (!match) continue;

    const heading = cleanHeading(match[1] ?? '');
    if (heading) headings.push(heading);
  }

  return headings;
}

/** Heading markdown → the text Astro renders, which is what the slugger sees. */
function headingPlainText(heading: string): string {
  return heading
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '');
}

/** github-slugger (Astro's rehypeHeadingIds): lowercase, drop punctuation, spaces → '-', dedupe with -N. */
function createSlugger(): (heading: string) => string {
  const occurrences = new Map<string, number>();
  return (heading) => {
    const original = headingPlainText(heading)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    let slug = original;
    while (occurrences.has(slug)) {
      const next = (occurrences.get(original) ?? 0) + 1;
      occurrences.set(original, next);
      slug = `${original}-${next}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`));
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Strips MDX-only syntax from prose (never from code fences) so the model reads plain markdown. */
function cleanProse(prose: string): string {
  return prose
    .replace(/^import\s+(?:[^'"\n]+\s+from\s+)?['"][^'"\n]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?:const|let|var|function|default)\b.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<([A-Z][\w.]*)\b([^>]*?)\/>/g, (_m, _tag: string, attrs: string) => {
      const label = attrValue(attrs, 'title') ?? attrValue(attrs, 'label');
      return label ? `**${label}**` : '';
    })
    .replace(/<([A-Z][\w.]*)\b([^>]*)>/g, (_m, _tag: string, attrs: string) => {
      const label = attrValue(attrs, 'label') ?? attrValue(attrs, 'title');
      return label ? `**${label}:**` : '';
    })
    .replace(/<\/[A-Z][\w.]*\s*>/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

function cleanSectionText(lines: string[]): string {
  const parts: string[] = [];
  let prose: string[] = [];
  let fence: string[] | null = null;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (fence) {
        fence.push(line.trim());
        parts.push(fence.join('\n'));
        fence = null;
      } else {
        parts.push(cleanProse(prose.join('\n')));
        prose = [];
        fence = [line.trim()];
      }
      continue;
    }
    if (fence) fence.push(line);
    else prose.push(line);
  }
  if (fence) parts.push(fence.join('\n'));
  parts.push(cleanProse(prose.join('\n')));

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits the body at `##`/`###` headings (the same ones `headings` lists) into searchable sections. */
function extractSections(body: string): DocsIndexSection[] {
  const slug = createSlugger();
  const sections: DocsIndexSection[] = [];
  let current = { heading: '', anchor: '', lines: [] as string[] };
  let inCodeFence = false;

  const flush = () => {
    const text = cleanSectionText(current.lines);
    if (current.heading || text) {
      sections.push({ heading: current.heading, anchor: current.anchor, text });
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inCodeFence = !inCodeFence;
      current.lines.push(line);
      continue;
    }

    const anyHeading = inCodeFence ? null : line.match(ANY_HEADING_RE);
    if (anyHeading) {
      const heading = cleanHeading(anyHeading[1] ?? '');
      const anchor = heading ? slug(heading) : '';
      if (heading && SECTION_HEADING_RE.test(line)) {
        flush();
        current = { heading, anchor, lines: [] };
        continue;
      }
    }

    current.lines.push(line);
  }
  flush();

  return sections;
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
      section,
      sections: extractSections(body)
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
