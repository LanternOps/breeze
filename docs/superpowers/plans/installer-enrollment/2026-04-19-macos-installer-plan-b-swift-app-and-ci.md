# macOS Installer App — Plan B: Swift Installer App + CI Notarization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the static `Breeze Installer.app` — signed + notarized once per release in CI — and produce a `Breeze Installer.app.zip` GitHub release asset. The app reads a token from its own bundle filename, fetches enrollment values from the Plan A bootstrap endpoint, prompts for admin password via native macOS dialog, installs the embedded PKG, and runs `breeze-agent enroll`.

**Architecture:** Swift Package Manager project (no Xcode project needed) + a build script that assembles the `.app` bundle from the SPM-built executable + Resources + Info.plist. CI job mirrors the existing `build-macos-agent` pattern: codesign with `Developer ID Application`, notarize via `notarytool`, staple, ship as a release asset. Plan A's bootstrap endpoint must be deployed before this app can be smoke-tested end-to-end, but the app itself ships as a static artifact independent of API state.

**Tech Stack:** Swift 5.9+, SwiftUI, AppKit (`NSAppleScript`), Swift Package Manager, `xcodebuild` not required, `codesign` + `xcrun notarytool` + `xcrun stapler`, GitHub Actions on `macos-latest`.

---

## File Structure

**Create (everything new under `agent/installer/macos-app/`):**
- `agent/installer/macos-app/Package.swift` — SPM manifest, executable target
- `agent/installer/macos-app/Sources/BreezeInstaller/main.swift` — entry point
- `agent/installer/macos-app/Sources/BreezeInstaller/FilenameTokenParser.swift` — extracts `[TOKEN@host]` from bundle name
- `agent/installer/macos-app/Sources/BreezeInstaller/BootstrapClient.swift` — HTTP call to `/installer/bootstrap/:token`
- `agent/installer/macos-app/Sources/BreezeInstaller/Architecture.swift` — `uname -m` detection
- `agent/installer/macos-app/Sources/BreezeInstaller/Installer.swift` — AppleScript-driven install runner
- `agent/installer/macos-app/Sources/BreezeInstaller/InstallerApp.swift` — `@main` SwiftUI app + state machine
- `agent/installer/macos-app/Sources/BreezeInstaller/Views/` — `LoadingView`, `ConfirmView`, `InstallingView`, `DoneView`, `ErrorView`
- `agent/installer/macos-app/Tests/BreezeInstallerTests/FilenameTokenParserTests.swift`
- `agent/installer/macos-app/Resources/Info.plist`
- `agent/installer/macos-app/Resources/AppIcon.icns` (placeholder; replace before ship)
- `agent/installer/macos-app/Resources/.gitkeep` for arm64/amd64 PKG slots
- `agent/installer/macos-app/build-app-bundle.sh` — assembles `.app` from SPM build output
- `agent/installer/macos-app/entitlements.plist` — minimal hardened-runtime entitlements
- `agent/installer/macos-app/README.md` — local dev + signing instructions

**Modify:**
- `.github/workflows/release.yml` — add `build-macos-installer-app` job after `build-macos-agent`

---

## Task 1: Swift Package skeleton

**Files:**
- Create: `agent/installer/macos-app/Package.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/main.swift` (placeholder)
- Create: `agent/installer/macos-app/.gitignore`

- [ ] **Step 1: Create `Package.swift`**

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BreezeInstaller",
    platforms: [.macOS(.v11)],
    products: [
        .executable(name: "BreezeInstaller", targets: ["BreezeInstaller"]),
    ],
    targets: [
        .executableTarget(
            name: "BreezeInstaller",
            path: "Sources/BreezeInstaller"
        ),
        .testTarget(
            name: "BreezeInstallerTests",
            dependencies: ["BreezeInstaller"],
            path: "Tests/BreezeInstallerTests"
        ),
    ]
)
```

- [ ] **Step 2: Placeholder entry point**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/main.swift
import Foundation
print("BreezeInstaller stub")
```

- [ ] **Step 3: `.gitignore`**

```
.build/
.swiftpm/
DerivedData/
build/
*.xcodeproj
```

- [ ] **Step 4: Verify it compiles**

```bash
cd agent/installer/macos-app && swift build
```
Expected: builds cleanly, produces `.build/debug/BreezeInstaller`.

- [ ] **Step 5: Commit**

```bash
git add agent/installer/macos-app/
git commit -m "installer-app: SPM skeleton"
```

