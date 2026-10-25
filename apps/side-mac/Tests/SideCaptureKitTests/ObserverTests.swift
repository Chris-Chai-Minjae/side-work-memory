import ApplicationServices
import CoreGraphics
import Foundation
import XCTest
@testable import Side
import SideCaptureKit

final class ObserverTests: XCTestCase {
    func testSensitiveApplicationsAreHardBlockedWithoutUserRules() {
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        for bundleID in ["com.apple.Passwords", "com.bitwarden.desktop", "org.keepassxc.keepassxc"] {
            XCTAssertTrue(stream.isExcluded(bundleID: bundleID), bundleID)
        }
    }

    func testAXCreationFailureIsCountedUntilSuccessfulRegistration() {
        var failCreation = true
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let hub = AXObserverHub(
            stream: stream, isTrusted: { true },
            createObserver: { pid, callback in
                guard !failCreation else { return nil }
                var observer: AXObserver?
                XCTAssertEqual(AXObserverCreate(pid, callback, &observer), .success)
                return observer
            },
            registerNotification: { _, _, _, _ in .success }
        )

        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        XCTAssertEqual(hub.registrationAttempts, 1)
        XCTAssertEqual(hub.observerRegistrationFailures, 1)

        failCreation = false
        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        XCTAssertEqual(hub.observerRegistrationFailures, 0)
    }

    func testAXCreationFailureRetriesAfterBackoffWithoutNewActivation() async throws {
        var failCreation = true
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let recovered = expectation(description: "AX observer recreated after backoff")
        let hub = AXObserverHub(
            stream: stream, isTrusted: { true },
            createObserver: { pid, callback in
                guard !failCreation else { return nil }
                var observer: AXObserver?
                XCTAssertEqual(AXObserverCreate(pid, callback, &observer), .success)
                recovered.fulfill()
                return observer
            },
            registerNotification: { _, _, _, _ in .success }
        )
        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        failCreation = false

        await fulfillment(of: [recovered], timeout: 2)
        XCTAssertEqual(hub.registrationAttempts, 2)
        XCTAssertEqual(hub.observerRegistrationFailures, 0)
        hub.stop()
    }

    func testFailedAXNotificationIsCountedEvenWhenAnotherRegistrationSucceeds() {
        var failWindowNotification = true
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let hub = AXObserverHub(
            stream: stream, isTrusted: { true },
            registerNotification: { _, _, name, _ in
                if failWindowNotification && name == kAXFocusedWindowChangedNotification as CFString {
                    return .failure
                }
                return .success
            }
        )

        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        XCTAssertEqual(hub.observerRegistrationFailures, 1)

        failWindowNotification = false
        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        XCTAssertEqual(hub.observerRegistrationFailures, 0)
    }

    func testUntrustedAccessibilityDoesNotCountAsAXRegistrationFailure() {
        var createCalls = 0
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let hub = AXObserverHub(
            stream: stream, isTrusted: { false },
            createObserver: { _, _ in createCalls += 1; return nil }
        )

        hub.activate(bundleID: "com.example.synthetic", appName: "Synthetic", pid: getpid())
        XCTAssertEqual(createCalls, 0)
        XCTAssertEqual(hub.registrationAttempts, 0)
        XCTAssertEqual(hub.observerRegistrationFailures, 0)
    }

    func testWorkspaceNotifiesBrowserActivationBeforeAXRegistration() {
        var activated: [String] = []
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        let hub = AXObserverHub(stream: stream)
        let workspace = WorkspaceObserver(
            stream: stream, axObserver: hub, onActivation: { activated.append($0) }
        )

        workspace.activate(bundleID: "com.google.Chrome", appName: "Chrome", pid: 1234)

        XCTAssertEqual(activated, ["com.google.Chrome"])
        XCTAssertEqual(hub.registrationAttempts, 0)
    }

    func testDeniedBrowserDoesNotRequestAutomationOnActivation() {
        var activated: [String] = []
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: ["com.google.Chrome"], captureTypedText: true, paused: false)
        let hub = AXObserverHub(stream: stream)
        let workspace = WorkspaceObserver(
            stream: stream, axObserver: hub, onActivation: { activated.append($0) }
        )

