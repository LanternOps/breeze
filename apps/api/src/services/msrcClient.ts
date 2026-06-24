const BASE_URL = 'https://api.msrc.microsoft.com/cvrf/v3.0';

export interface MsrcRecord {
  cveId: string;
  productName: string;
  cpe: string | null;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: string | null;
  fixedBuild: string | null;
  kbArticle: string | null;
}

type CvrfProduct = {
  ProductID?: unknown;
  CPE?: unknown;
  Value?: unknown;
};

type CvrfScoreSet = {
  BaseScore?: unknown;
  Vector?: unknown;
};

type CvrfDescription = {
  Value?: unknown;
};

type CvrfRemediation = {
  Type?: unknown;
  FixedBuild?: unknown;
  ProductID?: unknown;
  Description?: unknown;
};

type CvrfVulnerability = {
  CVE?: unknown;
  CVSSScoreSets?: unknown;
  Remediations?: unknown;
};

type CvrfDocument = {
  ProductTree?: {
    FullProductName?: unknown;
  };
  Vulnerability?: unknown;
};

export function severityFromCvss(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 9) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 4) return 'Medium';
  if (score > 0) return 'Low';
  return null;
}

export async function listUpdateMonths(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/updates`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`MSRC updates list failed: ${res.status}`);
  }

  const body = (await res.json()) as { value?: Array<{ ID?: unknown }> };
  return (body.value ?? [])
    .map((update) => update.ID)
    .filter((id): id is string => typeof id === 'string');
}

export async function fetchCvrf(month: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/cvrf/${encodeURIComponent(month)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`MSRC CVRF fetch failed for ${month}: ${res.status}`);
  }

  return res.json();
}

export function parseCvrf(doc: unknown): MsrcRecord[] {
  const cvrf = doc as CvrfDocument;
  const productNames = new Map<string, string>();
  const productCpes = new Map<string, string>();

  for (const product of asArray<CvrfProduct>(cvrf.ProductTree?.FullProductName)) {
    const productId = stringValue(product.ProductID);
    if (!productId) continue;

    const productName = stringValue(product.Value);
    if (productName) {
      productNames.set(productId, productName);
    }

    const cpe = stringValue(product.CPE);
    if (cpe) {
      productCpes.set(productId, cpe);
    }
  }

  const records: MsrcRecord[] = [];
  for (const vulnerability of asArray<CvrfVulnerability>(cvrf.Vulnerability)) {
    const cveId = stringValue(vulnerability.CVE);
    if (!cveId) continue;

    const scoreSet = asArray<CvrfScoreSet>(vulnerability.CVSSScoreSets)[0];
    const cvssScore = numericValue(scoreSet?.BaseScore);
    const cvssVector = stringValue(scoreSet?.Vector);
    const severity = severityFromCvss(cvssScore);

    for (const remediation of asArray<CvrfRemediation>(vulnerability.Remediations)) {
      if (remediation.Type !== 2) continue;

      const fixedBuild = stringValue(remediation.FixedBuild);
      if (!fixedBuild) continue;

      const kbArticle = descriptionValue(remediation.Description);
      for (const rawProductId of asArray<unknown>(remediation.ProductID)) {
        const productId = stringValue(rawProductId);
        if (!productId) continue;

        records.push({
          cveId,
          productName: productNames.get(productId) ?? `ProductID ${productId}`,
          cpe: productCpes.get(productId) ?? null,
          cvssScore,
          cvssVector,
          severity,
          fixedBuild,
          kbArticle,
        });
      }
    }
  }

  return records;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function descriptionValue(value: unknown): string | null {
  const direct = stringValue(value);
  if (direct) return direct;

  const description = value as CvrfDescription | null | undefined;
  return stringValue(description?.Value);
}
