import AppKit
import Foundation
import ScreenCaptureKit
import SideCaptureKit

struct RouterApplication: Encodable {
    let bundleId: String
    let name: String
    let denied: Bool
}

struct RouterIcon: Encodable {
    let bundleId: String
    let iconPngBase64: String
}

struct ObserverConfiguration: Decodable {
    let deniedBundleIds: [String]
    let captureTypedText: Bool
    let screenOcr: Bool
    let paused: Bool
}

@MainActor
protocol CommandRouterServices: AnyObject {
    var foreground: AXSnapshotForeground? { get }
    var secureInputEnabled: Bool { get }
    var screenOCREnabled: Bool { get }
    var screenRecordingTrusted: Bool { get }
    var captureGeneration: Int { get }

    func healthSnapshot() -> HelperHealth
    func permissionStatus() -> PermissionStatus
    func requestPermissions(_ kinds: Set<PermissionKind>) -> PermissionStatus
    func applications() -> [RouterApplication]
    func icons(bundleIDs: [String]) -> [RouterIcon]
    func isDenied(bundleID: String) -> Bool
    func mayObserve(bundleID: String) -> Bool
    func captureAX(bundleID: String, windowID: UInt32?) async -> String?
    func captureBrowser(bundleID: String, readContent: () async -> BrowserCaptureContent) async -> BrowserCaptureResult
    func browserURL(bundleID: String) async -> BrowserCaptureResult
    func rawBrowserURL(bundleID: String) async -> String?
    func captureOCR(windowID: UInt32) async throws -> String?
    func configure(_ configuration: ObserverConfiguration)
    func openSettings()
}

@MainActor
final class LiveCommandRouterServices: CommandRouterServices {
    private let stream: CaptureStream
    private let observerHub: AXObserverHub
    private let workspaceObserver: WorkspaceObserver
    private let inputTap: InputTap
    private let permissions: PermissionCoordinator
    private let browser: BrowserCapture
    private let axWorker = NativeStringWorker(cacheLifetime: 0.1)
    private let sampleHealth: () -> HelperHealth
    private let showSettings: () -> Void
    private var deniedBundleIDs: Set<String> = []
    private(set) var screenOCREnabled = false

    var foreground: AXSnapshotForeground? { AXSnapshotForeground.current() }
    var secureInputEnabled: Bool { stream.isSecureInputEnabled }
    var screenRecordingTrusted: Bool { permissions.preflight().screenRecording }
    var captureGeneration: Int { stream.generation }

    init(
        stream: CaptureStream, observerHub: AXObserverHub, workspaceObserver: WorkspaceObserver,
        inputTap: InputTap, permissions: PermissionCoordinator, browser: BrowserCapture,
        sampleHealth: @escaping () -> HelperHealth, showSettings: @escaping () -> Void
    ) {
        self.stream = stream
        self.observerHub = observerHub
        self.workspaceObserver = workspaceObserver
        self.inputTap = inputTap
        self.permissions = permissions
        self.browser = browser
        self.sampleHealth = sampleHealth
        self.showSettings = showSettings
    }

    func healthSnapshot() -> HelperHealth {
        var health = sampleHealth()
        let status = permissions.preflight()
        health.accessibilityTrusted = status.accessibility
        health.inputMonitoringTrusted = status.inputMonitoring
        health.screenRecordingTrusted = status.screenRecording
        health.secureInput = stream.isSecureInputEnabled
        browser.writeHealth(into: &health)
        return health
    }

    func permissionStatus() -> PermissionStatus { permissions.preflight() }
    func requestPermissions(_ kinds: Set<PermissionKind>) -> PermissionStatus {
        let status = permissions.request(kinds)
        let step: OnboardingStep?
        if kinds.contains(.accessibility) && !status.accessibility {
            step = .accessibility
        } else if kinds.contains(.inputMonitoring) && !status.inputMonitoring {
            step = .inputMonitoring
        } else if kinds.contains(.screenRecording) && !status.screenRecording {
            step = .screenRecording
        } else {
            step = nil
        }
        if let url = step?.settingsURL { NSWorkspace.shared.open(url) }
        return status
    }

