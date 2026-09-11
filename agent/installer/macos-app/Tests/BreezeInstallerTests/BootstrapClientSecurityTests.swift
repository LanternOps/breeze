import Foundation
import XCTest
@testable import BreezeInstaller

final class BootstrapClientSecurityTests: XCTestCase {
    private final class StubProtocol: URLProtocol {
        enum Action {
            case response(HTTPURLResponse, Data)
            case redirect(HTTPURLResponse, URLRequest)
        }

        static var handler: ((URLRequest) throws -> Action)?
        static var requests: [URLRequest] = []

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            do {
                Self.requests.append(request)
                switch try Self.handler!(request) {
                case .response(let response, let data):
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                    client?.urlProtocol(self, didLoad: data)
                    client?.urlProtocolDidFinishLoading(self)
                case .redirect(let response, let request):
                    client?.urlProtocol(self, wasRedirectedTo: request, redirectResponse: response)
                }
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }

        override func stopLoading() {}
    }

    override func tearDown() {
        StubProtocol.handler = nil
        StubProtocol.requests = []
        super.tearDown()
    }

    private func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return config
    }

    private func response(
        url: String,
        status: Int = 200,
        serverURL: String = "https://trusted.example"
    ) -> StubProtocol.Action {
        let response = HTTPURLResponse(
            url: URL(string: url)!,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
        let body = #"{"serverUrl":"\#(serverURL)","enrollmentKey":"child-key","orgName":"Example"}"#.data(using: .utf8)!
        return .response(response, body)
    }

    func testRejectsSuccessfulResponseFromDifferentAuthority() async throws {
        let config = configuration()
        StubProtocol.handler = { _ in
            self.response(
                url: "https://redirected.example/api/v1/installer/bootstrap",
                serverURL: "https://redirected.example"
            )
        }

        do {
            _ = try await BootstrapClient(configuration: config).fetch(
                token: "A7K2XQMN4P",
                apiHost: "trusted.example"
            )
            XCTFail("a final response from another authority must be rejected")
        } catch {}
    }

    func testRejectsCrossAuthorityRedirectBeforeForwardingToken() {
        var original = URLRequest(
            url: URL(string: "https://trusted.example/api/v1/installer/bootstrap")!
        )
        original.setValue("A7K2XQMN4P", forHTTPHeaderField: "X-Breeze-Bootstrap-Token")
        var proposed = original
        proposed.url = URL(string: "https://redirected.example/bootstrap")!

        XCTAssertNil(BootstrapClient.trustedRedirectRequest(
            originalRequest: original,
            proposedRequest: proposed
        ))
    }

    func testRedirectAuthorityMatrixForEveryHTTPRedirectStatus() {
        var original = URLRequest(
            url: URL(string: "https://trusted.example/api/v1/installer/bootstrap")!
        )
        original.setValue("A7K2XQMN4P", forHTTPHeaderField: "X-Breeze-Bootstrap-Token")

        for status in [301, 302, 303, 307, 308] {
            for (target, allowed) in [
                ("https://trusted.example/redirect-\(status)", true),
                ("https://redirected.example/redirect-\(status)", false),
                ("http://trusted.example/redirect-\(status)", false),
            ] {
                var proposed = original
                proposed.url = URL(string: target)!
                let decision = BootstrapClient.trustedRedirectRequest(
                    originalRequest: original,
                    proposedRequest: proposed
                )
                XCTAssertEqual(
                    decision != nil,
                    allowed,
                    "unexpected redirect decision for status \(status), target \(target)"
                )
                if !allowed {
                    XCTAssertNil(decision, "credential-bearing request must not be forwarded")
                }
            }
        }
    }

    func testWiredSessionRefusesUntrustedRedirectsWithoutContactingTarget() async throws {
        for status in [301, 302, 303, 307, 308] {
            for target in [
                "https://redirected.example/bootstrap",
                "http://trusted.example/bootstrap",
            ] {
                StubProtocol.requests = []
                let config = configuration()
                StubProtocol.handler = { request in
                    if request.url?.absoluteString == target {
                        return self.response(url: target, serverURL: target)
                    }
                    let redirectResponse = HTTPURLResponse(
                        url: request.url!,
                        statusCode: status,
                        httpVersion: nil,
                        headerFields: ["Location": target]
                    )!
                    var redirected = request
                    redirected.url = URL(string: target)!
                    return .redirect(redirectResponse, redirected)
                }

                do {
                    _ = try await BootstrapClient(
                        configuration: config,
                        requestTimeout: 0.05
                    ).fetch(token: "A7K2XQMN4P", apiHost: "trusted.example")
                    XCTFail("status \(status) redirect to \(target) must not produce a payload")
                } catch {}

                XCTAssertEqual(
                    StubProtocol.requests.count,
                    1,
                    "status \(status) redirect contacted untrusted target \(target)"
                )
                XCTAssertEqual(StubProtocol.requests.first?.url?.host, "trusted.example")
            }
        }
    }

    func testAllowsSameAuthorityRedirectAndValidPayload() async throws {
        for status in [301, 302, 303, 307, 308] {
            StubProtocol.requests = []
            let config = configuration()
            StubProtocol.handler = { request in
                if request.url?.path == "/redirected-bootstrap" {
                    return self.response(url: request.url!.absoluteString)
                }
                let redirectResponse = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: nil,
                    headerFields: ["Location": "https://trusted.example/redirected-bootstrap"]
                )!
                var redirected = request
                redirected.url = URL(string: "https://trusted.example/redirected-bootstrap")!
                return .redirect(redirectResponse, redirected)
            }

            let payload = try await BootstrapClient(configuration: config).fetch(
                token: "A7K2XQMN4P",
                apiHost: "trusted.example"
            )

            XCTAssertEqual(payload.enrollmentKey, "child-key")
            XCTAssertEqual(StubProtocol.requests.map { $0.url!.path }, [
                "/api/v1/installer/bootstrap",
                "/redirected-bootstrap",
            ])
            XCTAssertEqual(
                StubProtocol.requests.last?.value(forHTTPHeaderField: "X-Breeze-Bootstrap-Token"),
                "A7K2XQMN4P"
            )
        }
    }

    func testRejectsPayloadServerOutsideBootstrapAuthority() async throws {
        let config = configuration()
        StubProtocol.handler = { request in
            self.response(
                url: request.url!.absoluteString,
                serverURL: "https://redirected.example"
            )
        }

        do {
            _ = try await BootstrapClient(configuration: config).fetch(
                token: "A7K2XQMN4P",
                apiHost: "trusted.example"
            )
            XCTFail("an off-authority payload server must be rejected")
        } catch let error as BootstrapClient.Error {
            guard case .untrustedServer = error else {
                return XCTFail("expected untrusted server, got \(error)")
            }
        }
    }

    func testRejectsFinalResponseDowngradeAndPortChange() async throws {
        for finalURL in [
            "http://trusted.example/api/v1/installer/bootstrap",
            "https://trusted.example:8443/api/v1/installer/bootstrap",
        ] {
            let config = configuration()
            StubProtocol.handler = { _ in self.response(url: finalURL) }

            do {
                _ = try await BootstrapClient(configuration: config).fetch(
                    token: "A7K2XQMN4P",
                    apiHost: "trusted.example"
                )
                XCTFail("untrusted final response \(finalURL) must be rejected")
            } catch let error as BootstrapClient.Error {
                guard case .untrustedResponse = error else {
                    return XCTFail("expected untrusted response for \(finalURL), got \(error)")
                }
            }
        }
    }

    func testRejectsPayloadServerSchemeDowngradeAndCredentials() async throws {
        for serverURL in [
            "http://trusted.example",
            "https://user@trusted.example",
            "https://trusted.example?redirect=elsewhere",
            "https://trusted.example#fragment",
        ] {
            let config = configuration()
            StubProtocol.handler = { request in
                self.response(url: request.url!.absoluteString, serverURL: serverURL)
            }

            do {
                _ = try await BootstrapClient(configuration: config).fetch(
                    token: "A7K2XQMN4P",
                    apiHost: "trusted.example"
                )
                XCTFail("untrusted payload server \(serverURL) must be rejected")
            } catch let error as BootstrapClient.Error {
                guard case .untrustedServer = error else {
                    return XCTFail("expected untrusted server for \(serverURL), got \(error)")
                }
            }
        }
    }

    func testTrustedAuthorityNormalizesCaseAndDefaultHTTPSPort() {
        XCTAssertTrue(BootstrapClient.hasSameTrustedAuthority(
            URL(string: "https://TRUSTED.example/path")!,
            URL(string: "https://trusted.example:443/other")!
        ))
        XCTAssertFalse(BootstrapClient.hasSameTrustedAuthority(
            URL(string: "https://trusted.example/path")!,
            URL(string: "https://trusted.example:8443/other")!
        ))
        XCTAssertFalse(BootstrapClient.hasSameTrustedAuthority(
            URL(string: "https://trusted.example/path")!,
            URL(string: "http://trusted.example/other")!
        ))
    }
}
