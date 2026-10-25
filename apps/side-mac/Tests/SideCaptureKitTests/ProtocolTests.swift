import Foundation
import XCTest
import SideCaptureKit

final class ProtocolTests: XCTestCase {
    func testProtocolVersionMatchesHelloContract() {
        // Given the documented hello contract uses protocol version 1.
        // When the capture protocol version is read.
        // Then the helper and daemon can agree on the wire version.
        XCTAssertEqual(CaptureProtocol.version, 1)
    }

    func testPingUsesCorrelationIDWithoutPayload() throws {
        let message = try object(from: CaptureProtocol.encodePing(id: "native-42"))

        XCTAssertEqual(message["type"] as? String, "ping")
        XCTAssertEqual(message["id"] as? String, "native-42")
        XCTAssertEqual(Set(message.keys), ["type", "id"])
    }

    func testHelloUsesProtocolFieldsAndBase64Key() throws {
        // Given a synthetic 32-byte key.
        let key = Data(repeating: 0x42, count: 32)

        // When hello is encoded as a JSON line.
        let message = try object(from: CaptureProtocol.encodeHello(key: key, appVersion: "test-version"))

        // Then the wire object has exactly the approved hello fields.
        XCTAssertEqual(Set(message.keys), ["type", "protocolVersion", "key", "appVersion"])
        XCTAssertEqual(message["type"] as? String, "hello")
        XCTAssertEqual(message["protocolVersion"] as? Int, 1)
        XCTAssertEqual(message["key"] as? String, key.base64EncodedString())
        XCTAssertEqual(message["appVersion"] as? String, "test-version")
    }

    func testHealthAndEventUseTheirApprovedEnvelopeKeys() throws {
        // Given synthetic health and event payloads.
        var health = HelperHealth()
        health.state = .running
        health.perApp = ["com.example.synthetic": .init(chromeOnly: true, maxTreeBytes: 2_048)]
        let event = ["kind": "window.changed", "title": "Synthetic window"]

        // When each is encoded.
        let healthMessage = try object(from: CaptureProtocol.encodeHealth(health))
        let eventMessage = try object(from: CaptureProtocol.encodeEvent(event))

        // Then the payload appears under its documented key.
        XCTAssertEqual(Set(healthMessage.keys), ["type", "health"])
        XCTAssertEqual(healthMessage["type"] as? String, "health")
        let healthBody = try XCTUnwrap(healthMessage["health"] as? [String: Any])
        XCTAssertEqual(Set(healthBody.keys), [
            "platform", "protocolVersion", "nativeCaptureAvailable", "inputCaptureAvailable",
            "screenOcrAvailable", "screenOcrLanguages", "accessibilityTrusted", "inputMonitoringTrusted",
            "screenRecordingTrusted", "eventTapHealthy", "inputTapRunning", "observerRegistrationFailures",
            "secureInput", "permissionSheetVisible", "systemSessionActive", "idle", "pid", "observerPid",
            "responsibleSelf", "state", "asideAdapter", "perApp",
        ])
        XCTAssertEqual(healthBody["state"] as? String, "running")
        XCTAssertEqual(healthBody["platform"] as? String, "darwin")
        XCTAssertEqual(healthBody["protocolVersion"] as? Int, 1)
        XCTAssertEqual(healthBody["responsibleSelf"] as? Bool, true)
        XCTAssertEqual(Set(eventMessage.keys), ["type", "event"])
        XCTAssertEqual(eventMessage["type"] as? String, "event")
        XCTAssertEqual(eventMessage["event"] as? [String: String], event)
    }

    func testResultVariantsAndProtocolErrorUseApprovedFields() throws {
        // Given a synthetic command id and result payload.
        // When success, failure, and error are encoded.
        let success = try object(from: CaptureProtocol.encodeResultSuccess(id: "cmd-1", data: ["count": 2]))
        let failure = try object(from: CaptureProtocol.encodeResultFailure(id: "cmd-1", error: "unavailable"))
        let protocolError = try object(from: CaptureProtocol.encodeProtocolError("invalid message"))

        // Then each variant has only its approved fields.
        XCTAssertEqual(Set(success.keys), ["type", "id", "ok", "data"])
        XCTAssertEqual(success["ok"] as? Bool, true)
        XCTAssertEqual(success["data"] as? [String: Int], ["count": 2])
        XCTAssertEqual(Set(failure.keys), ["type", "id", "ok", "error"])
        XCTAssertEqual(failure["ok"] as? Bool, false)
        XCTAssertEqual(failure["error"] as? String, "unavailable")
        XCTAssertEqual(Set(protocolError.keys), ["type", "message"])
        XCTAssertEqual(protocolError["type"] as? String, "protocol-error")
    }

    func testRejectsInvalidHelloKeyAndOversizedLine() {
        // Given an invalid key and a payload above the 4 MB raw JSON limit.
        // When each is encoded.
        // Then neither can be sent as a protocol line.
        XCTAssertThrowsError(try CaptureProtocol.encodeHello(key: Data(repeating: 0x42, count: 31), appVersion: "test"))
        XCTAssertThrowsError(try CaptureProtocol.encodeProtocolError(String(repeating: "x", count: 4_194_304)))
    }

    func testEmbeddedNewlineIsEscapedInsideOneJsonLine() throws {
        // Given synthetic event text containing a newline.
        // When the event is encoded.
        let line = try CaptureProtocol.encodeEvent(["title": "first\nsecond"])

        // Then only the line terminator is a raw newline byte.
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
    }

    func testFourMegabyteLimitIncludesLineTerminator() throws {
        let overhead = try CaptureProtocol.encodeProtocolError("").count
        let allowed = CaptureProtocol.maxRawBytes - overhead

        XCTAssertEqual(try CaptureProtocol.encodeProtocolError(String(repeating: "x", count: allowed)).count,
                       CaptureProtocol.maxRawBytes)
        XCTAssertThrowsError(try CaptureProtocol.encodeProtocolError(String(repeating: "x", count: allowed + 1)))
    }

    private func object(from line: Data) throws -> [String: Any] {
        XCTAssertEqual(line.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
    }
}