---

## Task 2: Filename token parser (TDD)

**Files:**
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/FilenameTokenParser.swift`
- Create: `agent/installer/macos-app/Tests/BreezeInstallerTests/FilenameTokenParserTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
// agent/installer/macos-app/Tests/BreezeInstallerTests/FilenameTokenParserTests.swift
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
```

- [ ] **Step 2: Run, verify failure**

```bash
cd agent/installer/macos-app && swift test
```
Expected: build error — `FilenameTokenParser` not defined.

- [ ] **Step 3: Implement**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/FilenameTokenParser.swift
import Foundation

/// Parses the bootstrap token + API host out of the installer app's own
/// bundle filename. Format: `Breeze Installer [TOKEN@host.example].app`
/// where TOKEN is exactly 6 chars of [A-Z0-9] and host matches a relaxed
/// hostname pattern (letters, digits, dots, hyphens).
enum FilenameTokenParser {
    struct Result: Equatable {
        let token: String
        let apiHost: String
    }

    enum Error: Swift.Error, Equatable {
        case invalidFormat
    }

    private static let pattern = #"\[([A-Z0-9]{6})@([a-zA-Z0-9.\-]+)\]"#

    static func parse(bundleName: String) throws -> Result {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: bundleName,
                range: NSRange(bundleName.startIndex..., in: bundleName)
              ),
              match.numberOfRanges == 3,
              let tokenRange = Range(match.range(at: 1), in: bundleName),
              let hostRange = Range(match.range(at: 2), in: bundleName)
        else {
            throw Error.invalidFormat
        }
        return Result(
            token: String(bundleName[tokenRange]),
            apiHost: String(bundleName[hostRange])
        )
    }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd agent/installer/macos-app && swift test
```
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/installer/macos-app/Sources agent/installer/macos-app/Tests
git commit -m "installer-app: filename token parser"
```

---

## Task 3: Bootstrap HTTP client

**Files:**
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/BootstrapClient.swift`

No tests — testing real HTTP calls in CI requires a mock server, which is overkill for an internal tool. Smoke-tested manually against the live API in Task 9.

- [ ] **Step 1: Implement**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/BootstrapClient.swift
import Foundation

/// Fetches the enrollment payload from the Plan A bootstrap endpoint.
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
        case decoding(underlying: Swift.Error)

        var errorDescription: String? {
            switch self {
            case .network(let e):
                return "Network error: \(e.localizedDescription)"
            case .http(let status, _) where status == 404:
                return "This installer link has expired or already been used. Please re-download from your Breeze web console."
            case .http(let status, let body):
                return "Server error (\(status)): \(body.prefix(200))"
            case .decoding:
                return "Server returned an unexpected response. Please re-download the installer."
            }
        }
    }

    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetch(token: String, apiHost: String) async throws -> Payload {
        guard let url = URL(string: "https://\(apiHost)/api/v1/installer/bootstrap/\(token)") else {
            throw Error.http(status: 0, body: "constructed URL is invalid")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 30
        req.setValue("BreezeInstaller/1.0", forHTTPHeaderField: "User-Agent")

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw Error.network(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Error.http(status: 0, body: "non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw Error.http(status: http.statusCode, body: body)
        }
        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw Error.decoding(underlying: error)
        }
    }
}
```

- [ ] **Step 2: Verify build**

```bash
cd agent/installer/macos-app && swift build
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add agent/installer/macos-app/Sources/BreezeInstaller/BootstrapClient.swift
git commit -m "installer-app: bootstrap HTTP client"
```

---

## Task 4: Architecture detection

**Files:**
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Architecture.swift`
- Modify: `agent/installer/macos-app/Tests/BreezeInstallerTests/FilenameTokenParserTests.swift` (no — separate test file)
- Create: `agent/installer/macos-app/Tests/BreezeInstallerTests/ArchitectureTests.swift`

- [ ] **Step 1: Write test**

