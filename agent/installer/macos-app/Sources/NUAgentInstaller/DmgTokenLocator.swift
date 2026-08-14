// agent/installer/macos-app/Sources/NUAgentInstaller/DmgTokenLocator.swift
import Foundation

/// Finds the filename of the .dmg the running app was launched from, if any.
///
/// The DMG is named `Nodes Unlimited Agent [TOKEN@host].dmg`. When the user
/// runs the app straight off the mounted image (or the app was copied out of
/// it, but this process is still the one on the image), the bundle name may
/// have lost its `[TOKEN@host]` marker — but the backing disk image filename
/// still carries it. `hdiutil info -plist` maps a mount point back to the
/// image path, and needs no elevated privileges.
///
/// Every failure mode — not on a DMG, hdiutil missing/failing, malformed
/// plist — returns nil. Nothing here throws.
enum DmgTokenLocator {
    /// The .dmg filename backing `bundleURL`, or nil.
    static func backingDmgFileName(bundleURL: URL = Bundle.main.bundleURL) -> String? {
        guard let mountPoint = volumeMountPoint(for: bundleURL) else { return nil }
        guard let data = runHdiutilInfoPlist() else { return nil }
        guard let imagePath = imagePath(inHdiutilPlist: data, mountPoint: mountPoint) else { return nil }
        let name = URL(fileURLWithPath: imagePath).lastPathComponent
        guard name.lowercased().hasSuffix(".dmg") else { return nil }
        return name
    }

    /// Mount point of the volume that holds `url` (e.g. `/Volumes/Nodes Unlimited Agent`).
    static func volumeMountPoint(for url: URL) -> String? {
        guard let values = try? url.resourceValues(forKeys: [.volumeURLKey]),
              let volumeURL = values.volume
        else { return nil }
        return normalize(volumeURL.path)
    }

    /// Parses `hdiutil info -plist` output and returns the `image-path` whose
    /// `system-entities` include a `mount-point` equal to `mountPoint`.
    /// Split out from process execution so it can be unit-tested directly.
    static func imagePath(inHdiutilPlist data: Data, mountPoint: String) -> String? {
        guard let root = try? PropertyListSerialization.propertyList(
            from: data, options: [], format: nil
        ) as? [String: Any] else { return nil }
        guard let images = root["images"] as? [[String: Any]] else { return nil }

        let wanted = normalize(mountPoint)
        for image in images {
            guard let imagePath = image["image-path"] as? String else { continue }
            guard let entities = image["system-entities"] as? [[String: Any]] else { continue }
            for entity in entities {
                guard let mp = entity["mount-point"] as? String else { continue }
                if normalize(mp) == wanted { return imagePath }
            }
        }
        return nil
    }

    private static func normalize(_ path: String) -> String {
        var p = path
        while p.count > 1, p.hasSuffix("/") { p.removeLast() }
        return p
    }

    private static func runHdiutilInfoPlist() -> Data? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        proc.arguments = ["info", "-plist"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = Pipe()
        do {
            try proc.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0, !data.isEmpty else { return nil }
        return data
    }
}