    func applications() -> [RouterApplication] {
        let roots = [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "/System/Applications"),
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
        ]
        var found = Dictionary(uniqueKeysWithValues: Self.installedApplications(in: roots, denied: isDenied).map {
            ($0.bundleId, $0)
        })
        for app in NSWorkspace.shared.runningApplications {
            guard let bundleID = app.bundleIdentifier, !bundleID.isEmpty,
                  found[bundleID] == nil else { continue }
            found[bundleID] = RouterApplication(
                bundleId: bundleID, name: app.localizedName ?? bundleID,
                denied: isDenied(bundleID: bundleID)
            )
        }
        return found.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func installedApplications(in roots: [URL], denied: (String) -> Bool) -> [RouterApplication] {
        var found: [String: RouterApplication] = [:]
        for root in roots {
            guard let entries = FileManager.default.enumerator(
                at: root, includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }
            for case let url as URL in entries where url.pathExtension.lowercased() == "app" {
                guard let bundle = Bundle(url: url), let bundleID = bundle.bundleIdentifier,
                      !bundleID.isEmpty else { continue }
                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? url.deletingPathExtension().lastPathComponent
                found[bundleID] = RouterApplication(bundleId: bundleID, name: name, denied: denied(bundleID))
            }
        }
        return found.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func icons(bundleIDs: [String]) -> [RouterIcon] {
        var seen = Set<String>()
        return bundleIDs.compactMap { bundleID in
            guard seen.insert(bundleID).inserted,
                  let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
                  let encoded = Self.iconPNGBase64(NSWorkspace.shared.icon(forFile: url.path)) else { return nil }
            return RouterIcon(bundleId: bundleID, iconPngBase64: encoded)
        }
    }

    static func iconPNGBase64(_ icon: NSImage) -> String? {
        let bounds = NSRect(x: 0, y: 0, width: 64, height: 64)
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor.clear.setFill()
        bounds.fill()
        icon.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])?.base64EncodedString()
    }

    static func isHardDenied(bundleID: String) -> Bool {
        HardBlockedBundleIDs.all.contains(bundleID)
    }

    func isDenied(bundleID: String) -> Bool {
        deniedBundleIDs.contains(bundleID) || Self.isHardDenied(bundleID: bundleID) ||
            bundleID == Bundle.main.bundleIdentifier
    }

    func mayObserve(bundleID: String) -> Bool { stream.mayObserve(bundleID: bundleID) }

    func captureAX(bundleID: String, windowID: UInt32?) async -> String? {
        let before = foreground
        guard before?.bundleID == bundleID else { return nil }
        let key = "ax:\(bundleID):\(windowID.map(String.init) ?? "front")"
        let text = try? await axWorker.call(key: key) {
            AXSnapshot<LiveAXSnapshotReader>().capture(bundleID: bundleID, windowID: windowID)
        }
        guard foreground == before else { return nil }
        return text
    }

    func captureBrowser(
        bundleID: String,
        readContent: () async -> BrowserCaptureContent
    ) async -> BrowserCaptureResult {
        await browser.captureAsync(bundleID: bundleID, readContent: readContent)
    }

    func browserURL(bundleID: String) async -> BrowserCaptureResult {
        await browser.captureAsync(bundleID: bundleID) {
            BrowserCaptureContent(text: nil, axTreeBytes: 0)
        }
    }

    func rawBrowserURL(bundleID: String) async -> String? {
        await browser.rawBrowserURL(bundleID: bundleID)
    }

    func captureOCR(windowID: UInt32) async throws -> String? {
        let content = try await SCShareableContent.current
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else { return nil }
        return try await WindowOCR.captureText(for: window)
    }

    func configure(_ configuration: ObserverConfiguration) {
        deniedBundleIDs = Set(configuration.deniedBundleIds)
        screenOCREnabled = configuration.screenOcr
        permissions.configureScreenOCR(enabled: configuration.screenOcr)
        observerHub.configure(
            deniedBundleIds: deniedBundleIDs,
            captureTypedText: configuration.captureTypedText,
            paused: configuration.paused
        )
        if configuration.paused {
            inputTap.stop()
            workspaceObserver.stop()
        } else {
            workspaceObserver.start()
            if permissions.preflight().inputMonitoring { _ = inputTap.start() }
        }
    }

    func openSettings() { showSettings() }
}

private struct RouterHeader: Decodable {
    let type: String
    let id: String
    let name: String
}

private struct RouterCommand<Args: Decodable>: Decodable {
    let args: Args
}

private struct RouterPermissionArgs: Decodable { let kinds: [String] }
private struct RouterIconArgs: Decodable { let bundleIds: [String] }
private struct RouterCaptureArgs: Decodable {
    let targetKey: String
    let shape: String
    let trigger: String
}
private struct RouterOCRArgs: Decodable { let windowId: UInt32 }
private struct RouterBrowserArgs: Decodable { let bundleId: String }

private struct RouterTarget {
    let bundleID: String
    let windowID: UInt32?
    let url: String?

    init?(key: String) {
        let parts = key.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, !parts[0].isEmpty else { return nil }
        if parts[1] != "-" {
            guard let parsed = UInt32(parts[1]), parsed > 0 else { return nil }
            windowID = parsed
        } else {
            windowID = nil
        }
        bundleID = String(parts[0])
        url = parts[2] == "-" ? nil : String(parts[2])
    }
}

