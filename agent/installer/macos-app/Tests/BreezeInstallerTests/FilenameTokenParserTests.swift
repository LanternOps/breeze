import XCTest
@testable import BreezeInstaller

final class FilenameTokenParserTests: XCTestCase {
    func testExtractsTokenAndHostFromCanonicalFilename() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQ@us.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "A7K2XQ")
        XCTAssertEqual(result.apiHost, "us.2breeze.app")
    }

    func testHandlesNumericOnlyToken() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [123456@eu.2breeze.app].app"
        )
        XCTAssertEqual(result.token, "123456")
    }

    func testRejectsLowercaseToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [a7k2xq@us.2breeze.app].app"
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
            bundleName: "Breeze Installer [A7K2X@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsTooLongToken() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQ7@us.2breeze.app].app"
        )) { error in
            XCTAssertEqual(error as? FilenameTokenParser.Error, .invalidFormat)
        }
    }

    func testRejectsHostWithSpaces() {
        XCTAssertThrowsError(try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQ@us 2breeze.app].app"
        ))
    }

    func testAcceptsCustomHostForSelfHosters() throws {
        let result = try FilenameTokenParser.parse(
            bundleName: "Breeze Installer [A7K2XQ@rmm.acme.example].app"
        )
        XCTAssertEqual(result.apiHost, "rmm.acme.example")
    }
}
