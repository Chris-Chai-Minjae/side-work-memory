import AppKit
import Carbon
import Foundation
import SideCaptureKit

struct BrowserCaptureContent: Equatable {
    let text: String?
    let axTreeBytes: Int
}

struct BrowserHealth: Equatable {
    let chromeOnly: Bool
    let maxTreeBytes: Int
}

enum BrowserSuppression: Equatable {
    case incognito
}

enum BrowserUnavailable: Equatable {
    case unsupportedBrowser
    case notForeground
    case automationPermission
    case privateStateUnknown
    case urlUnavailable
    case urlChanged
}

enum BrowserCaptureResult: Equatable {
    case captured(url: String, content: BrowserCaptureContent, ocrFallbackNeeded: Bool)
    case suppressed(BrowserSuppression)
    case unavailable(BrowserUnavailable)
}

final class BrowserCapture {
    private static let emptyTreeBytes = 2_048
    private static let safariBundleID = "com.apple.Safari"
    private static let urlScripts = [
        "at.studio.AsideBrowser": "tell application \"Aside\" to get URL of active tab of front window",
        "com.google.Chrome": "tell application \"Google Chrome\" to get URL of active tab of front window",
        "com.apple.Safari": "tell application \"Safari\" to get URL of current tab of front window",
        "company.thebrowser.Browser": "tell application \"Arc\" to get URL of active tab of front window",
        "com.brave.Browser": "tell application \"Brave Browser\" to get URL of active tab of front window",
        "com.microsoft.edgemac": "tell application \"Microsoft Edge\" to get URL of active tab of front window",
    ]

    private struct Page {
        let rawURL: String
        let normalizedURL: String
        let windowID: UInt32?
    }

    private enum Resolution {
        case page(Page)
        case suppressed(BrowserSuppression)
        case unavailable(BrowserUnavailable)
    }

    private let frontmostBundleID: () -> String?
    private let foregroundWindowID: (String) -> UInt32?
    private let automationAllowed: (String) -> Bool
    private let runAppleScript: (String) -> String?
    private let worker: NativeStringWorker
    private var cachedModes: [String: (value: String?, at: Date)] = [:]
    private var cachedURLs: [String: (page: Page, at: Date)] = [:]
    private let cacheLifetime: TimeInterval = 2
    private(set) var perAppHealth: [String: BrowserHealth] = [:]

    init(
        frontmostBundleID: @escaping () -> String? = { NSWorkspace.shared.frontmostApplication?.bundleIdentifier },
        foregroundWindowID: @escaping (String) -> UInt32? = { bundleID in
            guard let current = AXSnapshotForeground.current(), current.bundleID == bundleID else { return nil }
            return current.windowID
        },
        automationAllowed: @escaping (String) -> Bool = BrowserCapture.hasAutomationPermission,
        runAppleScript: @escaping (String) -> String? = BrowserCapture.executeAppleScript,
        worker: NativeStringWorker = NativeStringWorker()
    ) {
        self.frontmostBundleID = frontmostBundleID
        self.foregroundWindowID = foregroundWindowID
        self.automationAllowed = automationAllowed
        self.runAppleScript = runAppleScript
        self.worker = worker
    }

    static func urlScript(for bundleID: String) -> String? {
        urlScripts[bundleID]
    }

    // Called before AX and input producers emit, so private-window content never enters the helper pipe.
    func isObservableForeground(bundleID: String) -> Bool {
        guard Self.urlScript(for: bundleID) != nil else { return true }
        guard frontmostBundleID() == bundleID else { return false }
        if bundleID == Self.safariBundleID { return false }
        guard automationAllowed(bundleID) else { return false }
        let modeScript = "tell application id \"\(bundleID)\" to get mode of front window"
        return runAppleScript(modeScript)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "normal"
    }

    func currentNormalizedURL(bundleID: String) -> String? {
        if case .page(let page) = resolvePage(bundleID: bundleID) { return page.normalizedURL }
        return nil
    }

