import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { abuseScriptHosts } from '../../db/schema';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

// ---------------------------------------------------------------------------
// Script-content detector: rmm.remote_access_installer / rmm.shared_installer_host
//
// Contract (same as heuristics.ts): loadScriptFindings() does bounded SQL and
// host persistence; computeScriptSignals() is pure and unit-tested. Signals
// here are NEVER age-decayed — a malicious installer is malicious regardless
// of account age — so the pure scorer deliberately never sees
// partnerCreatedAt / youngWeight().
//
// Cross-tenant corpus rule: hosts are extracted and persisted for ALL
// partners regardless of status (the shared-host correlation needs suspended
// partners in the corpus), but findings — and therefore signals — are only
// attributed to active, non-deleted partners.
// ---------------------------------------------------------------------------

interface RaProduct {
  name: string;
  pattern: RegExp;
  /** Lowercase tokens used for filename/vendor-host relatedness checks. */
  tokens: string[];
}

// Stage-1 gate, part A: the script must mention a remote-access product...
const RA_PRODUCTS: ReadonlyArray<RaProduct> = [
  { name: 'ScreenConnect', pattern: /screen ?connect/i, tokens: ['screenconnect', 'connectwise', 'control'] },
  { name: 'ConnectWise Control', pattern: /connectwise ?control/i, tokens: ['connectwise', 'screenconnect', 'control'] },
  { name: 'AnyDesk', pattern: /anydesk/i, tokens: ['anydesk'] },
  { name: 'TeamViewer', pattern: /teamviewer/i, tokens: ['teamviewer'] },
  { name: 'Splashtop', pattern: /splashtop/i, tokens: ['splashtop'] },
  { name: 'RustDesk', pattern: /rustdesk/i, tokens: ['rustdesk'] },
  { name: 'Supremo', pattern: /\bsupremo\b/i, tokens: ['supremo'] },
  { name: 'UltraViewer', pattern: /ultraviewer/i, tokens: ['ultraviewer'] },
  { name: 'LogMeIn', pattern: /logmein/i, tokens: ['logmein'] },
  { name: 'GoToAssist', pattern: /goto ?assist/i, tokens: ['gotoassist', 'goto'] },
  { name: 'Zoho Assist', pattern: /zoho ?assist/i, tokens: ['zoho', 'assist'] },
  { name: 'DWAgent', pattern: /\bdwagent\b/i, tokens: ['dwagent', 'dwservice'] },
  { name: 'MeshAgent', pattern: /mesh ?agent|mesh ?central/i, tokens: ['meshagent', 'meshcentral', 'mesh'] },
  { name: 'Atera', pattern: /\batera\b/i, tokens: ['atera'] },
  { name: 'Action1', pattern: /\baction1\b/i, tokens: ['action1'] },
];

// SQL-side prefilter mirroring RA_PRODUCTS — keeps the candidate row count
// bounded before any text leaves Postgres. \y = PG word boundary.
const RA_PRODUCT_SQL_RE =
  'screen ?connect|connectwise ?control|anydesk|teamviewer|splashtop|rustdesk|\\ysupremo\\y|ultraviewer|logmein|goto ?assist|zoho ?assist|\\ydwagent\\y|mesh ?agent|mesh ?central|\\yatera\\y|\\yaction1\\y';

// Stage-1 gate, part B: ...AND carry an install/fetch primitive.
const INSTALL_OR_FETCH =
  /msiexec|\/qn\b|\/quiet\b|\/silent\b|\/verysilent\b|invoke-webrequest|\biwr\b|webclient|downloadfile|downloaddata|start-bitstransfer|certutil\s+-urlcache/i;

// Stage-2 marker patterns.
const TLS_BYPASS = /TrustAllCertsPolicy|ICertificatePolicy|ServerCertificateValidationCallback/i;
const EXEC_POLICY_BYPASS = /-ExecutionPolicy\s+Bypass/i;
const BARE_IP_PORT_URL = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}/i;
const BARE_IP_PORT_HOST = /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/;
const UNATTENDED_E_ACCESS = /[?&]e=access\b/i;
const UNATTENDED_Y_GUEST = /[?&]y=guest\b/i;

