import ApplicationServices
import Foundation
import SideCaptureKit
import XCTest
@testable import Side

private struct RuntimePermissionProbe: PermissionProbing {
    func accessibility(prompt: Bool) -> Bool { false }
    func inputMonitoring(request: Bool) -> Bool { false }
    func screenRecording(request: Bool) -> Bool { false }
    func automation(bundleID: String, request: Bool) -> Bool { false }
}

private struct RuntimeKeyStore: SideKeyStore {
    func masterKey() throws -> Data { Data(repeating: 0x42, count: 32) }
    func rotateMasterKey() throws -> Data { Data(repeating: 0x43, count: 32) }
    func setProviderKey(ref: String, secret: String) throws {}
    func providerKey(ref: String) throws -> String? { nil }
    func providerKeyStatus(ref: String) throws -> (stored: Bool, accessible: Bool) { (false, false) }
    func authorizeProviderKey(ref: String) throws -> Bool { false }
}

private final class RecoveringRuntimeKeyStore: SideKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0

    var readCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return reads
    }

    func masterKey() throws -> Data {
        lock.lock()
        reads += 1
        let shouldFail = reads == 1
        lock.unlock()
        if shouldFail { throw NSError(domain: "SyntheticKeychain", code: 1) }
        return Data(repeating: 0x42, count: 32)
    }
    func rotateMasterKey() throws -> Data { Data(repeating: 0x43, count: 32) }
    func setProviderKey(ref: String, secret: String) throws {}
    func providerKey(ref: String) throws -> String? { nil }
    func providerKeyStatus(ref: String) throws -> (stored: Bool, accessible: Bool) { (false, false) }
    func authorizeProviderKey(ref: String) throws -> Bool { false }
}

@MainActor
final class SideRuntimeTests: XCTestCase {
    func testScreenUnlockRetriesFailedKeychainReadOnce() async throws {
        let (directory, daemon) = try makeDaemonScript { _ in
            "IFS= read -r hello\nwhile :; do sleep 1; done\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RecoveringRuntimeKeyStore()
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: store)
        let runtime = SideRuntime(supervisor: supervisor, permissionProbe: RuntimePermissionProbe(), defaults: defaults())
        runtime.start()
        defer { runtime.stop() }
        try await waitForSupervisorState(.keychainLocked, in: runtime)
        XCTAssertEqual(runtime.supervisorState, .keychainLocked)

        DistributedNotificationCenter.default().post(name: .init("com.apple.screenIsUnlocked"), object: nil)
        try await waitForSupervisorState(.running, in: runtime)
        DistributedNotificationCenter.default().post(name: .init("com.apple.screenIsUnlocked"), object: nil)
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(store.readCount, 2)
        XCTAssertEqual(runtime.supervisorState, .running)
    }

    func testHealthFrameReportsAXFailureAndClearsAfterRecovery() async throws {
        let (directory, daemon) = try makeDaemonScript { directory in
            let output = directory.appendingPathComponent("health").path
            return "IFS= read -r hello\nn=0\nwhile IFS= read -r frame; do\n  case \"$frame\" in\n    *'\"type\":\"health\"'*) n=$((n + 1)); printf '%s\\n' \"$frame\" > \"\(output)-$n.tmp\"; mv \"\(output)-$n.tmp\" \"\(output)-$n\" ;;\n  esac\ndone\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        var failCreation = true
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: RuntimeKeyStore())
        let runtime = SideRuntime(
            supervisor: supervisor, permissionProbe: RuntimePermissionProbe(), defaults: defaults(),
            observerFactory: { stream in
                AXObserverHub(
                    stream: stream, isTrusted: { true },
                    createObserver: { pid, callback in
                        guard !failCreation else { return nil }
                        var observer: AXObserver?
                        XCTAssertEqual(AXObserverCreate(pid, callback, &observer), .success)
                        return observer
                    },
                    registerNotification: { _, _, _, _ in .success }
                )
            }
        )
        runtime.start()
        defer { runtime.stop() }
        _ = try await waitForFile(directory.appendingPathComponent("health-1"))
        runtime.observerHub.configure(deniedBundleIds: [], captureTypedText: true, paused: false)

        runtime.observerHub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        try runtime.healthMonitor.refresh()
        let failed = try object(from: await waitForFile(directory.appendingPathComponent("health-4")))
        XCTAssertEqual((failed["health"] as? [String: Any])?["observerRegistrationFailures"] as? Int, 1)

        failCreation = false
        runtime.observerHub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        try runtime.healthMonitor.refresh()
        let recovered = try object(from: await waitForFile(directory.appendingPathComponent("health-5")))
        XCTAssertEqual((recovered["health"] as? [String: Any])?["observerRegistrationFailures"] as? Int, 0)
    }

