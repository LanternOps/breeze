import XCTest
@testable import BreezeInstaller

final class InstallerShellEscapeTests: XCTestCase {
    func testSimpleString() {
        XCTAssertEqual(Installer.shellEscape("hello"), "'hello'")
    }

    func testEmptyString() {
        XCTAssertEqual(Installer.shellEscape(""), "''")
    }

    func testStringWithSpaces() {
        XCTAssertEqual(Installer.shellEscape("hello world"), "'hello world'")
    }

    func testStringWithSingleQuote() {
        // Classic POSIX single-quote escape: close quote, escaped quote, reopen quote
        XCTAssertEqual(Installer.shellEscape("it's"), "'it'\\''s'")
    }

    func testStringWithMultipleSingleQuotes() {
        XCTAssertEqual(Installer.shellEscape("'a' 'b'"), "''\\''a'\\'' '\\''b'\\'''")
    }

    func testStringWithDollarSignAndBacktick() {
        // Inside single quotes these are literal; no escaping required
        XCTAssertEqual(Installer.shellEscape("$USER `whoami`"), "'$USER `whoami`'")
    }
}
