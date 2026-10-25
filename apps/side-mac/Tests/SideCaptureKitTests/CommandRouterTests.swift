import AppKit
import Foundation
import SideCaptureKit
import XCTest
@testable import Side

@MainActor
private final class FakeRouterServices: CommandRouterServices {
    var foreground: AXSnapshotForeground? = AXSnapshotForeground(bundleID: "com.example.Editor", pid: 42, windowID: 17)
    var secureInputEnabled = false
    var screenOCREnabled = false
    var screenRecordingTrusted = false
    var captureGeneration = 0
    var deniedBundleIDs: Set<String> = []
    var observeAllowed = true
    var axText: String? = "synthetic body"
    var onAXRead: (() -> Void)?
    var browserResult: BrowserCaptureResult?
    var browserURLValue = "https://example.test/page"
    var rawURLs: [String?] = []
    var ocrResult: String? = "synthetic OCR"
    var onOCRRead: (() -> Void)?
    var ocrReads = 0
    var axReads = 0
    var browserReads = 0
    var rawURLReads = 0
    var settingsOpens = 0
    var configurations: [ObserverConfiguration] = []
    var requestedKinds: [Set<PermissionKind>] = []
    var applicationItems = [RouterApplication(bundleId: "com.example.Editor", name: "Editor", denied: false)]
    var iconItems = [RouterIcon(bundleId: "com.example.Editor", iconPngBase64: "cG5n")]

    func healthSnapshot() -> HelperHealth { HelperHealth() }
    func permissionStatus() -> PermissionStatus {
        PermissionStatus(accessibility: true, inputMonitoring: true, screenRecording: screenRecordingTrusted, automation: [:])
    }
    func requestPermissions(_ kinds: Set<PermissionKind>) -> PermissionStatus {
        requestedKinds.append(kinds)
        return permissionStatus()
    }
    func applications() -> [RouterApplication] { applicationItems }
    func icons(bundleIDs: [String]) -> [RouterIcon] { iconItems.filter { bundleIDs.contains($0.bundleId) } }
    func isDenied(bundleID: String) -> Bool { deniedBundleIDs.contains(bundleID) }
    func mayObserve(bundleID: String) -> Bool { observeAllowed }
    func captureAX(bundleID: String, windowID: UInt32?) async -> String? {
        axReads += 1
        onAXRead?()
        return axText
    }
    func captureBrowser(bundleID: String, readContent: () async -> BrowserCaptureContent) async -> BrowserCaptureResult {
        browserReads += 1
        if let browserResult { return browserResult }
        let content = await readContent()
        return .captured(url: browserURLValue, content: content, ocrFallbackNeeded: content.axTreeBytes < 2_048)
    }
    func browserURL(bundleID: String) async -> BrowserCaptureResult {
        browserReads += 1
        if let browserResult { return browserResult }
        return .captured(url: browserURLValue, content: .init(text: nil, axTreeBytes: 0), ocrFallbackNeeded: true)
    }
    func rawBrowserURL(bundleID: String) async -> String? {
        rawURLReads += 1
        return rawURLs.isEmpty ? browserURLValue : rawURLs.removeFirst()
    }
    func captureOCR(windowID: UInt32) async throws -> String? {
        ocrReads += 1
        onOCRRead?()
        return ocrResult
    }
    func configure(_ configuration: ObserverConfiguration) { configurations.append(configuration) }
    func openSettings() { settingsOpens += 1 }
}

@MainActor
final class CommandRouterTests: XCTestCase {
    func testSensitiveApplicationsAreHardDeniedByCommandRouter() {
        for bundleID in ["com.apple.Passwords", "com.bitwarden.desktop", "org.keepassxc.keepassxc"] {
            XCTAssertTrue(LiveCommandRouterServices.isHardDenied(bundleID: bundleID), bundleID)
        }
    }