const URL_AUTHORITY = /https?:\/\/([^\s"'`<>()[\]{}\\|,;]+)/gi;

const SAVED_FILENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /-OutFile\s+["']?([^\s"';]+)/gi,
  /-Destination\s+["']?([^\s"';]+)/gi,
  /\.DownloadFile\(\s*[^,]+,\s*["']([^"']+)["']/gi,
  /msiexec(?:\.exe)?["']?[^\n]*?\/i\s+["']?([^\s"';]+)/gi,
];

// Filename stems too generic to call "misleading" (setup.exe is not a lie).
const GENERIC_FILENAME_STEMS: ReadonlySet<string> = new Set([
  'setup', 'install', 'installer', 'agent', 'client', 'remote', 'support',
  'temp', 'tmp', 'package', 'update', 'updater', 'app', 'tool', 'file',
  'download', 'deploy', 'run', 'bin', 'out', 'output',
]);

// Host labels that carry no branding — ignored when deciding whether a
// download host relates to the partner or the vendor.
const GENERIC_HOST_LABELS: ReadonlySet<string> = new Set([
  'www', 'dl', 'download', 'downloads', 'get', 'cdn', 'files', 'file',
  'app', 'apps', 'my', 'portal', 'remote', 'support', 'help', 'update',
  'updates', 'static', 'assets', 'storage', 'mirror', 'pkg', 'packages',
]);

export interface ScriptIndicators {
  /** Throwaway TLDs (no leading dot), lowercase. EMPTY by default — populate via ABUSE_SCRIPT_INDICATORS. */
  tlds: string[];
  /** Known-bad download hostnames (no port), lowercase. EMPTY by default. */
  hosts: string[];
}

/**
 * Indicator lists come from the ABUSE_SCRIPT_INDICATORS env var
 * (JSON: {"tlds": [...], "hosts": [...]}) and default to EMPTY — the repo is
 * public and committing real indicators would be an evasion guide.
 */
export function loadScriptIndicators(): ScriptIndicators {
  const empty: ScriptIndicators = { tlds: [], hosts: [] };
  const raw = process.env.ABUSE_SCRIPT_INDICATORS;
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[AbuseSignals] ABUSE_SCRIPT_INDICATORS is not valid JSON — using empty indicator lists');
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[AbuseSignals] ABUSE_SCRIPT_INDICATORS must be a JSON object — using empty indicator lists');
    return empty;
  }
  const toStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase()) : [];
  const obj = parsed as Record<string, unknown>;
  return { tlds: toStringList(obj.tlds), hosts: toStringList(obj.hosts) };
}

export interface ScriptFinding {
  partnerId: string;
  partnerName: string;
  /** Domain of the partner's billing email, when present (relatedness check). */
  partnerEmailDomain: string | null;
  scriptId: string;
  /** left(content, 20000); '' for execution-only findings. */
  scriptContent: string;
  /** This sweep's newly scanned stdout excerpts (incremental — see HWM below). */
  executionStdouts: string[];
  /**
   * Hosts previously persisted for this (partner, script) in
   * abuse_script_hosts. Keeps host-derived markers durable across sweeps even
   * though execution stdout is only ever scanned once.
   */
  persistedHosts: string[];
}

export interface ScriptFindingsResult {
  /** Findings for partners in the evaluated (active, non-deleted) scope only. */
  findings: ScriptFinding[];
  /** host -> distinct partner count (>= 2), computed over the FULL corpus. */
  sharedHosts: Map<string, number>;
  /** Partner ids whose scripts were scored this sweep — fed into evaluatedPartnerIds. */
  scannedPartnerIds: string[];
}

/** Extract URL authorities (host[:port]) from free text. Pure; exported for tests. */
export function extractHosts(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(URL_AUTHORITY)) {
    let authority = (match[1] ?? '').split('/')[0] ?? '';
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1); // strip userinfo
    authority = authority.replace(/[.,:'"!]+$/, '').toLowerCase();
    if (authority.length === 0 || authority.length > 255) continue;
    out.add(authority);
  }
  return [...out];
}

const hostnameOf = (host: string): string => host.split(':')[0] ?? host;
const isIpHost = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostnameOf(host));

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

const overlaps = (label: string, tokens: readonly string[]): boolean =>
  tokens.some((t) => label.includes(t) || (label.length >= 3 && t.includes(label)));

/**
 * A download host is "related" when a meaningful label overlaps the partner's
 * name/email-domain tokens (their own vendor instance: acmeit.<vendor>.tld),
 * or when EVERY meaningful label is a vendor token (the vendor's own download
 * domain). A vendor-instance host whose instance label belongs to someone
 * else is exactly the abuse fingerprint, so it stays unrelated.
 */
