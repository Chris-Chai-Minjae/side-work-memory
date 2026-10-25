import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import SideCaptureKit

enum PermissionKind: String, Hashable {
    case accessibility
    case inputMonitoring
    case screenRecording
    case automation
}

struct PermissionStatus: Encodable, Equatable {
    let accessibility: Bool
    let inputMonitoring: Bool
    let screenRecording: Bool
    let automation: [String: Bool]
}

protocol PermissionProbing {
    func accessibility(prompt: Bool) -> Bool
    func inputMonitoring(request: Bool) -> Bool
    func screenRecording(request: Bool) -> Bool
    func automation(bundleID: String, request: Bool) -> Bool
}

struct SystemPermissionProbe: PermissionProbing {
    func accessibility(prompt: Bool) -> Bool {
        let option = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([option: prompt] as CFDictionary)
    }

    func inputMonitoring(request: Bool) -> Bool {
        request ? CGRequestListenEventAccess() : CGPreflightListenEventAccess()
    }

    func screenRecording(request: Bool) -> Bool {
        request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    }

    func automation(bundleID: String, request: Bool) -> Bool {
        let address = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        guard let descriptor = address.aeDesc else { return false }
        return AEDeterminePermissionToAutomateTarget(
            descriptor, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), request
        ) == noErr
    }
}

@MainActor
final class PermissionCoordinator {
    private static let resumeSheetKey = "side.permissions.resumeSheet"

    private struct Command: Decodable {
        struct Args: Decodable {
            let kinds: [String]
        }

        let type: String
        let id: String
        let name: String
        let args: Args?
    }

    private let probe: PermissionProbing
    private let defaults: UserDefaults
    private let onAccessibilityGranted: @MainActor () -> Void
    private let onInputMonitoringChanged: @MainActor (Bool) -> Void
    private let onScreenRecordingGranted: @MainActor () -> Void
    private var browserBundleIDs: Set<String> = []
    private var promptedBrowsers: Set<String> = []
    private var lastBrowserBundleID: String?
    private var screenOCREnabled = false
    private(set) var status: PermissionStatus?
    private(set) var permissionSheetVisible = false
    var onChange: ((PermissionStatus) -> Void)?

    init(
        probe: PermissionProbing = SystemPermissionProbe(),
        defaults: UserDefaults = .standard,
        onAccessibilityGranted: @escaping @MainActor () -> Void = {},
        onInputMonitoringChanged: @escaping @MainActor (Bool) -> Void = { _ in },
        onScreenRecordingGranted: @escaping @MainActor () -> Void = {}
    ) {
        self.probe = probe
        self.defaults = defaults
        self.onAccessibilityGranted = onAccessibilityGranted
        self.onInputMonitoringChanged = onInputMonitoringChanged
        self.onScreenRecordingGranted = onScreenRecordingGranted
    }

    convenience init(
        observerHub: AXObserverHub,
        inputTap: InputTap,
        probe: PermissionProbing = SystemPermissionProbe(),
        defaults: UserDefaults = .standard,
        restartHelper: @escaping @MainActor () -> Void = { PermissionCoordinator.restartSideApp() }
    ) {
        self.init(
            probe: probe, defaults: defaults,
            onAccessibilityGranted: {
                guard let app = NSWorkspace.shared.frontmostApplication,
                      let bundleID = app.bundleIdentifier else { return }
                observerHub.activate(
                    bundleID: bundleID, appName: app.localizedName ?? "",
                    pid: app.processIdentifier
                )
            },
            onInputMonitoringChanged: { trusted in
                inputTap.stop()
                if trusted { _ = inputTap.start() }
            },
            onScreenRecordingGranted: restartHelper
        )
    }

    func configureScreenOCR(enabled: Bool) {
        screenOCREnabled = enabled
    }

