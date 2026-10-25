import Foundation
import SideCaptureKit

@MainActor
final class HelperHealthMonitor {
    static let heartbeatInterval: TimeInterval = 30

    private let permissions: PermissionCoordinator
    private let sample: () -> HelperHealth
    private let send: (Data) throws -> Void
    private let now: () -> Date
    private var timer: Timer?
    private var lastBody: Data?
    private var lastSentAt: Date?

    init(
        permissions: PermissionCoordinator,
        sample: @escaping () -> HelperHealth,
        send: @escaping (Data) throws -> Void,
        now: @escaping () -> Date = Date.init
    ) {
        self.permissions = permissions
        self.sample = sample
        self.send = send
        self.now = now
        let previousChange = permissions.onChange
        permissions.onChange = { [weak self] status in
            previousChange?(status)
            try? self?.publish(status: status)
        }
    }

    deinit { timer?.invalidate() }

    func start() {
        guard timer == nil else { return }
        try? refresh()
        let timer = Timer(timeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in try? self?.refresh() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func resetForDaemonGeneration() {
        lastBody = nil
        lastSentAt = nil
    }

    // Call after any capture state mutation for an immediate change report.
    func refresh() throws {
        let permissionStatus = permissions.preflight()
        try publish(status: permissionStatus)
    }

    private func publish(status permissionStatus: PermissionStatus) throws {
        var health = sample()
        health.accessibilityTrusted = permissionStatus.accessibility
        health.inputMonitoringTrusted = permissionStatus.inputMonitoring
        health.screenRecordingTrusted = permissionStatus.screenRecording
        health.inputTapRunning = health.inputTapRunning && permissionStatus.inputMonitoring
        health.inputCaptureAvailable = health.inputCaptureAvailable && health.inputTapRunning
        health.screenOcrAvailable = health.screenOcrAvailable && permissionStatus.screenRecording
        health.eventTapHealthy = health.eventTapHealthy && health.inputTapRunning
        health.permissionSheetVisible = permissions.permissionSheetVisible

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let body = try encoder.encode(health)
        let timestamp = now()
        let heartbeatDue = lastSentAt.map {
            timestamp.timeIntervalSince($0) >= Self.heartbeatInterval
        } ?? true
        guard body != lastBody || heartbeatDue else { return }
        try send(try CaptureProtocol.encodeHealth(health))
        lastBody = body
        lastSentAt = timestamp
    }
}