```swift
// agent/installer/macos-app/Tests/BreezeInstallerTests/ArchitectureTests.swift
import XCTest
@testable import BreezeInstaller

final class ArchitectureTests: XCTestCase {
    func testMapsArm64() {
        XCTAssertEqual(Architecture.fromUname("arm64\n"), .arm64)
        XCTAssertEqual(Architecture.fromUname("arm64"), .arm64)
    }

    func testMapsAmd64() {
        XCTAssertEqual(Architecture.fromUname("x86_64\n"), .amd64)
        XCTAssertEqual(Architecture.fromUname("x86_64"), .amd64)
    }

    func testRejectsUnknown() {
        XCTAssertNil(Architecture.fromUname("ppc"))
        XCTAssertNil(Architecture.fromUname(""))
    }

    func testPickPkgFilenames() {
        XCTAssertEqual(Architecture.arm64.pkgResourceName, "breeze-agent-arm64.pkg")
        XCTAssertEqual(Architecture.amd64.pkgResourceName, "breeze-agent-amd64.pkg")
    }
}
```

- [ ] **Step 2: Run, verify failure**

```bash
cd agent/installer/macos-app && swift test
```
Expected: build error — `Architecture` not defined.

- [ ] **Step 3: Implement**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Architecture.swift
import Foundation

enum Architecture: String {
    case arm64
    case amd64

    var pkgResourceName: String {
        switch self {
        case .arm64: return "breeze-agent-arm64.pkg"
        case .amd64: return "breeze-agent-amd64.pkg"
        }
    }

    /// Parses `uname -m` output. Returns nil for anything we don't ship a PKG for.
    static func fromUname(_ output: String) -> Architecture? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed {
        case "arm64": return .arm64
        case "x86_64": return .amd64
        default: return nil
        }
    }

    /// Detects the running host's architecture by invoking `/usr/bin/uname -m`.
    static func current() -> Architecture? {
        let task = Process()
        task.launchPath = "/usr/bin/uname"
        task.arguments = ["-m"]
        let pipe = Pipe()
        task.standardOutput = pipe
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return fromUname(output)
    }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd agent/installer/macos-app && swift test
```
Expected: all tests (parser + arch) pass.

- [ ] **Step 5: Commit**

```bash
git add agent/installer/macos-app/Sources/BreezeInstaller/Architecture.swift agent/installer/macos-app/Tests/BreezeInstallerTests/ArchitectureTests.swift
git commit -m "installer-app: architecture detection"
```

---

## Task 5: Install runner via AppleScript

**Files:**
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Installer.swift`

No unit test — `NSAppleScript` invocations are side-effecting and would require a real admin-password prompt, which we cannot script in CI. Smoke-tested manually in Task 9.

- [ ] **Step 1: Implement**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Installer.swift
import Foundation
import AppKit

/// Runs `installer -pkg` and `breeze-agent enroll` as root via the native
/// macOS admin-password dialog. Uses `NSAppleScript` because it is the
/// supported way to trigger the system auth prompt for a one-shot
/// administrator command — `AuthorizationExecuteWithPrivileges` is
/// deprecated and SMJobBless is overkill for this scope.
struct Installer {
    enum Error: Swift.Error, LocalizedError {
        case appleScriptFailed(message: String, code: Int)
        case scriptCreationFailed

        var errorDescription: String? {
            switch self {
            case .scriptCreationFailed:
                return "Could not construct installer script"
            case .appleScriptFailed(let message, let code) where code == -128:
                return "Administrator authentication was cancelled"
            case .appleScriptFailed(let message, let code):
                return "Install failed (\(code)): \(message)"
            }
        }
    }

