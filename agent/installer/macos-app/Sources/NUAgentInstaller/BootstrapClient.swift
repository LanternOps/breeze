import Foundation

/// Fetches the enrollment payload from the bootstrap endpoint.
struct BootstrapClient {
    struct Payload: Decodable {
        let serverUrl: String
        let enrollmentKey: String
        let enrollmentSecret: String?
        let siteId: String?
        let orgName: String
    }

    enum Error: Swift.Error, LocalizedError {
        case network(underlying: Swift.Error)
        case http(status: Int, body: String)
        case decoding(underlying: Swift.Error)

        var errorDescription: String? {
            switch self {
            case .network(let e):
                return "Network error: \(e.localizedDescription)"
            case .http(let status, _) where status == 404:
                return "This installer link has expired or already been used. Please re-download from your Nodes Unlimited console."
            case .http(let status, let body):
                return "Server error (\(status)): \(body.prefix(200))"
            case .decoding:
                return "Server returned an unexpected response. Please re-download the installer."
            }
        }
    }

    /// Record of the user ticking the terms checkbox on the token screen. Sent to
    /// the server so consent is auditable — this is a managed-device install on
    /// customer hardware, so "who agreed, and when" has to be recorded somewhere
    /// other than the installer's own memory.
    struct TermsAcceptance: Encodable {
        let acceptedTerms: Bool
        let acceptedTermsAt: String
        let termsUrl: String

        static let termsUrlString = "https://nodesunlimited.com/terms-of-service"

        static func now() -> TermsAcceptance {
            let fmt = ISO8601DateFormatter()
            fmt.formatOptions = [.withInternetDateTime]
            return TermsAcceptance(
                acceptedTerms: true,
                acceptedTermsAt: fmt.string(from: Date()),
                termsUrl: termsUrlString
            )
        }
    }

    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetch(token: String, apiHost: String, terms: TermsAcceptance? = nil) async throws -> Payload {
        guard let url = URL(string: "https://\(apiHost)/api/v1/installer/bootstrap") else {
            throw Error.http(status: 0, body: "constructed URL is invalid")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("NUAgentInstaller/1.0", forHTTPHeaderField: "User-Agent")
        req.setValue(token, forHTTPHeaderField: "X-Breeze-Bootstrap-Token")

        // The server treats these as optional, so an older installer that sends no
        // body keeps working. Encoding failure must not block an install — the
        // token header is what actually authenticates the request.
        if let terms, let body = try? JSONEncoder().encode(terms) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw Error.network(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Error.http(status: 0, body: "non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw Error.http(status: http.statusCode, body: body)
        }
        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw Error.decoding(underlying: error)
        }
    }
}
