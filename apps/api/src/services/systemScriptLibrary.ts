/**
 * First-party system script library (#4072 follow-up).
 *
 * System scripts (`scripts.is_system = true`, org/partner NULL) are the shared
 * library behind Scripts → "Import from library" (`GET /scripts/system-library`
 * / `POST /scripts/import/:id`). The legacy dev seed (`db/seed.ts`) only runs
 * when someone invokes `pnpm db:seed`, so definitions added there never reach
 * an existing install. Entries in this module are ensured at API boot instead
 * (see the `ensureSystemLibraryScripts` call in `index.ts`), which is how a
 * library script ships to hosted production and to self-host installs alike.
 *
 * Write-path note: `services/scriptWrite.ts` is the chokepoint for USER-driven
 * script creation (tenancy resolution, partner-wide gate, isSystem clamp).
 * This module writes fixed first-party definitions under the system DB context
 * with no user input in scope — the same seed lane as `seedScripts` and
 * `seedBuiltInPlaybooks` — so none of those gates apply to it.
 */
import { and, eq } from 'drizzle-orm';
import {
  scriptParameterDefinitionsEqual,
  scriptParameterDefinitionsSchema,
  type ScriptParameterDefinition,
} from '@breeze/shared';
import { db } from '../db';
import { scripts } from '../db/schema';
import { clearedScriptSecurityAcknowledgementColumns } from './scriptSecurityAcknowledgement';
import { cutScriptVersion } from './scriptVersions';

export type SystemLibraryScriptDefinition = {
  name: string;
  description: string;
  category: string;
  osTypes: string[];
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  content: string;
  parameters?: ScriptParameterDefinition[];
  timeoutSeconds: number;
  runAs: 'system' | 'user' | 'elevated';
};

/**
 * Identity-preserving Breeze Agent edition switch (self-hosted ⇄ hosted).
 *
 * Productization of the #4072 field remediation: agents on the stranded
 * self-host 0.105.x–0.106.x band cannot take a hosted-edition update over the
 * normal update channel, and each edition's MSI refuses to install
 * while the other edition is present (the OTHEREDITIONFOUND launch condition),
 * while a plain uninstall deletes the device identity. The dance below —
 * verify the target MSI first, back up identity, uninstall, restore identity,
 * install under a token-free filename — was proven in both directions on a
 * wedged field-replica device before being templated here.
 *
 * #5016: that proof ran the dance by hand, not through the agent. Run BY the
 * agent, the uninstall stops the agent, and the agent takes the script down
 * with it (current agents: the KILL_ON_JOB_CLOSE Job Object of
 * agent/internal/executor/job.go fires when the agent process exits), so the
 * uninstall/restore/install leg now runs in a detached stage 2 that starts only
 * after this command has exited normally — the one exit on which the agent
 * releases a script's containment and leaves its detached children running.
 *
 * The MSI URL and SHA-256 pin are script parameters, not literals: hosting a
 * signed installer somewhere reachable is deployment-specific, and a stale
 * baked-in pin would brick the run at the hash check (by design, before
 * anything is touched).
 */
