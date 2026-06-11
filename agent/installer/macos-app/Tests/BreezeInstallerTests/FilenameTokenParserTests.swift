import XCTest
@testable import BreezeInstaller

final class FilenameTokenParserTests: XCTestCase {
    func testLoadsTokenAndHostFromSiblingPayloadFile() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let appURL = dir.appendingPathComponent("Breeze Installer.app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)
        let payloadURL = dir.appendingPathComponent("Breeze Installer.bootstrap.json")
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

        let appURL = dir.appendingPathComponent("Breeze Installer [A7K2XQMN4P@us.2breeze.app].app")
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        let result = try FilenameTokenParser.load(bundleURL: appURL)
        XCTAssertEqual(result.token, "A7K2XQMN4P")
        XCTAssertEqual(result.apiHost, "us.2breeze.app")
    }

    func testExtractsTokenAndHostFromCanonicalFilename() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQMN4P@us.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "A7K2XQMN4P")
        XCTAssertEqual(result.apiHost, "us.2breeze.app")
    }

    func testHandlesNumericOnlyToken() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [1234567890@eu.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "1234567890")
    }

    func testRejectsLowercaseToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [a7k2xqmn4p@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsMissingBracket() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer.app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsTooShortToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQMN4@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsTooLongToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQMN4PZ@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsHostWithSpaces() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQMN4P@us 2breeze.app].app"
        ))
    }

    func testAcceptsCustomHostForSelfHosters() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQMN4P@rmm.acme.example].app"
        )
        XCTAssertEqual(result.apiHost, "rmm.acme.example")
    }
}
