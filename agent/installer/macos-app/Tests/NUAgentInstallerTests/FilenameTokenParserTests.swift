import XCTest
@testable import NUAgentInstaller

final class FilenameTokenParserTests: XCTestCase {
    func testLoadsTokenAndHostFromSiblingPayloadFile() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let appURL = dir.appendingPathComponent("Nodes Unlimited Installer.app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)
        let payloadURL = dir.appendingPathComponent("Nodes Unlimited Installer.bootstrap.json")
        try #"{"token":"A7K2XQMN4P","apiHost":"api.example.com"}"#
            .data(using: .utf8)!
            .write(to: payloadURL)

        let result = try FilenameTokenParser.load(bundleURL: appURL)
        XCTAssertEqual(result.token, "A7K2XQMN4P")
        XCTAssertEqual(result.apiHost, "api.example.com")
    }

    func testLoadFallsBackToLegacyFilenameToken() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let appURL = dir.appendingPathComponent("Nodes Unlimited Installer [A7K2XQMN4P@us.2breeze.app].app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        let result = try FilenameTokenParser.load(bundleURL: appURL)
        XCTAssertEqual(result.token, "A7K2XQMN4P")
        XCTAssertEqual(result.apiHost, "us.2breeze.app")
    }

    func testExtractsTokenAndHostFromCanonicalFilename() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [A7K2XQMN4P@us.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "A7K2XQMN4P")
        XCTAssertEqual(result.apiHost, "us.2breeze.app")
    }

    func testHandlesNumericOnlyToken() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [1234567890@eu.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "1234567890")
    }

    func testRejectsLowercaseToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [a7k2xqmn4p@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsMissingBracket() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer.app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsTooShortToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [A7K2XQMN4@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsTooLongToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [A7K2XQMN4PZ@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsHostWithSpaces() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [A7K2XQMN4P@us 2breeze.app].app"
        ))
    }

    func testResolveFallsBackToBackingDmgFileName() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // No sibling payload, no token in the bundle name — only the DMG has it.
        let appURL = dir.appendingPathComponent("Nodes Unlimited Installer.app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        let result = FilenameTokenParser.resolve(
            bundleURL: appURL,
            dmgFileName: "Nodes Unlimited Agent [A7K2XQMN4P@us.2breeze.app].dmg"
        )
        XCTAssertEqual(result?.token, "A7K2XQMN4P")
        XCTAssertEqual(result?.apiHost, "us.2breeze.app")
    }

    func testResolvePrefersBundleSourcesOverDmgFileName() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let appURL = dir.appendingPathComponent("Nodes Unlimited Installer [BBBBBBBBBB@bundle.example].app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        let result = FilenameTokenParser.resolve(
            bundleURL: appURL,
            dmgFileName: "Nodes Unlimited Agent [DDDDDDDDDD@dmg.example].dmg"
        )
        XCTAssertEqual(result?.token, "BBBBBBBBBB")
        XCTAssertEqual(result?.apiHost, "bundle.example")
    }

    func testResolveReturnsNilWhenNothingFound() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let appURL = dir.appendingPathComponent("Nodes Unlimited Installer.app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        XCTAssertNil(FilenameTokenParser.resolve(bundleURL: appURL, dmgFileName: nil))
        XCTAssertNil(FilenameTokenParser.resolve(bundleURL: appURL, dmgFileName: "Nodes Unlimited Agent.dmg"))
    }

    func testAcceptsCustomHostForSelfHosters() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Nodes Unlimited Installer [A7K2XQMN4P@rmm.acme.example].app"
        )
        XCTAssertEqual(result.apiHost, "rmm.acme.example")
    }
}
