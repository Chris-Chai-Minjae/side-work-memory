import AppKit
import ApplicationServices
import Carbon
import Foundation
import SideCaptureKit

struct CaptureEvent: Encodable {
    enum Kind: String, Encodable {
        case sessionStarted = "session.started"
        case sessionEnded = "session.ended"
        case windowChanged = "window.changed"
        case mouseClick = "mouse.click"
        case mouseContextMenu = "mouse.context_menu"
        case mouseDrag = "mouse.drag"
        case keyboardShortcut = "keyboard.shortcut"
        case keyboardSubmit = "keyboard.submit"
        case keyboardTextInput = "keyboard.text_input"
        case selectionChanged = "selection.changed"
    }

    let kind: Kind
    let source = "mac_ax"
    let occurredAt: Int64
    let bundleId: String?
    let appName: String?
    let windowTitle: String?
    let url: String?
    let windowId: UInt32?
    let role: String?
    let label: String?
    let chord: String?
    let text: String?
    let reason: String?
}

final class CaptureStream {
    private let output: (CaptureEvent) -> Void
    private let secureInputEnabled: () -> Bool
    private let browserPrivacyAllowed: (String) -> Bool
    private let browserURL: ((String) -> String?)?
    private let foregroundWindowID: (String) -> UInt32?
    private var deniedBundleIDs: Set<String> = []
    private(set) var captureTypedText = true
    private var paused = true
    private(set) var activeBundleID: String?
    private var activeAppName: String?
    private(set) var generation = 0
    var isSecureInputEnabled: Bool { secureInputEnabled() }

    init(
        output: @escaping (CaptureEvent) -> Void = CaptureStream.writeToStdout,
        secureInputEnabled: @escaping () -> Bool = { IsSecureEventInputEnabled() },
        browserPrivacyAllowed: @escaping (String) -> Bool = { _ in true },
        browserURL: ((String) -> String?)? = nil,
        foregroundWindowID: @escaping (String) -> UInt32? = { _ in nil }
    ) {
        self.output = output
        self.secureInputEnabled = secureInputEnabled
        self.browserPrivacyAllowed = browserPrivacyAllowed
        self.browserURL = browserURL
        self.foregroundWindowID = foregroundWindowID
    }

    func configure(deniedBundleIds: Set<String>, captureTypedText: Bool, paused: Bool) {
        deniedBundleIDs = deniedBundleIds
        self.captureTypedText = captureTypedText
        self.paused = paused
    }

    func invalidateSession() {
        generation += 1
        activeBundleID = nil
        activeAppName = nil
    }

    @discardableResult
    func activate(bundleID: String, appName: String) -> Bool {
        activeBundleID = bundleID
        activeAppName = appName
        return mayObserve(bundleID: bundleID)
    }

    func mayObserve(bundleID: String) -> Bool {
        guard !paused, !bundleID.isEmpty, activeBundleID == bundleID else { return false }
        guard !isExcluded(bundleID: bundleID) else { return false }
        return browserPrivacyAllowed(bundleID)
    }

    func isExcluded(bundleID: String) -> Bool {
        deniedBundleIDs.contains(bundleID) || HardBlockedBundleIDs.all.contains(bundleID) ||
            bundleID == Bundle.main.bundleIdentifier
    }

    func emit(
        _ kind: CaptureEvent.Kind,
        bundleID: String,
        windowTitle: String? = nil,
        role: String? = nil,
        label: String? = nil,
        chord: String? = nil,
        text: String? = nil,
        reason: String? = nil
    ) {
        guard mayObserve(bundleID: bundleID) else { return }
        if kind == .keyboardShortcut || kind == .keyboardSubmit ||
            kind == .keyboardTextInput || kind == .selectionChanged {
            guard !isSecureInputEnabled else { return }
        }
        guard kind != .keyboardTextInput || captureTypedText else { return }
        let url = browserURL?(bundleID)
        if browserURL != nil && BrowserCapture.urlScript(for: bundleID) != nil && url == nil { return }
        output(CaptureEvent(
            kind: kind, occurredAt: Self.nowMillis(), bundleId: bundleID,
            appName: activeAppName, windowTitle: windowTitle, url: url,
            windowId: foregroundWindowID(bundleID), role: role,
            label: label, chord: chord, text: text, reason: reason
        ))
    }

    func emitSession(_ kind: CaptureEvent.Kind, reason: String) {
        guard !paused else { return }
        output(CaptureEvent(
            kind: kind, occurredAt: Self.nowMillis(), bundleId: nil,
            appName: nil, windowTitle: nil, url: nil, windowId: nil, role: nil, label: nil,
            chord: nil, text: nil, reason: reason
        ))
    }

