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

    // #8778: enroll with the binary the .pkg installed, never a hard-coded
    // /usr/local/bin/breeze-agent.
    func testPrivilegedCommandResolvesTheInstalledAgent() {
        let cmd = Installer.privilegedCommand(pkgPath: "/tmp/a b.pkg", enrollArgs: "'KEY' --server 'https://x'")
        XCTAssertEqual(
            cmd,
            "/usr/sbin/installer -pkg '/tmp/a b.pkg' -target / && "
                + "if [ -f /Library/Breeze/bin/breeze-agent ] && [ ! -L /Library/Breeze/bin/breeze-agent ] && [ -x /Library/Breeze/bin/breeze-agent ]; "
                + "then B=/Library/Breeze/bin/breeze-agent; else B=/usr/local/bin/breeze-agent; fi && \"$B\" enroll 'KEY' --server 'https://x'"
        )
        XCTAssertFalse(cmd.contains("&& /usr/local/bin/breeze-agent enroll"))
    }
}