    /// Escapes a single value for safe interpolation inside an AppleScript
    /// `do shell script` POSIX string. Wraps in single quotes and escapes
    /// any embedded single quotes by closing/escaping/reopening.
    static func shellEscape(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    func run(
        pkgPath: String,
        serverUrl: String,
        enrollmentKey: String,
        enrollmentSecret: String?,
        siteId: String?
    ) throws {
        var enrollArgs = [
            shellEscape(enrollmentKey),
            "--server", shellEscape(serverUrl),
            "--quiet",
        ]
        if let secret = enrollmentSecret, !secret.isEmpty {
            enrollArgs += ["--enrollment-secret", Installer.shellEscape(secret)]
        }
        if let site = siteId, !site.isEmpty {
            enrollArgs += ["--site-id", Installer.shellEscape(site)]
        }
        let enrollCmd = enrollArgs.joined(separator: " ")

        let script = """
        do shell script "/usr/sbin/installer -pkg \(Installer.shellEscape(pkgPath)) -target / && /usr/local/bin/breeze-agent enroll \(enrollCmd)" with administrator privileges
        """

        guard let appleScript = NSAppleScript(source: script) else {
            throw Error.scriptCreationFailed
        }
        var errorDict: NSDictionary?
        appleScript.executeAndReturnError(&errorDict)
        if let err = errorDict {
            let message = err[NSAppleScript.errorMessage] as? String ?? "unknown"
            let code = err[NSAppleScript.errorNumber] as? Int ?? -1
            throw Error.appleScriptFailed(message: message, code: code)
        }
    }
}
```

- [ ] **Step 2: Verify build**

```bash
cd agent/installer/macos-app && swift build
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add agent/installer/macos-app/Sources/BreezeInstaller/Installer.swift
git commit -m "installer-app: AppleScript-driven install runner"
```

---

## Task 6: SwiftUI app + state machine

**Files:**
- Replace: `agent/installer/macos-app/Sources/BreezeInstaller/main.swift` (delete or convert to `@main`)
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/InstallerApp.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Views/LoadingView.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Views/ConfirmView.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Views/InstallingView.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Views/DoneView.swift`
- Create: `agent/installer/macos-app/Sources/BreezeInstaller/Views/ErrorView.swift`

- [ ] **Step 1: Delete the placeholder `main.swift`**

```bash
rm agent/installer/macos-app/Sources/BreezeInstaller/main.swift
```

- [ ] **Step 2: Create `InstallerApp.swift` (entry point + state machine)**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/InstallerApp.swift
import SwiftUI

enum InstallState {
    case loading
    case confirm(payload: BootstrapClient.Payload)
    case installing
    case done(orgName: String)
    case error(message: String, recoverable: Bool)
}

@MainActor
final class InstallController: ObservableObject {
    @Published var state: InstallState = .loading

    private var token: String?
    private var apiHost: String?
    private var payload: BootstrapClient.Payload?

    func start() {
        Task { await self.bootstrap() }
    }

    private func bootstrap() async {
        let bundleName = Bundle.main.bundleURL.lastPathComponent
        let parsed: FilenameTokenParser.Result
        do {
            parsed = try FilenameTokenParser.parse(bundleName: bundleName)
        } catch {
            state = .error(
                message: "This installer needs its original filename. Please re-download from your Breeze web console.",
                recoverable: false
            )
            return
        }
        token = parsed.token
        apiHost = parsed.apiHost

        let client = BootstrapClient()
        do {
            let p = try await client.fetch(token: parsed.token, apiHost: parsed.apiHost)
            payload = p
            state = .confirm(payload: p)
        } catch let err as BootstrapClient.Error {
            state = .error(message: err.errorDescription ?? "Unknown error", recoverable: true)
        } catch {
            state = .error(message: error.localizedDescription, recoverable: true)
        }
    }

    func confirmInstall() {
        guard let payload else { return }
        state = .installing
        Task { await self.runInstall(payload: payload) }
    }

    func retry() {
        state = .loading
        start()
    }

    private func runInstall(payload: BootstrapClient.Payload) async {
        guard let arch = Architecture.current() else {
            state = .error(message: "Unsupported CPU architecture", recoverable: false)
            return
        }
        guard let resourcesURL = Bundle.main.resourceURL else {
            state = .error(message: "Could not locate installer resources", recoverable: false)
            return
        }
        let pkgURL = resourcesURL.appendingPathComponent(arch.pkgResourceName)
        guard FileManager.default.fileExists(atPath: pkgURL.path) else {
            state = .error(message: "Bundled installer is missing \(arch.pkgResourceName). Please re-download.", recoverable: false)
            return
        }

        do {
            try Installer().run(
                pkgPath: pkgURL.path,
                serverUrl: payload.serverUrl,
                enrollmentKey: payload.enrollmentKey,
                enrollmentSecret: payload.enrollmentSecret,
                siteId: payload.siteId
            )
            state = .done(orgName: payload.orgName)
        } catch let err as Installer.Error {
            state = .error(message: err.errorDescription ?? "Install failed", recoverable: true)
        } catch {
            state = .error(message: error.localizedDescription, recoverable: true)
        }
    }
}

@main
struct BreezeInstallerApp: App {
    @StateObject private var controller = InstallController()

    var body: some Scene {
        WindowGroup("Breeze Installer") {
            RootView(controller: controller)
                .frame(width: 480, height: 320)
                .onAppear { controller.start() }
        }
        .windowResizability(.contentSize)
    }
}

struct RootView: View {
    @ObservedObject var controller: InstallController

