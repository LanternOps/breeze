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
# Parameters (all required):
#   msi_url        - HTTPS URL of the TARGET edition's MSI.
#   msi_sha256     - Expected SHA-256 of that MSI. Verified before anything
#                    is touched; on mismatch the device is left as-is.
#   target_edition - hosted | self-hosted
#
# EXPECT THIS COMMAND TO REPORT A TIMEOUT / NO RESULT when it succeeds past
# the uninstall step: the agent that would report the result is the one being
# replaced. Progress is written to C:\\ProgramData\\BreezeMigration\\migration.log
# and success shows as the device coming back online on its next heartbeat
# running the target edition.

$ErrorActionPreference = 'Stop'

$MsiUrl = $env:BREEZE_PARAM_MSI_URL
$MsiSha = $env:BREEZE_PARAM_MSI_SHA256
$TargetEdition = $env:BREEZE_PARAM_TARGET_EDITION

$work = 'C:\\ProgramData\\BreezeMigration'
$cfgDir = 'C:\\ProgramData\\Breeze'
$log = Join-Path $work 'migration.log'
# Working dir hardening: identity secrets (bearer token / mTLS key material,
# SYSTEM/Administrators-only at rest) are staged under $work during the dance.
# ProgramData's default ACL lets any local user pre-create this directory (or
# plant a junction) and read what SYSTEM copies in - so refuse reparse points
# outright and force a SYSTEM/Administrators-only ACL before anything secret
# is written. icacls runs every time: cheap, idempotent, and it also repairs a
# pre-existing user-created directory by re-owning its ACL.
New-Item -ItemType Directory -Force -Path $work | Out-Null
$workItem = Get-Item -LiteralPath $work -Force
if ($workItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  Write-Output 'BreezeMigration path is a reparse point; aborting (nothing touched)'
  exit 1
}
& icacls $work /inheritance:r /grant:r 'NT AUTHORITY\\SYSTEM:(OI)(CI)F' 'BUILTIN\\Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output 'failed to restrict BreezeMigration ACL; aborting (nothing touched)'
  exit 1
}
function Log($m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

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

  # Identity must exist or the reinstall would come up unenrolled.
  if (-not (Test-Path (Join-Path $cfgDir 'agent.yaml'))) { Log 'no agent.yaml; aborting (nothing touched)'; exit 1 }

  # Fetch + pin-verify the target MSI BEFORE touching the existing install.
  # Token-free fixed filename: the installer's enrollment step keys on a
  # token embedded in the MSI file name, so this name guarantees it skips and
  # the restored identity is used.
  $msi = Join-Path $work 'breeze-agent.msi'
  $haveGood = (Test-Path $msi) -and ((Get-FileHash -Algorithm SHA256 -Path $msi).Hash -eq $MsiSha)
  # -TimeoutSec keeps the one variable-duration step well inside the command's
  # 1800s budget: if the executor timeout fired while msiexec is mid-flight it
  # would kill only this PowerShell process, not msiexec (no process tree
  # management on Windows), leaving an unsupervised installer run.
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

  # From here the running agent dies (its own MSI stops it during uninstall).
  # This process survives it; the command never reports a result - expected.
  # 3010 (ERROR_SUCCESS_REBOOT_REQUIRED) and 1641 (reboot initiated) are
  # success: /qn /norestart makes msiexec report 3010 instead of rebooting,
  # and treating it as failure here would abort AFTER the uninstall actually
  # completed - leaving the device with no agent at all. Same convention as
  # the agent's own software installer.
  $msiOk = @(0, 3010, 1641)
  Log 'uninstalling current edition'
  $uninstallArgs = '/x {0} /qn /norestart /l*v "{1}"' -f $source.PSChildName, (Join-Path $work 'uninstall.log')
  $p = Start-Process msiexec.exe -ArgumentList $uninstallArgs -Wait -PassThru
  Log "uninstall exit $($p.ExitCode)"
  if ($msiOk -notcontains $p.ExitCode) { Log 'uninstall failed; the existing agent should still be intact'; exit 1 }
  if ($p.ExitCode -ne 0) { Log 'uninstall succeeded, reboot pending' }

  # Restore identity BEFORE install so the service's first start sees it.
  Copy-Item (Join-Path $bak 'agent.yaml') $cfgDir -Force
  if (Test-Path (Join-Path $bak 'secrets.yaml')) {
    Copy-Item (Join-Path $bak 'secrets.yaml') $cfgDir -Force
  }
  Log 'identity restored'

  Log 'installing target edition'
  $installArgs = '/i "{0}" /qn /norestart /l*v "{1}"' -f $msi, (Join-Path $work 'install.log')
  $p2 = Start-Process msiexec.exe -ArgumentList $installArgs -Wait -PassThru
  Log "install exit $($p2.ExitCode)"
  if ($msiOk -notcontains $p2.ExitCode) {
    Log 'TARGET INSTALL FAILED - device is currently agent-less; reinstall the agent manually'
    exit 1
  }
  if ($p2.ExitCode -ne 0) { Log 'install succeeded, reboot pending' }

  Start-Sleep -Seconds 20
  $svc = Get-Service BreezeAgent -ErrorAction SilentlyContinue
  Log "BreezeAgent service: $($svc.Status)"
  if ($svc -and $svc.Status -ne 'Running') { Start-Service BreezeAgent; Log 'started BreezeAgent' }
  # The restored originals now live in the config dir again - remove the
  # staged secret copies rather than leaving credential material behind.
  Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
  Log 'backup cleaned up'
  Log '--- edition migration complete ---'
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
      'target edition. The command is EXPECTED to report a timeout/no result on success — the agent ' +
      'that would report it is the one being replaced. Verify via the device coming back online on ' +
      'its next heartbeat; detailed progress is in C:\\ProgramData\\BreezeMigration\\migration.log ' +
      'on the device. Used to unwedge agents stranded on the self-hosted 0.105.x–0.106.x band that ' +
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
      })
      .from(scripts)
      .where(and(eq(scripts.name, def.name), eq(scripts.isSystem, true)))
      .limit(1);

    if (!existing) {
      await db.insert(scripts).values({
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
      });
      result.created += 1;
      continue;
    }

    if (existing.deletedAt) {
      result.skipped += 1;
      continue;
    }

    const unchanged =
      existing.content === def.content &&
      existing.description === def.description &&
      existing.category === def.category &&
      existing.language === def.language &&
      existing.timeoutSeconds === def.timeoutSeconds &&
      existing.runAs === def.runAs &&
      JSON.stringify(existing.osTypes) === JSON.stringify(def.osTypes) &&
      scriptParameterDefinitionsEqual(existing.parameters ?? [], parameters);

    if (unchanged) {
      result.unchanged += 1;
      continue;
    }

    await db
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
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(scripts.id, existing.id));
    result.updated += 1;
  }

  return result;
}
