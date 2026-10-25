import AppKit
import Combine
import Foundation
import SideCaptureKit

private final class CaptureMode {
    var paused = true
}

@MainActor
final class SideRuntime: ObservableObject {
    static let shared = SideRuntime()

    let supervisor: DaemonSupervisor
    let stream: CaptureStream
    let observerHub: AXObserverHub
    let inputTap: InputTap
    let workspaceObserver: WorkspaceObserver
    let permissions: PermissionCoordinator
    let browser: BrowserCapture
    let healthMonitor: HelperHealthMonitor
    let services: LiveCommandRouterServices
    let router: CommandRouter

    @Published private(set) var supervisorState: SupervisorState = .stopped

    private let mode: CaptureMode
    private var started = false
    private var healthStarted = false
    private var unlockObserver: NSObjectProtocol?

    init(
        supervisor providedSupervisor: DaemonSupervisor? = nil,
        browser: BrowserCapture = BrowserCapture(),
        permissionProbe: PermissionProbing = SystemPermissionProbe(),
        defaults: UserDefaults = .standard,
        foreground: @escaping () -> AXSnapshotForeground? = AXSnapshotForeground.current,
        observerFactory: (CaptureStream) -> AXObserverHub = { AXObserverHub(stream: $0) }
    ) {
        let supervisor = providedSupervisor ?? DaemonSupervisor()
        let mode = CaptureMode()
        let stream = CaptureStream(
            output: { [weak supervisor] event in try? supervisor?.sendEvent(event) },
            browserPrivacyAllowed: { browser.cachedObservableForeground(bundleID: $0) },
            browserURL: { browser.cachedNormalizedURL(bundleID: $0) },
            foregroundWindowID: { bundleID in
                guard let current = foreground(), current.bundleID == bundleID else { return nil }
                return current.windowID
            }
        )
        let observerHub = observerFactory(stream)
        let inputTap = InputTap(stream: stream, observerHub: observerHub)
        let permissions = PermissionCoordinator(
            observerHub: observerHub, inputTap: inputTap,
            probe: permissionProbe, defaults: defaults
        )
        permissions.onChange = { _ in
            if mode.paused { inputTap.stop() }
        }
        let workspaceObserver = WorkspaceObserver(
            stream: stream, axObserver: observerHub,
            onActivation: { [weak permissions, weak observerHub] bundleID in
                guard BrowserCapture.urlScript(for: bundleID) != nil else { return }
                Task { @MainActor in
                    guard let permissions else { return }
                    let wasAllowed = permissions.preflight().automation[bundleID] == true
                    let isAllowed = permissions.browserBecameForeground(bundleID).automation[bundleID] == true
                    await browser.refreshForeground(bundleID: bundleID)
                    guard let app = NSWorkspace.shared.frontmostApplication,
                          app.bundleIdentifier == bundleID else { return }
                    guard !wasAllowed, isAllowed else { return }
                    observerHub?.activate(
                        bundleID: bundleID, appName: app.localizedName ?? "", pid: app.processIdentifier
                    )
                }
            },
            invalidateCapture: { inputTap.stop() }
        )
        let sampleHealth = {
            var health = HelperHealth()
            let running = supervisor.state == .running
            health.nativeCaptureAvailable = running
            health.inputTapRunning = inputTap.isRunning
            health.inputCaptureAvailable = running && inputTap.isRunning
            health.eventTapHealthy = inputTap.isRunning
            health.screenOcrAvailable = true
            health.screenOcrLanguages = ["ko-KR", "en-US"]
            health.secureInput = stream.isSecureInputEnabled
            health.systemSessionActive = NSWorkspace.shared.frontmostApplication != nil
            health.idle = IdleMonitor().isIdle
            health.pid = Int(getpid())
            health.observerPid = Int(foreground()?.pid ?? 0)
            health.observerRegistrationFailures = observerHub.observerRegistrationFailures
            health.state = running ? (mode.paused ? .paused : .running) : .stopped
            browser.writeHealth(into: &health)
            return health
        }
        let healthMonitor = HelperHealthMonitor(
            permissions: permissions, sample: sampleHealth,
            send: { [weak supervisor] frame in
                guard let supervisor else { throw SupervisorTransportError.notRunning }
                try supervisor.sendFrame(frame)
            }
        )
        let services = LiveCommandRouterServices(
            stream: stream, observerHub: observerHub, workspaceObserver: workspaceObserver,
            inputTap: inputTap, permissions: permissions, browser: browser,
            sampleHealth: sampleHealth,
            showSettings: { SettingsWindowController.shared.open(.settings) }
        )

        self.supervisor = supervisor
        self.stream = stream
        self.observerHub = observerHub
        self.inputTap = inputTap
        self.workspaceObserver = workspaceObserver
        self.permissions = permissions
        self.browser = browser
        self.healthMonitor = healthMonitor
        self.services = services
        self.router = CommandRouter(services: services)
        self.mode = mode
        self.supervisorState = supervisor.state

        supervisor.onOtherCommand = { [weak self] line in
            await self?.route(line)
        }
        supervisor.onProcessReady = { [weak self] in
            guard let self, self.started, !self.healthStarted else { return }
            self.healthMonitor.resetForDaemonGeneration()
            self.healthStarted = true
            self.healthMonitor.start()
        }
        supervisor.onStateChange = { [weak self] state in
            self?.supervisorChanged(state)
        }
        supervisor.onWebSessionChange = { session in
            SettingsWindowController.shared.accept(session: session)
        }
    }

    func start() {
        guard !started else { return }
        unlockObserver = DistributedNotificationCenter.default().addObserver(
            forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.supervisor.retryKeychain() }
        }
        supervisor.start()
        started = true
        if supervisor.state == .running {
            healthMonitor.start()
            healthStarted = true
        }
    }

    func stop() {
        guard started else { return }
        started = false
        removeUnlockObserver()
        healthMonitor.stop()
        healthStarted = false
        pauseCapture()
        supervisor.stop()
    }

    func quit() async {
        guard started else { return }
        started = false
        removeUnlockObserver()
        healthMonitor.stop()
        healthStarted = false
        pauseCapture()
        await supervisor.stopForQuit()
    }

    private func route(_ line: Data) async -> Data? {
        let reply = await router.reply(for: line)
        if let reply,
           let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
           command["name"] as? String == "observer.configure",
           let args = command["args"] as? [String: Any], let paused = args["paused"] as? Bool,
           let result = try? JSONSerialization.jsonObject(with: reply) as? [String: Any],
           result["ok"] as? Bool == true {
            mode.paused = paused
            try? healthMonitor.refresh()
        }
        return reply
    }

    private func supervisorChanged(_ state: SupervisorState) {
        supervisorState = state
        guard started else { return }
        if state == .running {
            if !healthStarted {
                healthMonitor.start()
                healthStarted = true
            } else {
                try? healthMonitor.refresh()
            }
        } else {
            healthMonitor.stop()
            healthMonitor.resetForDaemonGeneration()
            healthStarted = false
            pauseCapture()
        }
    }

    private func removeUnlockObserver() {
        if let unlockObserver {
            DistributedNotificationCenter.default().removeObserver(unlockObserver)
            self.unlockObserver = nil
        }
    }

    private func pauseCapture() {
        mode.paused = true
        observerHub.configure(deniedBundleIds: [], captureTypedText: false, paused: true)
        inputTap.stop()
        workspaceObserver.stop()
    }
}
