import Foundation

enum NativeWorkerError: Error, Equatable {
    case timeout
    case queueFull
}

private final class NativeWorkerCompletion<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var continuation: CheckedContinuation<T, Error>?

    func wait() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func resolve(_ result: Result<T, Error>) {
        lock.lock()
        guard self.result == nil else {
            lock.unlock()
            return
        }
        if let continuation {
            self.continuation = nil
            lock.unlock()
            continuation.resume(with: result)
        } else {
            self.result = result
            lock.unlock()
        }
    }
}

final class BoundedNativeWorker: @unchecked Sendable {
    private let semaphore: DispatchSemaphore
    private let lock = NSLock()
    private let timeout: TimeInterval
    private let maximumQueued: Int
    private var queued = 0

    init(maximumActive: Int = 2, maximumQueued: Int = 16, timeout: TimeInterval = 2) {
        semaphore = DispatchSemaphore(value: maximumActive)
        self.maximumQueued = maximumQueued
        self.timeout = timeout
    }

    private func reserve() throws {
        lock.lock()
        defer { lock.unlock() }
        guard queued < maximumQueued else { throw NativeWorkerError.queueFull }
        queued += 1
    }

    private func performBlocking<T>(_ operation: @escaping @Sendable () throws -> T) throws -> T {
        semaphore.wait()
        lock.lock()
        queued -= 1
        lock.unlock()
        defer { semaphore.signal() }
        try Task.checkCancellation()
        return try operation()
    }

    func run<T: Sendable>(_ operation: @escaping @Sendable () throws -> T) async throws -> T {
        try Task.checkCancellation()
        try reserve()
        let completion = NativeWorkerCompletion<T>()
        let work = Task.detached(priority: .userInitiated) { [self] in
            try performBlocking(operation)
        }
        let reporter = Task {
            do { completion.resolve(.success(try await work.value)) }
            catch { completion.resolve(.failure(error)) }
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(self.timeout * 1_000_000_000))
            completion.resolve(.failure(NativeWorkerError.timeout))
        }
        return try await withTaskCancellationHandler {
            do {
                let value = try await completion.wait()
                timer.cancel()
                reporter.cancel()
                work.cancel()
                return value
            } catch {
                timer.cancel()
                reporter.cancel()
                work.cancel()
                throw error
            }
        } onCancel: {
            timer.cancel()
            reporter.cancel()
            work.cancel()
            completion.resolve(.failure(CancellationError()))
        }
    }
}

actor NativeStringWorker {
    private struct Cached {
        let value: String?
        let storedAt: Date
    }

    private let worker: BoundedNativeWorker
    private var cache: [String: Cached] = [:]
    private var inFlight: [String: Task<String?, Error>] = [:]
    private let cacheLifetime: TimeInterval
    private let cacheLimit: Int

    init(
        worker: BoundedNativeWorker = BoundedNativeWorker(),
        cacheLifetime: TimeInterval = 0.5,
        cacheLimit: Int = 32
    ) {
        self.worker = worker
        self.cacheLifetime = cacheLifetime
        self.cacheLimit = max(1, cacheLimit)
    }

    func call(
        key: String,
        cacheResult: Bool = true,
        operation: @escaping @Sendable () throws -> String?
    ) async throws -> String? {
        let now = Date()
        cache = cache.filter { now.timeIntervalSince($0.value.storedAt) < cacheLifetime }
        if cacheResult, let cached = cache[key] { return cached.value }
        if let inFlight = inFlight[key] { return try await inFlight.value }
        let task = Task { try await worker.run(operation) }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        let value = try await task.value
        if cacheResult {
            if cache.count >= cacheLimit, let oldest = cache.min(by: { $0.value.storedAt < $1.value.storedAt })?.key {
                cache[oldest] = nil
            }
            cache[key] = Cached(value: value, storedAt: Date())
        }
        return value
    }
}
