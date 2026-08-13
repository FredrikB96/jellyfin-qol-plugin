# Jellyfin QoL Plugin - Settings UI v2.2

- User QoL settings now mount as a normal Jellyfin preference page instead of a fixed modal overlay.
- Uses Jellyfin native settings classes: `settingsContainer`, `verticalSection`, `sectionTitle`, native select/input/checkbox/button classes, and a full-width Save button.
- Keeps Jellyfin's normal top header visible and temporarily changes its title to `QoL Settings`.
- The original Profile -> Settings page is hidden only while QoL Settings is open and restored on close.
- Browser/hash navigation away automatically closes the QoL page.
- Select dropdown arrows are decorated using Jellyfin's normal `selectArrowContainer` shape.
- Custom CSS remains only for QoL-specific layouts such as the keybind table and Windows protected-input grid.
- Bridge version bumped to 1.1.0; plugin file version bumped to 1.0.1.0.
