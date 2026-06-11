export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

export interface OsvResult {
  cveIds: string[];
  maxSeverity: 'critical' | 'important' | 'moderate' | 'low' | null;
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const OSV_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export class OsvRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsvRateLimitError';
  }
}

export class OsvServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsvServerError';
  }
}

function mapSeverity(s: string | undefined): OsvResult['maxSeverity'] {
  if (!s) return null;
  switch (s.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'important';
    case 'MEDIUM':
      return 'moderate';
    case 'LOW':
      return 'low';
    default:
      return null;
  }
}

export async function queryOsvForPackage(q: OsvQuery): Promise<OsvResult> {
  const res = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      package: { ecosystem: q.ecosystem, name: q.name },
      version: q.version,
    }),
    signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const bodySnippet = bodyText.slice(0, 500);
    const ctx = `package=${q.ecosystem}:${q.name}@${q.version}`;
    if (res.status === 429) {
      throw new OsvRateLimitError(
        `OSV rate limited (429) for ${ctx}: ${bodySnippet}`
      );
    }
    if (res.status >= 500) {
      throw new OsvServerError(
        `OSV server error (${res.status}) for ${ctx}: ${bodySnippet}`
      );
    }
    throw new Error(`OSV query failed (${res.status}) for ${ctx}: ${bodySnippet}`);
  }

  const text = await res.text();
  if (text.length >= MAX_RESPONSE_BYTES) {
    throw new OsvServerError(
      `OSV response too large (${text.length} bytes) for package=${q.ecosystem}:${q.name}@${q.version}`
    );
  }

  let json: {
    vulns?: Array<{
      id?: string;
      aliases?: string[];
      database_specific?: { severity?: string };
    }>;
  };
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new OsvServerError(
      `OSV returned invalid JSON for package=${q.ecosystem}:${q.name}@${q.version}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const vulns = json.vulns ?? [];

  const cveIds = Array.from(
    new Set(
      vulns.flatMap((v) =>
        [v.id, ...(v.aliases ?? [])].filter(
          (x): x is string => !!x && x.startsWith('CVE-')
        )
      )
    )
  );

  let maxRank = 0;
  let maxSev: OsvResult['maxSeverity'] = null;
  for (const v of vulns) {
    const sev = v.database_specific?.severity;
    if (!sev) continue;
    const rank = SEVERITY_RANK[sev.toUpperCase()] ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
      maxSev = mapSeverity(sev);
    }
  }
  return { cveIds, maxSeverity: maxSev };
}
