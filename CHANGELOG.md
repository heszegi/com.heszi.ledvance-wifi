# Changelog

## [1.0.8] – 2026-01-05

### Added
- Added full support for **LEDVANCE Smart+ WiFi T8 Tube** devices.
- Introduced a dedicated **T8 Tube driver** using Tuya protocol 3.5.
- Added a separate discovery strategy for T8 Tube devices based on MAC OUI detection.
- Extended supported LEDVANCE OUIs.

### Improved
- Improved device discovery reliability to correctly detect multiple T8 Tube devices on the same network.
- Relaxed overly strict discovery rules to avoid missed devices.
- Improved pairing flow consistency across platforms.

### UI / UX
- Added proper **driver images** (`small` and `large` PNG) for pairing on **iOS and Android**.
- Retained SVG-based device icons for the **Homey Web App**, device cards, and flows.
- Fixed multiple icon rendering issues across different Homey views (pairing, device list, web UI).
- Ensured theme-compatible SVG icons while keeping PNG fallbacks where required.

### Fixed
- Fixed validation issues related to Homey Compose driver image requirements.

### Maintenance
- Cleaned up Homey Compose structure.
- Ensured all manifests fully comply with Homey validation rules.
- Updated app version to **1.0.8**.
