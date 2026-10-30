import UIKit
import React
import os

/// Switches the Home Screen icon with iOS alternate app icons. Mirrors the Android
/// AppIconModule: same module name, same `getIcon()` / `setIcon(icon)` API and error codes.
///
/// The icon sets live in Images.xcassets and are registered through the
/// "Alternate App Icon Sets" build setting, which generates CFBundleAlternateIcons.
/// `UIApplication.alternateIconName` is the source of truth; `nil` means the primary icon.
@objc(AppIconModule)
final class AppIconModule: NSObject {

  // BEGIN GENERATED APP ICONS (npm run icons:generate; do not edit by hand)
  /// JS icon name -> alternate icon set name (`nil` = primary AppIcon).
  private static let iconSets: [String: String?] = [
    "Default": nil,
  ]

  private static let orderedNames = ["Default"]
  // END GENERATED APP ICONS

  /// Diagnostics for icon switching. In Xcode's console, filter by "AppIcon".
  private static let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "__IOS_APP_NAME__", category: "AppIcon")

  /// Only touched on the main queue; prevents overlapping setAlternateIconName calls.
  private var isSwitching = false

  @objc static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(getIcon:rejecter:)
  func getIcon(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        resolve(try Self.currentIconName())
      } catch let error as AppIconError {
        reject(error.code, error.message, nil)
      } catch {
        reject("E_READ_FAILED", "Could not read the app icon: \(error.localizedDescription)", error)
      }
    }
  }

  @objc(setIcon:resolver:rejecter:)
  func setIcon(
    _ icon: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let target = Self.iconSets[icon] else {
        reject(
          "E_INVALID_ICON",
          "Unknown icon '\(icon)'. Expected one of: \(Self.orderedNames.joined(separator: ", ")).",
          nil)
        return
      }
      guard UIApplication.shared.supportsAlternateIcons else {
        reject("E_SWITCH_FAILED", "This device does not support alternate app icons.", nil)
        return
      }
      if let missing = Self.missingIconSets().first {
        reject(
          "E_MISSING_ALIAS",
          "Alternate icon set '\(missing)' is not in CFBundleAlternateIcons. Add it to the "
            + "target's Alternate App Icon Sets build setting.",
          nil)
        return
      }
      guard !self.isSwitching else {
        reject("E_SWITCH_FAILED", "Another app icon change is already in progress.", nil)
        return
      }
      if UIApplication.shared.alternateIconName == target {
        resolve(icon)
        return
      }

      self.isSwitching = true
      self.performSwitch(icon: icon, target: target, resolve: resolve, reject: reject)
    }
  }

  private func performSwitch(
    icon: String,
    target: String?,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let startedAt = Date()
    Self.log.info(
      "setIcon \(icon, privacy: .public): from=\(Self.describe(UIApplication.shared.alternateIconName), privacy: .public) to=\(Self.describe(target), privacy: .public) appState=\(Self.describeAppState(), privacy: .public)")
    UIApplication.shared.setAlternateIconName(target) { error in
      DispatchQueue.main.async {
        let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        let applied = UIApplication.shared.alternateIconName
        if let error = error as NSError? {
          Self.log.error(
            "setIcon \(icon, privacy: .public) completed with error domain=\(error.domain, privacy: .public) code=\(error.code) message=\(error.localizedDescription, privacy: .public) userInfo=\(String(describing: error.userInfo), privacy: .public) applied=\(Self.describe(applied), privacy: .public) appState=\(Self.describeAppState(), privacy: .public) elapsedMs=\(elapsedMs)")
        } else {
          Self.log.info(
            "setIcon \(icon, privacy: .public) succeeded applied=\(Self.describe(applied), privacy: .public) elapsedMs=\(elapsedMs)")
        }

        // iOS can return an error even though it applied the new icon (verified in the iOS 26.2
        // Simulator: the change is applied but its alert fails with "Input/output error").
        // alternateIconName is the source of truth, so only report a failure when the
        // requested icon was not applied.
        if let error = error as NSError?, applied != target {
          self.isSwitching = false
          reject("E_SWITCH_FAILED", Self.switchFailureMessage(icon: icon, error: error), error)
          return
        }

        self.isSwitching = false
        // Confirm iOS actually applied the requested icon before resolving.
        guard applied == target else {
          reject("E_SWITCH_FAILED", "Switch to '\(icon)' did not take effect.", nil)
          return
        }
        resolve(icon)
      }
    }
  }

  // MARK: - Helpers (main queue)

  /// Verified on the iOS 26.2 Simulator: lsd cannot present the "You have changed the icon"
  /// alert ("couldn't load upcall bundle principal class", POSIX EIO). The first change is still
  /// applied, but the app's icon-alert token is never released, so every later change fails
  /// immediately with POSIX EAGAIN from LSIconAlertManager until the Simulator restarts.
  /// Retrying in-app does not help. Physical devices were not tested here.
  private static func switchFailureMessage(icon: String, error: NSError) -> String {
    #if targetEnvironment(simulator)
      if error.domain == NSPOSIXErrorDomain && error.code == Int(EAGAIN) {
        return "Could not switch to '\(icon)': this iOS Simulator blocks further icon changes "
          + "after the first one (Simulator bug). Restart the Simulator (Device > Restart) to "
          + "change it again, or test on a physical iPhone."
      }
    #endif
    return "Could not switch to '\(icon)': \(error.localizedDescription)"
  }

  private static func describe(_ iconSet: String?) -> String {
    iconSet ?? "nil(AppIcon)"
  }

  private static func describeAppState() -> String {
    switch UIApplication.shared.applicationState {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }

  private struct AppIconError: Error {
    let code: String
    let message: String
  }

  private static func currentIconName() throws -> String {
    let current = UIApplication.shared.alternateIconName
    guard let name = orderedNames.first(where: { iconSets[$0] == current }) else {
      throw AppIconError(
        code: "E_INVALID_STATE",
        message: "The current alternate icon '\(current ?? "nil")' is not one of the known icons.")
    }
    return name
  }

  /// Alternate icon set names that the built Info.plist does not declare.
  private static func missingIconSets() -> [String] {
    let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
    let declared = (icons?["CFBundleAlternateIcons"] as? [String: Any]).map { Set($0.keys) } ?? []
    return orderedNames.compactMap { iconSets[$0] ?? nil }.filter { !declared.contains($0) }
  }
}
