import CoreGraphics
import ScreenCaptureKit
import Vision

actor WindowOCRConcurrencyLimiter {
    private var active = 0
    private var waiters: [(UUID, CheckedContinuation<Void, Error>)] = []
    private let maximumActive: Int
    private let maximumQueued: Int

    init(maximumActive: Int = 2, maximumQueued: Int = 8) {
        self.maximumActive = maximumActive
        self.maximumQueued = maximumQueued
    }

    var activeCount: Int { active }
    var queuedCount: Int { waiters.count }

    func withPermit<T>(_ operation: () async throws -> T) async throws -> T {
        try await acquire()
        defer { release() }
        return try await operation()
    }

    private func acquire() async throws {
        try Task.checkCancellation()
        if active < maximumActive {
            active += 1
            return
        }
        guard waiters.count < maximumQueued else { throw CancellationError() }
        let id = UUID()
        try await withTaskCancellationHandler(operation: {
            let _: Void = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append((id, continuation))
                }
            }
        }, onCancel: {
            Task { await self.cancelWaiter(id: id) }
        })
    }

    private func cancelWaiter(id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.0 == id }) else { return }
        let waiter = waiters.remove(at: index).1
        waiter.resume(throwing: CancellationError())
    }

    private func release() {
        active = max(0, active - 1)
        guard active < maximumActive, !waiters.isEmpty else { return }
        let waiter = waiters.removeFirst().1
        active += 1
        waiter.resume()
    }
}

enum WindowOCR {
    static let maximumPixels = 4_000_000
    static let concurrencyLimiter = WindowOCRConcurrencyLimiter()

    static func captureText(for window: SCWindow) async throws -> String {
        try await concurrencyLimiter.withPermit {
            try Task.checkCancellation()
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            let size = scaledPixelSize(
                width: filter.contentRect.width,
                height: filter.contentRect.height,
                scale: CGFloat(filter.pointPixelScale)
            )
            configuration.width = size.width
            configuration.height = size.height

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            try Task.checkCancellation()
            return try await recognizeCancellable(image: image)
        }
    }

    static func scaledPixelSize(
        width: CGFloat, height: CGFloat, scale: CGFloat,
        maximumPixels: Int = WindowOCR.maximumPixels
    ) -> (width: Int, height: Int) {
        let originalWidth = max(1, width * max(scale, 1))
        let originalHeight = max(1, height * max(scale, 1))
        let pixels = originalWidth * originalHeight
        let downscale = pixels > CGFloat(maximumPixels)
            ? sqrt(CGFloat(maximumPixels) / pixels)
            : 1
        return (
            max(1, Int((originalWidth * downscale).rounded(.down))),
            max(1, Int((originalHeight * downscale).rounded(.down)))
        )
    }

    static func recognize(image: CGImage) throws -> String {
        try performRecognition(image: image, request: VNRecognizeTextRequest())
    }

    private static func recognizeCancellable(image: CGImage) async throws -> String {
        let request = VNRecognizeTextRequest()
        let work = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            return try performRecognition(image: image, request: request)
        }
        return try await withTaskCancellationHandler {
            try await work.value
        } onCancel: {
            request.cancel()
            work.cancel()
        }
    }

    private static func performRecognition(image: CGImage, request: VNRecognizeTextRequest) throws -> String {
        request.recognitionLanguages = ["ko-KR", "en-US"]
        request.recognitionLevel = .accurate
        try VNImageRequestHandler(cgImage: image).perform([request])
        return request.results?
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n") ?? ""
    }
}
