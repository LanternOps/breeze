import Foundation
import Security

/// Errors raised by `PrivilegedShell.run`.
enum PrivilegedShellError: Swift.Error, LocalizedError {
    case authCreateFailed(OSStatus)
    case authCancelled
    case authFailed(OSStatus)
    case execFailed(OSStatus)
    case missingExitStatus(output: String)
    case commandFailed(exitCode: Int32, output: String)

    var errorDescription: String? {
        switch self {
        case .authCreateFailed(let s):
            return "Could not create authorization (status \(s))"
        case .authCancelled:
            return "Administrator authentication was cancelled"
        case .authFailed(let s):
            return "Administrator authentication failed (status \(s))"
        case .execFailed(let s):
            return "Could not launch installer with administrator privileges (status \(s))"
        case .missingExitStatus(let output):
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return "Installer exited without reporting status.\n\n\(trimmed)"
        case .commandFailed(let code, let output):
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return "Install failed with exit code \(code).\n\n\(trimmed)"
        }
    }
}

/// Bridge to the deprecated-but-still-shipping `AuthorizationExecuteWithPrivileges`
/// symbol. Apple deprecated the function in macOS 10.7 and removed its public
/// Swift binding, but the symbol is still exported by the Security framework.
/// The supported successor (`SMJobBless` / `SMAppService`) requires installing
/// a persistent privileged helper tool — overkill for a one-shot installer
/// command, so we accept the deprecation and call the C symbol directly.
@_silgen_name("AuthorizationExecuteWithPrivileges")
private func _AuthorizationExecuteWithPrivileges(
    _ authorization: AuthorizationRef,
    _ pathToTool: UnsafePointer<CChar>,
    _ options: AuthorizationFlags,
    _ arguments: UnsafePointer<UnsafeMutablePointer<CChar>?>,
    _ communicationsPipe: UnsafeMutablePointer<UnsafeMutablePointer<FILE>?>?
) -> OSStatus

/// Marker the wrapped shell command echoes as its last line so we can
/// recover the wrapped command's exit status from the captured output.
/// `AuthorizationExecuteWithPrivileges` doesn't expose the spawned tool's
/// PID, so there's no other way to read its wait-status.
private let exitStatusMarker = "__BREEZE_INSTALLER_EXIT_STATUS__"

enum PrivilegedShell {
    /// Acquires the `system.privilege.admin` right (showing the modern auth
    /// dialog with Touch ID / Apple Watch unlock when enabled), then runs
    /// `/bin/sh -c <command>` as root and returns the captured stdout+stderr.
    ///
    /// `promptText` is shown above the credential entry in the auth dialog.
    /// Throws `.authCancelled` if the user cancels, or `.commandFailed` if
    /// the wrapped shell exits non-zero.
    static func run(command: String, promptText: String) throws -> String {
        var authRefOpt: AuthorizationRef?
        let createStatus = AuthorizationCreate(nil, nil, [], &authRefOpt)
        guard createStatus == errAuthorizationSuccess, let authRef = authRefOpt else {
            throw PrivilegedShellError.authCreateFailed(createStatus)
        }
        defer { AuthorizationFree(authRef, [.destroyRights]) }

        let copyStatus = acquireAdminRight(authRef: authRef, promptText: promptText)
        if copyStatus == errAuthorizationCanceled {
            throw PrivilegedShellError.authCancelled
        }
        guard copyStatus == errAuthorizationSuccess else {
            throw PrivilegedShellError.authFailed(copyStatus)
        }

        // Wrap so the child echoes its exit status as the final line.
        let wrapped = "\(command); echo \"\(exitStatusMarker)$?\""

        var argv: [UnsafeMutablePointer<CChar>?] = [
            strdup("-c"),
            strdup(wrapped),
            nil,
        ]
        defer { for p in argv { if let p = p { free(p) } } }

        var pipeOpt: UnsafeMutablePointer<FILE>?
        let execStatus: OSStatus = "/bin/sh".withCString { shellCStr in
            argv.withUnsafeMutableBufferPointer { buf in
                _AuthorizationExecuteWithPrivileges(authRef, shellCStr, [], buf.baseAddress!, &pipeOpt)
            }
        }
        guard execStatus == errAuthorizationSuccess, let pipe = pipeOpt else {
            throw PrivilegedShellError.execFailed(execStatus)
        }
        defer { fclose(pipe) }

        let output = readToEnd(pipe)
        return try parseExitStatus(rawOutput: output)
    }

    /// Pure parser exposed for unit testing — given captured shell output
    /// containing the exit-status marker, returns the cleaned output or
    /// throws the appropriate error.
    static func parseExitStatus(rawOutput: String) throws -> String {
        let lines = rawOutput.split(separator: "\n", omittingEmptySubsequences: false)
        for line in lines.reversed() {
            guard line.hasPrefix(exitStatusMarker) else { continue }
            let codeString = line.dropFirst(exitStatusMarker.count)
            let code = Int32(codeString) ?? -1
            let cleaned = lines
                .filter { !$0.hasPrefix(exitStatusMarker) }
                .joined(separator: "\n")
            if code != 0 {
                throw PrivilegedShellError.commandFailed(exitCode: code, output: cleaned)
            }
            return cleaned
        }
        throw PrivilegedShellError.missingExitStatus(output: rawOutput)
    }

    private static func acquireAdminRight(authRef: AuthorizationRef, promptText: String) -> OSStatus {
        // All buffers must outlive the AuthorizationCopyRights call. Nest
        // withCString blocks so the C strings stay valid, and use explicit
        // withUnsafeMutablePointer to give the AuthorizationItemSet/Rights
        // a stable backing pointer (avoids #TemporaryPointers warnings).
        return "system.privilege.admin".withCString { rightCStr in
            promptText.withCString { promptCStr in
                kAuthorizationEnvironmentPrompt.withCString { promptKeyCStr in
                    var promptItem = AuthorizationItem(
                        name: promptKeyCStr,
                        valueLength: strlen(promptCStr),
                        value: UnsafeMutableRawPointer(mutating: promptCStr),
                        flags: 0
                    )
                    var rightItem = AuthorizationItem(
                        name: rightCStr,
                        valueLength: 0,
                        value: nil,
                        flags: 0
                    )
                    return withUnsafeMutablePointer(to: &promptItem) { promptPtr in
                        withUnsafeMutablePointer(to: &rightItem) { rightPtr in
                            var environment = AuthorizationItemSet(count: 1, items: promptPtr)
                            var rights = AuthorizationRights(count: 1, items: rightPtr)
                            let flags: AuthorizationFlags = [.interactionAllowed, .extendRights, .preAuthorize]
                            return AuthorizationCopyRights(authRef, &rights, &environment, flags, nil)
                        }
                    }
                }
            }
        }
    }

    private static func readToEnd(_ pipe: UnsafeMutablePointer<FILE>) -> String {
        var output = ""
        let bufSize = 4096
        var buf = [UInt8](repeating: 0, count: bufSize)
        while true {
            let n = buf.withUnsafeMutableBufferPointer { ptr in
                fread(ptr.baseAddress, 1, bufSize, pipe)
            }
            if n == 0 { break }
            if let chunk = String(bytes: buf.prefix(n), encoding: .utf8) {
                output += chunk
            }
        }
        return output
    }
}
