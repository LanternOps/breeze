export interface InstallCommandOptions {
  /** Breeze API origin, e.g. https://eu.2breeze.app */
  apiUrl: string;
  /** Enrollment token from the Add Device / setup flow */
  token: string;
  /** Optional org enrollment secret */
  enrollmentSecret?: string;
}

export interface InstallCommands {
  windows: string;
  macos: string;
  linux: string;
}

/**
 * Builds the copy-paste agent install commands shown in the Add Device modal
 * and the setup wizard.
 *
 * macOS/Linux route through the server-generated install.sh, which pre-flights
 * connectivity to the server (distinguishing "unreachable" from "intercepted
 * by a captive portal/router"), verifies the download, and surfaces enrollment
 * failures — instead of letting `installer`/`bash` die with a cryptic OS error
 * (see PR #1271 for the original field report). The one-liner itself only
 * trusts the fetched file after a shebang check, so an intercepting device
 * serving HTML is reported as a connectivity problem rather than executed.
 */
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

  const winSecretFlag = enrollmentSecret ? ` -EnrollmentSecret ${powershellLiteral(enrollmentSecret)}` : '';
  const windows =
    `& { $ErrorActionPreference='Stop'; ` +
    `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; ` +
    `$r=iwr ${powershellLiteral(`${apiUrl}/api/v1/agents/install.ps1`)} -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0 -UserAgent 'BreezeInstaller/1.0' -Headers @{'Accept-Encoding'='identity'}; ` +
    `if($r.StatusCode -ne 200){throw 'Breeze: installer download did not return HTTP 200'}; ` +
    `if($r.Content -notmatch '^function Install-BreezeAgent[ \\t]*\\{'){throw 'Breeze: response is not a Breeze PowerShell installer'}; ` +
    `iex $r.Content; ` +
    `Install-BreezeAgent -Token ${powershellLiteral(token)}${winSecretFlag} }`;

  return { windows, macos: unixCmd, linux: unixCmd };
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
}
