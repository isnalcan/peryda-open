import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// Clicks inside a card reach only controls the reader can see: a button cut off by clipping does not
/// act (audit MA-9, 15 Nov). The translated page's Close and Retranslate, which SwiftUI puts outside
/// their own small containers, still do (PageTranslationSurfaceTests). A button merely covered by other
/// SwiftUI content has no view of its own to tell it apart; that limit is recorded here.
@MainActor
final class HiddenControlRoutingTests: XCTestCase {
    final class Taps { var visible = 0; var clipped = 0; var covered = 0; var overflow = 0 }

    func host(_ taps: Taps) -> (NSWindow, ZoomedHostingView<AnyView>) {
        let card = VStack(alignment: .leading, spacing: 0) {
            Button("visible") { taps.visible += 1 }.buttonStyle(.borderless).frame(width: 120, height: 30)
            // A button pushed below a 30-point frame that clips it.
            VStack(spacing: 0) {
                Color.clear.frame(height: 40)
                Button("clipped") { taps.clipped += 1 }.buttonStyle(.borderless).frame(width: 120, height: 30)
            }
            .frame(width: 200, height: 30, alignment: .top)
            .clipped()
            // A button under an opaque view drawn on top of it.
            Button("covered") { taps.covered += 1 }.buttonStyle(.borderless).frame(width: 120, height: 30)
                .overlay(Color.white.frame(width: 160, height: 40))
            // A button that overflows a zero-height frame and is covered by the next view.
            VStack(spacing: 0) {
                Button("overflow") { taps.overflow += 1 }.buttonStyle(.borderless).frame(width: 120, height: 30)
            }
            .frame(width: 200, height: 0, alignment: .top)
            Color.white.frame(width: 200, height: 60)
        }
        .frame(width: 300, height: 260, alignment: .topLeading)
        .background(Color.white)
        let view = ZoomedHostingView(rootView: AnyView(card))
        view.sizingOptions = []
        view.frame = CGRect(x: 0, y: 0, width: 300, height: 260)
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 300, height: 260), styleMask: [.borderless], backing: .buffered, defer: false)
        let container = NSView(frame: window.contentRect(forFrameRect: window.frame))
        container.addSubview(view)
        window.contentView = container
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        view.layoutSubtreeIfNeeded()
        return (window, view)
    }

    func controls(_ v: NSView) -> [NSControl] { ((v as? NSControl).map { [$0] } ?? []) + v.subviews.flatMap(controls) }

    func click(_ window: NSWindow, _ p: CGPoint) async {
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        func ev(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        NSApp.postEvent(ev(.leftMouseUp), atStart: false)
        window.sendEvent(ev(.leftMouseDown))
        CardButtonTests.deliverQueuedMouseEvents(to: window)
        try? await Task.sleep(for: .milliseconds(120))
    }

    func testOnlyVisibleControlsAct() async throws {
        let taps = Taps()
        let (window, view) = host(taps)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(200))
        let found = controls(view)
        XCTAssertGreaterThanOrEqual(found.count, 1)
        for control in found {
            await click(window, control.convert(CGPoint(x: control.bounds.midX, y: control.bounds.midY), to: nil))
        }
        XCTAssertEqual(taps.visible, 1, "a visible button acts")
        XCTAssertEqual(taps.clipped, 0, "a clipped button does not")
        // Known limit: SwiftUI content drawn over a control has no view to detect. Cards never put a
        // control under other content; if one does, this records the change.
        XCTAssertEqual(taps.covered, 1)
        XCTAssertEqual(taps.overflow, 1)
    }
}