    func testStartSendsHealthWhileCaptureRemainsPausedAndStopEndsSupervisor() async throws {
        // Given a daemon that records readiness and running health separately.
        let (directory, daemon) = try makeDaemonScript { directory in
            let output = directory.appendingPathComponent("health").path
            return "IFS= read -r hello\nn=0\nwhile IFS= read -r frame; do\n  case \"$frame\" in\n    *'\"type\":\"health\"'*) n=$((n + 1)); printf '%s\\n' \"$frame\" > \"\(output)-$n.tmp\"; mv \"\(output)-$n.tmp\" \"\(output)-$n\" ;;\n  esac\ndone\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: RuntimeKeyStore())
        let runtime = SideRuntime(supervisor: supervisor, permissionProbe: RuntimePermissionProbe(), defaults: defaults())

        // When the app runtime starts, before any observer.configure command.
        runtime.start()
        defer { runtime.stop() }
        runtime.stream.activate(bundleID: "com.example.Editor", appName: "Editor")
        let health = try object(from: await waitForFile(directory.appendingPathComponent("health-2")))

        // Then the daemon receives health, capture stays paused, and shutdown stops the supervisor.
        XCTAssertEqual(supervisor.state, .running)
        XCTAssertFalse(runtime.stream.mayObserve(bundleID: "com.example.Editor"))
        XCTAssertEqual(health["type"] as? String, "health")
        let body = try XCTUnwrap(health["health"] as? [String: Any])
        XCTAssertEqual(body["nativeCaptureAvailable"] as? Bool, true)
        XCTAssertEqual(body["state"] as? String, "paused")
        runtime.stop()
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.daemonPID)
    }