    @discardableResult
    func preflight() -> PermissionStatus {
        let automation = Dictionary(uniqueKeysWithValues: browserBundleIDs.sorted().map {
            ($0, probe.automation(bundleID: $0, request: false))
        })
        let current = PermissionStatus(
            accessibility: probe.accessibility(prompt: false),
            inputMonitoring: probe.inputMonitoring(request: false),
            screenRecording: probe.screenRecording(request: false),
            automation: automation
        )
        let previous = status
        status = current
        if screenOCREnabled && previous?.screenRecording == false && current.screenRecording {
            defaults.set(permissionSheetVisible, forKey: Self.resumeSheetKey)
            onScreenRecordingGranted()
            if previous != current { onChange?(current) }
            return current
        }
        if current.accessibility && previous?.accessibility != true {
            onAccessibilityGranted()
        }
        if current.inputMonitoring && previous?.inputMonitoring != true {
            onInputMonitoringChanged(true)
        } else if previous?.inputMonitoring == true && !current.inputMonitoring {
            onInputMonitoringChanged(false)
        }
        if previous != current { onChange?(current) }
        return current
    }

    @discardableResult
    func request(
        _ kinds: Set<PermissionKind>,
        screenOCREnabled: Bool? = nil,
        browserBundleID: String? = nil
    ) -> PermissionStatus {
        if let screenOCREnabled { self.screenOCREnabled = screenOCREnabled }
        let current = preflight()
        if kinds.contains(.accessibility) && !current.accessibility {
            setPermissionSheetVisible(true)
            _ = probe.accessibility(prompt: true)
        }
        if kinds.contains(.inputMonitoring) && !current.inputMonitoring {
            setPermissionSheetVisible(true)
            _ = probe.inputMonitoring(request: true)
        }
        if kinds.contains(.screenRecording) && self.screenOCREnabled && !current.screenRecording {
            setPermissionSheetVisible(true)
            _ = probe.screenRecording(request: true)
        }
        if kinds.contains(.automation), let browserBundleID = browserBundleID ?? lastBrowserBundleID,
           BrowserCapture.urlScript(for: browserBundleID) != nil {
            browserBundleIDs.insert(browserBundleID)
            if current.automation[browserBundleID] != true {
                setPermissionSheetVisible(true)
                promptedBrowsers.insert(browserBundleID)
                _ = probe.automation(bundleID: browserBundleID, request: true)
            }
        }
        return preflight()
    }

    @discardableResult
    func browserBecameForeground(_ bundleID: String) -> PermissionStatus {
        guard BrowserCapture.urlScript(for: bundleID) != nil else { return preflight() }
        browserBundleIDs.insert(bundleID)
        lastBrowserBundleID = bundleID
        let current = preflight()
        if !promptedBrowsers.contains(bundleID) && current.automation[bundleID] == false {
            promptedBrowsers.insert(bundleID)
            setPermissionSheetVisible(true)
            _ = probe.automation(bundleID: bundleID, request: true)
            return preflight()
        }
        return current
    }

    func dismissPermissionSheet() {
        setPermissionSheetVisible(false)
    }

    func presentPermissionSheet() {
        setPermissionSheetVisible(true)
    }

    func takeResumePermissionSheet() -> Bool {
        let resume = defaults.bool(forKey: Self.resumeSheetKey)
        defaults.removeObject(forKey: Self.resumeSheetKey)
        if resume { setPermissionSheetVisible(true) }
        return resume
    }

    private func setPermissionSheetVisible(_ visible: Bool) {
        guard permissionSheetVisible != visible else { return }
        permissionSheetVisible = visible
        if let status { onChange?(status) }
    }

    func replyForCommand(_ line: Data) -> Data? {
        guard let command = try? JSONDecoder().decode(Command.self, from: line),
              command.type == "command" else { return nil }
        switch command.name {
        case "permissions":
            return try? CaptureProtocol.encodeResultSuccess(id: command.id, data: preflight())
        case "requestPermissions":
            guard let rawKinds = command.args?.kinds,
                  rawKinds.allSatisfy({ PermissionKind(rawValue: $0) != nil }) else {
                return try? CaptureProtocol.encodeResultFailure(id: command.id, error: "invalid-arguments")
            }
            let kinds = Set(rawKinds.compactMap(PermissionKind.init(rawValue:)))
            return try? CaptureProtocol.encodeResultSuccess(id: command.id, data: request(kinds))
        default:
            return nil
        }
    }

    private static func restartSideApp() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { app, error in
            guard app != nil, error == nil else { return }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }
}
