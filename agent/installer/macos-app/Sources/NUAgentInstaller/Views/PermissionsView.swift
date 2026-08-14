// agent/installer/macos-app/Sources/NUAgentInstaller/Views/PermissionsView.swift
import SwiftUI
import AppKit

/// Guided walkthrough of the privacy permissions the agent needs.
/// Each row deep-links to the exact System Settings pane; the user checks
/// items off as they grant them. macOS only lets a process query its OWN
/// TCC status, so the agent daemon's grants cannot be auto-detected here.
struct PermissionsView: View {
    let orgName: String
    let onFinish: () -> Void

    struct Permission: Identifiable {
        let id: String
        let icon: String
        let title: String
        let detail: String
        let settingsAnchor: String
    }

    static let permissions: [Permission] = [
        Permission(
            id: "fda",
            icon: "internaldrive",
            title: "Full Disk Access",
            detail: "Lets support technicians back up files and investigate disk issues.",
            settingsAnchor: "Privacy_AllFiles"
        ),
        Permission(
            id: "screen",
            icon: "rectangle.on.rectangle",
            title: "Screen Recording",
            detail: "Lets support technicians see your screen during remote support sessions.",
            settingsAnchor: "Privacy_ScreenCapture"
        ),
        Permission(
            id: "ax",
            icon: "hand.point.up.left",
            title: "Accessibility",
            detail: "Lets support technicians control the mouse and keyboard when you ask for help.",
            settingsAnchor: "Privacy_Accessibility"
        ),
    ]

    @State private var granted: Set<String> = []

    private var allDone: Bool { granted.count == Self.permissions.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Grant permissions")
                .font(.title2).bold()
            Text("In each pane, click **+** (or enable the toggle) and add **NODES UNLIMITED AGENT**. Check items off as you go.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                ForEach(Self.permissions) { perm in
                    HStack(spacing: 12) {
                        Image(systemName: granted.contains(perm.id) ? "checkmark.circle.fill" : perm.icon)
                            .font(.system(size: 22))
                            .foregroundStyle(granted.contains(perm.id) ? .green : .accentColor)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(perm.title).font(.headline)
                            Text(perm.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        Button("Open Settings") { open(perm) }
                            .disabled(granted.contains(perm.id))
                        Toggle("", isOn: Binding(
                            get: { granted.contains(perm.id) },
                            set: { on in
                                if on { granted.insert(perm.id) } else { granted.remove(perm.id) }
                            }
                        ))
                        .toggleStyle(.checkbox)
                        .labelsHidden()
                        .help("Check once you've added NODES UNLIMITED AGENT in this pane")
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
                }
            }

            Spacer()

            HStack {
                Button("Skip for now") { onFinish() }
                Spacer()
                Button(allDone ? "Finish" : "Finish anyway") { onFinish() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func open(_ perm: Permission) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(perm.settingsAnchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}
