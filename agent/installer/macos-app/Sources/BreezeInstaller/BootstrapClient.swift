import Foundation

/// Fetches the enrollment payload from the Plan A bootstrap endpoint.
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
                return "This installer link has expired or already been used. Please re-download from your Breeze web console."
            case .http(let status, let body):
                return "Server error (\(status)): \(body.prefix(200))"
            case .decoding:
                return "Server returned an unexpected response. Please re-download the installer."
            }
        }
    }

    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetch(token: String, apiHost: String) async throws -> Payload {
        guard let url = URL(string: "https://\(apiHost)/api/v1/installer/bootstrap/\(token)") else {
            throw Error.http(status: 0, body: "constructed URL is invalid")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 30
        req.setValue("BreezeInstaller/1.0", forHTTPHeaderField: "User-Agent")

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
