import XCTest
@testable import Side
import SideCaptureKit

private final class BrowserScriptStub {
    var modes: [String?]
    var urls: [String?]
    private(set) var calls: [String] = []

    init(modes: [String?] = [], urls: [String?] = []) {
        self.modes = modes
        self.urls = urls
    }

    func run(_ script: String) -> String? {
        calls.append(script)
        if script.contains("get mode of front window") {
            return modes.isEmpty ? nil : modes.removeFirst()
        }
        if script.contains("get URL of") {
            return urls.isEmpty ? nil : urls.removeFirst()
        }
        return nil
    }
}

final class BrowsersTests: XCTestCase {
    private let chrome = "com.google.Chrome"

    func testProducerGateRejectsIncognitoAndUnknownModeBeforeAnyAXEvent() {
        let scripts = BrowserScriptStub(modes: ["incognito", nil, "normal"])
        let browser = makeChrome(scripts: scripts)

        XCTAssertFalse(browser.isObservableForeground(bundleID: chrome))
        XCTAssertFalse(browser.isObservableForeground(bundleID: chrome))
        XCTAssertTrue(browser.isObservableForeground(bundleID: chrome))
        XCTAssertEqual(scripts.calls.count, 3)
        XCTAssertTrue(scripts.calls.allSatisfy { $0.contains("get mode of front window") })
    }

    func testProducerGateAllowsNonBrowserButFailsClosedForSafariWithoutScript() {
        let scripts = BrowserScriptStub()
        let browser = makeChrome(scripts: scripts, frontmost: { "com.apple.Safari" })

        XCTAssertTrue(browser.isObservableForeground(bundleID: "com.example.Editor"))
        XCTAssertFalse(browser.isObservableForeground(bundleID: "com.apple.Safari"))
        XCTAssertTrue(scripts.calls.isEmpty)
    }

    func testCurrentURLIsNormalizedAndAbsentForIncognito() {
        let scripts = BrowserScriptStub(
            modes: ["normal", "incognito"],
            urls: ["https://example.test/page?secret=synthetic"]
        )
        let browser = makeChrome(scripts: scripts)

        XCTAssertEqual(browser.currentNormalizedURL(bundleID: chrome), "https://example.test/page")
        XCTAssertNil(browser.currentNormalizedURL(bundleID: chrome))
    }

    private func makeChrome(
        scripts: BrowserScriptStub,
        automationAllowed: Bool = true,
        frontmost: @escaping () -> String? = { "com.google.Chrome" },
        windowID: @escaping () -> UInt32? = { 7 }
    ) -> BrowserCapture {
        BrowserCapture(
            frontmostBundleID: frontmost,
            foregroundWindowID: { _ in windowID() },
            automationAllowed: { _ in automationAllowed },
            runAppleScript: scripts.run
        )
    }

    func testChromeIncognitoCaptureIsDiscardedWithSuppression() {
        // Given a synthetic foreground Chrome incognito window.
        let scripts = BrowserScriptStub(modes: ["incognito"])
        let browser = makeChrome(scripts: scripts)
        var readCount = 0

        // When capture is requested.
        let result = browser.capture(bundleID: chrome) {
            readCount += 1
            return BrowserCaptureContent(text: "synthetic body", axTreeBytes: 20)
        }

        // Then the content is discarded and suppression is reported.
        XCTAssertEqual(result, .suppressed(.incognito))
        XCTAssertEqual(readCount, 0)
        XCTAssertTrue(browser.perAppHealth.isEmpty)
        XCTAssertEqual(scripts.calls.count, 1)
    }

    func testSixBrowserURLQueriesMatchObserveScripts() {
        // Given the supported browser bundle IDs.
        let expected = [
            "at.studio.AsideBrowser": "tell application \"Aside\" to get URL of active tab of front window",
            "com.google.Chrome": "tell application \"Google Chrome\" to get URL of active tab of front window",
            "com.apple.Safari": "tell application \"Safari\" to get URL of current tab of front window",
            "company.thebrowser.Browser": "tell application \"Arc\" to get URL of active tab of front window",
            "com.brave.Browser": "tell application \"Brave Browser\" to get URL of active tab of front window",
            "com.microsoft.edgemac": "tell application \"Microsoft Edge\" to get URL of active tab of front window",
        ]

        // When each browser's query is selected.
        let actual = Dictionary(uniqueKeysWithValues: expected.keys.compactMap { bundleID -> (String, String)? in
            guard let script = BrowserCapture.urlScript(for: bundleID) else { return nil }
            return (bundleID, script)
        })

        // Then only the approved query is used for that bundle.
        XCTAssertEqual(actual, expected)
        XCTAssertNil(BrowserCapture.urlScript(for: "com.example.unsupported"))
    }

