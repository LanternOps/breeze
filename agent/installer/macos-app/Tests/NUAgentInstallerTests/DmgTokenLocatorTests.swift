import XCTest
@testable import NUAgentInstaller

final class DmgTokenLocatorTests: XCTestCase {
    private func plist(imagePath: String, mountPoint: String) -> Data {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>images</key>
          <array>
            <dict>
              <key>image-path</key>
              <string>\(imagePath)</string>
              <key>system-entities</key>
              <array>
                <dict><key>dev-entry</key><string>/dev/disk4</string></dict>
                <dict>
                  <key>dev-entry</key><string>/dev/disk4s1</string>
                  <key>mount-point</key><string>\(mountPoint)</string>
                </dict>
              </array>
            </dict>
          </array>
        </dict>
        </plist>
        """.data(using: .utf8)!
    }

    func testFindsImagePathForMatchingMountPoint() {
        let data = plist(
            imagePath: "/Users/jane/Downloads/Nodes Unlimited Agent [A7K2XQMN4P@us.2breeze.app].dmg",
            mountPoint: "/Volumes/Nodes Unlimited Agent"
        )
        XCTAssertEqual(
            DmgTokenLocator.imagePath(inHdiutilPlist: data, mountPoint: "/Volumes/Nodes Unlimited Agent"),
            "/Users/jane/Downloads/Nodes Unlimited Agent [A7K2XQMN4P@us.2breeze.app].dmg"
        )
    }

    func testTrailingSlashOnMountPointStillMatches() {
        let data = plist(
            imagePath: "/tmp/x [A7K2XQMN4P@us.2breeze.app].dmg",
            mountPoint: "/Volumes/NU"
        )
        XCTAssertNotNil(DmgTokenLocator.imagePath(inHdiutilPlist: data, mountPoint: "/Volumes/NU/"))
    }

    func testReturnsNilWhenNoMountPointMatches() {
        let data = plist(imagePath: "/tmp/other.dmg", mountPoint: "/Volumes/Something Else")
        XCTAssertNil(DmgTokenLocator.imagePath(inHdiutilPlist: data, mountPoint: "/Volumes/Nodes Unlimited Agent"))
    }

    func testReturnsNilWhenNoImagesMountedNonDmgCase() {
        let data = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>images</key><array/></dict></plist>
        """.data(using: .utf8)!
        XCTAssertNil(DmgTokenLocator.imagePath(inHdiutilPlist: data, mountPoint: "/"))
    }

    func testReturnsNilOnMalformedPlist() {
        XCTAssertNil(DmgTokenLocator.imagePath(inHdiutilPlist: Data("not a plist".utf8), mountPoint: "/"))
        XCTAssertNil(DmgTokenLocator.imagePath(inHdiutilPlist: Data(), mountPoint: "/"))
    }

    func testRootVolumeAppIsNotOnADmg() {
        // The test bundle lives on the boot volume, never on a mounted image.
        XCTAssertNil(DmgTokenLocator.backingDmgFileName(bundleURL: Bundle.main.bundleURL))
    }

    func testVolumeMountPointResolvesForRealPath() {
        XCTAssertNotNil(DmgTokenLocator.volumeMountPoint(for: URL(fileURLWithPath: "/usr/bin")))
    }
}
