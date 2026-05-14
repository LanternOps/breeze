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
  });
  if (!res.ok) throw new Error(`OSV query failed (${res.status})`);
  const json = (await res.json()) as {
    vulns?: Array<{
      id?: string;
      aliases?: string[];
      database_specific?: { severity?: string };
    }>;
  };
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
