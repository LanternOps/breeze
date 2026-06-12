export interface InstallCommandOptions {
  /** Breeze API origin, e.g. https://eu.2breeze.app */
  apiUrl: string;
  /** Base URL for direct Windows binary downloads (GitHub releases) */
  ghBase: string;
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
 * (the guest-VLAN report from v0.69.0). The one-liner itself only trusts the
 * fetched file after a shebang check, so an intercepting device serving HTML
 * is reported as a connectivity problem rather than executed.
 */
export function buildInstallCommands(opts: InstallCommandOptions): InstallCommands {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  const ghBase = opts.ghBase.replace(/\/+$/, '');
  const { token, enrollmentSecret } = opts;

  const unixSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const unixCmd =
    `f="$(mktemp)" && curl -fsSL -o "$f" "${apiUrl}/api/v1/agents/install.sh" && ` +
    `head -n1 "$f" | grep -q '^#!' && ` +
    `sudo bash "$f" --server "${apiUrl}" --token "${token}"${unixSecretFlag} || ` +
    `{ echo "[ERROR] Breeze install did not complete. If no error is shown above, this machine could not reach ${apiUrl} — verify it has network access to your Breeze server."; false; }`;

  const winSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const winThrow = (step: string) => `if($LASTEXITCODE){throw "Breeze: ${step} failed (exit code $LASTEXITCODE)"}`;
  const windows =
    `$ErrorActionPreference='Stop'; ` +
    `Invoke-WebRequest -Uri "${ghBase}/breeze-agent-windows-amd64.exe" -OutFile breeze-agent.exe; ` +
    `.\\breeze-agent.exe service install; ${winThrow('service install')}; ` +
    `.\\breeze-agent.exe enroll "${token}" --server "${apiUrl}"${winSecretFlag}; ${winThrow('enrollment')}; ` +
    `.\\breeze-agent.exe service start; ${winThrow('service start')}`;

  return { windows, macos: unixCmd, linux: unixCmd };
}