const EDITION_MIGRATION_CONTENT = `# Breeze Agent edition migration (Windows).
#
# Switches an installed Breeze Agent between the self-hosted and hosted
# editions in place, preserving the device identity (agent.yaml /
# secrets.yaml) so the device keeps its row and history - no re-enrollment,
# no duplicate device.
#
# Why the dance: each edition's MSI refuses to install while the other
# edition's product is present, and a plain MSI uninstall deletes the
# identity files. So: download + pin-verify first, back up identity,
# uninstall the current edition, restore identity, then install the target
# edition from an MSI whose filename carries no enrollment token (so the
# installer keeps the restored identity instead of enrolling fresh).
#
# Why two stages (#5016): this script is run BY the agent it replaces, and the
# uninstall stops that agent. A script cannot outlive its agent - the agent
# contains each script's process tree and tears it down when it exits - so a
# single-process dance dies between the uninstall and the install and leaves
# the device agent-less. Stage 1 (this process) therefore does everything that
# touches nothing: checks, download + pin-verify, identity backup. It then
# starts a detached stage 2 and EXITS, so the agent reports this command and
# releases it normally. Stage 2 waits for stage 1 to be gone, then uninstalls,
# restores the identity, installs the target edition and checks the service.
#
# Parameters (all required):
#   msi_url        - HTTPS URL of the TARGET edition's MSI.
#   msi_sha256     - Expected SHA-256 of that MSI. Verified before anything
#                    is touched; on mismatch the device is left as-is.
#   target_edition - hosted | self-hosted
#
# RESULT: exit 0 means stage 2 has taken over, NOT that the migration is done.
# The migration succeeded when the device comes back online running the target
# edition. Every step of both stages is written to
# C:\\ProgramData\\BreezeMigration\\migration.log on the device.

$ErrorActionPreference = 'Stop'

$MsiUrl = $env:BREEZE_PARAM_MSI_URL
$MsiSha = $env:BREEZE_PARAM_MSI_SHA256
$TargetEdition = $env:BREEZE_PARAM_TARGET_EDITION

$work = 'C:\\ProgramData\\BreezeMigration'
$cfgDir = 'C:\\ProgramData\\Breeze'
$log = Join-Path $work 'migration.log'
# Working dir hardening: identity secrets (bearer token / mTLS key material,
# SYSTEM/Administrators-only at rest) are staged under $work during the dance,
# and stage 2 is run FROM it as SYSTEM. ProgramData's default ACL lets any
# local user pre-create this directory (or plant a junction), and the creator
# owns it - so it could keep write access through any ACL we set. Refuse
# reparse points outright; move a directory owned by anyone but SYSTEM or
# Administrators out of the way (a rename, never a recursive delete, which
# could follow a planted link) and start clean; then force a
# SYSTEM/Administrators-only ACL before anything secret or executable lands.
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544')
function Test-TrustedItem($item) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  $o = (Get-Acl -LiteralPath $item.FullName).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  return ($trustedOwners -contains $o)
}
if (Test-Path -LiteralPath $work) {
  $workItem = Get-Item -LiteralPath $work -Force
  if ($workItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Write-Output 'BreezeMigration path is a reparse point; aborting (nothing touched)'
    exit 1
  }
  if (-not (Test-TrustedItem $workItem)) {
    $quarantine = 'BreezeMigration.untrusted-' + [guid]::NewGuid().ToString('N')
    try {
      Rename-Item -LiteralPath $work -NewName $quarantine -ErrorAction Stop
    } catch {
      Write-Output 'BreezeMigration is not owned by SYSTEM/Administrators and could not be moved aside; aborting (nothing touched)'
      exit 1
    }
  }
}
# Created WITHOUT -Force: anything that appeared at the path after the checks
# above (a re-planted junction) makes creation fail instead of being adopted.
if (-not (Test-Path -LiteralPath $work)) {
  try {
    New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
  } catch {
    Write-Output "could not create BreezeMigration ($($_.Exception.Message)); aborting (nothing touched)"
    exit 1
  }
}
& icacls $work /inheritance:r /grant:r 'NT AUTHORITY\\SYSTEM:(OI)(CI)F' 'BUILTIN\\Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output 'failed to restrict BreezeMigration ACL; aborting (nothing touched)'
  exit 1
}
# Re-verify once the ACL is locked: until icacls ran, a fresh directory still
# carried ProgramData's inherited ACL, which lets local users create entries
# in it. The directory itself and every top-level entry must be a non-link
# owned by SYSTEM/Administrators, or nothing here can be trusted.
$untrusted = @(@(Get-Item -LiteralPath $work -Force) + @(Get-ChildItem -LiteralPath $work -Force) |
  Where-Object { -not (Test-TrustedItem $_) })
if ($untrusted.Count -gt 0) {
  Write-Output "BreezeMigration contains untrusted entries ($(($untrusted | ForEach-Object { $_.Name }) -join ', ')); aborting (nothing touched)"
  exit 1
}
function Log($m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# Stage 2 - runs detached, as SYSTEM, after stage 1 has exited. It writes ONLY
# to migration.log: once the agent is gone nothing reads stdout/stderr, and a
# write to a pipe whose reader has died can itself end the process.
$stage2Script = @'
param([int]$ParentPid, [string]$SourceProductCode)
$ErrorActionPreference = 'Stop'
$work = 'C:\\ProgramData\\BreezeMigration'
$cfgDir = 'C:\\ProgramData\\Breeze'
$log = Join-Path $work 'migration.log'
$marker = Join-Path $work 'stage2.pid'
$go = Join-Path $work 'stage2.go'
$bak = Join-Path $work 'cfg-backup'
$msi = Join-Path $work 'breeze-agent.msi'
function Log($m) {
  $line = "$(Get-Date -Format o) [stage2] $m"
  for ($i = 0; $i -lt 10; $i++) {
    try { Add-Content -LiteralPath $log -Value $line -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 200 }
  }
}
# 1618 = another installation is already in progress (Windows Update, another
# deployment tool). Transient: wait and retry rather than fail the dance.
function Invoke-Msi($msiArgs, $what) {
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    $p = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru -WindowStyle Hidden
    Log "$what exit $($p.ExitCode) (attempt $attempt)"
    if ($p.ExitCode -ne 1618) { return $p.ExitCode }
    Start-Sleep -Seconds 60
  }
  return 1618
}
function Restore-Identity {
  Copy-Item -LiteralPath (Join-Path $bak 'agent.yaml') -Destination $cfgDir -Force
  if (Test-Path -LiteralPath (Join-Path $bak 'secrets.yaml')) {
    Copy-Item -LiteralPath (Join-Path $bak 'secrets.yaml') -Destination $cfgDir -Force
  }
}
$manual = 'to recover by hand: copy C:\\ProgramData\\BreezeMigration\\cfg-backup\\*.yaml to C:\\ProgramData\\Breeze, then run msiexec /i C:\\ProgramData\\BreezeMigration\\breeze-agent.msi /qn'
try {
  Set-Content -LiteralPath $marker -Value $PID -Encoding ASCII
  # Stage 1 is the agent's script process. Nothing destructive happens until it
  # has exited: only then has the agent released its process containment (a
  # command that ends normally leaves its detached children running), and only
  # then has the result been handed to the agent for reporting.
  try { Wait-Process -Id $ParentPid -Timeout 300 -ErrorAction Stop } catch { }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    Log 'stage 1 did not exit; aborting (nothing touched - the existing agent is intact)'
    exit 1
  }
  if (-not (Test-Path -LiteralPath $go)) {
    Log 'stage 1 did not complete its hand-off; aborting (nothing touched - the existing agent is intact)'
    exit 1
  }
  Remove-Item -LiteralPath $go -Force
  # Give the agent time to report the stage 1 result before its own MSI stops it.
  Start-Sleep -Seconds 30
  Log '--- stage 2 start ---'
  if (-not (Test-Path -LiteralPath (Join-Path $bak 'agent.yaml'))) {
    Log 'identity backup missing; aborting (nothing touched - the existing agent is intact)'
    exit 1
  }
  # 3010 (ERROR_SUCCESS_REBOOT_REQUIRED) and 1641 (reboot initiated) are
  # success: /qn /norestart makes msiexec report 3010 instead of rebooting,
  # and treating it as failure would abort AFTER the uninstall completed -
  # leaving the device with no agent at all.
  $msiOk = @(0, 3010, 1641)

  Log 'uninstalling current edition'
  $code = Invoke-Msi ('/x {0} /qn /norestart /l*v "{1}"' -f $SourceProductCode, (Join-Path $work 'uninstall.log')) 'uninstall'
  if ($msiOk -notcontains $code) { Log 'uninstall failed; the existing agent should still be intact'; exit 1 }
  if ($code -ne 0) { Log 'uninstall succeeded, reboot pending' }

  # Restore identity BEFORE install so the service's first start sees it.
  Restore-Identity
  Log 'identity restored'

  Log 'installing target edition'
  $installArgs = '/i "{0}" /qn /norestart /l*v "{1}"' -f $msi, (Join-Path $work 'install.log')
  $code = Invoke-Msi $installArgs 'install'
  if ($msiOk -notcontains $code) {
    # The device is agent-less right now: one more attempt after a pause,
    # with the identity re-laid in case the failed install's rollback moved it.
    Log 'install failed; retrying once in 60s (see install.log)'
    Start-Sleep -Seconds 60
    Restore-Identity
    $code = Invoke-Msi $installArgs 'install retry'
  }
  if ($msiOk -notcontains $code) {
    Log "TARGET INSTALL FAILED - device is currently agent-less; identity kept in cfg-backup; $manual"
    exit 1
  }
  if ($code -ne 0) { Log 'install succeeded, reboot pending' }
  if (-not (Test-Path -LiteralPath (Join-Path $cfgDir 'agent.yaml'))) {
    Log 'agent.yaml missing after install; restoring it'
    Restore-Identity
  }

  # The service must come up AND stay up: a build that refuses the restored
  # config at startup exits right after SCM starts it.
  $running = $false
  for ($i = 0; $i -lt 12; $i++) {
    $svc = Get-Service BreezeAgent -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { $running = $true; break }
    if ($svc -and $svc.Status -eq 'Stopped') {
      try { Start-Service BreezeAgent -ErrorAction Stop } catch { Log "starting BreezeAgent failed: $($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 5
  }
  if ($running) {
    Start-Sleep -Seconds 30
    $svc = Get-Service BreezeAgent -ErrorAction SilentlyContinue
    $running = [bool]($svc -and $svc.Status -eq 'Running')
  }
  if (-not $running) {
    Log "BreezeAgent is NOT running after install ($($svc.Status)) - see C:\\ProgramData\\Breeze\\logs and install.log; identity kept in cfg-backup"
    exit 1
  }
  Log 'BreezeAgent running'
  # The restored originals now live in the config dir again - remove the
  # staged secret copies rather than leaving credential material behind.
  Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
  Log 'backup cleaned up'
  Log '--- edition migration complete ---'
  exit 0
} catch {
  Log "FATAL: $($_.Exception.Message) - identity kept in cfg-backup; $manual"
  exit 1
} finally {
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
'@

try {
  Log '--- edition migration start ---'

  if ([string]::IsNullOrWhiteSpace($MsiUrl) -or [string]::IsNullOrWhiteSpace($MsiSha) -or [string]::IsNullOrWhiteSpace($TargetEdition)) {
    Log 'missing required parameter (msi_url, msi_sha256, target_edition); aborting (nothing touched)'
    exit 1
  }
  if ($MsiUrl -notmatch '^https://') { Log 'msi_url must be an https:// URL; aborting (nothing touched)'; exit 1 }
  $MsiSha = $MsiSha.Trim().ToUpperInvariant()
  if ($MsiSha -notmatch '^[0-9A-F]{64}$') { Log 'msi_sha256 must be 64 hex characters; aborting (nothing touched)'; exit 1 }

  $hostedName = 'Breeze Agent'
  $selfHostName = 'Breeze Agent (Self-Hosted)'
  switch ($TargetEdition) {
    'hosted'      { $targetName = $hostedName; $sourceName = $selfHostName }
    'self-hosted' { $targetName = $selfHostName; $sourceName = $hostedName }
    default { Log "unknown target_edition '$TargetEdition' (expected hosted or self-hosted); aborting (nothing touched)"; exit 1 }
  }

  # Idempotence: if the target edition is already installed there is nothing
  # to do, so a re-run (or a batch that includes already-migrated devices) is
  # harmless.
  $uninstallRoots = @(
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  )
  $products = Get-ItemProperty -Path $uninstallRoots -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Breeze Agent*' }
  $target = $products | Where-Object { $_.DisplayName -eq $targetName } | Select-Object -First 1
  if ($target) { Log "target edition already installed ($($target.DisplayVersion)); exiting"; exit 0 }
  $source = $products | Where-Object { $_.DisplayName -eq $sourceName } | Select-Object -First 1
  if (-not $source) { Log "no '$sourceName' product registered; aborting (nothing touched)"; exit 1 }
  Log "found $($source.DisplayName) $($source.DisplayVersion) $($source.PSChildName)"
  # The product code rides on stage 2's command line: accept only a GUID.
  $productCode = [string]$source.PSChildName
  if ($productCode -notmatch '^\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}$') {
    Log "unexpected product code '$productCode'; aborting (nothing touched)"
    exit 1
  }

  # Identity must exist or the reinstall would come up unenrolled.
  if (-not (Test-Path (Join-Path $cfgDir 'agent.yaml'))) { Log 'no agent.yaml; aborting (nothing touched)'; exit 1 }

  # One dance at a time: a stage 2 still running from an earlier dispatch owns
  # the device until it finishes.
  $marker = Join-Path $work 'stage2.pid'
  $go = Join-Path $work 'stage2.go'
  if (Test-Path -LiteralPath $marker) {
    $prior = 0
    [void][int]::TryParse([string](Get-Content -LiteralPath $marker -TotalCount 1 -ErrorAction SilentlyContinue), [ref]$prior)
    if ($prior -gt 0 -and (Get-Process -Id $prior -ErrorAction SilentlyContinue)) {
      Log "a migration stage 2 (pid $prior) is still running; aborting (nothing touched)"
      exit 1
    }
    Remove-Item -LiteralPath $marker -Force
  }
  if (Test-Path -LiteralPath $go) { Remove-Item -LiteralPath $go -Force }

  # Fetch + pin-verify the target MSI BEFORE touching the existing install.
  # Token-free fixed filename: the installer's enrollment step keys on a
  # token embedded in the MSI file name, so this name guarantees it skips and
  # the restored identity is used.
  $msi = Join-Path $work 'breeze-agent.msi'
  $haveGood = (Test-Path $msi) -and ((Get-FileHash -Algorithm SHA256 -Path $msi).Hash -eq $MsiSha)
  # -TimeoutSec keeps the one variable-duration step well inside the command's
  # 1800s budget.
  if (-not $haveGood) {
    Log 'downloading target MSI'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing -TimeoutSec 600
    $h = (Get-FileHash -Algorithm SHA256 -Path $msi).Hash
    if ($h -ne $MsiSha) { Log "HASH MISMATCH got=$h; aborting (nothing touched)"; exit 1 }
  }
  Log 'target MSI present, hash verified'

  # Back up identity: the uninstall's RemoveFiles deletes both files. The
  # backup dir is recreated fresh each run (never trusted if pre-existing)
  # and inherits the SYSTEM/Administrators-only ACL forced on $work above.
  $bak = Join-Path $work 'cfg-backup'
  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Recurse -Force }
  New-Item -ItemType Directory -Path $bak | Out-Null
  Copy-Item (Join-Path $cfgDir 'agent.yaml') $bak -Force
  if (Test-Path (Join-Path $cfgDir 'secrets.yaml')) {
    Copy-Item (Join-Path $cfgDir 'secrets.yaml') $bak -Force
  }
  Log 'identity backed up'

  # Hand off. Stage 2 is written fresh into the locked-down work dir and run
  # hidden; it signals it is alive by writing its pid, then waits for THIS
  # process to exit and for the go marker before it touches anything.
  $stage2Path = Join-Path $work 'migrate-stage2.ps1'
  if (Test-Path -LiteralPath $stage2Path) { Remove-Item -LiteralPath $stage2Path -Force }
  Set-Content -LiteralPath $stage2Path -Value $stage2Script -Encoding UTF8
  $psExe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $stage2Args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -ParentPid {1} -SourceProductCode {2}' -f $stage2Path, $PID, $productCode
  $s2 = Start-Process -FilePath $psExe -ArgumentList $stage2Args -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path -LiteralPath $marker) -and -not $s2.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $marker)) {
    if (-not $s2.HasExited) { Stop-Process -Id $s2.Id -Force -ErrorAction SilentlyContinue }
    Log 'stage 2 did not start; aborting (nothing touched - the existing agent is intact)'
    exit 1
  }
  Log "stage 2 running (pid $($s2.Id)); it uninstalls this agent once this command has exited. Progress continues in this log; success = the device comes back online on the target edition."
  Set-Content -LiteralPath $go -Value 'go' -Encoding ASCII
  exit 0
} catch {
  Log "FATAL: $($_.Exception.Message)"
  exit 1
}
`;