        workspace.activate(bundleID: "com.google.Chrome", appName: "Chrome", pid: 1234)

        XCTAssertTrue(activated.isEmpty)
        XCTAssertEqual(hub.registrationAttempts, 0)
    }

    func testBrowserProducerAttachesURLAndWindowIdentityOnlyWhenURLIsSafe() {
        var events: [CaptureEvent] = []
        var url: String? = nil
        let stream = CaptureStream(
            output: { events.append($0) }, secureInputEnabled: { false },
            browserPrivacyAllowed: { _ in true },
            browserURL: { _ in url }, foregroundWindowID: { _ in 17 }
        )
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.google.Chrome", appName: "Chrome")

        stream.emit(.windowChanged, bundleID: "com.google.Chrome", windowTitle: "Synthetic tab")
        XCTAssertTrue(events.isEmpty)
        url = "https://example.test/page"
        stream.emit(.windowChanged, bundleID: "com.google.Chrome", windowTitle: "Synthetic tab")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.url, "https://example.test/page")
        XCTAssertEqual(events.first?.windowId, 17)
    }

    func testPrivateBrowserBlocksEventsBeforeAnySnapshotRequest() {
        var events: [CaptureEvent] = []
        var browserSafe = false
        let stream = CaptureStream(
            output: { events.append($0) }, secureInputEnabled: { false },
            browserPrivacyAllowed: { _ in browserSafe }
        )
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let hub = AXObserverHub(stream: stream)
        let tap = InputTap(stream: stream)

        hub.activate(bundleID: "com.google.Chrome", appName: "Chrome", pid: 1234)
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.google.Chrome", focusedFieldLabel: nil)
        tap.handlePointer(kind: .mouseClick, bundleID: "com.google.Chrome", role: "AXButton", label: "Private tab")
        hub.recordSelection("private selection", bundleID: "com.google.Chrome")
        XCTAssertEqual(hub.registrationAttempts, 0)
        XCTAssertTrue(events.isEmpty)

        browserSafe = true
        stream.activate(bundleID: "com.google.Chrome", appName: "Chrome")
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.google.Chrome", focusedFieldLabel: nil)
        XCTAssertEqual(events.map(\.kind), [.keyboardShortcut])

        browserSafe = false
        tap.handlePointer(kind: .mouseClick, bundleID: "com.google.Chrome", role: "AXButton", label: "Private tab")
        XCTAssertEqual(events.map(\.kind), [.keyboardShortcut])
    }

    func testCaptureStartsPausedUntilExplicitConfiguration() {
        // Given a fresh stream with no observer.configure command.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        let tap = InputTap(stream: stream)

        // When an app activates and a synthetic shortcut arrives before and after enablement.
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.example.synthetic", focusedFieldLabel: nil)
        XCTAssertTrue(events.isEmpty)
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.example.synthetic", focusedFieldLabel: nil)

        // Then capture begins only after explicit configuration.
        XCTAssertEqual(events.map(\.kind), [.keyboardShortcut])
    }

    func testDenylistedTextEditProducesNoEventsOrAXRegistration() {
        // Given a synthetic TextEdit activation and a configured app denylist.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: ["com.apple.TextEdit"], captureTypedText: true, paused: false)
        let hub = AXObserverHub(stream: stream)
        let tap = InputTap(stream: stream)

        // When TextEdit activates and sends key, pointer, selection, and value signals.
        hub.activate(bundleID: "com.apple.TextEdit", appName: "TextEdit", pid: 1234)
        tap.handleKeyDown(keyCode: 0x00, flags: .maskCommand, bundleID: "com.apple.TextEdit", focusedFieldLabel: nil)
        tap.handlePointer(kind: .mouseClick, bundleID: "com.apple.TextEdit", role: "AXButton", label: "Synthetic")
        hub.recordSelection("synthetic selection", bundleID: "com.apple.TextEdit")
        hub.recordValueChange("synthetic sentence.", bundleID: "com.apple.TextEdit", field: .init(role: "AXTextField"))

        // Then neither an AX registration nor an event reaches the output.
        XCTAssertEqual(hub.registrationAttempts, 0)
        XCTAssertTrue(events.isEmpty)
    }

    func testUnmodifiedCharacterKeyIsDiscardedAndShortcutContainsOnlyChord() throws {
        // Given an allowed synthetic app and a key-code only input path.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let tap = InputTap(stream: stream)

        // When a bare character key and then Command-S arrive.
        tap.handleKeyDown(keyCode: 0x01, flags: [], bundleID: "com.example.synthetic", focusedFieldLabel: nil)
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.example.synthetic", focusedFieldLabel: nil)

        // Then only the physical shortcut notation is emitted, with no typed text field.
        XCTAssertEqual(events.map(\.kind), [.keyboardShortcut])
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.chord, "⌘S")
        XCTAssertNil(event.text)
        let line = try CaptureProtocol.encodeEvent(event)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
        let payload = try XCTUnwrap(object["event"] as? [String: Any])
        XCTAssertNil(payload["text"])
        XCTAssertNil(payload["keyCode"])
    }

    func testPointerEventContainsElementMetadataWithoutCoordinates() throws {
        // Given an allowed app and synthetic metadata for the element under a pointer.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let tap = InputTap(stream: stream)

        // When the pointer clicks the element.
        tap.handlePointer(kind: .mouseClick, bundleID: "com.example.synthetic", role: "AXButton", label: "Open")

        // Then the wire event has role and label but no location.
        let event = try XCTUnwrap(events.first)
        let line = try CaptureProtocol.encodeEvent(event)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
        let payload = try XCTUnwrap(object["event"] as? [String: Any])
        XCTAssertEqual(payload["role"] as? String, "AXButton")
        XCTAssertEqual(payload["label"] as? String, "Open")
        XCTAssertNil(payload["x"])
        XCTAssertNil(payload["y"])
        XCTAssertNil(payload["location"])
    }

    func testSecureInputSuppressesKeyboardSelectionAndTypedText() {
        // Given an allowed app while secure event input is enabled.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { true })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let tap = InputTap(stream: stream)

        // When keyboard and AX text signals arrive.
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.example.synthetic", focusedFieldLabel: nil)
        hub.recordSelection("synthetic selection", bundleID: "com.example.synthetic")
        hub.recordValueChange("synthetic sentence.", bundleID: "com.example.synthetic", field: .init(role: "AXTextField"))

        // Then no text-related event is emitted.
        XCTAssertTrue(events.isEmpty)
    }

    func testReturnInUnlabeledTextFieldEmitsSubmitWithoutKeyText() {
        // Given an allowed app with focus in an unlabeled text field.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let tap = InputTap(stream: stream)

        // When Return is pressed without modifiers.
        tap.handleKeyDown(
            keyCode: 0x24, flags: [], bundleID: "com.example.synthetic",
            focusedFieldLabel: nil, textFieldFocused: true
        )

        // Then a submit event is produced even though the field has no label.
        XCTAssertEqual(events.map(\.kind), [.keyboardSubmit])
        XCTAssertNil(events.first?.text)
    }

    func testReturnOnNonTextElementDoesNotEmitSubmit() {
        // Given an allowed app with a labeled non-text element focused.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let tap = InputTap(stream: stream)

        // When Return is pressed while a button is focused.
        tap.handleKeyDown(keyCode: 0x24, flags: [], bundleID: "com.example.synthetic", focusedFieldLabel: "Open", textFieldFocused: false)

        // Then no keyboard.submit is generated.
        XCTAssertTrue(events.isEmpty)
    }

    func testAXValueChangeEmitsCompletedSentenceOnly() {
        // Given an allowed, non-sensitive AX text field.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let field = FieldMetadata(role: "AXTextField", title: "Note")

        // When the AX value grows and later completes a sentence.
        hub.recordValueChange("", bundleID: "com.example.synthetic", field: field)
        hub.recordValueChange("Synthetic note", bundleID: "com.example.synthetic", field: field)
        XCTAssertTrue(events.isEmpty)
        hub.recordValueChange("Synthetic note.", bundleID: "com.example.synthetic", field: field)

        // Then only the completed sentence is emitted from the AX path.
        XCTAssertEqual(events.map(\.kind), [.keyboardTextInput])
        XCTAssertEqual(events.first?.text, "Synthetic note.")
    }

    func testIdleStartsOnlyAfterMoreThan180Seconds() {
        // Given an injectable source for seconds since the last input event.
        var seconds: TimeInterval = 180
        let monitor = IdleMonitor(secondsSinceLastInput: { seconds }, secureInputEnabled: { false })

        // When the elapsed time crosses the attention threshold.
        XCTAssertFalse(monitor.isIdle)
        seconds = 181

        // Then the current reading is idle and preserves elapsed seconds.
        XCTAssertTrue(monitor.isIdle)
        XCTAssertEqual(monitor.idleSeconds, 181)
    }

    func testWorkspaceSessionSignalsEmitOneStartAndEndPerTransition() {
        // Given duplicate synthetic wake/active and lock/inactive notifications.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let workspace = WorkspaceObserver(stream: stream, axObserver: AXObserverHub(stream: stream))

        // When the session starts and ends through duplicate system signals.
        workspace.recordSessionStarted(reason: "wake")
        workspace.recordSessionStarted(reason: "active")
        workspace.recordSessionEnded(reason: "lock")
        workspace.recordSessionEnded(reason: "inactive")

        // Then the stream has exactly one event for each state transition.
        XCTAssertEqual(events.map(\.kind), [.sessionStarted, .sessionEnded])
        XCTAssertEqual(events.map(\.reason), ["wake", "lock"])
    }

    func testSessionEndInvalidatesInputAndActiveCaptureGeneration() {
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.Editor", appName: "Editor")
        var invalidations = 0
        let workspace = WorkspaceObserver(
            stream: stream, axObserver: AXObserverHub(stream: stream),
            invalidateCapture: { invalidations += 1 }
        )
        workspace.recordSessionStarted(reason: "startup")
        let generation = stream.generation

        workspace.recordSessionEnded(reason: "lock")

        XCTAssertEqual(invalidations, 1)
        XCTAssertEqual(stream.generation, generation + 1)
        XCTAssertFalse(stream.mayObserve(bundleID: "com.example.Editor"))
    }

    func testTypedDraftOverflowDropsWholeRunBeforeNextSentence() {
        // Given an allowed AX text field and a synthetic UTF-8 draft over 4096 bytes.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let field = FieldMetadata(role: "AXTextField")
        let oversized = String(repeating: "가", count: 1_500)

        // When the run overflows, is flushed, and a later sentence is appended.
        hub.recordValueChange("", bundleID: "com.example.synthetic", field: field)
        hub.recordValueChange(oversized, bundleID: "com.example.synthetic", field: field)
        hub.flushTypedText()
        XCTAssertTrue(events.isEmpty)
        hub.recordValueChange(oversized + "New.", bundleID: "com.example.synthetic", field: field)

        // Then the oversized content is absent and only the later sentence appears.
        XCTAssertEqual(events.map(\.kind), [.keyboardTextInput])
        XCTAssertEqual(events.first?.text, "New.")
    }

    func testSideBundleIsAlwaysDeniedEvenWithoutUserRule() {
        // Given the app's own bundle and an empty user denylist.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let hub = AXObserverHub(stream: stream)
        let tap = InputTap(stream: stream)

        // When the Side bundle becomes active and sends a synthetic shortcut.
        hub.activate(bundleID: "com.minjaechai.Side", appName: "Side", pid: 1234)
        tap.handleKeyDown(keyCode: 0x01, flags: .maskCommand, bundleID: "com.minjaechai.Side", focusedFieldLabel: nil)

        // Then it is never registered or emitted.
        XCTAssertEqual(hub.registrationAttempts, 0)
        XCTAssertTrue(events.isEmpty)
    }

    func testDraftFlushesAfterFiveMinutesWithoutValueChange() {
        // Given a synthetic clock and an incomplete AX text draft.
        var now = Date(timeIntervalSince1970: 1_000)
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream, now: { now })
        hub.recordValueChange("", bundleID: "com.example.synthetic", field: .init(role: "AXTextField"))
        hub.recordValueChange("Synthetic draft", bundleID: "com.example.synthetic", field: .init(role: "AXTextField"))

        // When the draft reaches the documented idle interval.
        now.addTimeInterval(299)
        hub.flushDraftIfIdle()
        XCTAssertTrue(events.isEmpty)
        now.addTimeInterval(1)
        hub.flushDraftIfIdle()

        // Then the pending text is emitted once and never repeated.
        hub.flushDraftIfIdle()
        XCTAssertEqual(events.map(\.kind), [.keyboardTextInput])
        XCTAssertEqual(events.first?.text, "Synthetic draft")
    }

    func testTypedCaptureOffAndBlockedFieldPreventAXValueRead() {
        // Given an allowed app with typed capture disabled.
        let stream = CaptureStream(output: { _ in }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: false, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)

        // When the value-read decision is made for a normal and a blocked field.
        let normalAllowed = hub.shouldReadAXValue(bundleID: "com.example.synthetic", field: .init(role: "AXTextField", title: "Note"))
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        let blockedAllowed = hub.shouldReadAXValue(bundleID: "com.example.synthetic", field: .init(role: "AXTextField", title: "Password"))

        // Then neither field value may be requested from AX.
        XCTAssertFalse(normalAllowed)
        XCTAssertFalse(blockedAllowed)
    }

    func testInitialAXValueBecomesBaselineWithoutEmission() {
        // Given an allowed field with existing synthetic content.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let field = FieldMetadata(role: "AXTextField")

        // When the initial value is observed and then a new sentence is appended.
        hub.recordValueChange("Old private draft.", bundleID: "com.example.synthetic", field: field)
        XCTAssertTrue(events.isEmpty)
        hub.recordValueChange("Old private draft. New sentence.", bundleID: "com.example.synthetic", field: field)

        // Then only the new sentence leaves the producer.
        XCTAssertEqual(events.map(\.text), ["New sentence."])
    }

    func testShortSentencesAndDraftsAreDroppedOnFlush() {
        // Given an allowed text field and a synthetic short sentence.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let field = FieldMetadata(role: "AXTextField")

        // When punctuation and submit/blur flush a run shorter than three characters.
        hub.recordValueChange("", bundleID: "com.example.synthetic", field: field)
        hub.recordValueChange("a.", bundleID: "com.example.synthetic", field: field)
        hub.recordValueChange("a. x", bundleID: "com.example.synthetic", field: field)
        hub.flushTypedText()

        // Then no text event is emitted.
        XCTAssertTrue(events.isEmpty)
    }

    func testCompletedSentencesAreTrimmedAndEmittedSeparately() {
        // Given an allowed text field with no prior value.
        var events: [CaptureEvent] = []
        let stream = CaptureStream(output: { events.append($0) }, secureInputEnabled: { false })
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.example.synthetic", appName: "Synthetic")
        let hub = AXObserverHub(stream: stream)
        let field = FieldMetadata(role: "AXTextField")

        // When one AX update contains two completed sentences.
        hub.recordValueChange("", bundleID: "com.example.synthetic", field: field)
        hub.recordValueChange("  First.   Second.  ", bundleID: "com.example.synthetic", field: field)

        // Then each trimmed sentence is sent as one event.
        XCTAssertEqual(events.map(\.text), ["First.", "Second."])
    }

    func testReentrantBrowserURLReadPreservesCompletedSentences() {
        // Given a browser URL lookup that delivers a nested AX callback while the first sentence is emitted.
        var events: [CaptureEvent] = []
        var didReenter = false
        weak var reentrantHub: AXObserverHub?
        let stream = CaptureStream(
            output: { events.append($0) }, secureInputEnabled: { false },
            browserURL: { _ in
                if !didReenter {
                    didReenter = true
                    reentrantHub?.flushTypedText()
                }
                return "https://example.test/"
            }
        )
        stream.configure(deniedBundleIds: [], captureTypedText: true, paused: false)
        stream.activate(bundleID: "com.google.Chrome", appName: "Chrome")
        let hub = AXObserverHub(stream: stream)
        reentrantHub = hub
        let field = FieldMetadata(role: "AXTextField")
        hub.recordValueChange("", bundleID: "com.google.Chrome", field: field)

        // When one AX update completes two sentences and the URL lookup reenters the observer.
        hub.recordValueChange("First. Second.", bundleID: "com.google.Chrome", field: field)

        // Then both sentences are emitted once, in order, without reading stale String indices.
        XCTAssertTrue(didReenter)
        XCTAssertEqual(events.map(\.text), ["First.", "Second."])
    }
}
