package app.planeahead.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/**
 * The one Tile of the Wear OS shell (increment 11, ADR 0008): a static "no flight yet" layout.
 * Phase 2 renders the next flight from the shared content state.
 */
class NextFlightTileService : TileService() {
  override fun onTileRequest(
    requestParams: RequestBuilders.TileRequest
  ): ListenableFuture<TileBuilders.Tile> =
    CallbackToFutureAdapter.getFuture { completer ->
      val layout =
        LayoutElementBuilders.Text.Builder().setText(getString(R.string.no_flight)).build()
      completer.set(
        TileBuilders.Tile.Builder()
          .setResourcesVersion(RESOURCES_VERSION)
          .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout))
          .build()
      )
      "NextFlightTile"
    }

  override fun onTileResourcesRequest(
    requestParams: RequestBuilders.ResourcesRequest
  ): ListenableFuture<ResourceBuilders.Resources> =
    CallbackToFutureAdapter.getFuture { completer ->
      completer.set(ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build())
      "NextFlightTileResources"
    }

  private companion object {
    const val RESOURCES_VERSION = "1"
  }
}
