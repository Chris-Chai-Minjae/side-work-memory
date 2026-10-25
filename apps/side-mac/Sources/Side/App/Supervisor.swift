import Foundation
import Darwin
import OSLog
import SideCaptureKit

enum RestartDecision: Equatable {
    case restart(after: TimeInterval)
    case captureNotRunning
}

struct RestartPolicy {
    private var recentExits: [Date] = []
    private var attempt = 0
    private var stopped = false

    mutating func recordAbnormalExit(at date: Date) -> RestartDecision {
        guard !stopped else { return .captureNotRunning }
        recentExits.removeAll { $0 <= date.addingTimeInterval(-60) }
        recentExits.append(date)
        if recentExits.count > 5 {
            stopped = true
            return .captureNotRunning
        }
        attempt += 1
        return .restart(after: min(TimeInterval(1 << min(attempt - 1, 6)), 60))
    }
}

enum SupervisorState: Equatable {
    case stopped
    case starting
    case running
    case waitingToRestart(TimeInterval)
    case keychainLocked
    case captureNotRunning

    var menuBarMessage: String? {
        if self == .captureNotRunning || self == .keychainLocked {
            return "Capture is not running"
        }
        return nil
    }

    func unlockKeychainTitle(language: SideLanguage) -> String? {
        guard self == .keychainLocked else { return nil }
        return language.localized("Unlock Keychain…", "Keychain 허용…")
    }
}

enum SupervisorTransportError: Error, Equatable {
    case invalidFrame
    case notRunning
}

@MainActor
final class DaemonSupervisor {
    private static let logger = Logger(subsystem: "com.minjaechai.Side", category: "DaemonSupervisor")
    private let daemonURL: URL
    private let appVersion: String
    private let keyStore: SideKeyStore
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var writer: DaemonFrameWriter?
    private var frame = Data()
    private var policy = RestartPolicy()
    private var restartTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var killTask: Task<Void, Never>?
    private var launchGeneration = 0
    private var launchPending = false
    private var rotationTask: Task<Data?, Never>?
    private var pingSequence = 0
    private var pendingPing: (id: String, sentAt: Date)?
    private var recovering = false
    private let pingInterval: TimeInterval
    private let pingTimeout: TimeInterval
    private let terminationGrace: TimeInterval

    private(set) var state: SupervisorState = .stopped {
        didSet { onStateChange?(state) }
    }
    private(set) var webSession: SettingsWebSession?
    var daemonPID: Int32? { process?.processIdentifier }
    var onStateChange: ((SupervisorState) -> Void)?
    var onProcessReady: (() -> Void)?
    var onWebSessionChange: ((SettingsWebSession?) -> Void)?
    var onOtherCommand: (@MainActor (Data) async -> Data?)?
    var writeData: (FileHandle, Data) throws -> Void = { handle, data in
        try handle.write(contentsOf: data)
    }

    init(
        daemonURL: URL = Bundle.main.resourceURL!.appendingPathComponent("side"),
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0",
        keyStore: SideKeyStore = SideKeychain(),
        pingInterval: TimeInterval = 5,
        pingTimeout: TimeInterval = 10,
        terminationGrace: TimeInterval = 5
    ) {
        self.daemonURL = daemonURL
        self.appVersion = appVersion
        self.keyStore = keyStore
        self.pingInterval = pingInterval
        self.pingTimeout = pingTimeout
        self.terminationGrace = terminationGrace
    }

    func start() {
        guard process == nil, !launchPending else { return }
        restartTask?.cancel()
        restartTask = nil
        policy = RestartPolicy()
        launch()
    }

    func retryKeychain() {
        guard state == .keychainLocked else { return }
        launch()
    }

    func stop() {
        launchGeneration += 1
        launchPending = false
        restartTask?.cancel()
        restartTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        killTask?.cancel()
        killTask = nil
        let child = process
        child?.terminationHandler = nil
        output?.fileHandleForReading.readabilityHandler = nil
        writer?.close()
        writer = nil
        process = nil
        input = nil
        output = nil
        pendingPing = nil
        recovering = false
        frame.removeAll()
        clearWebSession()
        if child?.isRunning == true { child?.terminate() }
        state = .stopped
    }

    func stopForQuit() async {
        let child = process
        stop()
        guard let child else { return }
        let deadline = Date().addingTimeInterval(terminationGrace)
        while child.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if child.isRunning { _ = kill(child.processIdentifier, SIGKILL) }
        await Task.detached { child.waitUntilExit() }.value
    }

