import Foundation

enum Architecture: String {
    case arm64
    case amd64

    var pkgResourceName: String {
        switch self {
        case .arm64: return "breeze-agent-arm64.pkg"
        case .amd64: return "breeze-agent-amd64.pkg"
        }
    }

    /// Parses `uname -m` output. Returns nil for anything we don't ship a PKG for.
    static func fromUname(_ output: String) -> Architecture? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed {
        case "arm64": return .arm64
        case "x86_64": return .amd64
        default: return nil
        }
    }

    /// Detects the running host's architecture by invoking `/usr/bin/uname -m`.
    static func current() -> Architecture? {
        let task = Process()
        task.launchPath = "/usr/bin/uname"
        task.arguments = ["-m"]
        let pipe = Pipe()
        task.standardOutput = pipe
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return fromUname(output)
    }
}
