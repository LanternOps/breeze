// agent/installer/macos-app/Sources/NUAgentInstaller/Views/TokenEntryView.swift
import SwiftUI

/// Enable/disable logic for the token step, kept free of SwiftUI so it can be
/// unit-tested on its own.
struct TokenEntryModel {
    static let tokenPattern = #"^[A-Z0-9]{10}$"#
    static let termsUrl = "https://nodesunlimited.com/terms-of-service"
    static let privacyUrl = "https://nodesunlimited.com/privacy-policy"

    /// Raw field text. Always stored uppercased, matching what the user sees.
    var token: String = "" {
        didSet {
            let up = token.uppercased()
            if up != token { token = up }
        }
    }
    var accepted: Bool = false

    init(token: String = "", accepted: Bool = false) {
        self.token = token.uppercased()
        self.accepted = accepted
    }

    var isTokenValid: Bool {
        token.range(of: Self.tokenPattern, options: .regularExpression) != nil
    }

    /// Quiet UX: an untouched empty field is not "wrong" yet.
    var shouldShowHint: Bool { !token.isEmpty && !isTokenValid }

    var canProceed: Bool { isTokenValid && accepted }
}

struct TokenEntryView: View {
    let prefill: String?
    let onNext: (String) -> Void

    @State private var model: TokenEntryModel

    init(prefill: String?, onNext: @escaping (String) -> Void) {
        self.prefill = prefill
        self.onNext = onNext
        _model = State(initialValue: TokenEntryModel(token: prefill ?? ""))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Install NODES UNLIMITED AGENT")
                .font(.title2).bold()
            Text("Enter the enrollment token from your Nodes Unlimited console.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                TextField("ABCDE12345", text: Binding(
                    get: { model.token },
                    set: { model.token = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
                .disableAutocorrection(true)
                Text(model.shouldShowHint ? "Tokens are 10 characters, letters A–Z and digits 0–9." : " ")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Toggle("", isOn: $model.accepted)
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                HStack(spacing: 0) {
                    Text("I agree to the Nodes Unlimited ")
                    Link("Terms of Service", destination: URL(string: TokenEntryModel.termsUrl)!)
                    Text(" and ")
                    Link("Privacy Policy", destination: URL(string: TokenEntryModel.privacyUrl)!)
                    Text(".")
                }
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            HStack {
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut(.cancelAction)
                Button("Next") { onNext(model.token) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canProceed)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