export const SYSTEM_LIBRARY_SCRIPTS: SystemLibraryScriptDefinition[] = [
  {
    name: 'Migrate Agent Edition (Windows)',
    description:
      'Switches an installed Breeze Agent between the self-hosted and hosted editions in place, ' +
      'preserving the device identity so it keeps its device row and history (no re-enrollment). ' +
      'Downloads the target-edition MSI from msi_url, verifies it against msi_sha256 before touching ' +
      'anything, then uninstalls the current edition, restores the identity files, and installs the ' +
      'target edition. The uninstall stops the agent running this command, so that leg runs in a ' +
      'detached second stage: the command reports success once the second stage has taken over, NOT ' +
      'when the migration is done. Verify via the device coming back online on the target edition; ' +
      'every step is logged to C:\\ProgramData\\BreezeMigration\\migration.log on the device. Used to unwedge agents stranded on the self-hosted 0.105.x–0.106.x band that ' +
      'cannot take a hosted-edition update over the normal update channel.',
    category: 'Maintenance',
    osTypes: ['windows'],
    language: 'powershell',
    content: EDITION_MIGRATION_CONTENT,
    parameters: [
      { name: 'msi_url', type: 'string', required: true, source: 'runtime' },
      { name: 'msi_sha256', type: 'string', required: true, source: 'runtime' },
      {
        name: 'target_edition',
        type: 'select',
        required: true,
        options: 'hosted,self-hosted',
        defaultValue: 'hosted',
        source: 'runtime',
      },
    ],
    timeoutSeconds: 1800,
    runAs: 'system',
  },
];