    private static func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }

    private static func writeToStdout(_ event: CaptureEvent) {
        guard let line = try? CaptureProtocol.encodeEvent(event) else { return }
        FileHandle.standardOutput.write(line)
    }
}

final class AXObserverHub {
    private let stream: CaptureStream
    private let isTrusted: () -> Bool
    private let createObserver: (pid_t, AXObserverCallback) -> AXObserver?
    private let registerNotification: (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?) -> AXError
    private var observer: AXObserver?
    private var application: AXUIElement?
    private var focusedWindow: AXUIElement?
    private var focusedElement: AXUIElement?
    private var registrations: [(AXUIElement, CFString)] = []
    private var failedRegistrations: [(AXUIElement, CFString)] = []
    private var observerCreationFailed = false
    private var bundleID: String?
    private var previousValue: String?
    private var pendingText = ""
    private var fieldLabel: String?
    private(set) var isTextFieldFocused = false
    private let now: () -> Date
    private var lastInputAt: Date?
    private var idleFlushTimer: Timer?
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0
    private var activePID: pid_t?
    private var activeAppName: String?
    private(set) var registrationAttempts = 0
    var observerRegistrationFailures: Int {
        failedRegistrations.count + (observerCreationFailed ? 1 : 0)
    }

    init(
        stream: CaptureStream, now: @escaping () -> Date = { Date() },
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        createObserver: @escaping (pid_t, AXObserverCallback) -> AXObserver? = { pid, callback in
            var observer: AXObserver?
            return AXObserverCreate(pid, callback, &observer) == .success ? observer : nil
        },
        registerNotification: @escaping (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?) -> AXError = {
            AXObserverAddNotification($0, $1, $2, $3)
        }
    ) {
        self.stream = stream
        self.now = now
        self.isTrusted = isTrusted
        self.createObserver = createObserver
        self.registerNotification = registerNotification
    }

    deinit { stop() }

    func configure(deniedBundleIds: Set<String>, captureTypedText: Bool, paused: Bool) {
        stream.configure(deniedBundleIds: deniedBundleIds, captureTypedText: captureTypedText, paused: paused)
        if let bundleID, !stream.mayObserve(bundleID: bundleID) { stop() }
        else if observer != nil { refreshFocusedElement() }
    }

    func activate(bundleID: String, appName: String, pid: pid_t) {
        stop()
        self.bundleID = bundleID
        activePID = pid
        activeAppName = appName
        retryAttempt = 0
        registerObserver(reason: "activation")
    }

    private func registerObserver(reason: String) {
        retryTask?.cancel()
        retryTask = nil
        if let observer {
            for (element, name) in registrations {
                AXObserverRemoveNotification(observer, element, name)
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        registrations.removeAll()
        failedRegistrations.removeAll()
        observer = nil
        application = nil
        focusedWindow = nil
        focusedElement = nil
        guard let bundleID, let activePID, let activeAppName else { return }
        guard stream.activate(bundleID: bundleID, appName: activeAppName) else { return }
        guard isTrusted() else {
            stream.emit(.windowChanged, bundleID: bundleID, reason: reason)
            return
        }

        registrationAttempts += 1
        guard let newObserver = createObserver(activePID, Self.callback) else {
            observerCreationFailed = true
            stream.emit(.windowChanged, bundleID: bundleID, reason: reason)
            scheduleRetry()
            return
        }
        observerCreationFailed = false
        observer = newObserver
        let app = AXUIElementCreateApplication(activePID)
        application = app
        addNotification(kAXFocusedWindowChangedNotification as CFString, to: app)
        addNotification(kAXFocusedUIElementChangedNotification as CFString, to: app)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(newObserver), .commonModes)
        refreshFocusedWindow(reason: reason)
        refreshFocusedElement()
        if observerRegistrationFailures == 0 { retryAttempt = 0 }
        else { scheduleRetry() }
    }

    private func scheduleRetry() {
        guard retryTask == nil, bundleID != nil else { return }
        retryAttempt += 1
        let delay = min(pow(2.0, Double(retryAttempt - 1)), 30.0)
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await MainActor.run { self.registerObserver(reason: "retry") }
        }
    }

