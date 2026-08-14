// agent/installer/macos-app/Sources/NUAgentInstaller/Views/MoveToApplicationsView.swift
import SwiftUI

/// Shown when the installer is launched from the DMG (or Downloads) instead of
/// /Applications. One click moves it into place and relaunches, making the
/// "drag to Applications" step effectively the install trigger.
struct MoveToApplicationsView: View {
    let onMove: () -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "arrow.right.square.fill")
                .font(.system(size: 44))
                .foregroundStyle(.purple)
            Text("Move to Applications")
                .font(.title2).bold()
            Text("The installer works best from your Applications folder. Click below and it will move itself there and continue automatically.")
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            HStack {
                Button("Continue from here") { onSkip() }
                Spacer()
                Button("Move to Applications & Continue") { onMove() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