function hostRelated(host: string, partnerTokens: readonly string[], productTokens: readonly string[]): boolean {
  const labels = hostnameOf(host).split('.').slice(0, -1); // drop TLD label
  const meaningful = labels.filter((l) => l.length >= 3 && !GENERIC_HOST_LABELS.has(l) && !/^\d+$/.test(l));
  if (meaningful.length === 0) return false;
  if (meaningful.some((l) => overlaps(l, partnerTokens))) return true;
  return meaningful.every((l) => overlaps(l, productTokens));
}

function extractSavedFilenameStems(text: string): string[] {
  const stems = new Set<string>();
  for (const re of SAVED_FILENAME_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const raw = match[1] ?? '';
      const base = raw.split(/[\\/]/).pop() ?? '';
      if (base.includes('$') || base.includes('%')) continue; // variable, not a literal name
      const stem = (base.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (stem.length >= 3) stems.add(stem);
    }
  }
  return [...stems];
}

interface ScoredFinding {
  score: number;
  markers: string[];
  hosts: string[];
}

function scoreFinding(
  f: ScriptFinding,
  sharedHosts: ReadonlyMap<string, number>,
  cfg: SignalConfig,
  indicators: ScriptIndicators,
): ScoredFinding | null {
  const text = [f.scriptContent, ...f.executionStdouts].join('\n');
  const products = RA_PRODUCTS.filter((p) => p.pattern.test(text));
  if (products.length === 0 || !INSTALL_OR_FETCH.test(text)) return null;

  const hosts = [...new Set([...extractHosts(text), ...f.persistedHosts.map((h) => h.toLowerCase())])];
  const productTokens = products.flatMap((p) => p.tokens);
  const partnerTokens = [
    ...tokenize(f.partnerName),
    ...(f.partnerEmailDomain ? f.partnerEmailDomain.toLowerCase().split('.').slice(0, -1).filter((l) => l.length >= 3) : []),
  ];

  const minPartners = cfg['rmm.shared_installer_host.min_partners'];
  const indicatorHostSet = new Set(indicators.hosts);
  const markers: Array<{ name: string; weight: number }> = [];
  const add = (name: string, weight: number) => markers.push({ name, weight });

  if (TLS_BYPASS.test(text)) {
    add('tls_bypass', cfg['rmm.remote_access_installer.marker.tls_bypass']);
  }
  if (hosts.some((h) => (sharedHosts.get(h) ?? 0) >= minPartners)) {
    add('shared_host', cfg['rmm.remote_access_installer.marker.shared_host']);
  }
  if (indicatorHostSet.size > 0 && hosts.some((h) => indicatorHostSet.has(hostnameOf(h)))) {
    add('indicator_host', cfg['rmm.remote_access_installer.marker.indicator_host']);
  }
  if (indicators.tlds.length > 0 && hosts.some((h) => indicators.tlds.some((t) => hostnameOf(h).endsWith(`.${t}`)))) {
    add('throwaway_tld', cfg['rmm.remote_access_installer.marker.throwaway_tld']);
  }
  if (BARE_IP_PORT_URL.test(text) || hosts.some((h) => BARE_IP_PORT_HOST.test(h))) {
    add('bare_ip_port', cfg['rmm.remote_access_installer.marker.bare_ip_port']);
  }
  const misleadingStem = extractSavedFilenameStems(text).find(
    (stem) => !GENERIC_FILENAME_STEMS.has(stem) && !overlaps(stem, productTokens),
  );
  if (misleadingStem !== undefined) {
    add('misleading_filename', cfg['rmm.remote_access_installer.marker.misleading_filename']);
  }
  // Bare-IP hosts are excluded here — they already scored via bare_ip_port.
  const namedHosts = hosts.filter((h) => !isIpHost(h));
  if (namedHosts.length > 0 && namedHosts.every((h) => !hostRelated(h, partnerTokens, productTokens))) {
    add('unrelated_host', cfg['rmm.remote_access_installer.marker.unrelated_host']);
  }
  if (EXEC_POLICY_BYPASS.test(text)) {
    add('exec_policy_bypass', cfg['rmm.remote_access_installer.marker.exec_policy_bypass']);
  }
  if (UNATTENDED_E_ACCESS.test(text) && UNATTENDED_Y_GUEST.test(text)) {
    add('unattended_params', cfg['rmm.remote_access_installer.marker.unattended_params']);
  }

  const raw = cfg['rmm.remote_access_installer.gate_score'] + markers.reduce((sum, m) => sum + m.weight, 0);
  return {
    score: Math.min(100, Math.round(raw)),
    markers: markers.map((m) => m.name),
    hosts,
  };
}

