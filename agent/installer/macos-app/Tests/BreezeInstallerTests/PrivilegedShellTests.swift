import XCTest
@testable import BreezeInstaller

final class PrivilegedShellTests: XCTestCase {
    private let marker = "__BREEZE_INSTALLER_EXIT_STATUS__"

    func testParseExitStatusSuccessReturnsCleanedOutput() throws {
        let raw = """
        installer: Package name is breeze-agent
        installer: Installation finished
        \(marker)0
        """
        let cleaned = try PrivilegedShell.parseExitStatus(rawOutput: raw)
        XCTAssertEqual(cleaned, "installer: Package name is breeze-agent\ninstaller: Installation finished")
    }

    func testParseExitStatusNonZeroThrowsCommandFailedWithCode() {
        let raw = """
        installer: Error - couldn't open archive
        \(marker)42
        """
        XCTAssertThrowsError(try PrivilegedShell.parseExitStatus(rawOutput: raw)) { error in
            guard case PrivilegedShellError.commandFailed(let code, let output) = error else {
                return XCTFail("expected .commandFailed, got \(error)")
            }
            XCTAssertEqual(code, 42)
            XCTAssertTrue(output.contains("couldn't open archive"))
            XCTAssertFalse(output.contains(marker))
        }
    }

    func testParseExitStatusMissingMarkerThrowsMissingExitStatus() {
        let raw = "installer: started\ninstaller: stopped\n"
        XCTAssertThrowsError(try PrivilegedShell.parseExitStatus(rawOutput: raw)) { error in
            guard case PrivilegedShellError.missingExitStatus = error else {
                return XCTFail("expected .missingExitStatus, got \(error)")
            }
        }
    }

    func testParseExitStatusOnlyConsidersFinalMarker() throws {
        // Earlier matching lines must be ignored — only the final marker decides
        // success/failure. This guards against subcommands accidentally echoing
        // the same prefix in their own output.
        let raw = """
        \(marker)1
        recovered, retrying
        \(marker)0
        """
        let cleaned = try PrivilegedShell.parseExitStatus(rawOutput: raw)
        XCTAssertEqual(cleaned, "recovered, retrying")
    }

    func testParseExitStatusGarbageCodeMapsToMinusOne() {
        let raw = "installer: weird\n\(marker)not-a-number"
        XCTAssertThrowsError(try PrivilegedShell.parseExitStatus(rawOutput: raw)) { error in
            guard case PrivilegedShellError.commandFailed(let code, _) = error else {
                return XCTFail("expected .commandFailed, got \(error)")
            }
            XCTAssertEqual(code, -1)
        }
    }
}