private struct RouterObservation: Encodable {
    enum Kind: String, Encodable { case snapshot = "content.snapshot", ocr = "screen.ocr" }
    enum Shape: String, Encodable { case ax, text }

    let occurredAt: Int64
    let source = "mac_ax"
    let kind: Kind
    let bundleId: String
    let url: String?
    let windowId: UInt32?
    let content: String
    let shape: Shape
}

@MainActor
final class CommandRouter {
    private let services: any CommandRouterServices
    private let nowMillis: () -> Int64

    init(services: any CommandRouterServices, nowMillis: @escaping () -> Int64 = {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }) {
        self.services = services
        self.nowMillis = nowMillis
    }

    func reply(for line: Data) async -> Data? {
        guard let header = try? JSONDecoder().decode(RouterHeader.self, from: line),
              header.type == "command" else { return nil }
        switch header.name {
        case "health":
            return success(header.id, services.healthSnapshot())
        case "permissions":
            return success(header.id, services.permissionStatus())
        case "requestPermissions":
            guard let args = decode(RouterPermissionArgs.self, from: line),
                  args.kinds.allSatisfy({ PermissionKind(rawValue: $0) != nil }) else {
                return failure(header.id, "invalid-arguments")
            }
            return success(header.id, services.requestPermissions(Set(args.kinds.compactMap(PermissionKind.init(rawValue:)))))
        case "applications.list":
            return success(header.id, services.applications())
        case "applications.icons":
            guard let args = decode(RouterIconArgs.self, from: line) else { return failure(header.id, "invalid-arguments") }
            return success(header.id, services.icons(bundleIDs: args.bundleIds))
        case "capture.request":
            guard let args = decode(RouterCaptureArgs.self, from: line),
                  let target = RouterTarget(key: args.targetKey),
                  args.shape == "ax",
                  ["interaction", "activation", "navigation", "sweep", "discovery"].contains(args.trigger) else {
                return failure(header.id, "invalid-arguments")
            }
            switch await capture(target: target) {
            case .success(let observation): return success(header.id, observation)
            case .failure(let code): return failure(header.id, code.rawValue)
            }
        case "ocr.window":
            guard let args = decode(RouterOCRArgs.self, from: line) else { return failure(header.id, "invalid-arguments") }
            switch await captureOCR(windowID: args.windowId) {
            case .success(let observation): return success(header.id, observation)
            case .failure(let code): return failure(header.id, code.rawValue)
            }
        case "browser.url":
            guard let args = decode(RouterBrowserArgs.self, from: line), !args.bundleId.isEmpty else {
                return failure(header.id, "invalid-arguments")
            }
            switch await browserURL(bundleID: args.bundleId) {
            case .success(let url): return success(header.id, url)
            case .failure(let code): return failure(header.id, code.rawValue)
            }
        case "observer.configure":
            guard let args = decode(ObserverConfiguration.self, from: line) else {
                return failure(header.id, "invalid-arguments")
            }
            services.configure(args)
            return success(header.id, Optional<String>.none)
        case "settings.open":
            services.openSettings()
            return success(header.id, Optional<String>.none)
        default:
            return nil
        }
    }

    private enum Failure: String, Error {
        case denied, incognito, unavailable
        case emptyContent = "empty-content"
        case secureInput = "secure-input"
    }

