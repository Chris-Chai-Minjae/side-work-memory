import ImageIO
import XCTest
@testable import Side

final class OCRTests: XCTestCase {
    func testCaptureDimensionsHonorPixelCapAndPreserveAspectRatio() {
        let size = WindowOCR.scaledPixelSize(width: 4_000, height: 2_000, scale: 2)

        XCTAssertLessThanOrEqual(size.width * size.height, WindowOCR.maximumPixels)
        XCTAssertEqual(size.width, size.height * 2)
        XCTAssertEqual(WindowOCR.scaledPixelSize(width: 100, height: 50, scale: 1).width, 100)
    }

    func testOCRConcurrencyQueueIsBoundedAndCancellationReleasesWaiter() async throws {
        let limiter = WindowOCRConcurrencyLimiter(maximumActive: 1, maximumQueued: 1)
        let first = Task { try await limiter.withPermit { try await Task.sleep(nanoseconds: 5_000_000_000) } }
        for _ in 0..<200 {
            if await limiter.activeCount == 1 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let active = await limiter.activeCount
        XCTAssertEqual(active, 1)

        let second = Task { try await limiter.withPermit { "second" } }
        for _ in 0..<200 {
            if await limiter.queuedCount == 1 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let queued = await limiter.queuedCount
        XCTAssertEqual(queued, 1)

        let third = Task { try await limiter.withPermit { "third" } }
        first.cancel()
        let results = await [second.result, third.result]
        _ = try? await first.value

        XCTAssertEqual(results.filter { if case .success = $0 { return true }; return false }.count, 1)
        XCTAssertEqual(results.filter { if case .failure = $0 { return true }; return false }.count, 1)
    }

    func testRecognizesSyntheticFixtureInMemory() throws {
        // Given the same synthetic image used by the tesseract test.
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../tests/fixtures/ocr.png")
            .standardizedFileURL
        let imageData = try Data(contentsOf: fixtureURL)
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return XCTFail("Could not decode OCR fixture")
        }

        // When Vision recognizes the in-memory image.
        let text = try WindowOCR.recognize(image: image)

        // Then it contains the established tesseract expectation.
        XCTAssertTrue(text.contains("LOCAL CONTEXT"))
    }
}
