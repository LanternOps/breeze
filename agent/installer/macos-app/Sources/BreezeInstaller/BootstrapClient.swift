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
        case untrustedResponse
        case untrustedServer
        case decoding(underlying: Swift.Error)

        var errorDescription: String? {
            switch self {
            case .network(let e):
                return "Network error: \(e.localizedDescription)"
            case .http(let status, _) where status == 404:
                return "This installer link has expired or already been used. Please re-download from your Breeze web console."
            case .http(let status, let body):
                return "Server error (\(status)): \(body.prefix(200))"
            case .untrustedResponse:
                return "The installer was redirected to an untrusted server. Please re-download from your Breeze web console."
            case .untrustedServer:
                return "Server returned an untrusted enrollment address. Please re-download the installer."
            case .decoding:
                return "Server returned an unexpected response. Please re-download the installer."
            }
        }
    }

    private final class RedirectDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(BootstrapClient.trustedRedirectRequest(
                originalRequest: task.originalRequest,
                proposedRequest: request
            ))
        }
    }

    private let configuration: URLSessionConfiguration
    private let requestTimeout: TimeInterval

    init(
        configuration: URLSessionConfiguration = .ephemeral,
        requestTimeout: TimeInterval = 30
    ) {
        self.configuration = configuration
        self.requestTimeout = requestTimeout
    }

    func fetch(token: String, apiHost: String) async throws -> Payload {
        guard let url = URL(string: "https://\(apiHost)/api/v1/installer/bootstrap") else {
            throw Error.http(status: 0, body: "constructed URL is invalid")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = requestTimeout
        req.setValue("BreezeInstaller/1.0", forHTTPHeaderField: "User-Agent")
        req.setValue(token, forHTTPHeaderField: "X-Breeze-Bootstrap-Token")

        let session = URLSession(
            configuration: configuration,
            delegate: RedirectDelegate(),
            delegateQueue: nil
        )
        defer { session.finishTasksAndInvalidate() }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw Error.network(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Error.http(status: 0, body: "non-HTTP response")
        }
        guard let finalURL = http.url,
              Self.hasSameTrustedAuthority(url, finalURL)
        else {
            throw Error.untrustedResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw Error.http(status: http.statusCode, body: body)
        }
        do {
            let payload = try JSONDecoder().decode(Payload.self, from: data)
            guard let serverURL = URL(string: payload.serverUrl),
                  serverURL.user == nil,
                  serverURL.password == nil,
                  serverURL.query == nil,
                  serverURL.fragment == nil,
                  Self.hasSameTrustedAuthority(url, serverURL)
            else {
                throw Error.untrustedServer
            }
            return payload
        } catch let error as Error {
            throw error
        } catch {
            throw Error.decoding(underlying: error)
        }
    }

    /// Bootstrap trust is pinned to the initial HTTPS authority. Redirects may
    /// adjust a path on that authority, but may not change scheme, host, or
    /// effective port. This comparison also applies to the final response URL
    /// and the control-plane URL returned in the decoded payload.
    static func hasSameTrustedAuthority(_ lhs: URL, _ rhs: URL) -> Bool {
        guard lhs.scheme?.lowercased() == "https",
              rhs.scheme?.lowercased() == "https",
              let lhsHost = lhs.host?.lowercased(),
              let rhsHost = rhs.host?.lowercased(),
              !lhsHost.isEmpty,
              !rhsHost.isEmpty,
              lhs.user == nil,
              lhs.password == nil,
              rhs.user == nil,
              rhs.password == nil
        else {
            return false
        }
        return lhsHost == rhsHost && (lhs.port ?? 443) == (rhs.port ?? 443)
    }

    static func trustedRedirectRequest(
        originalRequest: URLRequest?,
        proposedRequest: URLRequest
    ) -> URLRequest? {
        guard let originalURL = originalRequest?.url,
              let redirectURL = proposedRequest.url,
              hasSameTrustedAuthority(originalURL, redirectURL)
        else {
            return nil
        }
        return proposedRequest
    }
}