    func cachedObservableForeground(bundleID: String) -> Bool {
        guard Self.urlScript(for: bundleID) != nil else { return true }
        guard frontmostBundleID() == bundleID, bundleID != Self.safariBundleID,
              let mode = cachedModes[bundleID], let page = cachedURLs[bundleID],
              Date().timeIntervalSince(mode.at) < cacheLifetime,
              Date().timeIntervalSince(page.at) < cacheLifetime,
              let currentWindowID = foregroundWindowID(bundleID),
              page.page.windowID == currentWindowID else { return false }
        return mode.value == "normal"
    }

    func cachedNormalizedURL(bundleID: String) -> String? {
        guard cachedObservableForeground(bundleID: bundleID),
              let cached = cachedURLs[bundleID],
              Date().timeIntervalSince(cached.at) < cacheLifetime else { return nil }
        return cached.page.normalizedURL
    }

    func refreshForeground(bundleID: String) async {
        _ = await resolvePageAsync(bundleID: bundleID)
    }

    func rawBrowserURL(bundleID: String) async -> String? {
        guard let source = Self.urlScript(for: bundleID),
              frontmostBundleID() == bundleID,
              bundleID != Self.safariBundleID else { return nil }
        return try? await runScriptAsync(source, cacheResult: false)
    }

    func captureAsync(
        bundleID: String,
        readContent: () async -> BrowserCaptureContent
    ) async -> BrowserCaptureResult {
        let before: Page
        switch await resolvePageAsync(bundleID: bundleID, cacheResult: false) {
        case .page(let page): before = page
        case .suppressed(let reason): return .suppressed(reason)
        case .unavailable(let reason): return .unavailable(reason)
        }
        let content = await readContent()
        switch await resolvePageAsync(bundleID: bundleID, cacheResult: false) {
        case .page(let after):
            guard before.rawURL == after.rawURL else { return .unavailable(.urlChanged) }
        case .suppressed(let reason): return .suppressed(reason)
        case .unavailable(let reason): return .unavailable(reason)
        }
        let bytes = max(0, content.axTreeBytes)
        let needsOCR = bytes < Self.emptyTreeBytes
        perAppHealth[bundleID] = BrowserHealth(
            chromeOnly: needsOCR,
            maxTreeBytes: max(perAppHealth[bundleID]?.maxTreeBytes ?? 0, bytes)
        )
        return .captured(url: before.normalizedURL, content: content, ocrFallbackNeeded: needsOCR)
    }

