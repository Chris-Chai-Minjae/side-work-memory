import AppKit
import ApplicationServices
import CoreGraphics
import SideCaptureKit

struct AXSnapshotForeground: Equatable {
    let bundleID: String
    let pid: pid_t
    let windowID: UInt32?

    static func current() -> Self? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier else { return nil }
        let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] ?? []
        let window = windows.first {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier &&
                ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        let windowID = (window?[kCGWindowNumber as String] as? NSNumber)?.uint32Value
        return Self(bundleID: bundleID, pid: app.processIdentifier, windowID: windowID)
    }
}

protocol AXSnapshotReading {
    associatedtype Element: Equatable

    func focusedWindow(for pid: pid_t) -> Element?
    func role(of element: Element) -> String
    func subrole(of element: Element) -> String
    func value(of element: Element) -> String?
    func children(of element: Element) -> [Element]
    func fieldMetadata(of element: Element) -> FieldMetadata
}

struct AXSnapshot<Reader: AXSnapshotReading> {
    let reader: Reader
    let foreground: () -> AXSnapshotForeground?

    func capture(bundleID: String, windowID: UInt32?) -> String? {
        guard let before = foreground(),
              before.bundleID == bundleID,
              (windowID == nil || before.windowID == windowID),
              let window = reader.focusedWindow(for: before.pid) else { return nil }

        let text = AXText.extract(from: AXSnapshotNode(element: window, reader: reader))
        guard reader.focusedWindow(for: before.pid) == window,
              foreground() == before else { return nil }
        return text
    }
}

private struct AXSnapshotNode<Reader: AXSnapshotReading>: AXTextNode {
    let element: Reader.Element
    let reader: Reader

    var role: String { reader.role(of: element) }
    var subrole: String { reader.subrole(of: element) }
    var value: String? { reader.value(of: element) }
    var children: [Self] {
        let nodeRole = reader.role(of: element)
        if nodeRole == "AXTextField" || nodeRole == "AXTextArea" {
            guard FieldLabels.blockedRule(for: reader.fieldMetadata(of: element)) == nil else { return [] }
        }
        return reader.children(of: element).prefix(AXText.maxChildrenPerNode).map {
            Self(element: $0, reader: reader)
        }
    }
}

struct LiveAXSnapshotReader: AXSnapshotReading {
    func focusedWindow(for pid: pid_t) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    func role(of element: AXUIElement) -> String {
        attribute(element, kAXRoleAttribute as CFString) as? String ?? ""
    }

    func subrole(of element: AXUIElement) -> String {
        attribute(element, kAXSubroleAttribute as CFString) as? String ?? ""
    }

    func value(of element: AXUIElement) -> String? {
        attribute(element, kAXValueAttribute as CFString) as? String
    }

    func children(of element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
    }

    func fieldMetadata(of element: AXUIElement) -> FieldMetadata {
        FieldMetadata(
            role: role(of: element), subrole: subrole(of: element),
            title: attribute(element, kAXTitleAttribute as CFString) as? String,
            description: attribute(element, kAXDescriptionAttribute as CFString) as? String,
            placeholder: attribute(element, kAXPlaceholderValueAttribute as CFString) as? String
        )
    }

    private func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
        return value
    }
}

extension AXSnapshot where Reader == LiveAXSnapshotReader {
    init() {
        self.init(reader: LiveAXSnapshotReader(), foreground: AXSnapshotForeground.current)
    }
}