    func testDeniedAutomationDoesNotExecuteAppleScriptOrReadContent() {
        // Given Automation permission is absent.
        let scripts = BrowserScriptStub()
        let browser = makeChrome(scripts: scripts, automationAllowed: false)
        var readCount = 0

        // When capture is requested.
        let result = browser.capture(bundleID: chrome) {
            readCount += 1
            return BrowserCaptureContent(text: nil, axTreeBytes: 0)
        }

        // Then no browser content is queried.
        XCTAssertEqual(result, .unavailable(.automationPermission))
        XCTAssertEqual(readCount, 0)
        XCTAssertTrue(scripts.calls.isEmpty)
    }

    func testUnknownChromiumModeFailsClosedBeforeURLOrContent() {
        // Given a Chromium browser whose private mode cannot be determined.
        let scripts = BrowserScriptStub(modes: [nil])
        let browser = makeChrome(scripts: scripts)
        var readCount = 0

        // When capture is requested.
        let result = browser.capture(bundleID: chrome) {
            readCount += 1
            return BrowserCaptureContent(text: nil, axTreeBytes: 0)
        }

        // Then capture stops before the URL and content are read.
        XCTAssertEqual(result, .unavailable(.privateStateUnknown))
        XCTAssertEqual(readCount, 0)
        XCTAssertEqual(scripts.calls.count, 1)
    }

    func testNormalChromeCaptureStripsURLSecretsAndReportsAXHealth() {
        // Given an ordinary foreground Chrome window with a stable URL.
        let rawURL = "https://name:placeholder@example.test/page?token=synthetic#section"
        let scripts = BrowserScriptStub(modes: ["normal", "normal"], urls: [rawURL, rawURL])
        let browser = makeChrome(scripts: scripts)
        let content = BrowserCaptureContent(text: "synthetic body", axTreeBytes: 2_048)

        // When the AX capture completes.
        let result = browser.capture(bundleID: chrome) { content }

        // Then only the normalized URL leaves the browser gate, with no OCR fallback.
        XCTAssertEqual(result, .captured(url: "https://example.test/page", content: content, ocrFallbackNeeded: false))
        XCTAssertEqual(browser.perAppHealth[chrome], .init(chromeOnly: false, maxTreeBytes: 2_048))
    }

    func testShortAXTreeFlagsOCRFallbackAndTracksMaximum() {
        // Given two ordinary captures of the same browser.
        let rawURL = "https://example.test/"
        let scripts = BrowserScriptStub(modes: Array(repeating: "normal", count: 4), urls: Array(repeating: rawURL, count: 4))
        let browser = makeChrome(scripts: scripts)
        _ = browser.capture(bundleID: chrome) { BrowserCaptureContent(text: nil, axTreeBytes: 3_000) }

        // When the next AX tree is below EMPTY_TREE_BYTES.
        let short = BrowserCaptureContent(text: nil, axTreeBytes: 2_047)
        let result = browser.capture(bundleID: chrome) { short }

        // Then health marks chromeOnly and keeps the greatest observed tree size.
        XCTAssertEqual(result, .captured(url: rawURL, content: short, ocrFallbackNeeded: true))
        XCTAssertEqual(browser.perAppHealth[chrome], .init(chromeOnly: true, maxTreeBytes: 3_000))
    }