/**
 * Ensure every definition above exists in the system library, updating rows in
 * place (and bumping `version`) when a shipped definition changed. Keyed on
 * `(name, is_system)`. A soft-deleted row is left alone entirely — an operator
 * deleted it on purpose, and inserting a sibling would collide with the
 * import flow's name-based duplicate check.
 *
 * Runs at API boot under the system DB context; must stay idempotent.
 */
export async function ensureSystemLibraryScripts(): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}> {
  const result = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const def of SYSTEM_LIBRARY_SCRIPTS) {
    // Fail loud at boot on an invalid shipped definition instead of storing a
    // parameter contract the run modal and dispatch path cannot honor.
    const parameters = scriptParameterDefinitionsSchema.parse(def.parameters ?? []);

    const [existing] = await db
      .select({
        id: scripts.id,
        description: scripts.description,
        category: scripts.category,
        osTypes: scripts.osTypes,
        language: scripts.language,
        content: scripts.content,
        parameters: scripts.parameters,
        timeoutSeconds: scripts.timeoutSeconds,
        runAs: scripts.runAs,
        version: scripts.version,
        deletedAt: scripts.deletedAt,
        origin: scripts.origin,
      })
      .from(scripts)
      .where(and(eq(scripts.name, def.name), eq(scripts.isSystem, true)))
      .limit(1);

    if (!existing) {
      await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(scripts)
          .values({
            orgId: null,
            partnerId: null,
            name: def.name,
            description: def.description,
            category: def.category,
            osTypes: def.osTypes,
            language: def.language,
            content: def.content,
            parameters,
            timeoutSeconds: def.timeoutSeconds,
            runAs: def.runAs,
            isSystem: true,
            // cutScriptVersion moves it to 1 below.
            version: 0,
            // #5671: without this it falls through to the schema default
            // ('human'), contradicting the origin='system' cutScriptVersion
            // writes onto the version row in the same transaction below.
            origin: 'system',
          })
          .returning({ id: scripts.id });

        if (!created) {
          throw new Error(`system library script "${def.name}" insert returned no row`);
        }

        // No user on the boot path — index.ts wraps this in
        // runWithSystemDbAccess, so createdBy is honestly null.
        await cutScriptVersion(tx, {
          scriptId: created.id,
          provenance: { origin: 'system', changelog: 'Shipped system library definition', createdBy: null },
        });
      });
      result.created += 1;
      continue;
    }

    if (existing.deletedAt) {
      result.skipped += 1;
      continue;
    }

    // #5129 — tracked separately from `unchanged` below, which is a
    // conjunction over eight fields. The acknowledgement must be revoked when
    // the BODY is replaced, not merely when some tracked field differs: a
    // release that only bumps `timeoutSeconds` leaves the reviewed content
    // byte-identical, and wiping the approval there would break the script for
    // no reason on the next API boot.
    const contentChanged = existing.content !== def.content;

    // #5948: a row inserted before #5671 shipped is permanently stuck at the
    // schema default ('human') unless the sync corrects it here — nothing
    // else ever revisits `origin` on an existing system script.
    const originStale = existing.origin !== 'system';

    const unchanged =
      existing.content === def.content &&
      existing.description === def.description &&
      existing.category === def.category &&
      existing.language === def.language &&
      existing.timeoutSeconds === def.timeoutSeconds &&
      existing.runAs === def.runAs &&
      JSON.stringify(existing.osTypes) === JSON.stringify(def.osTypes) &&
      scriptParameterDefinitionsEqual(existing.parameters ?? [], parameters);

    if (unchanged && !originStale) {
      result.unchanged += 1;
      continue;
    }

    if (unchanged && originStale) {
      // The shipped definition itself did not change — only `origin` needs
      // correcting. Patch it directly rather than going through the full
      // update + cutScriptVersion path below: cutScriptVersion always bumps
      // `version`, and bumping it for a definition that is byte-for-byte
      // unchanged would skip a number and break UNIQUE-backed history for no
      // real content change.
      await db
        .update(scripts)
        .set({ origin: 'system', updatedAt: new Date() })
        .where(eq(scripts.id, existing.id));
      result.updated += 1;
      continue;
    }

    await db.transaction(async (tx) => {
    await tx
      .update(scripts)
      .set({
        description: def.description,
        category: def.category,
        osTypes: def.osTypes,
        language: def.language,
        content: def.content,
        parameters,
        timeoutSeconds: def.timeoutSeconds,
        runAs: def.runAs,
        // #5948: the update path must correct a stale `origin` on any content
        // update too — not just when the definition is otherwise unchanged —
        // since an update here means the row is about to get a fresh
        // origin='system' version row from cutScriptVersion below anyway.
        origin: 'system',
        // #5129 — when the library sync replaces `content` from a shipped
        // definition there is no human in the loop, so any acknowledgement the
        // row carried is revoked rather than inherited by the new body. Only a
        // system-scope PUT can put one on a system script in the first place,
        // so this is rarely non-empty — but the invariant "a wholesale content
        // replacement never inherits an approval" has to hold on every path,
        // not just the ones that are easy to reach.
        //
        // Gated on `contentChanged`, NOT on reaching this branch: the branch
        // also fires for a metadata-only diff (a timeout or description tweak)
        // where the reviewed body is untouched and the approval must stand.
        ...(contentChanged ? clearedScriptSecurityAcknowledgementColumns() : {}),
        // `version` is NOT set here — cutScriptVersion owns the bump, and a
        // second bump would skip a number and break UNIQUE-backed history.
        updatedAt: new Date(),
      })
      .where(eq(scripts.id, existing.id));

      await cutScriptVersion(tx, {
        scriptId: existing.id,
        provenance: {
          origin: 'system',
          changelog: 'Shipped system library definition updated',
          createdBy: null,
        },
      });
    });
    result.updated += 1;
  }

  return result;
}
