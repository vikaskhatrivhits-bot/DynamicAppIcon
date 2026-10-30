package com.mustwatch.appicon

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.mustwatch.MainActivity
import com.mustwatch.R
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Switches the launcher icon by enabling exactly one `<activity-alias>` declared in
 * AndroidManifest.xml. PackageManager component state is the only source of truth, so the
 * selection survives process restarts and reboots without any separate storage.
 *
 * Invalid states (zero or several aliases enabled) are reported by [getIcon] as
 * `E_INVALID_STATE`; calling [setIcon] with any icon normalizes back to exactly one alias.
 */
class AppIconModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private class AppIconException(val code: String, message: String, cause: Throwable? = null) :
      Exception(message, cause)

  // All PackageManager reads and writes run on this one thread, so operations never overlap.
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  override fun getName(): String = NAME

  @ReactMethod
  fun getIcon(promise: Promise) {
    runSerialized(promise, E_READ_FAILED) { readSelection() }
  }

  @ReactMethod
  fun setIcon(icon: String, promise: Promise) {
    runSerialized(promise, E_SWITCH_FAILED) { switchTo(icon) }
  }

  override fun invalidate() {
    executor.shutdown()
    super.invalidate()
  }

  private fun runSerialized(promise: Promise, fallbackCode: String, block: () -> String) {
    try {
      executor.execute {
        try {
          promise.resolve(block())
        } catch (e: AppIconException) {
          promise.reject(e.code, e.message, e)
        } catch (e: Exception) {
          promise.reject(fallbackCode, "Unexpected app icon error: ${e.message}", e)
        }
      }
    } catch (e: RejectedExecutionException) {
      promise.reject(fallbackCode, "App icon module is shutting down.", e)
    }
  }

  private val packageManager: PackageManager
    get() = reactApplicationContext.packageManager

  private fun componentFor(icon: String): ComponentName = componentFor(reactApplicationContext, icon)

  /** Confirms every alias is declared (enabled or not) and targets MainActivity. */
  private fun validateAliases() {
    val expectedTarget = MainActivity::class.java.name
    for (icon in ALIASES.keys) {
      val component = componentFor(icon)
      val info: ActivityInfo =
          try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              packageManager.getActivityInfo(
                  component,
                  PackageManager.ComponentInfoFlags.of(
                      PackageManager.MATCH_DISABLED_COMPONENTS.toLong()))
            } else {
              @Suppress("DEPRECATION")
              packageManager.getActivityInfo(component, PackageManager.MATCH_DISABLED_COMPONENTS)
            }
          } catch (e: PackageManager.NameNotFoundException) {
            throw AppIconException(
                E_MISSING_ALIAS,
                "Launcher alias ${component.className} for '$icon' is not declared in the manifest.",
                e)
          }
      if (info.targetActivity != expectedTarget) {
        throw AppIconException(
            E_MISSING_ALIAS,
            "Launcher alias ${component.className} targets ${info.targetActivity}, expected $expectedTarget.")
      }
    }
  }

  /** Returns the effective enabled flag of every alias, keyed by JS icon name. */
  private fun readEnabledStates(): Map<String, Boolean> =
      try {
        enabledStates(reactApplicationContext)
      } catch (e: Exception) {
        throw AppIconException(E_READ_FAILED, "Could not read launcher alias state: ${e.message}", e)
      }

  private fun readSelection(): String {
    validateAliases()
    val enabled = readEnabledStates().filterValues { it }.keys
    if (enabled.size != 1) {
      val detail = if (enabled.isEmpty()) "none are enabled" else "several are enabled: ${enabled.joinToString()}"
      throw AppIconException(
          E_INVALID_STATE,
          "Expected exactly one launcher icon alias to be enabled, but $detail. Select an icon to repair it.")
    }
    return enabled.single()
  }

  private fun switchTo(icon: String): String {
    if (icon !in ALIASES) {
      throw AppIconException(
          E_INVALID_ICON, "Unknown icon '$icon'. Expected one of: ${ALIASES.keys.joinToString()}.")
    }
    validateAliases()

    val before = readEnabledStates()
    if (before.all { (name, on) -> on == (name == icon) }) {
      updateRunningTaskIcon(icon)
      return icon
    }

    val rawBefore =
        try {
          ALIASES.keys.associateWith { packageManager.getComponentEnabledSetting(componentFor(it)) }
        } catch (e: Exception) {
          throw AppIconException(E_READ_FAILED, "Could not read launcher alias state: ${e.message}", e)
        }

    try {
      applyStates(
          ALIASES.keys.associateWith {
            if (it == icon) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
          })
    } catch (e: Exception) {
      val recovery =
          try {
            applyStates(rawBefore)
            "The previous launcher icon state was restored."
          } catch (recoveryError: Exception) {
            e.addSuppressed(recoveryError)
            "Recovery also failed (${recoveryError.message}); the launcher entry may be missing until an icon is selected again."
          }
      throw AppIconException(E_SWITCH_FAILED, "Could not switch to '$icon': ${e.message}. $recovery", e)
    }

    val after = readEnabledStates()
    if (!after.all { (name, on) -> on == (name == icon) }) {
      throw AppIconException(
          E_SWITCH_FAILED,
          "Switch to '$icon' did not take effect; enabled aliases: ${after.filterValues { it }.keys.joinToString().ifEmpty { "none" }}.")
    }
    updateRunningTaskIcon(icon)
    return icon
  }

  /**
   * The running task keeps the icon of the component it was started from, so Recents would show
   * the previous icon until the task is recreated. Best-effort; never fails the switch.
   */
  private fun updateRunningTaskIcon(icon: String) {
    val activity = reactApplicationContext.currentActivity as? MainActivity ?: return
    activity.runOnUiThread { AppIconTaskDescription.apply(activity, ICON_RESOURCES.getValue(icon)) }
  }

  /**
   * Applies raw component states. API 33+ uses one batched call; older APIs enable first and
   * disable afterwards, so a failure part-way never leaves every launcher alias disabled.
   */
  private fun applyStates(states: Map<String, Int>) {
    val flags = PackageManager.DONT_KILL_APP
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      packageManager.setComponentEnabledSettings(
          states.map { (icon, state) ->
            PackageManager.ComponentEnabledSetting(componentFor(icon), state, flags)
          })
      return
    }
    val ordered =
        states.entries.sortedBy {
          if (it.value == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) 1 else 0
        }
    for ((icon, state) in ordered) {
      packageManager.setComponentEnabledSetting(componentFor(icon), state, flags)
    }
  }

  companion object {
    const val NAME = "AppIconModule"

    // BEGIN GENERATED APP ICONS (npm run icons:generate; do not edit by hand)
    /** JS icon name -> alias suffix; must match `${applicationId}.<suffix>` in the manifest. */
    private val ALIASES =
        linkedMapOf(
            "Default" to "IconDefault",
            "Holi" to "IconHoli",
            "Utrayan" to "IconUtrayan",
            "Diwali" to "IconDiwali",
            "Navratri" to "IconNavratri",
            "Dussera" to "IconDussera",
            "Butterfly" to "IconButterfly",
        )

    /** Aliases declared with android:enabled="true" in the manifest. */
    private val MANIFEST_ENABLED = setOf("Default")

    /** JS icon name -> launcher artwork; must match each alias's android:icon. */
    private val ICON_RESOURCES =
        mapOf(
            "Default" to R.mipmap.ic_launcher_default,
            "Holi" to R.mipmap.ic_launcher_holi,
            "Utrayan" to R.mipmap.ic_launcher_utrayan,
            "Diwali" to R.mipmap.ic_launcher_diwali,
            "Navratri" to R.mipmap.ic_launcher_navratri,
            "Dussera" to R.mipmap.ic_launcher_dussera,
            "Butterfly" to R.mipmap.ic_launcher_butterfly,
        )
    // END GENERATED APP ICONS

    private fun componentFor(context: Context, icon: String): ComponentName =
        ComponentName(context.packageName, "${context.packageName}.${ALIASES.getValue(icon)}")

    /** Effective enabled flag of every alias, keyed by JS icon name. */
    private fun enabledStates(context: Context): Map<String, Boolean> =
        ALIASES.keys.associateWith { icon ->
          when (context.packageManager.getComponentEnabledSetting(componentFor(context, icon))) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            // DEFAULT means "whatever the manifest declares", not "the Default icon".
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> icon in MANIFEST_ENABLED
            else -> false
          }
        }

    /**
     * Shows the selected icon on this activity's task in Recents. Called from
     * MainActivity.onCreate so tasks started from MainActivity directly or from a previously
     * enabled alias still show the current selection. Skipped when the alias state is invalid.
     */
    fun syncTaskIcon(activity: Activity) {
      val enabled =
          try {
            enabledStates(activity).filterValues { it }.keys
          } catch (e: Exception) {
            return
          }
      val icon = enabled.singleOrNull() ?: return
      AppIconTaskDescription.apply(activity, ICON_RESOURCES.getValue(icon))
    }

    private const val E_INVALID_ICON = "E_INVALID_ICON"
    private const val E_MISSING_ALIAS = "E_MISSING_ALIAS"
    private const val E_INVALID_STATE = "E_INVALID_STATE"
    private const val E_READ_FAILED = "E_READ_FAILED"
    private const val E_SWITCH_FAILED = "E_SWITCH_FAILED"
  }
}
