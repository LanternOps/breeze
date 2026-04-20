import Foundation
import AppKit

/// Runs `installer -pkg` and `breeze-agent enroll` as root via the native
/// macOS admin-password dialog. Uses `NSAppleScript` because it is the
/// supported way to trigger the system auth prompt for a one-shot
/// administrator command — `AuthorizationExecuteWithPrivileges` is
/// deprecated and SMJobBless is overkill for this scope.
struct Installer {
    enum Error: Swift.Error, LocalizedError {
        case appleScriptFailed(message: String, code: Int)
        case scriptCreationFailed

        var errorDescription: String? {
            switch self {
            case .scriptCreationFailed:
                return "Could not construct installer script"
            case .appleScriptFailed(_, let code) where code == -128:
                return "Administrator authentication was cancelled"
            case .appleScriptFailed(let message, let code):
                return "Install failed (\(code)): \(message)"
            }
        }
    }

    /// Escapes a single value for safe interpolation inside an AppleScript
    /// `do shell script` POSIX string. Wraps in single quotes and escapes
    /// any embedded single quotes by closing/escaping/reopening.
    ///
    /// Note: values containing literal double quotes (e.g. an enrollment
    /// secret with `"` in it) would break the enclosing AppleScript
    /// double-quoted string literal. For v1 this is acceptable — enrollment
    /// secrets are admin-configured, not end-user input — but should be
    /// addressed before allowing arbitrary user-provided secrets.
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

        let script = """
        do shell script "/usr/sbin/installer -pkg \(Installer.shellEscape(pkgPath)) -target / && /usr/local/bin/breeze-agent enroll \(enrollCmd)" with administrator privileges
        """

        guard let appleScript = NSAppleScript(source: script) else {
            throw Error.scriptCreationFailed
        }
        var errorDict: NSDictionary?
        appleScript.executeAndReturnError(&errorDict)
        if let err = errorDict {
            let message = err[NSAppleScript.errorMessage] as? String ?? "unknown"
            let code = err[NSAppleScript.errorNumber] as? Int ?? -1
            throw Error.appleScriptFailed(message: message, code: code)
        }
    }
}
