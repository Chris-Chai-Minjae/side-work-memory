import Foundation
import XCTest
@testable import Side

final class DaemonFrameWriterTests: XCTestCase {
    func testWritesAreSerializedOffCallingThreadAndOverflowFailsFast() throws {
        let pipe = Pipe()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let failures = expectation(description: "overflow reported")
        let writer = DaemonFrameWriter(
            handle: pipe.fileHandleForWriting,
            maximumBufferedBytes: 10,
            writeData: { _, _ in
                entered.signal()
                release.wait()
            },
            onFailure: { error in
                XCTAssertEqual(error as? DaemonFrameWriterError, .overflow)
                failures.fulfill()
            }
        )
        try writer.enqueue(Data("one".utf8))
        try writer.enqueue(Data("two".utf8))
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)

        XCTAssertThrowsError(try writer.enqueue(Data("overflow".utf8))) {
            XCTAssertEqual($0 as? DaemonFrameWriterError, .overflow)
        }
        wait(for: [failures], timeout: 0.1)
        writer.close()
        release.signal()
    }
}
