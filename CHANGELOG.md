# Changelog

## 0.3.0 - 2026-07-27

### Added

- Added deterministic `open()` results for completed, superseded, and closed
  navigation attempts.
- Added `AbortSignal` cancellation and positive load timeouts.
- Added `flushStorageData()` and lifecycle state subscriptions.
- Added Windows, Linux, and macOS CI with real Electron smoke coverage for CJS,
  ESM, partition Sessions, path Sessions, and persisted localStorage.

### Security

- Enforced worker and subframe Node.js isolation, disabled insecure mixed
  content, WebView tags, experimental features, and host-provided Blink feature
  flags.
- Updated the Electron development validation baseline to `40.10.6`.

### Changed

- Added local `publint` and AreTheTypesWrong CI and release gates.
- Made superseded and closed loads settle promptly without allowing stale
  `loadURL()` rejections to become unhandled.

## 0.2.0 - 2026-07-24

### Added

- Added `open({ visible: false })` for loading and restoring a view without
  showing it.
- Added deterministic visibility intent while navigation is pending.

### Fixed

- Rolled back newly created WebContents when configuration or attachment fails.
- Completed detachment, WebContents closure, and state reset even when a host
  cleanup hook throws.
- Cleaned up controller state and listeners when WebContents is destroyed
  externally.
- Preserved an active view when an open request targets a different parent
  window.
- Prevented stale asynchronous loads from revealing a closed or replaced view.

### Documentation

- Documented that WebContentsView is composited above renderer DOM overlays and
  must be hidden by the host while welcome screens, settings, and modals are
  visible.
