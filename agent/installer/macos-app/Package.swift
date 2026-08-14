// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NUAgentInstaller",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "NUAgentInstaller", targets: ["NUAgentInstaller"]),
    ],
    targets: [
        .executableTarget(
            name: "NUAgentInstaller",
            path: "Sources/NUAgentInstaller"
        ),
        .testTarget(
            name: "NUAgentInstallerTests",
            dependencies: ["NUAgentInstaller"],
            path: "Tests/NUAgentInstallerTests"
        ),
    ]
)