    func testDaemonConfigureReplyUnpausesCaptureAndForwardsSanitizedBrowserEvent() async throws {
        // Given a daemon command and a browser with a private query in its current URL.
        let (directory, daemon) = try makeDaemonScript { directory in
            let reply = directory.appendingPathComponent("reply").path
            let event = directory.appendingPathComponent("event").path
            let switched = directory.appendingPathComponent("switched").path
            return "IFS= read -r hello\nprintf '%s\\n' '{\"type\":\"command\",\"id\":\"configure-1\",\"name\":\"observer.configure\",\"args\":{\"deniedBundleIds\":[],\"captureTypedText\":true,\"screenOcr\":false,\"paused\":false}}'\nwhile IFS= read -r frame; do\n  case \"$frame\" in\n    *'\"id\":\"configure-1\"'*) printf '%s\\n' \"$frame\" > '\(reply).tmp'; mv '\(reply).tmp' '\(reply)' ;;\n    *'\"windowTitle\":\"Synthetic tab\"'*) printf '%s\\n' \"$frame\" > '\(event).tmp'; mv '\(event).tmp' '\(event)' ;;\n    *'\"windowTitle\":\"Synthetic switched\"'*) printf '%s\\n' \"$frame\" > '\(switched).tmp'; mv '\(switched).tmp' '\(switched)' ;;\n  esac\ndone\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        var currentForeground = AXSnapshotForeground(bundleID: "com.google.Chrome", pid: 42, windowID: 31)
        let browser = BrowserCapture(
            frontmostBundleID: { "com.google.Chrome" },
            foregroundWindowID: { _ in currentForeground.windowID },
            automationAllowed: { _ in true },
            runAppleScript: { script in
                if script.contains("mode of front window") { return "normal" }
                return "https://Example.com/path?token=hidden#fragment"
            }
        )
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: RuntimeKeyStore())
        let runtime = SideRuntime(
            supervisor: supervisor, browser: browser, permissionProbe: RuntimePermissionProbe(),
            defaults: defaults(),
            foreground: { currentForeground }
        )

        // When the daemon configures observation and a synthetic browser signal arrives.
        runtime.start()
        defer { runtime.stop() }
        let reply = try object(from: await waitForFile(directory.appendingPathComponent("reply")))
        await browser.refreshForeground(bundleID: "com.google.Chrome")
        runtime.stream.activate(bundleID: "com.google.Chrome", appName: "Chrome")
        XCTAssertTrue(runtime.stream.mayObserve(bundleID: "com.google.Chrome"))
        runtime.stream.emit(.windowChanged, bundleID: "com.google.Chrome", windowTitle: "Synthetic tab")
        let event = try object(from: await waitForFile(directory.appendingPathComponent("event")))

        // Then the reply is correlated and the event carries only the normalized URL and window identity.
        XCTAssertEqual(reply["id"] as? String, "configure-1")
        XCTAssertEqual(reply["ok"] as? Bool, true)
        let payload = try XCTUnwrap(event["event"] as? [String: Any])
        XCTAssertEqual(payload["kind"] as? String, "window.changed")
        XCTAssertEqual(payload["url"] as? String, "https://example.com/path")
        XCTAssertEqual(payload["windowId"] as? Int, 31)
        XCTAssertFalse(String(decoding: try Data(contentsOf: directory.appendingPathComponent("event")), as: UTF8.self).contains("token=hidden"))

        currentForeground = AXSnapshotForeground(bundleID: "com.example.Other", pid: 99, windowID: 99)
        runtime.stream.emit(.windowChanged, bundleID: "com.google.Chrome", windowTitle: "Synthetic switched")
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("switched").path))
    }

    func testDaemonRestartSendsFreshHealthAndRequiresNewObserverConfiguration() async throws {
        // Given a daemon that enables observation, exits abnormally, and restarts without configuring again.
        let (directory, daemon) = try makeDaemonScript { directory in
            let marker = directory.appendingPathComponent("first-start").path
            let secondHealth = directory.appendingPathComponent("second-health").path
            return "IFS= read -r hello\nif [ ! -e '\(marker)' ]; then\n  : > '\(marker)'\n  printf '%s\\n' '{\"type\":\"command\",\"id\":\"configure-first\",\"name\":\"observer.configure\",\"args\":{\"deniedBundleIds\":[],\"captureTypedText\":true,\"screenOcr\":false,\"paused\":false}}'\n  while IFS= read -r frame; do\n    case \"$frame\" in *'\"id\":\"configure-first\"'*) exit 9 ;; esac\n  done\nelse\n  IFS= read -r readiness\n  IFS= read -r frame\n  printf '%s\\n' \"$frame\" > '\(secondHealth).tmp'\n  mv '\(secondHealth).tmp' '\(secondHealth)'\n  while IFS= read -r ignored; do :; done\nfi\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: RuntimeKeyStore())
        let runtime = SideRuntime(supervisor: supervisor, permissionProbe: RuntimePermissionProbe(), defaults: defaults())

        // When the first daemon exits and the supervisor launches the second instance.
        runtime.start()
        defer { runtime.stop() }
        let frame = try object(from: await waitForFile(directory.appendingPathComponent("second-health")))
        runtime.stream.activate(bundleID: "com.example.Editor", appName: "Editor")

        // Then health is published to the new daemon and capture is paused until it configures.
        XCTAssertEqual(frame["type"] as? String, "health")
        XCTAssertEqual((frame["health"] as? [String: Any])?["state"] as? String, "paused")
        XCTAssertEqual(supervisor.state, .running)
        XCTAssertFalse(runtime.stream.mayObserve(bundleID: "com.example.Editor"))
    }

    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "SideRuntimeTests.\(UUID().uuidString)")!
    }

    private func waitForSupervisorState(_ state: SupervisorState, in runtime: SideRuntime) async throws {
        for _ in 0..<200 {
            if runtime.supervisorState == state { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("runtime did not reach \(state); current state: \(runtime.supervisorState)")
    }

    private func makeDaemonScript(_ body: (URL) -> String) throws -> (URL, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("side-runtime-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let daemon = directory.appendingPathComponent("side")
        try Data(("#!/bin/sh\n" + body(directory)).utf8).write(to: daemon)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: daemon.path)
        return (directory, daemon)
    }

    private func waitForFile(_ url: URL) async throws -> Data {
        for _ in 0..<200 {
            if let data = try? Data(contentsOf: url) { return data }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(domain: "SideRuntimeTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "daemon frame missing"])
    }

    private func object(from line: Data) throws -> [String: Any] {
        XCTAssertEqual(line.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
    }
}
