// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BreezeInstaller",
    platforms: [.macOS(.v12)],
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