/**
 * Pure scoring: no I/O, unit-testable. Emits per-partner:
 *   - rmm.remote_access_installer — MAX across the partner's gated scripts.
 *   - rmm.shared_installer_host — an extracted host appears under >=
 *     min_partners distinct partners in the corpus.
 * Deliberately no youngWeight()/age decay anywhere in this function.
 */
export function computeScriptSignals(
  findings: ScriptFinding[],
  sharedHosts: ReadonlyMap<string, number>,
  cfg: SignalConfig,
  indicators: ScriptIndicators,
): ComputedSignal[] {
  const minPartners = cfg['rmm.shared_installer_host.min_partners'];
  const bestInstaller = new Map<string, { finding: ScriptFinding; scored: ScoredFinding }>();
  const bestShared = new Map<string, { finding: ScriptFinding; host: string; partnerCount: number }>();

  for (const f of findings) {
    const scored = scoreFinding(f, sharedHosts, cfg, indicators);
    if (scored) {
      const prev = bestInstaller.get(f.partnerId);
      if (!prev || scored.score > prev.scored.score) bestInstaller.set(f.partnerId, { finding: f, scored });
    }

    // Shared-host correlation does not require the install gate: the corpus
    // is already product-prefiltered, and the same host recurring across
    // partners is suspicious on its own.
    const allHosts = [...new Set([...extractHosts([f.scriptContent, ...f.executionStdouts].join('\n')), ...f.persistedHosts.map((h) => h.toLowerCase())])];
    for (const host of allHosts) {
      const count = sharedHosts.get(host) ?? 0;
      if (count < minPartners) continue;
      const prev = bestShared.get(f.partnerId);
      if (!prev || count > prev.partnerCount) bestShared.set(f.partnerId, { finding: f, host, partnerCount: count });
    }
  }

  const signals: ComputedSignal[] = [];

  for (const { finding, scored } of bestInstaller.values()) {
    signals.push({
      partnerId: finding.partnerId,
      signalKey: 'rmm.remote_access_installer',
      score: scored.score,
      severity: scoreToSeverity(scored.score, cfg),
      // Evidence stays compact (formatSignalAlert truncates to 800 chars):
      // matched host(s), marker names, script id — NEVER script bodies.
      evidence: {
        partnerName: finding.partnerName,
        scriptId: finding.scriptId,
        markers: scored.markers,
        hosts: scored.hosts.slice(0, 3),
      },
    });
  }

  for (const [partnerId, s] of bestShared) {
    const score = Math.min(
      100,
      Math.round(
        cfg['rmm.shared_installer_host.base_score'] +
          cfg['rmm.shared_installer_host.per_extra_partner'] * (s.partnerCount - minPartners),
      ),
    );
    signals.push({
      partnerId,
      signalKey: 'rmm.shared_installer_host',
      score,
      severity: scoreToSeverity(score, cfg),
      evidence: {
        partnerName: s.finding.partnerName,
        scriptId: s.finding.scriptId,
        host: s.host,
        partnerCount: s.partnerCount,
      },
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Bound every text read; never pull unbounded fleet-wide text. */
const TEXT_CAP = 20_000;
const SCRIPTS_PER_PARTNER_CAP = 25;
const EXECUTIONS_PER_SWEEP_CAP = 5_000;
const EXECUTION_MATCHES_PER_PARTNER_CAP = 50;
const PERSISTED_HOSTS_PER_PARTNER_CAP = 100;
const HOST_UPSERTS_PER_SWEEP_CAP = 2_000;
const BACKFILL_WINDOW_DAYS = 30;

const EXECUTION_SCAN_STATE_KEY = 'script_execution_scan';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quote a validated uuid list for interpolation into sql.raw. */
function uuidArraySql(ids: readonly string[]): string {
  const safe = ids.filter((id) => UUID_RE.test(id));
  return `ARRAY[${safe.map((id) => `'${id}'`).join(',')}]::uuid[]`;
}

interface PartnerRow {
  partner_id: string;
  partner_name: string;
  partner_status: string;
  partner_deleted: boolean;
  billing_email: string | null;
}

const emailDomain = (email: string | null): string | null => {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
};

/**
 * Loads script/execution findings and maintains the abuse_script_hosts corpus.
 * MUST run inside a system DB context — bare breeze_app reads return 0 rows.
 *
 * Incremental execution scan — high-water-mark choice: a tiny state row in
 * abuse_sweep_state (key 'script_execution_scan') storing the max
 * script_executions.created_at already scanned. Chosen over deriving from
 * persisted host data because most executions yield no hosts, which would
 * force rescanning. The first run backfills from now - 30 days; every sweep
 * advances the mark over at most EXECUTIONS_PER_SWEEP_CAP rows, so the
 * backfill is bounded and batched across hourly sweeps. Script CONTENT (not
 * stdout) is small and re-scanned in full every sweep, which is what lets
 * open script signals stale-resolve on real evidence (script edited/deleted).
 */
export async function loadScriptFindings(now: Date): Promise<ScriptFindingsResult> {
  // --- 1. Candidate scripts (ALL partners — corpus rule) -------------------
  const scriptRows = (await db.execute(sql`
    WITH candidates AS (
      SELECT s.id,
        left(s.content, ${TEXT_CAP}) AS content,
        COALESCE(s.partner_id, o.partner_id) AS owner_partner_id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(s.partner_id, o.partner_id)
          ORDER BY s.updated_at DESC
        ) AS rn
      FROM scripts s
      LEFT JOIN organizations o ON o.id = s.org_id
      WHERE s.deleted_at IS NULL
        AND s.is_system = false
        AND COALESCE(s.partner_id, o.partner_id) IS NOT NULL
        AND left(s.content, ${TEXT_CAP}) ~* ${RA_PRODUCT_SQL_RE}
    )
    SELECT c.id, c.content,
      c.owner_partner_id AS partner_id,
      p.name AS partner_name,
      p.status AS partner_status,
      (p.deleted_at IS NOT NULL) AS partner_deleted,
      p.billing_email
    FROM candidates c
    JOIN partners p ON p.id = c.owner_partner_id
    WHERE c.rn <= ${SCRIPTS_PER_PARTNER_CAP}
  `)) as unknown as Array<PartnerRow & { id: string; content: string }>;

  // --- 2. Incremental execution-stdout scan --------------------------------
  const stateRows = (await db.execute(sql`
    SELECT value FROM abuse_sweep_state WHERE key = ${EXECUTION_SCAN_STATE_KEY}
  `)) as unknown as Array<{ value: { lastExecutionCreatedAt?: string } | null }>;
  const storedMark = stateRows[0]?.value?.lastExecutionCreatedAt;
  const since = storedMark
    ? new Date(storedMark)
    : new Date(now.getTime() - BACKFILL_WINDOW_DAYS * 86_400_000);

  // Window upper bound FIRST, over created_at only, so the mark advances past
  // non-matching rows too (a regex-filtered LIMIT could not tell us how far
  // the scan actually got).
  // Dates are bound as ISO strings + ::timestamptz — postgres.js cannot
  // serialize raw Date params through db.execute(sql``).
  const upperRows = (await db.execute(sql`
    SELECT max(created_at) AS upper_bound FROM (
      SELECT created_at FROM script_executions
      WHERE created_at > ${since.toISOString()}::timestamptz
        AND created_at <= ${now.toISOString()}::timestamptz
      ORDER BY created_at ASC
      LIMIT ${EXECUTIONS_PER_SWEEP_CAP}
    ) w
  `)) as unknown as Array<{ upper_bound: string | Date | null }>;
  const upperBound = upperRows[0]?.upper_bound ? new Date(String(upperRows[0].upper_bound)) : null;

  const executionRows = upperBound
    ? ((await db.execute(sql`
        WITH matches AS (
          SELECT se.script_id,
            left(se.stdout, ${TEXT_CAP}) AS stdout,
            o.partner_id AS owner_partner_id,
            ROW_NUMBER() OVER (PARTITION BY o.partner_id ORDER BY se.created_at DESC) AS rn
          FROM script_executions se
          JOIN organizations o ON o.id = se.org_id
          WHERE se.created_at > ${since.toISOString()}::timestamptz
            AND se.created_at <= ${upperBound.toISOString()}::timestamptz
            AND se.stdout IS NOT NULL
            AND left(se.stdout, ${TEXT_CAP}) ~* ${RA_PRODUCT_SQL_RE}
        )
        SELECT m.script_id, m.stdout,
          m.owner_partner_id AS partner_id,
          p.name AS partner_name,
          p.status AS partner_status,
          (p.deleted_at IS NOT NULL) AS partner_deleted,
          p.billing_email
        FROM matches m
        JOIN partners p ON p.id = m.owner_partner_id
        WHERE m.rn <= ${EXECUTION_MATCHES_PER_PARTNER_CAP}
      `)) as unknown as Array<PartnerRow & { script_id: string; stdout: string }>)
    : [];

  // --- 3. Persist extracted hosts (ALL partners — corpus rule) -------------
  const upserts = new Map<string, { partnerId: string; host: string; source: 'script' | 'execution'; scriptId: string | null }>();
  const addUpserts = (partnerId: string, scriptId: string | null, source: 'script' | 'execution', text: string) => {
    for (const host of extractHosts(text)) {
      if (upserts.size >= HOST_UPSERTS_PER_SWEEP_CAP) return;
      upserts.set(`${partnerId}|${host}|${source}`, { partnerId, host, source, scriptId });
    }
  };
  for (const r of scriptRows) addUpserts(r.partner_id, r.id, 'script', r.content);
  for (const r of executionRows) addUpserts(r.partner_id, r.script_id, 'execution', r.stdout);

  if (upserts.size > 0) {
    await db
      .insert(abuseScriptHosts)
      .values([...upserts.values()].map((u) => ({
        partnerId: u.partnerId,
        host: u.host,
        source: u.source,
        scriptId: u.scriptId,
        firstSeenAt: now,
        lastSeenAt: now,
      })))
      .onConflictDoUpdate({
        target: [abuseScriptHosts.partnerId, abuseScriptHosts.host, abuseScriptHosts.source],
        set: { lastSeenAt: now },
      });
  }

  // --- 4. Shared-host correlation over the FULL corpus ---------------------
  const sharedRows = (await db.execute(sql`
    SELECT host, COUNT(DISTINCT partner_id) AS partner_count
    FROM abuse_script_hosts
    GROUP BY host
    HAVING COUNT(DISTINCT partner_id) >= 2
  `)) as unknown as Array<{ host: string; partner_count: string }>;
  const sharedHosts = new Map(sharedRows.map((r) => [r.host, Number(r.partner_count)]));

  // --- 5. Build findings for the evaluated scope only ----------------------
  const inScope = (r: PartnerRow): boolean => r.partner_status === 'active' && !r.partner_deleted;

  const findingByScript = new Map<string, ScriptFinding>();
  const ensureFinding = (r: PartnerRow, scriptId: string): ScriptFinding => {
    let f = findingByScript.get(scriptId);
    if (!f) {
      f = {
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        partnerEmailDomain: emailDomain(r.billing_email),
        scriptId,
        scriptContent: '',
        executionStdouts: [],
        persistedHosts: [],
      };
      findingByScript.set(scriptId, f);
    }
    return f;
  };

  for (const r of scriptRows) {
    if (!inScope(r)) continue;
    ensureFinding(r, r.id).scriptContent = r.content;
  }
  for (const r of executionRows) {
    if (!inScope(r)) continue;
    ensureFinding(r, r.script_id).executionStdouts.push(r.stdout);
  }

  const findings = [...findingByScript.values()];
  const scannedPartnerIds = [...new Set(findings.map((f) => f.partnerId))];

  // Attach persisted hosts so host-derived markers stay durable across sweeps
  // (execution stdout is only scanned once).
  if (scannedPartnerIds.length > 0) {
    const persistedRows = (await db.execute(sql.raw(`
      SELECT partner_id, script_id, host FROM (
        SELECT partner_id, script_id, host,
          ROW_NUMBER() OVER (PARTITION BY partner_id ORDER BY last_seen_at DESC) AS rn
        FROM abuse_script_hosts
        WHERE partner_id = ANY(${uuidArraySql(scannedPartnerIds)})
      ) x WHERE rn <= ${PERSISTED_HOSTS_PER_PARTNER_CAP}
    `))) as unknown as Array<{ partner_id: string; script_id: string | null; host: string }>;
    for (const row of persistedRows) {
      if (!row.script_id) continue;
      const f = findingByScript.get(row.script_id);
      if (f && f.partnerId === row.partner_id) f.persistedHosts.push(row.host);
    }
  }

  // --- 6. Advance the high-water mark --------------------------------------
  if (upperBound) {
    await db.execute(sql`
      INSERT INTO abuse_sweep_state (key, value, updated_at)
      VALUES (
        ${EXECUTION_SCAN_STATE_KEY},
        ${JSON.stringify({ lastExecutionCreatedAt: upperBound.toISOString() })}::jsonb,
        ${now.toISOString()}::timestamptz
      )
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
  }

  return { findings, sharedHosts, scannedPartnerIds };
}