    private func reply(_ router: CommandRouter, _ command: String) async throws -> [String: Any] {
        let response = await router.reply(for: Data(command.utf8))
        let line = try XCTUnwrap(response)
        XCTAssertEqual(line.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
    }

    func testHealthAndPermissionsReturnCorrelatedApprovedResults() async throws {
        // Given a fake service with no TCC prompts.
        let service = FakeRouterServices()
        let router = CommandRouter(services: service)

        // When health and permissions commands arrive.
        let health = try await reply(router, #"{"type":"command","id":"h","name":"health"}"#)
        let permissions = try await reply(router, #"{"type":"command","id":"p","name":"permissions"}"#)

        // Then both results are correlated and carry typed data.
        XCTAssertEqual(health["id"] as? String, "h")
        XCTAssertEqual(health["ok"] as? Bool, true)
        XCTAssertEqual((health["data"] as? [String: Any])?["platform"] as? String, "darwin")
        XCTAssertEqual(permissions["id"] as? String, "p")
        XCTAssertEqual((permissions["data"] as? [String: Any])?["accessibility"] as? Bool, true)
    }

    func testRequestPermissionsRoutesOnlyValidSelectedKinds() async throws {
        // Given a fake permission service.
        let service = FakeRouterServices()
        let router = CommandRouter(services: service)

        // When valid and unknown kinds arrive.
        let valid = try await reply(router, #"{"type":"command","id":"p1","name":"requestPermissions","args":{"kinds":["accessibility","screenRecording"]}}"#)
        let invalid = try await reply(router, #"{"type":"command","id":"p2","name":"requestPermissions","args":{"kinds":["unknown"]}}"#)

        // Then only valid kinds reach the permission coordinator.
        XCTAssertEqual(valid["ok"] as? Bool, true)
        XCTAssertEqual(service.requestedKinds, [[.accessibility, .screenRecording]])
        XCTAssertEqual(invalid["ok"] as? Bool, false)
        XCTAssertEqual(invalid["error"] as? String, "invalid-arguments")
    }

    func testApplicationsConfigureAndSettingsCommandsUseInjectedServices() async throws {
        // Given fake app picker, observer, and settings services.
        let service = FakeRouterServices()
        let router = CommandRouter(services: service)

        // When each approved command arrives.
        let apps = try await reply(router, #"{"type":"command","id":"a","name":"applications.list"}"#)
        let icons = try await reply(router, #"{"type":"command","id":"i","name":"applications.icons","args":{"bundleIds":["com.example.Editor"]}}"#)
        let configured = try await reply(router, #"{"type":"command","id":"c","name":"observer.configure","args":{"deniedBundleIds":["com.example.Blocked"],"captureTypedText":false,"screenOcr":true,"paused":false}}"#)
        let opened = try await reply(router, #"{"type":"command","id":"s","name":"settings.open"}"#)

        // Then only requested data and the exact configuration are passed on.
        XCTAssertEqual((apps["data"] as? [[String: Any]])?.first?["bundleId"] as? String, "com.example.Editor")
        XCTAssertEqual((icons["data"] as? [[String: Any]])?.first?["iconPngBase64"] as? String, "cG5n")
        XCTAssertEqual(configured["ok"] as? Bool, true)
        XCTAssertEqual(service.configurations.first?.deniedBundleIds, ["com.example.Blocked"])
        XCTAssertEqual(service.configurations.first?.screenOcr, true)
        XCTAssertEqual(opened["ok"] as? Bool, true)
        XCTAssertEqual(service.settingsOpens, 1)
    }

    func testOversizedIconResultReturnsFailureInsteadOfLeavingCommandUnanswered() async throws {
        // Given icon data larger than the approved JSON-line frame limit.
        let service = FakeRouterServices()
        service.iconItems = [RouterIcon(
            bundleId: "com.example.Editor",
            iconPngBase64: String(repeating: "A", count: CaptureProtocol.maxRawBytes)
        )]
        let router = CommandRouter(services: service)

        // When the icon command is routed.
        let result = try await reply(router, #"{"type":"command","id":"large","name":"applications.icons","args":{"bundleIds":["com.example.Editor"]}}"#)

        // Then a correlated failure reaches the daemon without an oversized frame.
        XCTAssertEqual(result["id"] as? String, "large")
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "unavailable")
    }

    func testInstalledApplicationScannerIncludesAppsOutsideRunningProcesses() throws {
        // Given a synthetic installed app bundle inside a temporary Applications directory.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("SideApps-\(UUID().uuidString)")
        let contents = root.appendingPathComponent("Utilities/Synthetic.app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let info: [String: String] = [
            "CFBundleIdentifier": "com.example.Installed",
            "CFBundleName": "Synthetic Installed",
        ]
        let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try plist.write(to: contents.appendingPathComponent("Info.plist"))

        // When installed applications are scanned without running-process data.
        let apps = LiveCommandRouterServices.installedApplications(in: [root]) { $0 == "com.example.Installed" }

        // Then the installed app is listed with its denylist verdict.
        XCTAssertEqual(apps.map(\.bundleId), ["com.example.Installed"])
        XCTAssertEqual(apps.first?.name, "Synthetic Installed")
        XCTAssertEqual(apps.first?.denied, true)
    }

    func testIconEncodingProducesSixtyFourPixelPNG() throws {
        // Given a synthetic app icon larger than the approved 32px@2x output.
        let icon = NSImage(size: NSSize(width: 128, height: 128))
        icon.lockFocus()
        NSColor.systemBlue.setFill()
        NSRect(x: 0, y: 0, width: 128, height: 128).fill()
        icon.unlockFocus()

        // When the icon is encoded for applications.icons.
        let encoded = try XCTUnwrap(LiveCommandRouterServices.iconPNGBase64(icon))
        let png = try XCTUnwrap(Data(base64Encoded: encoded))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: png))

        // Then the response is a 64-by-64 PNG image.
        XCTAssertEqual(bitmap.pixelsWide, 64)
        XCTAssertEqual(bitmap.pixelsHigh, 64)
    }

    func testCaptureRequestReturnsObservationDirectlyWithAXContent() async throws {
        // Given an allowed foreground editor and synthetic AX text.
        let service = FakeRouterServices()
        let router = CommandRouter(services: service, nowMillis: { 123_456 })

        // When capture.request targets the focused window.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"activation"}}"#)

        // Then the daemon's ObservationSchema can consume the result data directly.
        XCTAssertEqual(result["ok"] as? Bool, true)
        let data = try XCTUnwrap(result["data"] as? [String: Any])
        XCTAssertEqual(data["occurredAt"] as? Int, 123_456)
        XCTAssertEqual(data["kind"] as? String, "content.snapshot")
        XCTAssertEqual(data["source"] as? String, "mac_ax")
        XCTAssertEqual(data["shape"] as? String, "ax")
        XCTAssertEqual(data["bundleId"] as? String, "com.example.Editor")
        XCTAssertEqual(data["windowId"] as? Int, 17)
        XCTAssertEqual(data["content"] as? String, "synthetic body")
        XCTAssertEqual(service.ocrReads, 0)
    }

    func testCaptureRequestRejectsDeniedAndSecureInputBeforeAXRead() async throws {
        // Given first a denied app, then active secure input.
        let service = FakeRouterServices()
        let router = CommandRouter(services: service)
        let command = #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"activation"}}"#
        service.deniedBundleIDs = ["com.example.Editor"]

        // When capture is requested in each protected state.
        let denied = try await reply(router, command)
        service.deniedBundleIDs = []
        service.secureInputEnabled = true
        let secure = try await reply(router, command)

        // Then neither state reads AX or returns content.
        XCTAssertEqual(denied["error"] as? String, "denied")
        XCTAssertEqual(secure["error"] as? String, "secure-input")
        XCTAssertNil(denied["data"])
        XCTAssertNil(secure["data"])
        XCTAssertEqual(service.axReads, 0)
    }

    func testCaptureRequestDiscardsForegroundSwitchAndUnknownWindowIdentity() async throws {
        // Given a request with no window ID whose foreground app changes during AX read.
        let service = FakeRouterServices()
        service.onAXRead = {
            service.foreground = AXSnapshotForeground(bundleID: "com.example.Other", pid: 43, windowID: 18)
        }
        let router = CommandRouter(services: service)

        // When capture is requested.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|-|-","shape":"ax","trigger":"activation"}}"#)

        // Then stale content is discarded even without an expected CG window ID.
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "unavailable")
        XCTAssertNil(result["data"])
    }

    func testBrowserPrivateAndURLMismatchReturnFailureWithoutContent() async throws {
        // Given a browser that is private, then a normal browser on another URL.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 17)
        let router = CommandRouter(services: service)
        let command = #"{"type":"command","id":"b","name":"capture.request","args":{"targetKey":"com.google.Chrome|17|https://example.test/page","shape":"ax","trigger":"navigation"}}"#
        service.browserResult = .suppressed(.incognito)

        // When capture is requested in each state.
        let privateResult = try await reply(router, command)
        service.browserResult = .captured(
            url: "https://example.test/other", content: .init(text: "synthetic body", axTreeBytes: 2_100),
            ocrFallbackNeeded: false
        )
        let mismatched = try await reply(router, command)

        // Then neither browser state returns captured text.
        XCTAssertEqual(privateResult["error"] as? String, "incognito")
        XCTAssertEqual(mismatched["error"] as? String, "unavailable")
        XCTAssertNil(privateResult["data"])
        XCTAssertNil(mismatched["data"])
    }

    func testBrowserCaptureResolvesURLWhenTargetKeyHasNoURLOrWindowID() async throws {
        // Given a browser target created from an event without URL or CG window ID.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 17)
        let router = CommandRouter(services: service)

        // When the current browser window is captured.
        let result = try await reply(router, #"{"type":"command","id":"b","name":"capture.request","args":{"targetKey":"com.google.Chrome|-|-","shape":"ax","trigger":"activation"}}"#)

        // Then BrowserCapture's checked URL is returned and no invented window ID is emitted.
        XCTAssertEqual(result["ok"] as? Bool, true)
        let data = try XCTUnwrap(result["data"] as? [String: Any])
        XCTAssertEqual(data["url"] as? String, "https://example.test/page")
        XCTAssertEqual(data["content"] as? String, "synthetic body")
        XCTAssertNil(data["windowId"])
    }

    func testCaptureRequestUsesMemoryOnlyOCRFallbackAndRechecksWindow() async throws {
        // Given a short AX tree, OCR permission, and synthetic in-memory OCR text.
        let service = FakeRouterServices()
        service.screenOCREnabled = true
        service.screenRecordingTrusted = true
        service.axText = "short"
        let router = CommandRouter(services: service)

        // When capture.request targets the current window.
        let result = try await reply(router, #"{"type":"command","id":"o","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"interaction"}}"#)

        // Then the result is a screen.ocr observation with only synthetic text.
        let data = try XCTUnwrap(result["data"] as? [String: Any])
        XCTAssertEqual(data["kind"] as? String, "screen.ocr")
        XCTAssertEqual(data["shape"] as? String, "text")
        XCTAssertEqual(data["content"] as? String, "synthetic OCR")
        XCTAssertEqual(service.ocrReads, 1)
    }

    func testCaptureRequestDoesNotOCRAfterForegroundSwitch() async throws {
        // Given an AX adapter that returns nil while the foreground changes.
        let service = FakeRouterServices()
        service.axText = nil
        service.onAXRead = {
            service.foreground = AXSnapshotForeground(bundleID: "com.example.Other", pid: 43, windowID: 18)
        }
        service.screenOCREnabled = true
        service.screenRecordingTrusted = true
        let router = CommandRouter(services: service)

        // When capture.request targets the foreground editor.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"activation"}}"#)

        // Then a changed target never triggers a second content read.
        XCTAssertEqual(result["error"] as? String, "unavailable")
        XCTAssertNil(result["data"])
        XCTAssertEqual(service.ocrReads, 0)
    }

    func testCaptureRequestKeepsWrongWindowFailureUnavailableWhenAXIsEmpty() async throws {
        // Given an Aside request for window 42, then the same-URL foreground changes to window 43 during AX read.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "at.studio.AsideBrowser", pid: 42, windowID: 42)
        service.axText = ""
        service.onAXRead = {
            service.foreground = AXSnapshotForeground(bundleID: "at.studio.AsideBrowser", pid: 42, windowID: 43)
        }
        let router = CommandRouter(services: service)

        // When capture.request asks for window 42.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"at.studio.AsideBrowser|42|https://example.test/page","shape":"ax","trigger":"navigation"}}"#)

        // Then the identity failure remains unavailable and cannot claim verified empty content.
        XCTAssertEqual(result["error"] as? String, "unavailable")
        XCTAssertNil(result["data"])
    }

    func testAsideBrowserEmptyAXReturnsVerifiedEmptyContent() async throws {
        // Given a stable Aside window with no AX text.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "at.studio.AsideBrowser", pid: 42, windowID: 42)
        service.axText = ""
        let router = CommandRouter(services: service)
        let command = #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"at.studio.AsideBrowser|42|https://example.test/page","shape":"ax","trigger":"navigation"}}"#

        // When native capture checks that window.
        let verifiedEmpty = try await reply(router, command)

        // Then the fully checked empty result carries the distinct reason.
        XCTAssertEqual(verifiedEmpty["error"] as? String, "empty-content")
        XCTAssertNil(verifiedEmpty["data"])
    }

    func testAsideBrowserMissingAXWindowDoesNotClaimVerifiedEmpty() async throws {
        // Given a stable Aside URL but no verified AX window result.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "at.studio.AsideBrowser", pid: 42, windowID: 42)
        service.axText = nil
        let router = CommandRouter(services: service)

        // When native capture checks that window.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"at.studio.AsideBrowser|42|https://example.test/page","shape":"ax","trigger":"navigation"}}"#)

        // Then an unverified AX window stays unavailable despite the stable URL.
        XCTAssertEqual(result["error"] as? String, "unavailable")
        XCTAssertNil(result["data"])
    }

    func testAsideBrowserDenylistChangeDuringEmptyAXDoesNotClaimVerifiedEmpty() async throws {
        // Given a stable Aside window that becomes denied during an empty AX read.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "at.studio.AsideBrowser", pid: 42, windowID: 42)
        service.axText = ""
        service.onAXRead = { service.deniedBundleIDs.insert("at.studio.AsideBrowser") }
        let router = CommandRouter(services: service)

        // When native capture checks that window.
        let denied = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"at.studio.AsideBrowser|42|https://example.test/page","shape":"ax","trigger":"navigation"}}"#)

        // Then it fails closed without claiming verified empty content.
        XCTAssertEqual(denied["error"] as? String, "unavailable")
        XCTAssertNil(denied["data"])
    }

    func testCaptureRequestFallsBackToOCRWhenBrowserAXIsNilOrEmpty() async throws {
        for axText in [String?.none, ""] {
            // Given a normal browser with no readable AX text and OCR permission.
            let service = FakeRouterServices()
            service.foreground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 17)
            service.axText = axText
            service.screenOCREnabled = true
            service.screenRecordingTrusted = true
            let router = CommandRouter(services: service)

            // When capture.request targets the stable browser window.
            let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.google.Chrome|17|https://example.test/page","shape":"ax","trigger":"navigation"}}"#)

            // Then Vision OCR content is returned only after browser URL checks.
            let data = try XCTUnwrap(result["data"] as? [String: Any])
            XCTAssertEqual(data["kind"] as? String, "screen.ocr")
            XCTAssertEqual(data["content"] as? String, "synthetic OCR")
            XCTAssertEqual(data["url"] as? String, "https://example.test/page")
            XCTAssertEqual(service.ocrReads, 1)
            XCTAssertEqual(service.rawURLReads, 2)
        }
    }

    func testCaptureRequestDoesNotPersistEmptyAXWhenOCRUnavailable() async throws {
        // Given an empty AX tree with OCR disabled.
        let service = FakeRouterServices()
        service.axText = ""
        let router = CommandRouter(services: service)

        // When capture.request targets the stable editor window.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"activation"}}"#)

        // Then verified empty content is distinguished from an identity failure.
        XCTAssertEqual(result["error"] as? String, "empty-content")
        XCTAssertNil(result["data"])
        XCTAssertEqual(service.ocrReads, 0)
    }

    func testCaptureRequestDiscardsBrowserOCRWhenPrivateModeStartsDuringOCR() async throws {
        // Given a normal browser whose mode becomes private during OCR.
        let service = FakeRouterServices()
        service.foreground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 17)
        service.axText = "short"
        service.screenOCREnabled = true
        service.screenRecordingTrusted = true
        service.onOCRRead = { service.browserResult = .suppressed(.incognito) }
        let router = CommandRouter(services: service)

        // When capture.request falls back to OCR.
        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.google.Chrome|17|https://example.test/page","shape":"ax","trigger":"navigation"}}"#)

        // Then private-window content is discarded without a data field.
        XCTAssertEqual(result["error"] as? String, "incognito")
        XCTAssertNil(result["data"])
        XCTAssertEqual(service.rawURLReads, 1)
    }

    func testOCRWindowAndBrowserURLRouteThroughExistingCaptureServices() async throws {
        // Given a foreground window and a normal browser URL.
        let service = FakeRouterServices()
        service.screenOCREnabled = true
        service.screenRecordingTrusted = true
        let router = CommandRouter(services: service)

        // When ocr.window and browser.url are requested.
        let ocr = try await reply(router, #"{"type":"command","id":"o","name":"ocr.window","args":{"windowId":17}}"#)
        service.foreground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 17)
        let url = try await reply(router, #"{"type":"command","id":"u","name":"browser.url","args":{"bundleId":"com.google.Chrome"}}"#)

        // Then OCR is correlated and the browser URL is sanitized by BrowserCapture.
        XCTAssertEqual((ocr["data"] as? [String: Any])?["kind"] as? String, "screen.ocr")
        XCTAssertEqual(url["data"] as? String, "https://example.test/page")
        XCTAssertEqual(service.ocrReads, 1)
        XCTAssertEqual(service.browserReads, 1)
    }

    func testSessionGenerationChangeDuringOCRDiscardsResult() async throws {
        let service = FakeRouterServices()
        service.axText = "short"
        service.screenOCREnabled = true
        service.screenRecordingTrusted = true
        service.onOCRRead = { service.captureGeneration += 1 }
        let router = CommandRouter(services: service)

        let result = try await reply(router, #"{"type":"command","id":"x","name":"capture.request","args":{"targetKey":"com.example.Editor|17|-","shape":"ax","trigger":"navigation"}}"#)

        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "unavailable")
        XCTAssertNil(result["data"])
    }

    func testUnknownAndKeychainCommandsRemainForOtherOwners() async {
        // Given a router that owns only the requested command set.
        let router = CommandRouter(services: FakeRouterServices())

        // When unrelated commands arrive.
        let keychain = await router.reply(for: Data(#"{"type":"command","id":"k","name":"keychain.get","args":{"ref":"synthetic"}}"#.utf8))
        let unknown = await router.reply(for: Data(#"{"type":"command","id":"z","name":"not.approved"}"#.utf8))

        // Then the existing supervisor or protocol layer retains ownership.
        XCTAssertNil(keychain)
        XCTAssertNil(unknown)
    }
}
