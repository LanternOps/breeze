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
