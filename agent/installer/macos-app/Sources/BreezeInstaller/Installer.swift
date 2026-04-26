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
        if let site = siteId, !site.isEmpty {
            enrollArgs += ["--site-id", Installer.shellEscape(site)]
        }
        let enrollCmd = enrollArgs.joined(separator: " ")
        let command = "/usr/sbin/installer -pkg \(Installer.shellEscape(pkgPath)) -target / && /usr/local/bin/breeze-agent enroll \(enrollCmd)"
        let prompt = "Breeze needs to install the agent and configure system services."

        do {
            _ = try PrivilegedShell.run(command: command, promptText: prompt)
        } catch let inner as PrivilegedShellError {
            throw Error.privilegedShellFailed(inner)
        }
    }
}
