// agent/installer/macos-app/Sources/NUAgentInstaller/InstallerApp.swift
import SwiftUI

enum InstallState {
    case loading
    case moveToApplications
    case tokenEntry(prefill: String?, apiHost: String?)
    case confirm(payload: BootstrapClient.Payload)
    case installing
    case permissions(orgName: String)
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
        // Running straight off the read-only DMG (or from Downloads)? Offer to
        // move into /Applications first, so the drag step is effectively the
        // trigger and Gatekeeper app-translocation is avoided.
        let path = Bundle.main.bundleURL.path
        if !path.hasPrefix("/Applications/") {
            state = .moveToApplications
            return
        }
        Task { await self.bootstrap() }
    }

    func moveToApplicationsAndRelaunch() {
        let fm = FileManager.default
        let src = Bundle.main.bundleURL
        let dst = URL(fileURLWithPath: "/Applications").appendingPathComponent(src.lastPathComponent)
        do {
            if fm.fileExists(atPath: dst.path) {
                try fm.removeItem(at: dst)
            }
            try fm.copyItem(at: src, to: dst)
            let config = NSWorkspace.OpenConfiguration()
            config.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: dst, configuration: config) { _, _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        } catch {
            state = .error(
                message: "Couldn't copy to Applications (\(error.localizedDescription)). Please drag the installer into the Applications folder manually, then open it from there.",
                recoverable: false
            )
        }
    }

    func continueWithoutMoving() {
        // This is a managed corporate device. Even if the user declines the
        // explicit move, relocate the app into /Applications best-effort (silent)
        // so it lands in the managed location, then proceed with the install.
        let fm = FileManager.default
        let src = Bundle.main.bundleURL
        if !src.path.hasPrefix("/Applications/") {
            let dst = URL(fileURLWithPath: "/Applications").appendingPathComponent(src.lastPathComponent)
            // Only attempt a copy off the DMG/read-only volume; ignore failures.
            try? fm.removeItem(at: dst)
            try? fm.copyItem(at: src, to: dst)
        }
        Task { await self.bootstrap() }
    }

    /// Host used when the token was pasted by hand and no host was discovered.
    static func defaultApiHost() -> String? {
        guard let host = Bundle.main.object(forInfoDictionaryKey: "NUDefaultApiHost") as? String,
              !host.isEmpty
        else { return nil }
        return host
    }

    private func bootstrap() async {
        // bootstrap.json → app bundle name → backing DMG filename → ask the user.
        let parsed = FilenameTokenParser.resolve(bundleURL: Bundle.main.bundleURL)
        token = parsed?.token
        apiHost = parsed?.apiHost
        state = .tokenEntry(prefill: parsed?.token, apiHost: parsed?.apiHost)
    }

    /// Called from TokenEntryView once the token is valid and terms accepted.
    func submitToken(_ enteredToken: String, apiHost hostHint: String?) {
        let host = hostHint ?? apiHost ?? Self.defaultApiHost()
        guard let host else {
            state = .error(
                message: "No Nodes Unlimited server was configured for this installer. Please re-download from your Nodes Unlimited console.",
                recoverable: false
            )
            return
        }
        token = enteredToken
        apiHost = host
        state = .loading
        Task { await self.fetchBootstrap(token: enteredToken, apiHost: host) }
    }

    private func fetchBootstrap(token enteredToken: String, apiHost host: String) async {
        let client = BootstrapClient()
        do {
            // TokenEntryView only enables Next once the terms checkbox is ticked, so
            // reaching this call IS the acceptance — stamp it and send it for audit.
            let p = try await client.fetch(
                token: enteredToken,
                apiHost: host,
                terms: .now()
            )
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

    func finishPermissions() {
        if case .permissions(let orgName) = state {
            state = .done(orgName: orgName)
        }
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
            state = .permissions(orgName: payload.orgName)
        } catch let err as Installer.Error {
            state = .error(message: err.errorDescription ?? "Install failed", recoverable: true)
        } catch {
            state = .error(message: error.localizedDescription, recoverable: true)
        }
    }
}

@main
struct NUAgentInstallerApp: App {
    @StateObject private var controller = InstallController()

    var body: some Scene {
        WindowGroup("NODES UNLIMITED AGENT Installer") {
            RootView(controller: controller)
                .frame(width: 520, height: 440)
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
            case .moveToApplications:
                MoveToApplicationsView(
                    onMove: controller.moveToApplicationsAndRelaunch,
                    onSkip: controller.continueWithoutMoving
                )
            case .tokenEntry(let prefill, let apiHost):
                TokenEntryView(prefill: prefill) { entered in
                    controller.submitToken(entered, apiHost: apiHost)
                }
            case .confirm(let payload):
                ConfirmView(payload: payload, onInstall: controller.confirmInstall)
            case .installing:
                InstallingView()
            case .permissions(let orgName):
                PermissionsView(orgName: orgName, onFinish: controller.finishPermissions)
            case .done(let orgName):
                DoneView(orgName: orgName)
            case .error(let message, let recoverable):
                ErrorView(message: message, recoverable: recoverable, onRetry: controller.retry)
            }
        }
        .padding(24)
    }
}
