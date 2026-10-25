import Foundation
import SideCaptureKit

enum DaemonFrameWriterError: Error, Equatable {
    case overflow
    case closed
}

final class DaemonFrameWriter: @unchecked Sendable {
    private let handle: FileHandle
    private let writeData: (FileHandle, Data) throws -> Void
    private let onFailure: (Error) -> Void
    private let queue = DispatchQueue(label: "com.minjaechai.Side.daemon-stdin")
    private let lock = NSLock()
    private let maximumBufferedBytes: Int
    private var pending: [Data] = []
    private var bufferedBytes = 0
    private var draining = false
    private var closed = false

    init(
        handle: FileHandle,
        maximumBufferedBytes: Int = CaptureProtocol.maxRawBytes,
        writeData: @escaping (FileHandle, Data) throws -> Void,
        onFailure: @escaping (Error) -> Void
    ) {
        self.handle = handle
        self.maximumBufferedBytes = maximumBufferedBytes
        self.writeData = writeData
        self.onFailure = onFailure
    }

    func enqueue(_ data: Data) throws {
        lock.lock()
        guard !closed else {
            lock.unlock()
            throw DaemonFrameWriterError.closed
        }
        guard data.count <= maximumBufferedBytes,
              bufferedBytes + data.count <= maximumBufferedBytes else {
            lock.unlock()
            onFailure(DaemonFrameWriterError.overflow)
            throw DaemonFrameWriterError.overflow
        }
        pending.append(data)
        bufferedBytes += data.count
        if !draining {
            draining = true
            queue.async { [weak self] in self?.drainNext() }
        }
        lock.unlock()
    }

    func close() {
        lock.lock()
        closed = true
        pending.removeAll()
        bufferedBytes = 0
        lock.unlock()
    }

    private func drainNext() {
        lock.lock()
        guard !closed, !pending.isEmpty else {
            draining = false
            lock.unlock()
            return
        }
        let next = pending.removeFirst()
        bufferedBytes -= next.count
        lock.unlock()
        do {
            try writeData(handle, next)
            queue.async { [weak self] in self?.drainNext() }
        } catch {
            close()
            onFailure(error)
        }
    }
}