    func testBrowserHealthCopiesIntoApprovedHelperEnvelope() throws {
        // Given a synthetic browser capture below the AX tree threshold.
        let scripts = BrowserScriptStub(
            modes: ["normal", "normal"],
            urls: ["https://example.test/", "https://example.test/"]
        )
        let browser = makeChrome(scripts: scripts)
        _ = browser.capture(bundleID: chrome) { BrowserCaptureContent(text: nil, axTreeBytes: 42) }
        var health = HelperHealth()
        health.perApp["com.example.other"] = .init(chromeOnly: false, maxTreeBytes: 500)

        // When browser health is copied into the protocol envelope.
        browser.writeHealth(into: &health)

        // Then the approved perApp fields carry the measured browser state.
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(health)) as? [String: Any])
        let perApp = try XCTUnwrap(encoded["perApp"] as? [String: [String: Any]])
        let chromeHealth = try XCTUnwrap(perApp[chrome])
        XCTAssertEqual(chromeHealth["chromeOnly"] as? Bool, true)
        XCTAssertEqual(chromeHealth["maxTreeBytes"] as? Int, 42)
        XCTAssertNotNil(perApp["com.example.other"])
    }

    func testPrivateTransitionDuringCaptureDiscardsContentAndHealth() {
        // Given a Chrome window that turns incognito while the content is read.
        let scripts = BrowserScriptStub(modes: ["normal", "incognito"], urls: ["https://example.test/"])
        let browser = makeChrome(scripts: scripts)
        var readCount = 0

        // When capture completes after the transition.
        let result = browser.capture(bundleID: chrome) {
            readCount += 1
            return BrowserCaptureContent(text: "synthetic body", axTreeBytes: 3_000)
        }

        // Then the captured content is discarded and no health size is retained.
        XCTAssertEqual(result, .suppressed(.incognito))
        XCTAssertEqual(readCount, 1)
        XCTAssertTrue(browser.perAppHealth.isEmpty)
    }

    func testRawURLChangeDuringCaptureDiscardsContentEvenWhenNormalizedURLMatches() {
        // Given a page whose query changes during AX capture.
        let scripts = BrowserScriptStub(
            modes: ["normal", "normal"],
            urls: ["https://example.test/page?step=one", "https://example.test/page?step=two"]
        )
        let browser = makeChrome(scripts: scripts)

        // When capture completes.
        let result = browser.capture(bundleID: chrome) {
            BrowserCaptureContent(text: "synthetic body", axTreeBytes: 3_000)
        }

        // Then the capture is discarded despite equal sanitized URLs.
        XCTAssertEqual(result, .unavailable(.urlChanged))
        XCTAssertTrue(browser.perAppHealth.isEmpty)
    }

    func testAsyncCaptureBypassesScriptCacheForRawURLVerification() async {
        let scripts = BrowserScriptStub(
            modes: ["normal", "normal"],
            urls: ["https://example.test/page?step=one", "https://example.test/page?step=two"]
        )
        let browser = makeChrome(scripts: scripts)

        let result = await browser.captureAsync(bundleID: chrome) {
            BrowserCaptureContent(text: "synthetic body", axTreeBytes: 3_000)
        }

        XCTAssertEqual(result, .unavailable(.urlChanged))
        XCTAssertTrue(browser.perAppHealth.isEmpty)
    }

    func testProducerCacheStartsClosedAndUsesFreshVerifiedModeAndURL() async {
        let scripts = BrowserScriptStub(modes: ["normal"], urls: ["https://example.test/private?token=hidden"])
        let browser = makeChrome(scripts: scripts)
        XCTAssertFalse(browser.cachedObservableForeground(bundleID: chrome))
        XCTAssertNil(browser.cachedNormalizedURL(bundleID: chrome))

        await browser.refreshForeground(bundleID: chrome)

        XCTAssertTrue(browser.cachedObservableForeground(bundleID: chrome))
        XCTAssertEqual(browser.cachedNormalizedURL(bundleID: chrome), "https://example.test/private")
    }

    func testProducerCacheDoesNotCrossWindowIdentity() async {
        let scripts = BrowserScriptStub(modes: ["normal"], urls: ["https://example.test/normal"])
        var windowID: UInt32 = 7
        let browser = makeChrome(scripts: scripts, windowID: { windowID })
        await browser.refreshForeground(bundleID: chrome)
        XCTAssertTrue(browser.cachedObservableForeground(bundleID: chrome))

        windowID = 8

        XCTAssertFalse(browser.cachedObservableForeground(bundleID: chrome))
        XCTAssertNil(browser.cachedNormalizedURL(bundleID: chrome))
    }

    func testRefreshDiscardsModeWhenWindowChangesBeforeURLReturns() async {
        var windowID: UInt32 = 7
        let browser = BrowserCapture(
            frontmostBundleID: { self.chrome },
            foregroundWindowID: { _ in windowID },
            automationAllowed: { _ in true },
            runAppleScript: { script in
                if script.contains("get mode of front window") { return "normal" }
                windowID = 8
                return "https://example.test/private"
            }
        )

        await browser.refreshForeground(bundleID: chrome)

        XCTAssertFalse(browser.cachedObservableForeground(bundleID: chrome))
        XCTAssertNil(browser.cachedNormalizedURL(bundleID: chrome))
    }

    func testForegroundChangeDuringCaptureDiscardsContent() {
        // Given Chrome is foreground initially but Safari takes focus during capture.
        let scripts = BrowserScriptStub(modes: ["normal"], urls: ["https://example.test/"])
        var foregroundChecks = 0
        let browser = makeChrome(scripts: scripts, frontmost: {
            foregroundChecks += 1
            return foregroundChecks == 1 ? self.chrome : "com.apple.Safari"
        })

        // When capture completes.
        let result = browser.capture(bundleID: chrome) {
            BrowserCaptureContent(text: "synthetic body", axTreeBytes: 3_000)
        }

        // Then the captured content is discarded.
        XCTAssertEqual(result, .unavailable(.notForeground))
        XCTAssertTrue(browser.perAppHealth.isEmpty)
    }

    func testSafariCaptureFailsClosedBeforeURLOrContent() {
        let scripts = BrowserScriptStub(urls: ["https://example.test/"])
        let browser = BrowserCapture(
            frontmostBundleID: { "com.apple.Safari" },
            automationAllowed: { _ in true },
            runAppleScript: scripts.run
        )
        var reads = 0

        let result = browser.capture(bundleID: "com.apple.Safari") {
            reads += 1
            return BrowserCaptureContent(text: nil, axTreeBytes: 0)
        }

        XCTAssertEqual(result, .unavailable(.privateStateUnknown))
        XCTAssertEqual(reads, 0)
        XCTAssertTrue(scripts.calls.isEmpty)
    }
}
