import XCTest
@testable import NUAgentInstaller

final class TokenEntryModelTests: XCTestCase {
    func testDisabledWhenTokenInvalid() {
        XCTAssertFalse(TokenEntryModel(token: "SHORT", accepted: true).canProceed)
        XCTAssertFalse(TokenEntryModel(token: "A7K2XQMN4PZ", accepted: true).canProceed)
        XCTAssertFalse(TokenEntryModel(token: "A7K2-QMN4P", accepted: true).canProceed)
    }

    func testDisabledWhenBoxUnticked() {
        XCTAssertFalse(TokenEntryModel(token: "A7K2XQMN4P", accepted: false).canProceed)
    }

    func testDisabledWhenBothBad() {
        XCTAssertFalse(TokenEntryModel().canProceed)
    }

    func testEnabledOnlyWhenBothGood() {
        XCTAssertTrue(TokenEntryModel(token: "A7K2XQMN4P", accepted: true).canProceed)
        XCTAssertTrue(TokenEntryModel(token: "1234567890", accepted: true).canProceed)
    }

    func testLowercaseInputIsUppercased() {
        var model = TokenEntryModel(token: "a7k2xqmn4p")
        XCTAssertEqual(model.token, "A7K2XQMN4P")
        XCTAssertTrue(model.isTokenValid)

        model.token = "zzzz111111"
        XCTAssertEqual(model.token, "ZZZZ111111")
        XCTAssertTrue(model.isTokenValid)
    }

    func testEmptyFieldShowsNoHint() {
        XCTAssertFalse(TokenEntryModel().shouldShowHint)
        XCTAssertTrue(TokenEntryModel(token: "ABC").shouldShowHint)
        XCTAssertFalse(TokenEntryModel(token: "A7K2XQMN4P").shouldShowHint)
    }
}
