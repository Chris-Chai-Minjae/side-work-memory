import Foundation

public struct HelperHealth: Encodable {
    public enum State: String, Encodable {
        case starting, running, paused, stopped
    }

    public enum AsideAdapter: String, Encodable {
        case off, available, unavailable, error
    }

    public struct PerApp: Encodable {
        public let chromeOnly: Bool
        public let maxTreeBytes: Int

        public init(chromeOnly: Bool, maxTreeBytes: Int) {
            self.chromeOnly = chromeOnly
            self.maxTreeBytes = maxTreeBytes
        }
    }

    public let platform = "darwin"
    public let protocolVersion = CaptureProtocol.version
    public var nativeCaptureAvailable = false
    public var inputCaptureAvailable = false
    public var screenOcrAvailable = false
    public var screenOcrLanguages: [String] = []
    public var accessibilityTrusted = false
    public var inputMonitoringTrusted = false
    public var screenRecordingTrusted = false
    public var eventTapHealthy = false
    public var inputTapRunning = false
    public var observerRegistrationFailures = 0
    public var secureInput = false
    public var permissionSheetVisible = false
    public var systemSessionActive = false
    public var idle = false
    public var pid = 0
    public var observerPid = 0
    public let responsibleSelf = true
    public var state: State = .starting
    public var asideAdapter: AsideAdapter = .off
    public var perApp: [String: PerApp] = [:]

    public init() {}
}

public enum CaptureProtocolError: Error {
    case invalidKeyLength
    case frameTooLarge
}

public enum CaptureProtocol {
    public static let version = 1
    public static let maxRawBytes = 4_194_304

    private struct Hello: Encodable {
        let type = "hello"
        let protocolVersion = CaptureProtocol.version
        let key: String
        let appVersion: String
    }

    private struct Health: Encodable {
        let type = "health"
        let health: HelperHealth
    }

    private struct Ping: Encodable {
        let type = "ping"
        let id: String
    }

    private struct Event<Payload: Encodable>: Encodable {
        let type = "event"
        let event: Payload
    }

    private struct ResultSuccess<Payload: Encodable>: Encodable {
        let type = "result"
        let id: String
        let ok = true
        let data: Payload
    }

    private struct ResultFailure: Encodable {
        let type = "result"
        let id: String
        let ok = false
        let error: String
    }

    private struct ProtocolError: Encodable {
        let type = "protocol-error"
        let message: String
    }

    public static func encodeHello(key: Data, appVersion: String) throws -> Data {
        guard key.count == 32 else { throw CaptureProtocolError.invalidKeyLength }
        return try line(Hello(key: key.base64EncodedString(), appVersion: appVersion))
    }

    public static func encodeHealth(_ health: HelperHealth) throws -> Data {
        try line(Health(health: health))
    }

    public static func encodePing(id: String) throws -> Data {
        try line(Ping(id: id))
    }

    public static func encodeEvent<Payload: Encodable>(_ event: Payload) throws -> Data {
        try line(Event(event: event))
    }

    public static func encodeResultSuccess<Payload: Encodable>(id: String, data: Payload) throws -> Data {
        try line(ResultSuccess(id: id, data: data))
    }

    public static func encodeResultFailure(id: String, error: String) throws -> Data {
        try line(ResultFailure(id: id, error: error))
    }

    public static func encodeProtocolError(_ message: String) throws -> Data {
        try line(ProtocolError(message: message))
    }

    private static func line<Payload: Encodable>(_ message: Payload) throws -> Data {
        var data = try JSONEncoder().encode(message)
        guard data.count + 1 <= maxRawBytes else { throw CaptureProtocolError.frameTooLarge }
        data.append(0x0A)
        return data
    }
}