    var body: some View {
        Group {
            switch controller.state {
            case .loading:
                LoadingView()
            case .confirm(let payload):
                ConfirmView(payload: payload, onInstall: controller.confirmInstall)
            case .installing:
                InstallingView()
            case .done(let orgName):
                DoneView(orgName: orgName)
            case .error(let message, let recoverable):
                ErrorView(message: message, recoverable: recoverable, onRetry: controller.retry)
            }
        }
        .padding(24)
    }
}
```

- [ ] **Step 3: Create `LoadingView.swift`**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Views/LoadingView.swift
import SwiftUI

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Preparing installer…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 4: Create `ConfirmView.swift`**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Views/ConfirmView.swift
import SwiftUI

struct ConfirmView: View {
    let payload: BootstrapClient.Payload
    let onInstall: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Install Breeze Agent")
                .font(.title2).bold()
            Text("This will install the Breeze monitoring agent for **\(payload.orgName)**. You will be prompted for your administrator password.")
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            HStack {
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut(.cancelAction)
                Button("Install") { onInstall() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 5: Create `InstallingView.swift`**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Views/InstallingView.swift
import SwiftUI

struct InstallingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Installing Breeze Agent…")
                .font(.headline)
            Text("This usually takes about 10 seconds.")
                .foregroundStyle(.secondary)
                .font(.subheadline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 6: Create `DoneView.swift`**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Views/DoneView.swift
import SwiftUI

struct DoneView: View {
    let orgName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
            Text("Breeze Agent installed")
                .font(.title2).bold()
            Text("Your Mac is now monitored under **\(orgName)**.")
            Spacer()
            HStack {
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 7: Create `ErrorView.swift`**

```swift
// agent/installer/macos-app/Sources/BreezeInstaller/Views/ErrorView.swift
import SwiftUI

struct ErrorView: View {
    let message: String
    let recoverable: Bool
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.orange)
            Text("Install could not continue")
                .font(.title3).bold()
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            HStack {
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut(.cancelAction)
                if recoverable {
                    Button("Try again") { onRetry() }
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 8: Build**

```bash
cd agent/installer/macos-app && swift build
```
Expected: clean build. (May warn about `@main` + `main.swift` if the placeholder wasn't deleted — fix.)

- [ ] **Step 9: Run all tests**

```bash
cd agent/installer/macos-app && swift test
```
Expected: 12 tests pass (8 parser + 4 arch).

- [ ] **Step 10: Commit**

```bash
git add agent/installer/macos-app/
git commit -m "installer-app: SwiftUI views + state machine"
```

---

## Task 7: `Info.plist` and entitlements

**Files:**
- Create: `agent/installer/macos-app/Resources/Info.plist`
- Create: `agent/installer/macos-app/entitlements.plist`

- [ ] **Step 1: `Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>BreezeInstaller</string>
    <key>CFBundleIdentifier</key>
    <string>com.breeze.installer</string>
    <key>CFBundleName</key>
    <string>Breeze Installer</string>
    <key>CFBundleDisplayName</key>
    <string>Breeze Installer</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2026 Olive Technologies LLC.</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
```

- [ ] **Step 2: `entitlements.plist` (minimal hardened-runtime)**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <false/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <false/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <false/>
</dict>
</plist>
```

(No sandbox entitlement — installer needs to invoke `/usr/sbin/installer` as root via AppleScript, which the sandbox would block. Hardened runtime is required for notarization.)

- [ ] **Step 3: Commit**

```bash
git add agent/installer/macos-app/Resources/Info.plist agent/installer/macos-app/entitlements.plist
git commit -m "installer-app: Info.plist + entitlements"
```

---

## Task 8: Build script — assemble `.app` bundle from SPM output

**Files:**
- Create: `agent/installer/macos-app/build-app-bundle.sh`

The script takes the SPM-built executable + Resources + Info.plist and assembles a proper macOS `.app` bundle that Gatekeeper recognizes. Universal binary (arm64 + x86_64) so a single app runs on all Macs.

- [ ] **Step 1: Implement**

```bash
#!/usr/bin/env bash
# agent/installer/macos-app/build-app-bundle.sh
#
# Assembles Breeze Installer.app from the SPM-built executable.
# Produces a universal (arm64 + x86_64) .app bundle.
#
# Usage:
#   ./build-app-bundle.sh \
#     --pkg-amd64 /path/to/breeze-agent-darwin-amd64.pkg \
#     --pkg-arm64 /path/to/breeze-agent-darwin-arm64.pkg \
#     --output    /path/to/output/Breeze\ Installer.app
#
# Requires Swift 5.9+, macOS 11+ build host.
set -euo pipefail

PKG_AMD64=""
PKG_ARM64=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pkg-amd64) PKG_AMD64="$2"; shift 2 ;;
        --pkg-arm64) PKG_ARM64="$2"; shift 2 ;;
        --output)    OUTPUT="$2";    shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$PKG_AMD64" || -z "$PKG_ARM64" || -z "$OUTPUT" ]]; then
    echo "Usage: $0 --pkg-amd64 PATH --pkg-arm64 PATH --output PATH" >&2
    exit 1
fi
for f in "$PKG_AMD64" "$PKG_ARM64"; do
    [[ -f "$f" ]] || { echo "Missing PKG: $f" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "→ Building universal binary…"
swift build -c release --arch arm64
swift build -c release --arch x86_64
ARM_BIN=".build/arm64-apple-macosx/release/BreezeInstaller"
X86_BIN=".build/x86_64-apple-macosx/release/BreezeInstaller"
[[ -f "$ARM_BIN" && -f "$X86_BIN" ]] || { echo "SPM build did not produce expected binaries" >&2; exit 1; }

UNIVERSAL_BIN="$(mktemp -d)/BreezeInstaller"
lipo -create "$ARM_BIN" "$X86_BIN" -output "$UNIVERSAL_BIN"
file "$UNIVERSAL_BIN"

echo "→ Assembling .app bundle at $OUTPUT…"
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/Contents/MacOS"
mkdir -p "$OUTPUT/Contents/Resources"

cp "$UNIVERSAL_BIN" "$OUTPUT/Contents/MacOS/BreezeInstaller"
chmod 755 "$OUTPUT/Contents/MacOS/BreezeInstaller"

cp Resources/Info.plist "$OUTPUT/Contents/Info.plist"
if [[ -f Resources/AppIcon.icns ]]; then
    cp Resources/AppIcon.icns "$OUTPUT/Contents/Resources/AppIcon.icns"
fi

cp "$PKG_AMD64" "$OUTPUT/Contents/Resources/breeze-agent-amd64.pkg"
cp "$PKG_ARM64" "$OUTPUT/Contents/Resources/breeze-agent-arm64.pkg"

echo "→ .app bundle assembled:"
ls -la "$OUTPUT/Contents/"
echo "✓ Done. Sign + notarize with the CI workflow or manually:"
echo "    codesign --force --options runtime --entitlements entitlements.plist \\"
echo "      --sign \"Developer ID Application: …\" --timestamp \"$OUTPUT\""
```

- [ ] **Step 2: Make executable + smoke-test locally**

```bash
chmod +x agent/installer/macos-app/build-app-bundle.sh

# Create dummy PKGs for the local smoke
mkdir -p /tmp/breeze-installer-smoke
echo "fake" > /tmp/breeze-installer-smoke/amd64.pkg
echo "fake" > /tmp/breeze-installer-smoke/arm64.pkg

agent/installer/macos-app/build-app-bundle.sh \
  --pkg-amd64 /tmp/breeze-installer-smoke/amd64.pkg \
  --pkg-arm64 /tmp/breeze-installer-smoke/arm64.pkg \
  --output /tmp/breeze-installer-smoke/Breeze\ Installer.app
```
Expected: bundle is created with the universal binary in `Contents/MacOS/`, both fake PKGs in `Contents/Resources/`, Info.plist in place. `file Contents/MacOS/BreezeInstaller` shows "Mach-O universal binary with 2 architectures".

- [ ] **Step 3: Test launch (will fail bootstrap but should show error UI)**

```bash
mv "/tmp/breeze-installer-smoke/Breeze Installer.app" "/tmp/breeze-installer-smoke/Breeze Installer [A7K2XQ@nonexistent.example].app"
open "/tmp/breeze-installer-smoke/Breeze Installer [A7K2XQ@nonexistent.example].app"
```
Expected: window opens, parser succeeds, network fetch fails, shows ErrorView with "Network error: …" and a Try again button.

- [ ] **Step 4: Commit**

```bash
git add agent/installer/macos-app/build-app-bundle.sh
git commit -m "installer-app: build script for .app bundle assembly"
```

---

## Task 9: Local sign + notarize + staple test

This is a manual verification step using the developer's own Apple Developer ID credentials. No CI involved yet — proves the assembled `.app` is notarizable before wiring CI.

**Files:** none (manual)

- [ ] **Step 1: Build a real .app with real PKGs**

Use the latest signed PKGs from a recent release (download from GitHub or build locally):

```bash
agent/installer/macos-app/build-app-bundle.sh \
  --pkg-amd64 ~/Downloads/breeze-agent-darwin-amd64.pkg \
  --pkg-arm64 ~/Downloads/breeze-agent-darwin-arm64.pkg \
  --output "/tmp/Breeze Installer.app"
```

- [ ] **Step 2: Sign**

```bash
SIGNING_IDENTITY="Developer ID Application: Olive Technologies LLC (TEAMID)"
codesign --force --options runtime \
  --entitlements agent/installer/macos-app/entitlements.plist \
  --sign "$SIGNING_IDENTITY" --timestamp \
  --deep "/tmp/Breeze Installer.app"
codesign --verify --verbose=2 "/tmp/Breeze Installer.app"
```
Expected: `valid on disk` + `satisfies its Designated Requirement`.

- [ ] **Step 3: Notarize**

```bash
ditto -c -k --keepParent "/tmp/Breeze Installer.app" "/tmp/installer-notarize.zip"
xcrun notarytool submit "/tmp/installer-notarize.zip" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 30m
```
Expected: status `Accepted` after 30s–3min.

- [ ] **Step 4: Staple**

```bash
xcrun stapler staple "/tmp/Breeze Installer.app"
xcrun stapler validate "/tmp/Breeze Installer.app"
```
Expected: `The validate action worked!`.

- [ ] **Step 5: Verify Gatekeeper acceptance**

```bash
spctl -a -t exec -vv "/tmp/Breeze Installer.app"
```
Expected: `accepted` + `source=Notarized Developer ID`.

- [ ] **Step 6: Rename + launch**

```bash
mv "/tmp/Breeze Installer.app" "/tmp/Breeze Installer [A7K2XQ@us.2breeze.app].app"
open "/tmp/Breeze Installer [A7K2XQ@us.2breeze.app].app"
```
Expected: window appears, attempts to fetch bootstrap (will 404 against real API since the token is fake), shows ErrorView. **Critically:** no Gatekeeper warning, no "unidentified developer" prompt — proves the rename does not invalidate the signature/staple.

If you want to test the happy path: issue a real token via the Plan A endpoints first, use that token in the rename, and run with the actual API.

No commit — verification only.

---

## Task 10: CI workflow — `build-macos-installer-app` job

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the job**

Insert after the existing `build-macos-agent` job (around line 770), and before `build-viewer`:

```yaml
  build-macos-installer-app:
    name: Build macOS Installer App
    needs: [build-macos-agent]
    runs-on: macos-latest
    if: vars.ENABLE_MACOS_SIGNING == 'true'
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Download .pkg darwin/amd64
        uses: actions/download-artifact@v7
        with:
          name: breeze-agent-darwin-amd64-pkg
          path: installer-pkgs/
      - name: Download .pkg darwin/arm64
        uses: actions/download-artifact@v7
        with:
          name: breeze-agent-darwin-arm64-pkg
          path: installer-pkgs/

      - name: Setup signing keychain
        env:
          APPLE_CERTIFICATE_BASE64: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          # Reuse the existing keychain setup pattern from build-macos-agent.
          # If that job already runs in the same job graph, the keychain may
          # not survive across jobs — we set it up fresh here.
          KEYCHAIN_PATH="$RUNNER_TEMP/signing.keychain-db"
          KEYCHAIN_PASSWORD=$(openssl rand -base64 32)
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          echo "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/cert.p12"
          security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN_PATH" \
            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security list-keychains -d user -s "$KEYCHAIN_PATH" $(security list-keychains -d user | tr -d '"')
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

      - name: Build .app bundle
        run: |
          chmod +x agent/installer/macos-app/build-app-bundle.sh
          agent/installer/macos-app/build-app-bundle.sh \
            --pkg-amd64 installer-pkgs/breeze-agent-darwin-amd64.pkg \
            --pkg-arm64 installer-pkgs/breeze-agent-darwin-arm64.pkg \
            --output "build/Breeze Installer.app"

      - name: Sign .app
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        run: |
          codesign --force --options runtime \
            --entitlements agent/installer/macos-app/entitlements.plist \
            --sign "$APPLE_SIGNING_IDENTITY" --timestamp \
            --deep "build/Breeze Installer.app"
          codesign --verify --verbose=2 "build/Breeze Installer.app"

      - name: Notarize + staple
        env:
          APPLE_ID:       ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID:  ${{ secrets.APPLE_TEAM_ID }}
        run: |
          ditto -c -k --keepParent "build/Breeze Installer.app" build/installer-notarize.zip
          xcrun notarytool submit build/installer-notarize.zip \
            --apple-id "$APPLE_ID" \
            --password "$APPLE_PASSWORD" \
            --team-id "$APPLE_TEAM_ID" \
            --wait --timeout 30m
          xcrun stapler staple "build/Breeze Installer.app"
          xcrun stapler validate "build/Breeze Installer.app"
          spctl -a -t exec -vv "build/Breeze Installer.app"

      - name: Package for release
        run: |
          ditto -c -k --sequesterRsrc --keepParent \
            "build/Breeze Installer.app" \
            "build/Breeze Installer.app.zip"
          ls -lh build/

      - name: Upload artifact
        uses: actions/upload-artifact@v7
        with:
          name: breeze-installer-app
          path: build/Breeze Installer.app.zip
          retention-days: 30

      - name: Cleanup keychain
        if: always()
        run: security delete-keychain "$RUNNER_TEMP/signing.keychain-db" || true
```

- [ ] **Step 2: Wire into release-asset upload**

Find the existing release-asset upload step (`actions/upload-release-asset` or `softprops/action-gh-release` near the bottom of `release.yml`) and add `Breeze Installer.app.zip` to its file list. Pattern:

```yaml
      - name: Download installer-app artifact
        uses: actions/download-artifact@v7
        with:
          name: breeze-installer-app
          path: release-assets/

      # Then in the release-create step, add release-assets/Breeze Installer.app.zip to the files list.
```

(Exact wiring depends on the existing `release` job at the bottom of `release.yml` — match its convention.)

- [ ] **Step 3: Validate workflow YAML**

```bash
gh workflow view release.yml 2>&1 | head -5  # smoke-checks the YAML parses
# Or use actionlint if installed:
actionlint .github/workflows/release.yml
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build, sign, notarize Breeze Installer.app"
```

- [ ] **Step 5: Test on a release tag (optional, blocking)**

The CI job only runs when `vars.ENABLE_MACOS_SIGNING == 'true'`. Either:
- (a) Push a test tag to trigger the full release pipeline and confirm `breeze-installer-app` artifact appears.
- (b) Manually run the job via `gh workflow run release.yml -f ref=refs/heads/feature/...` if the workflow supports it.
- (c) Defer validation to the first real release that includes this PR.

Recommendation: **(c)** — minimize risk of accidentally publishing a release. The first real release after merge will validate end-to-end.

---

## Self-Review Notes

- **Spec coverage:** Plan B delivers Spec §"Components #1 — Swift installer app" (filename parser, bootstrap fetcher, AppleScript installer, SwiftUI views) and §"Components #4 — CI" (build, sign, notarize, staple, upload). Spec §"Components #2 — API" is Plan A. Spec §"Components #5 — installer builder service" + the route flip is Plan C.
- **No placeholders:** all Swift code, Info.plist, entitlements, build script, and CI YAML are concrete.
- **Type consistency:** `BootstrapClient.Payload`, `Architecture`, `Installer`, `FilenameTokenParser.Result`, `InstallController`, `InstallState` — all defined where first used and referenced consistently downstream. The state machine cases match between `InstallState` enum and `RootView` switch.
- **One known unknown:** the existing `build-macos-agent` job's exact keychain setup pattern. Plan B's CI step recreates the keychain rather than depending on artifact-passed state — slightly more work per release but isolates failures. If during execution the existing keychain pattern is materially different, mirror it instead.
- **One deferred polish:** `Resources/AppIcon.icns` is referenced in Info.plist + build script but not generated here. The build script already handles its absence (skips the copy). Add a real icon as a Plan B followup.

---

## Plan B Followups (not in this plan)

- Real `AppIcon.icns` (e.g. via `iconutil` from a square PNG; one-time design work).
- Localized strings (`en.lproj/Localizable.strings`) so non-English users see translated UI.
- In-app update check (compare `CFBundleShortVersionString` against latest GitHub release; offer "Get latest installer").
- Installer telemetry (HTTP POST to `/api/v1/installer/events` with `install.start`/`install.success`/`install.fail` — needs a corresponding API route).
- Self-hoster doc: how to rebuild and re-sign the installer app with a custom Developer ID.