    func stop() {
        retryTask?.cancel()
        retryTask = nil
        retryAttempt = 0
        activePID = nil
        activeAppName = nil
        idleFlushTimer?.invalidate()
        idleFlushTimer = nil
        flushTypedText()
        if let observer {
            for (element, name) in registrations {
                AXObserverRemoveNotification(observer, element, name)
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        registrations.removeAll()
        failedRegistrations.removeAll()
        observerCreationFailed = false
        observer = nil
        application = nil
        focusedWindow = nil
        focusedElement = nil
        bundleID = nil
        previousValue = nil
        pendingText = ""
        fieldLabel = nil
        isTextFieldFocused = false
        lastInputAt = nil
    }

    var focusedTextFieldLabel: String? { fieldLabel }

    func recordSelection(_ text: String, bundleID: String) {
        guard stream.mayObserve(bundleID: bundleID), !stream.isSecureInputEnabled,
              !text.isEmpty else { return }
        let limited = Self.prefixUTF8(text, maxBytes: 600)
        stream.emit(.selectionChanged, bundleID: bundleID, label: fieldLabel, text: limited)
    }

    func recordValueChange(_ value: String, bundleID: String, field: FieldMetadata) {
        guard shouldReadAXValue(bundleID: bundleID, field: field) else { return }
        self.bundleID = bundleID
        guard value.utf16.count <= 20_000 else {
            previousValue = nil
            pendingText = ""
            lastInputAt = nil
            idleFlushTimer?.invalidate()
            return
        }
        guard let previousValue else {
            self.previousValue = value
            pendingText = ""
            lastInputAt = nil
            idleFlushTimer?.invalidate()
            return
        }
        guard value.hasPrefix(previousValue) else {
            self.previousValue = value
            pendingText = ""
            lastInputAt = nil
            idleFlushTimer?.invalidate()
            return
        }
        let appended = value.dropFirst(previousValue.count)
        self.previousValue = value
        guard !appended.isEmpty else { return }
        pendingText += appended
        guard pendingText.utf8.count <= 4_096 else {
            pendingText = ""
            lastInputAt = nil
            idleFlushTimer?.invalidate()
            return
        }
        lastInputAt = now()
        let bufferedText = pendingText
        var start = bufferedText.startIndex
        var completedSentences: [String] = []
        for index in bufferedText.indices where ".!?。！？\n".contains(bufferedText[index]) {
            let end = bufferedText.index(after: index)
            let sentence = String(bufferedText[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            if sentence.utf16.count >= 3 {
                completedSentences.append(sentence)
            }
            start = end
        }
        pendingText = String(bufferedText[start...])
        if pendingText.isEmpty { lastInputAt = nil }
        scheduleDraftFlush()
        let label = fieldLabel
        for sentence in completedSentences {
            stream.emit(.keyboardTextInput, bundleID: bundleID, label: label, text: sentence)
        }
    }

    func flushTypedText() {
        guard let bundleID else { return }
        let draft = pendingText.trimmingCharacters(in: .whitespacesAndNewlines)
        pendingText = ""
        lastInputAt = nil
        idleFlushTimer?.invalidate()
        idleFlushTimer = nil
        if draft.utf16.count >= 3 {
            stream.emit(.keyboardTextInput, bundleID: bundleID, label: fieldLabel, text: draft)
        }
    }

    func flushDraftIfIdle() {
        guard let lastInputAt, now().timeIntervalSince(lastInputAt) >= 300 else { return }
        flushTypedText()
    }

    private func scheduleDraftFlush() {
        idleFlushTimer?.invalidate()
        idleFlushTimer = nil
        guard !pendingText.isEmpty else { return }
        let timer = Timer(timeInterval: 300, repeats: false) { [weak self] _ in self?.flushDraftIfIdle() }
        idleFlushTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func shouldReadAXValue(bundleID: String, field: FieldMetadata) -> Bool {
        stream.mayObserve(bundleID: bundleID) && stream.captureTypedText &&
            !stream.isSecureInputEnabled &&
            (field.role == "AXTextField" || field.role == "AXTextArea") &&
            FieldLabels.blockedRule(for: field) == nil
    }

    private static let callback: AXObserverCallback = { _, element, notification, refcon in
        guard let refcon else { return }
        let hub = Unmanaged<AXObserverHub>.fromOpaque(refcon).takeUnretainedValue()
        hub.handleNotification(element: element, name: notification)
    }

    private func addNotification(_ name: CFString, to element: AXUIElement) {
        guard let observer else { return }
        if registerNotification(observer, element, name, Unmanaged.passUnretained(self).toOpaque()) == .success {
            registrations.append((element, name))
            failedRegistrations.removeAll { $0.0 == element && $0.1 == name }
        } else if !failedRegistrations.contains(where: { $0.0 == element && $0.1 == name }) {
            failedRegistrations.append((element, name))
        }
    }

    private func handleNotification(element: AXUIElement, name: CFString) {
        guard let bundleID, stream.mayObserve(bundleID: bundleID),
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return }
        switch name as String {
        case "AXFocusedWindowChanged":
            refreshFocusedWindow(reason: "focus")
        case "AXTitleChanged":
            refreshFocusedWindow(reason: "title")
        case "AXFocusedUIElementChanged":
            flushTypedText()
            refreshFocusedElement()
        case "AXSelectedTextChanged":
            guard !stream.isSecureInputEnabled, let field = focusedFieldMetadata(),
                  FieldLabels.blockedRule(for: field) == nil,
                  let text = Self.attribute(element, kAXSelectedTextAttribute as CFString) as? String else { return }
            recordSelection(text, bundleID: bundleID)
        case "AXValueChanged":
            guard let field = focusedFieldMetadata(), shouldReadAXValue(bundleID: bundleID, field: field),
                  let value = Self.attribute(element, kAXValueAttribute as CFString) as? String else { return }
            recordValueChange(value, bundleID: bundleID, field: field)
        default:
            break
        }
    }

    private func refreshFocusedWindow(reason: String) {
        guard let bundleID, stream.mayObserve(bundleID: bundleID), let application else { return }
        if let old = focusedWindow, let observer {
            AXObserverRemoveNotification(observer, old, kAXTitleChangedNotification as CFString)
            registrations.removeAll { $0.0 == old && $0.1 == kAXTitleChangedNotification as CFString }
        }
        if let old = focusedWindow {
            failedRegistrations.removeAll { $0.0 == old && $0.1 == kAXTitleChangedNotification as CFString }
        }
        focusedWindow = Self.axElement(Self.attribute(application, kAXFocusedWindowAttribute as CFString))
        if let focusedWindow {
            addNotification(kAXTitleChangedNotification as CFString, to: focusedWindow)
        }
        let title = focusedWindow.flatMap { Self.attribute($0, kAXTitleAttribute as CFString) as? String }
        stream.emit(.windowChanged, bundleID: bundleID, windowTitle: title, reason: reason)
    }

    private func refreshFocusedElement() {
        guard let bundleID, stream.mayObserve(bundleID: bundleID), let application else { return }
        if let old = focusedElement, let observer {
            for name in [kAXValueChangedNotification, kAXSelectedTextChangedNotification] {
                AXObserverRemoveNotification(observer, old, name as CFString)
                registrations.removeAll { $0.0 == old && $0.1 == name as CFString }
            }
        }
        if let old = focusedElement {
            failedRegistrations.removeAll {
                $0.0 == old && ($0.1 == kAXValueChangedNotification as CFString ||
                    $0.1 == kAXSelectedTextChangedNotification as CFString)
            }
        }
        focusedElement = Self.axElement(Self.attribute(application, kAXFocusedUIElementAttribute as CFString))
        previousValue = nil
        pendingText = ""
        fieldLabel = nil
        isTextFieldFocused = false
        lastInputAt = nil
        idleFlushTimer?.invalidate()
        idleFlushTimer = nil
        guard let focusedElement, let field = focusedFieldMetadata(),
              FieldLabels.blockedRule(for: field) == nil else { return }
        fieldLabel = field.title ?? field.description ?? field.placeholder
        addNotification(kAXSelectedTextChangedNotification as CFString, to: focusedElement)
        isTextFieldFocused = field.role == "AXTextField" || field.role == "AXTextArea"
        if shouldReadAXValue(bundleID: bundleID, field: field) {
            addNotification(kAXValueChangedNotification as CFString, to: focusedElement)
            previousValue = Self.attribute(focusedElement, kAXValueAttribute as CFString) as? String
        }
    }

    private func focusedFieldMetadata() -> FieldMetadata? {
        guard let focusedElement else { return nil }
        return FieldMetadata(
            role: Self.attribute(focusedElement, kAXRoleAttribute as CFString) as? String,
            subrole: Self.attribute(focusedElement, kAXSubroleAttribute as CFString) as? String,
            title: Self.attribute(focusedElement, kAXTitleAttribute as CFString) as? String,
            description: Self.attribute(focusedElement, kAXDescriptionAttribute as CFString) as? String,
            placeholder: Self.attribute(focusedElement, kAXPlaceholderValueAttribute as CFString) as? String
        )
    }

    static func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
        return value
    }

    static func axElement(_ value: Any?) -> AXUIElement? {
        guard let value, CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
    }

    private static func prefixUTF8(_ text: String, maxBytes: Int) -> String {
        var result = ""
        var count = 0
        for scalar in text.unicodeScalars {
            let size = scalar.utf8.count
            guard count + size <= maxBytes else { break }
            result.unicodeScalars.append(scalar)
            count += size
        }
        return result
    }
}
