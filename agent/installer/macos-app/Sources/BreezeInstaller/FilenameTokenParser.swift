import Foundation

/// Parses the bootstrap token + API host out of the installer app's own
/// bundle filename. Format: `Breeze Installer [TOKEN@host.example].app`
/// where TOKEN is exactly 6 chars of [A-Z0-9] and host matches a relaxed
/// hostname pattern (letters, digits, dots, hyphens).
enum FilenameTokenParser {
    struct Result: Equatable {
        let token: String
        let apiHost: String
    }

    enum Error: Swift.Error, Equatable {
        case invalidFormat
    }

    private static let pattern = #"\[([A-Z0-9]{6})@([a-zA-Z0-9.\-]+)\]"#

    static func parse(bundleName: String) throws -> Result {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: bundleName,
                range: NSRange(bundleName.startIndex..., in: bundleName)
              ),
              match.numberOfRanges == 3,
              let tokenRange = Range(match.range(at: 1), in: bundleName),
              let hostRange = Range(match.range(at: 2), in: bundleName)
        else {
            throw Error.invalidFormat
        }
        return Result(
            token: String(bundleName[tokenRange]),
            apiHost: String(bundleName[hostRange])
        )
    }
}
