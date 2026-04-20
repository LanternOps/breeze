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