    private func capture(target: RouterTarget) async -> Result<RouterObservation, Failure> {
        guard !services.isDenied(bundleID: target.bundleID) else { return .failure(.denied) }
        guard !services.secureInputEnabled else { return .failure(.secureInput) }
        guard services.mayObserve(bundleID: target.bundleID),
              let before = services.foreground,
              before.bundleID == target.bundleID,
              target.windowID == nil || before.windowID == target.windowID else { return .failure(.unavailable) }

        let generation = services.captureGeneration
        let isBrowser = BrowserCapture.urlScript(for: target.bundleID) != nil
        var text: String?
        var url: String?
        var ocrFallbackNeeded = false
        if isBrowser {
            switch await services.captureBrowser(bundleID: target.bundleID, readContent: {
                let extracted = await services.captureAX(bundleID: target.bundleID, windowID: target.windowID)
                return BrowserCaptureContent(text: extracted, axTreeBytes: extracted?.utf8.count ?? 0)
            }) {
            case .captured(let capturedURL, let content, let needsOCR):
                guard target.url == nil || target.url == capturedURL else { return .failure(.unavailable) }
                text = content.text
                url = capturedURL
                ocrFallbackNeeded = needsOCR
            case .suppressed:
                return .failure(.incognito)
            case .unavailable:
                return .failure(.unavailable)
            }
        } else {
            guard target.url == nil else { return .failure(.unavailable) }
            text = await services.captureAX(bundleID: target.bundleID, windowID: target.windowID)
            ocrFallbackNeeded = (text?.utf8.count ?? 0) < 2_048
        }
        guard services.foreground == before, services.captureGeneration == generation else {
            return .failure(.unavailable)
        }

        var kind = RouterObservation.Kind.snapshot
        var shape = RouterObservation.Shape.ax
        var content = text ?? ""
        if ocrFallbackNeeded, services.screenOCREnabled,
           services.screenRecordingTrusted, let windowID = before.windowID {
            let rawBefore = isBrowser ? await services.rawBrowserURL(bundleID: target.bundleID) : nil
            if isBrowser && rawBefore == nil { return .failure(.unavailable) }
            do {
                if let recognized = try await services.captureOCR(windowID: windowID), !recognized.isEmpty {
                    content = recognized
                    kind = .ocr
                    shape = .text
                }
            } catch {
                return .failure(.unavailable)
            }
            if isBrowser {
                switch await browserURL(bundleID: target.bundleID) {
                case .success(let afterURL) where afterURL == url: break
                case .failure(let code): return .failure(code)
                default: return .failure(.unavailable)
                }
                guard await services.rawBrowserURL(bundleID: target.bundleID) == rawBefore else {
                    return .failure(.unavailable)
                }
            }
        }
        guard services.foreground == before, services.captureGeneration == generation,
              !services.isDenied(bundleID: target.bundleID),
              services.mayObserve(bundleID: target.bundleID), !services.secureInputEnabled else {
            return .failure(.unavailable)
        }
        guard !content.isEmpty else { return .failure(text == nil ? .unavailable : .emptyContent) }
        return .success(RouterObservation(
            occurredAt: nowMillis(), kind: kind, bundleId: target.bundleID,
            url: url, windowId: target.windowID, content: content, shape: shape
        ))
    }

    private func captureOCR(windowID: UInt32) async -> Result<RouterObservation, Failure> {
        guard let before = services.foreground, before.windowID == windowID,
              !services.isDenied(bundleID: before.bundleID),
              !services.secureInputEnabled,
              services.mayObserve(bundleID: before.bundleID),
              services.screenOCREnabled, services.screenRecordingTrusted else { return .failure(.unavailable) }
        let generation = services.captureGeneration
        let isBrowser = BrowserCapture.urlScript(for: before.bundleID) != nil
        let url: String?
        let rawBefore: String?
        if isBrowser {
            switch await browserURL(bundleID: before.bundleID) {
            case .success(let resolved): url = resolved
            case .failure(let code): return .failure(code)
            }
            rawBefore = await services.rawBrowserURL(bundleID: before.bundleID)
            guard rawBefore != nil else { return .failure(.unavailable) }
        } else {
            url = nil
            rawBefore = nil
        }
        do {
            guard let text = try await services.captureOCR(windowID: windowID), !text.isEmpty,
                  services.foreground == before, services.captureGeneration == generation,
                  !services.secureInputEnabled, services.mayObserve(bundleID: before.bundleID) else {
                return .failure(.unavailable)
            }
            if isBrowser {
                switch await browserURL(bundleID: before.bundleID) {
                case .success(let afterURL) where afterURL == url: break
                case .failure(let code): return .failure(code)
                default: return .failure(.unavailable)
                }
                guard await services.rawBrowserURL(bundleID: before.bundleID) == rawBefore else {
                    return .failure(.unavailable)
                }
            }
            return .success(RouterObservation(
                occurredAt: nowMillis(), kind: .ocr, bundleId: before.bundleID,
                url: url, windowId: windowID, content: text, shape: .text
            ))
        } catch {
            return .failure(.unavailable)
        }
    }

    private func browserURL(bundleID: String) async -> Result<String, Failure> {
        guard !services.isDenied(bundleID: bundleID) else { return .failure(.denied) }
        guard services.mayObserve(bundleID: bundleID), services.foreground?.bundleID == bundleID else {
            return .failure(.unavailable)
        }
        switch await services.browserURL(bundleID: bundleID) {
        case .captured(let url, _, _): return .success(url)
        case .suppressed: return .failure(.incognito)
        case .unavailable: return .failure(.unavailable)
        }
    }

    private func decode<Args: Decodable>(_ type: Args.Type, from line: Data) -> Args? {
        try? JSONDecoder().decode(RouterCommand<Args>.self, from: line).args
    }

    private func success<Value: Encodable>(_ id: String, _ data: Value) -> Data? {
        do {
            return try CaptureProtocol.encodeResultSuccess(id: id, data: data)
        } catch {
            return failure(id, "unavailable")
        }
    }

    private func failure(_ id: String, _ code: String) -> Data? {
        try? CaptureProtocol.encodeResultFailure(id: id, error: code)
    }
}