    private func resolvePageAsync(bundleID: String, cacheResult: Bool = true) async -> Resolution {
        guard let urlScript = Self.urlScript(for: bundleID) else { return .unavailable(.unsupportedBrowser) }
        guard frontmostBundleID() == bundleID, let windowID = foregroundWindowID(bundleID) else {
            return .unavailable(.notForeground)
        }
        guard automationAllowed(bundleID) else { return .unavailable(.automationPermission) }
        if bundleID == Self.safariBundleID { return .unavailable(.privateStateUnknown) }
        let modeScript = "tell application id \"\(bundleID)\" to get mode of front window"
        let rawMode = try? await runScriptAsync(modeScript, cacheResult: cacheResult)
        let mode = rawMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if mode == "incognito" { return .suppressed(.incognito) }
        guard mode == "normal" else { return .unavailable(.privateStateUnknown) }
        guard let rawURL = try? await runScriptAsync(urlScript, cacheResult: cacheResult),
              let normalizedURL = Self.normalizedURL(rawURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              frontmostBundleID() == bundleID, foregroundWindowID(bundleID) == windowID else {
            cachedURLs[bundleID] = nil
            cachedModes[bundleID] = nil
            return .unavailable(.urlUnavailable)
        }
        let page = Page(
            rawURL: rawURL.trimmingCharacters(in: .whitespacesAndNewlines),
            normalizedURL: normalizedURL,
            windowID: windowID
        )
        cachedModes[bundleID] = (mode, Date())
        cachedURLs[bundleID] = (page, Date())
        return .page(page)
    }

    private func runScriptAsync(_ source: String, cacheResult: Bool = true) async throws -> String? {
        let run = runAppleScript
        return try await worker.call(key: "applescript:\(source)", cacheResult: cacheResult) {
            run(source)
        }
    }

    func writeHealth(into health: inout HelperHealth) {
        health.perApp.merge(perAppHealth.mapValues {
            HelperHealth.PerApp(chromeOnly: $0.chromeOnly, maxTreeBytes: $0.maxTreeBytes)
        }) { _, browser in browser }
    }

    func capture(bundleID: String, readContent: () -> BrowserCaptureContent) -> BrowserCaptureResult {
        let before: Page
        switch resolvePage(bundleID: bundleID) {
        case .page(let page): before = page
        case .suppressed(let reason): return .suppressed(reason)
        case .unavailable(let reason): return .unavailable(reason)
        }

        let content = readContent()

        let after: Page
        switch resolvePage(bundleID: bundleID) {
        case .page(let page): after = page
        case .suppressed(let reason): return .suppressed(reason)
        case .unavailable(let reason): return .unavailable(reason)
        }
        guard before.rawURL == after.rawURL else { return .unavailable(.urlChanged) }

        // S-2 could not activate AXManualAccessibility; the caller uses existing AX and OCR fallback.
        let bytes = max(0, content.axTreeBytes)
        let needsOCR = bytes < Self.emptyTreeBytes
        perAppHealth[bundleID] = BrowserHealth(
            chromeOnly: needsOCR,
            maxTreeBytes: max(perAppHealth[bundleID]?.maxTreeBytes ?? 0, bytes)
        )
        return .captured(url: before.normalizedURL, content: content, ocrFallbackNeeded: needsOCR)
    }

    private func resolvePage(bundleID: String) -> Resolution {
        guard let urlScript = Self.urlScript(for: bundleID) else {
            return .unavailable(.unsupportedBrowser)
        }
        guard frontmostBundleID() == bundleID else { return .unavailable(.notForeground) }
        guard automationAllowed(bundleID) else { return .unavailable(.automationPermission) }
        if bundleID == Self.safariBundleID { return .unavailable(.privateStateUnknown) }

        if bundleID != Self.safariBundleID {
            let modeScript = "tell application id \"\(bundleID)\" to get mode of front window"
            let mode = runAppleScript(modeScript)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            switch mode {
            case "incognito": return .suppressed(.incognito)
            case "normal": break
            default: return .unavailable(.privateStateUnknown)
            }
        }

        guard let rawURL = runAppleScript(urlScript)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let normalizedURL = Self.normalizedURL(rawURL) else {
            return .unavailable(.urlUnavailable)
        }
        return .page(Page(
            rawURL: rawURL,
            normalizedURL: normalizedURL,
            windowID: foregroundWindowID(bundleID)
        ))
    }

    private static func normalizedURL(_ rawURL: String) -> String? {
        guard var parts = URLComponents(string: rawURL),
              let scheme = parts.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = parts.host, !host.isEmpty else { return nil }
        parts.scheme = scheme
        parts.host = host.lowercased()
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        if parts.path.isEmpty { parts.path = "/" }
        return parts.url?.absoluteString
    }

    private static func hasAutomationPermission(_ bundleID: String) -> Bool {
        let address = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        guard let descriptor = address.aeDesc else { return false }
        return AEDeterminePermissionToAutomateTarget(
            descriptor, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), false
        ) == noErr
    }

    private static func executeAppleScript(_ source: String) -> String? {
        guard let script = NSAppleScript(source: source) else { return nil }
        var error: NSDictionary?
        return script.executeAndReturnError(&error).stringValue
    }
}
