import Foundation
import AppKit

/// Runs `installer -pkg` and `breeze-agent enroll` as root via the modern
/// macOS auth dialog (Touch ID / Apple Watch unlock when enabled). See
/// `PrivilegedShell` for why we bridge to `AuthorizationExecuteWithPrivileges`
/// directly instead of using AppleScript's `do shell script ... with
/// administrator privileges` (the AppleScript path uses an old code path
/// that explicitly disables biometrics).
struct Installer {
    enum Error: Swift.Error, LocalizedError {
        case privilegedShellFailed(PrivilegedShellError)

        var errorDescription: String? {
            switch self {
            case .privilegedShellFailed(let inner):
                return inner.errorDescription
            }
        }
    }

    /// Escapes a single value for safe interpolation inside a `/bin/sh -c`
    /// command. Wraps in single quotes and escapes any embedded single
    /// quotes by closing/escaping/reopening.
    static func shellEscape(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    /// The .pkg installs breeze-agent to /Library/Breeze/bin or /usr/local/bin
    /// (agent/installer/macos/install-location.sh, #7211), so enroll with the
    /// binary it actually installed (#8778). Same rule as choose_bin_dir there:
    /// an agent already in /Library/Breeze/bin stays there, so it wins over a
    /// leftover /usr/local/bin copy. `enrollArgs` is already shell-escaped.
    static func privilegedCommand(pkgPath: String, enrollArgs: String) -> String {
        let trusted = "/Library/Breeze/bin/breeze-agent"
        let pick = "if [ -f \(trusted) ] && [ ! -L \(trusted) ] && [ -x \(trusted) ]; "
            + "then B=\(trusted); else B=/usr/local/bin/breeze-agent; fi"
        return "/usr/sbin/installer -pkg \(Installer.shellEscape(pkgPath)) -target / && \(pick) && \"$B\" enroll \(enrollArgs)"
    }

    func run(
        pkgPath: String,
        serverUrl: String,
        enrollmentKey: String,
        enrollmentSecret: String?,
        siteId: String?
    ) throws {
        var enrollArgs = [
            Installer.shellEscape(enrollmentKey),
            "--server", Installer.shellEscape(serverUrl),
            "--quiet",
        ]
        if let secret = enrollmentSecret, !secret.isEmpty {
            enrollArgs += ["--enrollment-secret", Installer.shellEscape(secret)]
        }
        let enrollCmd = enrollArgs.joined(separator: " ")
        let command = Installer.privilegedCommand(pkgPath: pkgPath, enrollArgs: enrollCmd)
        let prompt = "Breeze needs to install the agent and configure system services."

        do {
            _ = try PrivilegedShell.run(command: command, promptText: prompt)
        } catch let inner as PrivilegedShellError {
            throw Error.privilegedShellFailed(inner)
        }
    }
}
