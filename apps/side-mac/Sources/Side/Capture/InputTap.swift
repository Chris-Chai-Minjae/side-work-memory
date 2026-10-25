import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import SideCaptureKit

final class InputTap {
    private let stream: CaptureStream
    private weak var observerHub: AXObserverHub?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var dragStart: CGPoint?
    private var dragReported = false
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0

    init(stream: CaptureStream, observerHub: AXObserverHub? = nil) {
        self.stream = stream
        self.observerHub = observerHub
    }

    deinit { stop() }

    var isRunning: Bool { tap != nil }

    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        retryTask?.cancel()
        retryTask = nil
        let types: [CGEventType] = [.keyDown, .leftMouseDown, .leftMouseUp, .rightMouseDown, .leftMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let newTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: Self.callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ), let newSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else {
            scheduleRetry()
            return false
        }
        retryAttempt = 0
        tap = newTap
        source = newSource
        CFRunLoopAddSource(CFRunLoopGetMain(), newSource, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        return true
    }

    private func scheduleRetry() {
        guard retryTask == nil else { return }
        retryAttempt += 1
        let delay = min(pow(2.0, Double(retryAttempt - 1)), 30.0)
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await MainActor.run { _ = self.start() }
        }
    }

    func stop() {
        retryTask?.cancel()
        retryTask = nil
        retryAttempt = 0
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        source = nil
        tap = nil
        dragStart = nil
        dragReported = false
    }

    func handleKeyDown(
        keyCode: UInt16, flags: CGEventFlags, bundleID: String,
        focusedFieldLabel: String?, textFieldFocused: Bool = false
    ) {
        guard stream.mayObserve(bundleID: bundleID), !stream.isSecureInputEnabled else { return }
        if keyCode == 0x24, textFieldFocused {
            stream.emit(.keyboardSubmit, bundleID: bundleID, label: focusedFieldLabel)
            observerHub?.flushTypedText()
            return
        }
        var modifiers: ChordModifiers = []
        if flags.contains(.maskControl) { modifiers.insert(.control) }
        if flags.contains(.maskAlternate) { modifiers.insert(.option) }
        if flags.contains(.maskShift) { modifiers.insert(.shift) }
        if flags.contains(.maskCommand) { modifiers.insert(.command) }
        guard let chord = Chord.notation(keyCode: keyCode, modifiers: modifiers) else { return }
        stream.emit(.keyboardShortcut, bundleID: bundleID, chord: chord)
    }

    func handlePointer(kind: CaptureEvent.Kind, bundleID: String, role: String?, label: String?) {
        guard kind == .mouseClick || kind == .mouseContextMenu || kind == .mouseDrag,
              stream.mayObserve(bundleID: bundleID) else { return }
        let field = FieldMetadata(role: role, title: label)
        let safeLabel = FieldLabels.blockedRule(for: field) == nil ? label : nil
        stream.emit(kind, bundleID: bundleID, role: role, label: safeLabel)
    }

    private static let callback: CGEventTapCallBack = { proxy, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let inputTap = Unmanaged<InputTap>.fromOpaque(userInfo).takeUnretainedValue()
        inputTap.process(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    private func process(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier,
              stream.mayObserve(bundleID: bundleID) else { return }
        switch type {
        case .keyDown:
            guard !stream.isSecureInputEnabled else { return }
            let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
            handleKeyDown(
                keyCode: keyCode, flags: event.flags, bundleID: bundleID,
                focusedFieldLabel: observerHub?.focusedTextFieldLabel,
                textFieldFocused: observerHub?.isTextFieldFocused ?? false
            )
        case .leftMouseDown:
            dragStart = event.location
            dragReported = false
            emitPointer(.mouseClick, bundleID: bundleID, pid: app.processIdentifier, at: event.location)
        case .rightMouseDown:
            emitPointer(.mouseContextMenu, bundleID: bundleID, pid: app.processIdentifier, at: event.location)
        case .leftMouseDragged:
            guard !dragReported, let dragStart else { return }
            dragReported = true
            emitPointer(.mouseDrag, bundleID: bundleID, pid: app.processIdentifier, at: dragStart)
        case .leftMouseUp:
            dragStart = nil
            dragReported = false
        default:
            break
        }
    }

    private func emitPointer(_ kind: CaptureEvent.Kind, bundleID: String, pid: pid_t, at point: CGPoint) {
        guard stream.mayObserve(bundleID: bundleID) else { return }
        let application = AXUIElementCreateApplication(pid)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &element) == .success,
              let element else {
            handlePointer(kind: kind, bundleID: bundleID, role: nil, label: nil)
            return
        }
        let role = AXObserverHub.attribute(element, kAXRoleAttribute as CFString) as? String
        let title = AXObserverHub.attribute(element, kAXTitleAttribute as CFString) as? String
        let description = AXObserverHub.attribute(element, kAXDescriptionAttribute as CFString) as? String
        let placeholder = AXObserverHub.attribute(element, kAXPlaceholderValueAttribute as CFString) as? String
        handlePointer(kind: kind, bundleID: bundleID, role: role, label: title ?? description ?? placeholder)
    }
}
