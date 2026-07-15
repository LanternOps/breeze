import Foundation

/// Loads the bootstrap token + API host from the installer zip payload.
///
/// The token is delivered in two places: a sibling `Breeze Installer.bootstrap.json`
/// (preferred — clean parse, no token in the visible bundle name) and the app
/// bundle's own filename `Breeze Installer [TOKEN@host].app` (fallback). The
/// filename copy is NOT redundant: macOS App Translocation copies only the .app
/// bundle to a randomized read-only path when a quarantined app is launched in
/// place, stranding the sibling JSON. The bundle name travels with the app, so
/// the filename fallback is what keeps the install working in that case (#2544).
enum FilenameTokenParser {
    struct Result: Equatable {
        let token: String
        let apiHost: String
    }

    enum Error: Swift.Error, Equatable {
        case invalidFormat
    }

    private static let pattern = #"\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]"#
    private static let hostPattern = #"^[a-zA-Z0-9.\-]+$"#
    private static let payloadFileName = "Breeze Installer.bootstrap.json"

    private struct Payload: Decodable {
        let token: String
        let apiHost: String
    }

    static func load(bundleURL: URL) throws -> Result {
        let payloadURL = bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent(payloadFileName)

        if let data = try? Data(contentsOf: payloadURL),
           let payload = try? JSONDecoder().decode(Payload.self, from: data),
           isValidToken(payload.token),
           isValidHost(payload.apiHost) {
            return Result(token: payload.token, apiHost: payload.apiHost)
        }

        return try parse(bundleName: bundleURL.lastPathComponent)
    }

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

    private static func isValidToken(_ token: String) -> Bool {
        token.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil
    }

    private static func isValidHost(_ host: String) -> Bool {
        host.range(of: hostPattern, options: .regularExpression) != nil
    }
}
