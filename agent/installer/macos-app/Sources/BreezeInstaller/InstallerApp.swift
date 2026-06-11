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
        let parsed: FilenameTokenParser.Result
        do {
            parsed = try FilenameTokenParser.load(bundleURL: Bundle.main.bundleURL)
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
