import Foundation
import SideCaptureKit
import XCTest
@testable import Side

private final class FakePermissionProbe: PermissionProbing {
    var accessibility = false
    var inputMonitoring = false
    var screenRecording = false
    var automation: [String: Bool] = [:]
    var requests: [String] = []

    func accessibility(prompt: Bool) -> Bool {
        if prompt { requests.append("accessibility") }
        return accessibility
    }

    func inputMonitoring(request: Bool) -> Bool {
        if request { requests.append("inputMonitoring") }
        return inputMonitoring
    }

    func screenRecording(request: Bool) -> Bool {
        if request { requests.append("screenRecording") }
        return screenRecording
    }

    func automation(bundleID: String, request: Bool) -> Bool {
        if request { requests.append("automation:\(bundleID)") }
        return automation[bundleID] ?? false
    }
}

@MainActor
final class PermissionsHealthTests: XCTestCase {
    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "SidePermissionsTests.\(UUID().uuidString)")!
    }

    func testPreflightAndRequestsUseOnlySelectedPermissionPrompts() {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())

        let initial = coordinator.preflight()
        XCTAssertFalse(initial.accessibility)
        XCTAssertFalse(initial.inputMonitoring)
        XCTAssertFalse(initial.screenRecording)
        XCTAssertTrue(initial.automation.isEmpty)
        XCTAssertTrue(probe.requests.isEmpty)

        _ = coordinator.request([.accessibility, .inputMonitoring, .screenRecording], screenOCREnabled: false)
        XCTAssertEqual(probe.requests, ["accessibility", "inputMonitoring"])
        XCTAssertTrue(coordinator.permissionSheetVisible)

        _ = coordinator.request([.screenRecording], screenOCREnabled: true)
        XCTAssertEqual(probe.requests.last, "screenRecording")
    }

    func testBrowserAutomationPromptsOnceOnFirstForegroundAndCanRetryExplicitly() {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        let browser = "com.google.Chrome"

        XCTAssertFalse(coordinator.browserBecameForeground(browser).automation[browser] ?? true)
        XCTAssertFalse(coordinator.browserBecameForeground(browser).automation[browser] ?? true)
        XCTAssertEqual(probe.requests, ["automation:\(browser)"])

        _ = coordinator.request([.automation], browserBundleID: browser)
        XCTAssertEqual(probe.requests, ["automation:\(browser)", "automation:\(browser)"])
        probe.automation[browser] = true
        let status = coordinator.preflight()
        XCTAssertEqual(status.automation[browser], true)
        _ = coordinator.browserBecameForeground("com.example.not-browser")
        XCTAssertEqual(probe.requests.count, 2)
    }

    func testGrantAndRevocationRecoverObserverAndTapOncePerTransition() {
        let probe = FakePermissionProbe()
        var registrations = 0
        var tapChanges: [Bool] = []
        let coordinator = PermissionCoordinator(
            probe: probe, defaults: defaults(),
            onAccessibilityGranted: { registrations += 1 },
            onInputMonitoringChanged: { tapChanges.append($0) }
        )
        _ = coordinator.preflight()
        probe.accessibility = true
        probe.inputMonitoring = true

        _ = coordinator.preflight()
        _ = coordinator.preflight()
        XCTAssertEqual(registrations, 1)
        XCTAssertEqual(tapChanges, [true])

        probe.inputMonitoring = false
        XCTAssertFalse(coordinator.preflight().inputMonitoring)
        XCTAssertEqual(tapChanges, [true, false])
    }

    func testScreenRecordingGrantSetsPersistentSheetResumeBeforeRestart() {
        let probe = FakePermissionProbe()
        let store = defaults()
        var restartCount = 0
        let coordinator = PermissionCoordinator(
            probe: probe, defaults: store,
            onScreenRecordingGranted: { restartCount += 1 }
        )
        _ = coordinator.preflight()
        _ = coordinator.request([.screenRecording], screenOCREnabled: true)
        probe.screenRecording = true

        _ = coordinator.preflight()
        _ = coordinator.preflight()
        XCTAssertEqual(restartCount, 1)
        let resumed = PermissionCoordinator(probe: probe, defaults: store)
        XCTAssertTrue(resumed.takeResumePermissionSheet())
        XCTAssertTrue(resumed.permissionSheetVisible)
        XCTAssertFalse(resumed.takeResumePermissionSheet())
    }

    func testScreenRecordingRestartHandoffPrecedesOtherGrantCallbacks() {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(
            probe: probe, defaults: defaults(),
            onAccessibilityGranted: { probe.requests.append("observer") },
            onInputMonitoringChanged: { _ in probe.requests.append("tap") },
            onScreenRecordingGranted: { probe.requests.append("restart") }
        )
        _ = coordinator.preflight()
        coordinator.configureScreenOCR(enabled: true)
        probe.accessibility = true
        probe.inputMonitoring = true
        probe.screenRecording = true

        _ = coordinator.preflight()

        XCTAssertEqual(probe.requests, ["restart"])
    }

    func testHealthFailedSendKeepsCacheDirtyAndDaemonResetForcesFirstFrame() throws {
        let coordinator = PermissionCoordinator(probe: FakePermissionProbe(), defaults: defaults())
        var frames: [Data] = []
        var fail = true
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { HelperHealth() },
            send: {
                if fail { throw NSError(domain: "SyntheticHealth", code: 1) }
                frames.append($0)
            }
        )
        XCTAssertThrowsError(try monitor.refresh())
        fail = false
        try monitor.refresh()
        try monitor.refresh()
        XCTAssertEqual(frames.count, 1)

        monitor.resetForDaemonGeneration()
        try monitor.refresh()
        XCTAssertEqual(frames.count, 2)
    }

    func testHealthEmitsAllApprovedFieldsOnChangeAndEveryThirtySeconds() throws {
        let probe = FakePermissionProbe()
        probe.accessibility = true
        probe.inputMonitoring = true
        probe.screenRecording = true
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        var now = Date(timeIntervalSince1970: 1_000)
        var health = HelperHealth()
        health.nativeCaptureAvailable = true
        health.inputCaptureAvailable = true
        health.screenOcrAvailable = true
        health.screenOcrLanguages = ["ko-KR", "en-US"]
        health.eventTapHealthy = true
        health.inputTapRunning = true
        health.observerRegistrationFailures = 2
        health.secureInput = true
        health.systemSessionActive = true
        health.idle = false
        health.pid = 42
        health.observerPid = 17
        health.state = .running
        health.asideAdapter = .available
        health.perApp = ["com.google.Chrome": .init(chromeOnly: true, maxTreeBytes: 4_096)]
        var lines: [Data] = []
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { health }, send: { lines.append($0) }, now: { now }
        )

        try monitor.refresh()
        XCTAssertEqual(lines.count, 1)
        let body = try healthBody(lines[0])
        XCTAssertEqual(Set(body.keys), [
            "platform", "protocolVersion", "nativeCaptureAvailable", "inputCaptureAvailable",
            "screenOcrAvailable", "screenOcrLanguages", "accessibilityTrusted", "inputMonitoringTrusted",
            "screenRecordingTrusted", "eventTapHealthy", "inputTapRunning", "observerRegistrationFailures",
            "secureInput", "permissionSheetVisible", "systemSessionActive", "idle", "pid", "observerPid",
            "responsibleSelf", "state", "asideAdapter", "perApp",
        ])
        XCTAssertEqual(body["observerRegistrationFailures"] as? Int, 2)
        XCTAssertEqual(body["asideAdapter"] as? String, "available")
        XCTAssertEqual(body["inputCaptureAvailable"] as? Bool, true)
        try monitor.refresh()
        XCTAssertEqual(lines.count, 1)
        now.addTimeInterval(29)
        try monitor.refresh()
        XCTAssertEqual(lines.count, 1)
        now.addTimeInterval(1)
        try monitor.refresh()
        XCTAssertEqual(lines.count, 2)

        health.idle = true
        try monitor.refresh()
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(try healthBody(lines[2])["idle"] as? Bool, true)

        health.inputTapRunning = false
        try monitor.refresh()
        let stoppedTap = try healthBody(XCTUnwrap(lines.last))
        XCTAssertEqual(stoppedTap["inputCaptureAvailable"] as? Bool, false)
        XCTAssertEqual(stoppedTap["eventTapHealthy"] as? Bool, false)
    }

    func testRevokedInputMonitoringForcesUntrustedAndUnhealthyTap() throws {
        let probe = FakePermissionProbe()
        probe.inputMonitoring = true
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        var health = HelperHealth()
        health.inputCaptureAvailable = true
        health.inputTapRunning = true
        health.eventTapHealthy = true
        var lines: [Data] = []
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { health }, send: { lines.append($0) }
        )
        try monitor.refresh()
        probe.inputMonitoring = false

        try monitor.refresh()
        let body = try healthBody(XCTUnwrap(lines.last))
        XCTAssertEqual(body["inputMonitoringTrusted"] as? Bool, false)
        XCTAssertEqual(body["eventTapHealthy"] as? Bool, false)
        XCTAssertEqual(body["inputCaptureAvailable"] as? Bool, false)
        XCTAssertEqual(body["inputTapRunning"] as? Bool, false)
    }

    func testPermissionTransitionEmitsHealthWithoutWaitingForTimer() throws {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        var lines: [Data] = []
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { HelperHealth() }, send: { lines.append($0) }
        )
        try monitor.refresh()
        probe.inputMonitoring = true

        _ = coordinator.preflight()
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(try healthBody(lines[1])["inputMonitoringTrusted"] as? Bool, true)
    }

    func testPermissionSheetChangesEmitHealthWithoutPolling() throws {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        var lines: [Data] = []
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { HelperHealth() }, send: { lines.append($0) }
        )
        try monitor.refresh()

        _ = coordinator.request([.accessibility])
        XCTAssertEqual(try healthBody(XCTUnwrap(lines.last))["permissionSheetVisible"] as? Bool, true)
        coordinator.dismissPermissionSheet()
        XCTAssertEqual(try healthBody(XCTUnwrap(lines.last))["permissionSheetVisible"] as? Bool, false)
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(HelperHealthMonitor.heartbeatInterval, 30)
    }

    func testPermissionCommandsReturnCorrelatedStatusAndRouteSelectedKinds() throws {
        let probe = FakePermissionProbe()
        probe.accessibility = true
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        let browser = "com.google.Chrome"
        _ = coordinator.browserBecameForeground(browser)
        coordinator.configureScreenOCR(enabled: true)
        let statusCommand = Data(#"{"type":"command","id":"p-1","name":"permissions"}"#.utf8)
        let requestCommand = Data(#"{"type":"command","id":"p-2","name":"requestPermissions","args":{"kinds":["automation","screenRecording"]}}"#.utf8)

        let statusReply = try replyBody(XCTUnwrap(coordinator.replyForCommand(statusCommand)))
        let requestReply = try replyBody(XCTUnwrap(coordinator.replyForCommand(requestCommand)))

        XCTAssertEqual(statusReply["id"] as? String, "p-1")
        let data = try XCTUnwrap(statusReply["data"] as? [String: Any])
        XCTAssertEqual(Set(data.keys), ["accessibility", "inputMonitoring", "screenRecording", "automation"])
        XCTAssertEqual(data["accessibility"] as? Bool, true)
        XCTAssertEqual(requestReply["id"] as? String, "p-2")
        XCTAssertEqual(probe.requests, ["automation:\(browser)", "screenRecording", "automation:\(browser)"])
    }

    func testPermissionCommandRejectsUnknownKindWithoutPrompting() throws {
        let probe = FakePermissionProbe()
        let coordinator = PermissionCoordinator(probe: probe, defaults: defaults())
        let command = Data(#"{"type":"command","id":"p-3","name":"requestPermissions","args":{"kinds":["unknown"]}}"#.utf8)

        let reply = try replyBody(XCTUnwrap(coordinator.replyForCommand(command)))

        XCTAssertEqual(reply["id"] as? String, "p-3")
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["error"] as? String, "invalid-arguments")
        XCTAssertTrue(probe.requests.isEmpty)
    }

    private func healthBody(_ line: Data) throws -> [String: Any] {
        XCTAssertEqual(line.last, 0x0A)
        let envelope = try replyBody(line)
        XCTAssertEqual(envelope["type"] as? String, "health")
        return try XCTUnwrap(envelope["health"] as? [String: Any])
    }

    private func replyBody(_ line: Data) throws -> [String: Any] {
        XCTAssertEqual(line.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
    }
}
