// The watchOS shell's app (increment 11, ADR 0008): the minimum a watch target compiles, with
// nothing but the name on screen. Phase 2 gives it content.
import SwiftUI

@main
struct PlaneAheadWatchApp: App {
  var body: some Scene {
    WindowGroup {
      Text("PlaneAhead")
    }
  }
}
