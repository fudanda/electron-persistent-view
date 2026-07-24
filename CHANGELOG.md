# Changelog

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
