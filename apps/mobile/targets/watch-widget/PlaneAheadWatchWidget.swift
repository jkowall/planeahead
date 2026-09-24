import SwiftUI
import WidgetKit

struct Entry: TimelineEntry {
  let date: Date
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> Entry { Entry(date: Date()) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    completion(Entry(date: Date()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [Entry(date: Date())], policy: .never))
  }
}

@main
struct PlaneAheadWatchWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "PlaneAheadWatchWidget", provider: Provider()) { _ in
      Text("PlaneAhead")
    }
    .supportedFamilies([.accessoryCircular, .accessoryRectangular])
  }
}
