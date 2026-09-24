package app.planeahead.surfaces

import android.app.Notification
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android counterpart of the flight Live Activity: an ongoing notification that Android 16
 * can promote to a Live Update (increment 11, ADR 0008).
 *
 * Phase 0 ships the shell only: the module compiles, links and exposes one method that does
 * nothing. Nothing is posted, so the app declares no notification permission for it; Phase 1
 * adds the channel, POST_PROMOTED_NOTIFICATIONS and the call from JavaScript.
 */
class OngoingNotificationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PlaneAheadOngoingNotification")

    // No-op in Phase 0. Phase 1 posts or updates the flight's ongoing notification here from the
    // shared LiveActivityContentStateV1 fields.
    Function("update") { _: Map<String, Any?> -> }
  }

  companion object {
    /**
     * The builder Phase 1 will post. Not called in Phase 0; it is here so the promotion call
     * compiles against the SDK the app builds with.
     *
     * Live Updates need API 36: `Notification.ProgressStyle` exists there, while the platform
     * `Notification.Builder#setRequestPromotedOngoing` only exists from API 36.1 (Android 16
     * QPR2) and does not compile against Expo SDK 57's compileSdk 36. androidx.core 1.17.0's
     * `NotificationCompat.Builder#setRequestPromotedOngoing` compiles against 36 and is guarded
     * here as well, so the request is only ever made on an Android 16 device.
     */
    internal fun ongoingBuilder(context: Context, channelId: String): NotificationCompat.Builder {
      val builder =
        NotificationCompat.Builder(context, channelId)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setCategory(Notification.CATEGORY_PROGRESS)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
        builder.setRequestPromotedOngoing(true)
      }
      return builder
    }
  }
}
