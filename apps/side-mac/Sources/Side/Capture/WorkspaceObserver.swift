import AppKit
import Foundation

final class WorkspaceObserver: NSObject {
    private let stream: CaptureStream
    private let axObserver: AXObserverHub
    private let onActivation: (String) -> Void
    private let invalidateCapture: () -> Void
    private var running = false
    private var sessionActive = false

    init(
        stream: CaptureStream, axObserver: AXObserverHub,
        onActivation: @escaping (String) -> Void = { _ in },
        invalidateCapture: @escaping () -> Void = {}
    ) {
        self.stream = stream
        self.axObserver = axObserver
        self.onActivation = onActivation
        self.invalidateCapture = invalidateCapture
    }

    deinit { stop() }

    func start() {
        guard !running else { return }
        running = true
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(applicationActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        workspace.addObserver(self, selector: #selector(applicationTerminated(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionStarted(_:)), name: NSWorkspace.didWakeNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionEnded(_:)), name: NSWorkspace.willSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionStarted(_:)), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        workspace.addObserver(self, selector: #selector(sessionEnded(_:)), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(self, selector: #selector(sessionStarted(_:)), name: .init("com.apple.screenIsUnlocked"), object: nil)
        distributed.addObserver(self, selector: #selector(sessionEnded(_:)), name: .init("com.apple.screenIsLocked"), object: nil)
        recordSessionStarted(reason: "startup")
        if let frontmost = NSWorkspace.shared.frontmostApplication { activate(frontmost) }
    }

    func stop() {
        guard running else { return }
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        axObserver.stop()
        sessionActive = false
        running = false
    }

    func recordSessionStarted(reason: String) {
        guard !sessionActive else { return }
        sessionActive = true
        stream.emitSession(.sessionStarted, reason: reason)
    }

    func recordSessionEnded(reason: String) {
        guard sessionActive else { return }
        sessionActive = false
        axObserver.stop()
        stream.invalidateSession()
        invalidateCapture()
        stream.emitSession(.sessionEnded, reason: reason)
    }

    private func activate(_ app: NSRunningApplication) {
        guard let bundleID = app.bundleIdentifier else { return }
        activate(bundleID: bundleID, appName: app.localizedName ?? "", pid: app.processIdentifier)
    }

    func activate(bundleID: String, appName: String, pid: pid_t) {
        if !stream.isExcluded(bundleID: bundleID) { onActivation(bundleID) }
        axObserver.activate(bundleID: bundleID, appName: appName, pid: pid)
    }

    @objc private func applicationActivated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        activate(app)
    }

    @objc private func applicationTerminated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              app.bundleIdentifier == stream.activeBundleID else { return }
        axObserver.stop()
    }

    @objc private func sessionStarted(_ note: Notification) {
        guard !sessionActive else { return }
        recordSessionStarted(reason: note.name.rawValue)
        if let frontmost = NSWorkspace.shared.frontmostApplication { activate(frontmost) }
    }

    @objc private func sessionEnded(_ note: Notification) {
        guard sessionActive else { return }
        axObserver.stop()
        recordSessionEnded(reason: note.name.rawValue)
    }
}
