package __ANDROID_PACKAGE__.appicon

import android.app.Activity
import android.app.ActivityManager.TaskDescription
import android.graphics.BitmapFactory
import android.util.Log
import androidx.annotation.DrawableRes
import __ANDROID_PACKAGE__.R

/**
 * Sets the icon shown for this app's task in Recents (Overview).
 *
 * Without an explicit TaskDescription, Android uses the icon of the component the task was
 * started from (MainActivity or the launcher alias that was tapped), which does not change when a
 * different alias is enabled later. Setting the TaskDescription lets the running task show the
 * selected icon. Recents UIs are owned by the launcher/OEM, so how quickly the card redraws can
 * still vary by device.
 *
 * The icon must be a Bitmap: Launcher3's Recents only reads in-memory/bitmap task icons and falls
 * back to the base activity icon for resource icons (Builder.setIcon(int) or
 * TaskDescription(String, int)), which here is MainActivity's, i.e. the Default artwork. The
 * Bitmap constructor is deprecated but is the only public Bitmap API and works on API 21-36.
 */
internal object AppIconTaskDescription {
  private const val TAG = "AppIconTaskDescription"

  /** Must be called on the UI thread. Best-effort: failures are logged, never thrown. */
  fun apply(activity: Activity, @DrawableRes iconRes: Int) {
    if (activity.isFinishing || activity.isDestroyed) {
      return
    }
    try {
      val bitmap = BitmapFactory.decodeResource(activity.resources, iconRes)
      if (bitmap == null) {
        Log.w(TAG, "Could not decode task icon resource $iconRes")
        return
      }
      @Suppress("DEPRECATION")
      activity.setTaskDescription(TaskDescription(activity.getString(R.string.app_name), bitmap))
    } catch (e: Exception) {
      Log.w(TAG, "Could not update the Recents task icon", e)
    }
  }
}
