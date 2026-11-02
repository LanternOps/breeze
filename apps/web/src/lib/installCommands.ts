import type { WindowsInstallerIntegrity } from '@breeze/shared';

export interface InstallCommandOptions {
  /** Breeze API origin, e.g. https://eu.2breeze.app */
  apiUrl: string;
  /** Enrollment token from the Add Device / setup flow */
  token: string;
  /** Optional org enrollment secret */
  enrollmentSecret?: string;
  /** URL and SHA-256 from authenticated onboarding. Null disables Windows commands. */
  windowsInstaller: WindowsInstallerIntegrity | null;
}

export interface InstallCommands {
  windows: string | null;
  macos: string;
  linux: string;
}

export function buildInstallCommands(opts: InstallCommandOptions): InstallCommands {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  const { token, enrollmentSecret } = opts;

  // The connectivity message is scoped to the fetch + shebang check only —
  // once install.sh runs it reports its own failures precisely, and appending
  // a "could not reach" hint after e.g. an enrollment error would mislead.
  const unixSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const unixCmd =
    `f="$(mktemp)" && ` +
    `{ curl -fsSL --connect-timeout 10 -o "$f" "${apiUrl}/api/v1/agents/install.sh" && head -n1 "$f" | grep -q '^#!' || ` +
    `{ echo "[ERROR] Could not fetch the Breeze installer from ${apiUrl} — verify this machine has network access to your Breeze server." >&2; false; }; } && ` +
    `sudo bash "$f" --server "${apiUrl}" --token "${token}"${unixSecretFlag}`;

  const installer = opts.windowsInstaller;
  const winSecretFlag = enrollmentSecret ? ` -EnrollmentSecret ${powershellLiteral(enrollmentSecret)}` : '';
  const windows = installer ?
    `& { $ErrorActionPreference='Stop'; ` +
    `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; ` +
    `$r=iwr ${powershellLiteral(installer.url)} -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0 -UserAgent 'BreezeInstaller/1.0' -Headers @{'Accept-Encoding'='identity'}; ` +
    `if($r.StatusCode -ne 200){throw 'Breeze: installer download did not return HTTP 200'}; ` +
    `$r.RawContentStream.Position=0; ` +
    `if((Get-FileHash -Algorithm SHA256 -InputStream $r.RawContentStream).Hash -ne ${powershellLiteral(installer.sha256)})` +
    `{throw 'Breeze: installer checksum mismatch. Generate a new command in Add Device'}; ` +
    `iex ([Text.UTF8Encoding]::new($false,$true).GetString($r.RawContentStream.ToArray())); ` +
    `Install-BreezeAgent -Token ${powershellLiteral(token)}${winSecretFlag} }`
    : null;

  return { windows, macos: unixCmd, linux: unixCmd };
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
}