    func makeProcess() -> Process {
        let child = Process()
        child.executableURL = daemonURL
        child.arguments = ["daemon"]
        let inherited = ProcessInfo.processInfo.environment
        var environment = [
            "HOME": inherited["HOME"] ?? NSHomeDirectory(),
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": inherited["LANG"] ?? "en_US.UTF-8",
        ]
        for name in ["USER", "LOGNAME"] {
            environment[name] = inherited[name].flatMap { $0.isEmpty ? nil : $0 } ?? NSUserName()
        }
        if let dataDirectory = inherited["SIDE_DATA_DIR"] {
            environment["SIDE_DATA_DIR"] = dataDirectory
        }
        child.environment = environment
        child.standardError = FileHandle.nullDevice
        return child
    }

    func sendEvent<Payload: Encodable>(_ event: Payload) throws {
        try sendFrame(CaptureProtocol.encodeEvent(event))
    }

    func sendHealth(_ health: HelperHealth) throws {
        try sendFrame(CaptureProtocol.encodeHealth(health))
    }

    func sendFrame(_ line: Data) throws {
        guard Self.isAppFrame(line) else { throw SupervisorTransportError.invalidFrame }
        guard let child = process else { throw SupervisorTransportError.notRunning }
        try write(line, to: child)
        if state == .starting,
           (try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])?["type"] as? String == "health" {
            state = .running
            startWatchdog()
        }
    }

    func replyForCommand(_ line: Data) -> Data? {
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return try? CaptureProtocol.encodeProtocolError("invalid command")
        }
        if message["type"] as? String == "protocol-error" { return nil }
        guard message["type"] as? String == "command",
              let id = message["id"] as? String,
              let name = message["name"] as? String else {
            return try? CaptureProtocol.encodeProtocolError("invalid command")
        }
        if name == "web.session" {
            guard let args = message["args"] as? [String: Any],
                  Set(args.keys) == ["port", "token"],
                  let port = args["port"] as? Int,
                  let token = args["token"] as? String,
                  token.count == 64,
                  token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  let session = SettingsWebSession(port: port, token: token) else {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
            }
            webSession = session
            onWebSessionChange?(session)
            return try? CaptureProtocol.encodeResultSuccess(id: id, data: Optional<String>.none)
        }
        if name == "keychain.rotate" {
            guard Set(message.keys) == ["type", "id", "name"] else {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
            }
            do {
                let replacement = try keyStore.rotateMasterKey()
                guard replacement.count == 32 else { throw SideKeychainError.invalidMasterKey }
                return try CaptureProtocol.encodeResultSuccess(
                    id: id, data: ["key": replacement.base64EncodedString()]
                )
            } catch {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "keychain-unavailable")
            }
        }
        return Self.replyForProviderCommand(line, keyStore: keyStore)
    }

    func replyForKeychainCommand(_ line: Data) async -> Data? {
        let store = keyStore
        let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
        guard message?["name"] as? String == "keychain.rotate" else {
            return await Task.detached(priority: .userInitiated) {
                Self.replyForCommand(line, keyStore: store)
            }.value
        }
        if let rotationTask { return await rotationTask.value }
        let task = Task.detached(priority: .userInitiated) {
            Self.replyForCommand(line, keyStore: store)
        }
        rotationTask = task
        let reply = await task.value
        rotationTask = nil
        return reply
    }

    func replyForProviderCommand(_ line: Data) async -> Data? {
        await replyForKeychainCommand(line)
    }

    private nonisolated static func replyForCommand(_ line: Data, keyStore: SideKeyStore) -> Data? {
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              message["type"] as? String == "command",
              message["name"] as? String == "keychain.rotate" else {
            return Self.replyForProviderCommand(line, keyStore: keyStore)
        }
        guard let id = message["id"] as? String, Set(message.keys) == ["type", "id", "name"] else {
            let id = message["id"] as? String ?? ""
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
        }
        do {
            let replacement = try keyStore.rotateMasterKey()
            guard replacement.count == 32 else { throw SideKeychainError.invalidMasterKey }
            return try CaptureProtocol.encodeResultSuccess(
                id: id, data: ["key": replacement.base64EncodedString()]
            )
        } catch {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "keychain-unavailable")
        }
    }

    private nonisolated static func replyForProviderCommand(_ line: Data, keyStore: SideKeyStore) -> Data? {
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              message["type"] as? String == "command",
              let id = message["id"] as? String,
              let name = message["name"] as? String,
              ["keychain.set", "keychain.get", "keychain.status", "keychain.authorize"].contains(name) else { return nil }
        guard Set(message.keys) == ["type", "id", "name", "args"] else {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
        }
        guard let args = message["args"] as? [String: Any],
              Set(args.keys) == (name == "keychain.set" ? ["ref", "secret"] : ["ref"]),
              let ref = args["ref"] as? String, !ref.isEmpty else {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
        }
        do {
            if name == "keychain.set" {
                guard let secret = args["secret"] as? String, !secret.isEmpty else {
                    return try CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
                }
                try keyStore.setProviderKey(ref: ref, secret: secret)
                return try CaptureProtocol.encodeResultSuccess(id: id, data: ["ref": ref])
            }
            if name == "keychain.status" {
                let status = try keyStore.providerKeyStatus(ref: ref)
                return try CaptureProtocol.encodeResultSuccess(
                    id: id, data: ["stored": status.stored, "accessible": status.accessible]
                )
            }
            if name == "keychain.authorize" {
                let authorized = try keyStore.authorizeProviderKey(ref: ref)
                return try CaptureProtocol.encodeResultSuccess(id: id, data: ["authorized": authorized])
            }
            let secret = try keyStore.providerKey(ref: ref)
            return try CaptureProtocol.encodeResultSuccess(id: id, data: secret)
        } catch {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "keychain-unavailable")
        }
    }

    private func launch() {
        launchGeneration += 1
        let generation = launchGeneration
        launchPending = true
        clearWebSession()
        guard launchGeneration == generation else { return }
        state = .starting
        guard launchGeneration == generation else { return }
        let store = keyStore
        let version = appVersion
        let pendingRotation = rotationTask
        Task.detached(priority: .userInitiated) { [weak self] in
            await pendingRotation?.value
            let hello = try? CaptureProtocol.encodeHello(key: store.masterKey(), appVersion: version)
            await self?.finishLaunch(hello, generation: generation)
        }
    }

    private func finishLaunch(_ hello: Data?, generation: Int) {
        guard launchGeneration == generation else { return }
        launchPending = false
        guard let hello else {
            state = .keychainLocked
            return
        }
        let child = makeProcess()
        let stdin = Pipe()
        let stdout = Pipe()
        child.standardInput = stdin
        child.standardOutput = stdout
        child.terminationHandler = { [weak self] terminated in
            Task { @MainActor in self?.didExit(terminated) }
        }
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            Task { @MainActor in self?.receive(bytes, from: child) }
        }
        do {
            try child.run()
            process = child
            input = stdin
            output = stdout
            recovering = false
            let writer = DaemonFrameWriter(
                handle: stdin.fileHandleForWriting,
                writeData: writeData,
                onFailure: { [weak self, weak child] _ in
                    Task { @MainActor in
                        guard let self, let child else { return }
                        self.terminateForRecovery(child, reason: "write-error")
                    }
                }
            )
            self.writer = writer
            try writer.enqueue(hello)
            Self.logger.info("daemon.started pid=\(child.processIdentifier, privacy: .public)")
            if let onProcessReady {
                onProcessReady()
            } else {
                try? sendHealth(HelperHealth())
            }
        } catch {
            Self.logger.warning("daemon.launch.failed code=\((error as NSError).code, privacy: .public)")
            stdout.fileHandleForReading.readabilityHandler = nil
            writer?.close()
            writer = nil
            if child.isRunning { terminateForRecovery(child, reason: "launch-failure") }
            else {
                process = nil
                input = nil
                output = nil
                scheduleRestart()
            }
        }
    }

    private func receive(_ bytes: Data, from child: Process) {
        guard process === child, !bytes.isEmpty else { return }
        for byte in bytes {
            if byte == 0x0A {
                let command = frame
                frame.removeAll(keepingCapacity: true)
                Task { [weak self] in await self?.handleCommand(command, from: child) }
            } else {
                guard frame.count < CaptureProtocol.maxRawBytes - 1 else {
                    Self.logger.warning("daemon.transport.failed reason=oversized-frame")
                    terminateForRecovery(child, reason: "oversized-frame")
                    return
                }
                frame.append(byte)
            }
        }
    }

    private func handleCommand(_ line: Data, from child: Process) async {
        guard process === child else { return }
        if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
            if message["type"] as? String == "protocol-error" {
                Self.logger.warning("daemon.transport.failed reason=protocol-error")
                terminateForRecovery(child, reason: "protocol-error")
                return
            }
            if message["type"] as? String == "pong",
               let id = message["id"] as? String, id == pendingPing?.id {
                pendingPing = nil
                return
            }
        }
        let commandName = (try? JSONSerialization.jsonObject(with: line) as? [String: Any])?["name"] as? String
        let keychainReply: Data?
        if let commandName, ["keychain.rotate", "keychain.set", "keychain.get", "keychain.status", "keychain.authorize"].contains(commandName) {
            keychainReply = await replyForKeychainCommand(line)
        } else {
            keychainReply = replyForCommand(line)
        }
        if let reply = keychainReply {
            try? write(reply, to: child)
            return
        }
        guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              command["type"] as? String == "command",
              let id = command["id"] as? String else { return }
        let routedReply = await onOtherCommand?(line)
        guard process === child else { return }
        let reply: Data?
        if let routedReply, Self.isCorrelatedResult(routedReply, id: id) {
            reply = routedReply
        } else {
            reply = try? CaptureProtocol.encodeResultFailure(
                id: id, error: routedReply == nil ? "unavailable" : "invalid-result"
            )
        }
        if let reply { try? write(reply, to: child) }
    }

    private func write(_ line: Data, to child: Process) throws {
        guard process === child, child.isRunning, let writer else {
            throw SupervisorTransportError.notRunning
        }
        try writer.enqueue(line)
    }

    private static func isAppFrame(_ line: Data) -> Bool {
        guard isSingleLine(line),
              let message = try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any],
              let type = message["type"] as? String else { return false }
        switch type {
        case "event":
            return Set(message.keys) == ["type", "event"] && message["event"] is [String: Any]
        case "health":
            return Set(message.keys) == ["type", "health"] && message["health"] is [String: Any]
        default:
            return false
        }
    }

    private static func isCorrelatedResult(_ line: Data, id: String) -> Bool {
        guard isSingleLine(line),
              let message = try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any],
              message["type"] as? String == "result", message["id"] as? String == id,
              let ok = message["ok"] as? Bool else { return false }
        if ok { return Set(message.keys) == ["type", "id", "ok", "data"] }
        return Set(message.keys) == ["type", "id", "ok", "error"] && message["error"] is String
    }

    private static func isSingleLine(_ line: Data) -> Bool {
        guard line.count <= CaptureProtocol.maxRawBytes, line.last == 0x0A else { return false }
        let body = line.dropLast()
        return !body.contains(0x0A) && !body.contains(0x0D) && String(data: body, encoding: .utf8) != nil
    }

    private func didExit(_ child: Process) {
        guard process === child else { return }
        output?.fileHandleForReading.readabilityHandler = nil
        watchdogTask?.cancel()
        watchdogTask = nil
        killTask?.cancel()
        killTask = nil
        writer?.close()
        writer = nil
        process = nil
        input = nil
        output = nil
        pendingPing = nil
        recovering = false
        frame.removeAll()
        clearWebSession()
        Self.logger.warning("daemon.exited pid=\(child.processIdentifier, privacy: .public) reason=\(child.terminationReason.rawValue, privacy: .public) status=\(child.terminationStatus, privacy: .public)")
        scheduleRestart()
    }

    private func startWatchdog() {
        watchdogTask?.cancel()
        pendingPing = nil
        watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64((self?.pingInterval ?? 5) * 1_000_000_000))
                guard !Task.isCancelled, let self, let child = self.process, self.state == .running else { return }
                if let pending = self.pendingPing {
                    if Date().timeIntervalSince(pending.sentAt) >= self.pingTimeout {
                        self.terminateForRecovery(child, reason: "ping-timeout")
                    }
                    continue
                }
                self.pingSequence += 1
                let id = "native-\(self.pingSequence)"
                do {
                    try self.write(try CaptureProtocol.encodePing(id: id), to: child)
                    self.pendingPing = (id, Date())
                } catch {
                    self.terminateForRecovery(child, reason: "ping-write")
                }
            }
        }
    }

    private func terminateForRecovery(_ child: Process, reason: String) {
        guard process === child, child.isRunning, !recovering else { return }
        recovering = true
        watchdogTask?.cancel()
        watchdogTask = nil
        pendingPing = nil
        writer?.close()
        Self.logger.warning("daemon.recovery.terminating reason=\(reason, privacy: .public)")
        child.terminate()
        killTask = Task { [weak self, weak child] in
            try? await Task.sleep(nanoseconds: UInt64((self?.terminationGrace ?? 5) * 1_000_000_000))
            guard !Task.isCancelled, let self, let child, self.process === child, child.isRunning else { return }
            _ = kill(child.processIdentifier, SIGKILL)
        }
    }

    private func scheduleRestart() {
        switch policy.recordAbnormalExit(at: Date()) {
        case .captureNotRunning:
            Self.logger.error("daemon.recovery.exhausted")
            state = .captureNotRunning
        case .restart(let delay):
            Self.logger.warning("daemon.recovery.scheduled delay=\(delay, privacy: .public)")
            state = .waitingToRestart(delay)
            restartTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.restartTask = nil
                self?.launch()
            }
        }
    }

    private func clearWebSession() {
        guard webSession != nil else { return }
        webSession = nil
        onWebSessionChange?(nil)
    }
}
