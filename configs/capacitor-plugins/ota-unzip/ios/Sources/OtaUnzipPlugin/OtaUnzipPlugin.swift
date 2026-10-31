import Foundation
import Capacitor
import ZIPFoundation

/// Native (non-JS, non-WebView) OTA-bundle unzip - exists specifically to
/// avoid routing the downloaded zip's bytes through the WebView/JS bridge at
/// all. Capacitor's own `convertFileSrc()` native handler
/// (`WebViewAssetHandler.swift`) reads a requested non-media file (our
/// `.zip`) whole into memory before handing it to WebKit, which is suspected
/// to be what was crashing the WKWebView content process when the JS side
/// tried to stream-unzip a 500MB+ bundle through `fetch(convertFileSrc(...))`
/// - see new-files/src/system/offline/mobile-updater.ts's doc comment on
/// stageAndActivateOta(). Doing the unzip here instead means the only thing
/// that crosses the bridge is two short path strings in, and a small result
/// object out - never the archive's bytes.
///
/// Uses ZIPFoundation (https://github.com/weichsel/ZIPFoundation, MIT) rather
/// than a hand-written ZIP reader. Verified directly against its source
/// (Archive+Reading.swift / Data+Compression.swift): `extract(_:to:)` opens
/// the destination with `fopen`, reads the source in `defaultReadChunkSize`
/// (16KB) chunks via a provider closure, decompresses through a bounded
/// `compression_stream` loop, and writes each decompressed chunk out
/// immediately - it never holds a whole entry or the whole archive in memory
/// at once.
@objc(OtaUnzipPlugin)
public class OtaUnzipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OtaUnzipPlugin"
    public let jsName = "OtaUnzip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "unzip", returnType: CAPPluginReturnPromise)
    ]

    enum OtaUnzipError: Error {
        case missingArgument(String)
        case invalidPath(String)
        case entryEscapesDestination(String)
    }

    /// Accepts either a file:// URI (what mobile-updater.ts passes - the
    /// result of Capacitor's own Filesystem.getUri()) or a plain filesystem
    /// path.
    private static func resolveURL(_ pathOrUri: String) -> URL? {
        if pathOrUri.hasPrefix("file:") {
            return URL(string: pathOrUri)
        }
        return URL(fileURLWithPath: pathOrUri)
    }

    @objc func unzip(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath") else {
            call.reject("Missing 'sourcePath'")
            return
        }
        guard let destDirPath = call.getString("destDir") else {
            call.reject("Missing 'destDir'")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let entryCount = try Self.unzip(sourcePath: sourcePath, destDirPath: destDirPath)
                call.resolve(["entryCount": entryCount])
            } catch {
                call.reject("OTA unzip failed: \(error.localizedDescription)", nil, error)
            }
        }
    }

    /// Strips exactly one leading path segment from every entry (this OTA
    /// zip's own `dist/` wrapper - build-ios.yml's `zip -r ota.zip dist` zips
    /// the "dist" directory itself, not just what's inside it) so destDir's
    /// own root directly contains index.html - matches the stripping
    /// streamingUnzipToDir() used to do in JS.
    private static func stripLeadingSegment(_ path: String) -> String {
        guard let slashIndex = path.firstIndex(of: "/") else { return path }
        return String(path[path.index(after: slashIndex)...])
    }

    private static func unzip(sourcePath: String, destDirPath: String) throws -> Int {
        guard let sourceURL = resolveURL(sourcePath) else {
            throw OtaUnzipError.invalidPath(sourcePath)
        }
        guard let destDirURL = resolveURL(destDirPath) else {
            throw OtaUnzipError.invalidPath(destDirPath)
        }

        let archive = try Archive(url: sourceURL, accessMode: .read)
        let destDirStandardized = destDirURL.standardizedFileURL.path
        var entryCount = 0

        for entry in archive {
            guard entry.type == .file else { continue }
            let relativeName = stripLeadingSegment(entry.path)
            if relativeName.isEmpty { continue }

            let destinationURL = destDirURL.appendingPathComponent(relativeName)
            let destinationStandardized = destinationURL.standardizedFileURL.path
            guard destinationStandardized.hasPrefix(destDirStandardized + "/") else {
                // Zip-slip guard: an entry name that escapes destDir (e.g.
                // "../../Library/...") is malformed/malicious - this OTA
                // source is our own release asset, but there's no reason not
                // to guard it anyway.
                throw OtaUnzipError.entryEscapesDestination(entry.path)
            }

            _ = try archive.extract(entry, to: destinationURL)
            entryCount += 1
        }

        return entryCount
    }
}
