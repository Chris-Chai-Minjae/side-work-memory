import Foundation
import XCTest
@testable import Side

private final class NativeCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func increment() { lock.lock(); value += 1; lock.unlock() }
}

final class NativeWorkerTests: XCTestCase {
    func testNativeCallTimeoutReturnsWithoutBlockingMainActor() async throws {
        let worker = BoundedNativeWorker(maximumActive: 1, maximumQueued: 1, timeout: 0.05)
        let call = Task { @MainActor in
            try await worker.run {
                Thread.sleep(forTimeInterval: 1)
                return "late"
            }
        }
        let responsive = expectation(description: "main actor remains responsive")
        Task { @MainActor in responsive.fulfill() }
        await fulfillment(of: [responsive], timeout: 0.5)

        let started = Date()
        do {
            _ = try await call.value
            XCTFail("expected native call timeout")
        } catch {
            XCTAssertEqual(error as? NativeWorkerError, .timeout)
            XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        }
    }

    func testCallerCancellationReturnsPromptly() async throws {
        let worker = BoundedNativeWorker(maximumActive: 1, maximumQueued: 1, timeout: 5)
        let call = Task {
            try await worker.run {
                Thread.sleep(forTimeInterval: 1)
                return "late"
            }
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        let started = Date()
        call.cancel()

        do {
            _ = try await call.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
            XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
        }
    }

    func testIdenticalCallsAreDeduplicatedAndCached() async throws {
        let worker = NativeStringWorker(
            worker: BoundedNativeWorker(maximumActive: 2, maximumQueued: 2, timeout: 1),
            cacheLifetime: 1
        )
        let counter = NativeCallCounter()
        let operation: @Sendable () throws -> String? = {
            counter.increment()
            Thread.sleep(forTimeInterval: 0.05)
            return "value"
        }
        async let first = worker.call(key: "same", operation: operation)
        async let second = worker.call(key: "same", operation: operation)

        let values = try await [first, second]
        XCTAssertEqual(values, ["value", "value"])
        let cached = try await worker.call(key: "same", operation: operation)
        XCTAssertEqual(cached, "value")
        XCTAssertEqual(counter.count, 1)
    }

    func testStringCacheEvictsOldestEntryAtLimit() async throws {
        let worker = NativeStringWorker(cacheLifetime: 60, cacheLimit: 2)
        _ = try await worker.call(key: "first") { "sensitive one" }
        try await Task.sleep(nanoseconds: 1_000_000)
        _ = try await worker.call(key: "second") { "sensitive two" }
        try await Task.sleep(nanoseconds: 1_000_000)
        _ = try await worker.call(key: "third") { "sensitive three" }
        let counter = NativeCallCounter()

        let first = try await worker.call(key: "first") {
            counter.increment()
            return "reloaded"
        }
        let third = try await worker.call(key: "third") {
            counter.increment()
            return "reloaded"
        }

        XCTAssertEqual(first, "reloaded")
        XCTAssertEqual(third, "sensitive three")
        XCTAssertEqual(counter.count, 1)
    }
}
