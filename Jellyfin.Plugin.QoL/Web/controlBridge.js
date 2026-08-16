// Jellyfin QoL - Production Control Bridge v1.0.1
//
// Production native-control ownership bridge for contexts where AirNav normally yields:
//   - text entry: blur/refocus the active field
//   - player/native modal: navigate visible native controls
//
// Page navigation remains model/GeometryEngine driven. Native-surface
// geometry here is a temporary compatibility bridge until dedicated player
// and modal navigation phases model those controls directly.

(function (QoL) {
  'use strict';

  const VERSION = '1.0.1';
  const LEGACY_VERSION = '6.11';

  if (QoL.controlBridgeRuntime?.version === VERSION) {
    QoL.airControlBridge = QoL.controlBridgeRuntime;
    return;
  }

  const controlBridge = (function () {
    const DEFAULTS = {
      debug: false,
      playerRootSelector: [
        '.videoPlayerContainer',
        '.videoOsdBottom',
        '.videoOsdTop',
        '.skinHeader.osdHeader'
      ].join(', '),
      playerPlayPauseSelector: [
        '.videoPlayerContainer .btnPause',
        '.videoPlayerContainer .btnPlay',
        '.videoOsdBottom .btnPause',
        '.videoOsdBottom .btnPlay'
      ].join(', '),
      modalRootSelector: [
        '.actionSheet',
        '.dialogContainer .dialog',
        '[role="dialog"]',
        '[data-role="dialog"]',
        '.dialog',
        '.je-more-info-modal.active',
        '.jellyseerr-season-modal.show'
      ].join(', '),

      // Some playback plugins expose a visual pause screen as role="dialog".
      // It is not an interactive settings modal and must not steal AirNav's
      // player control surface. Genuine player settings/action sheets still
      // take priority over the OSD.
      playerPassiveOverlaySelector: [
        '#pause-screen-overlay'
      ].join(', '),

      // Real AirNav actions in the player count as user activity. This allows
      // inactivity-driven plugins (notably Jellyfin Enhanced's pause screen)
      // to hide immediately on input and restart their own idle timer.
      pauseOverlayActivityIntegration: true,

      // Broadcast a benign pointer/mouse movement for other DOM subscribers.
      // The pulse is intentionally > Jellyfin Enhanced's 15 px mouse threshold.
      // Periodic OSD keepalive uses a separate 1 px signal and does NOT count
      // as meaningful user activity.
      broadcastPlayerActivity: true,
      playerActivityMovePx: 24,

      // If Jellyfin's inputManager happens to be exposed by a wrapper/client,
      // use its public notify() shape as well. Standard jellyfin-web bundles
      // normally keep the ES module private, so this is feature-detected only.
      notifyExposedJellyfinInputManager: true,

      // While the custom pause overlay is legitimately active after inactivity,
      // stop forcing the OSD above it. The next real AirNav action dismisses
      // the overlay, resets its timer, and restores the OSD.
      yieldOsdToPauseOverlay: true,

      controlSelector: [
        'button:not([disabled])',
        'a[href]',
        '[role="button"]:not([aria-disabled="true"])',
        '[tabindex]:not([tabindex="-1"])',
        'select:not([disabled])'
      ].join(', '),

      // Most sliders remain excluded because they have native arrow semantics.
      // Volume is the exception: it can be selected as a normal AirNav target,
      // then ACTIVATE enters an explicit adjustment mode.
      skipAdjustableControls: true,
      adjustableControlSelector: [
        'input[type="range"]',
        '[role="slider"]',
        '[aria-valuemin][aria-valuemax]',
        '.volumeSlider',
        '.osdVolumeSlider',
        '.videoOsdVolumeSlider',
        '.positionSlider'
      ].join(', '),
      // Use a stable wrapper as the navigation identity. Jellyfin can update
      // or replace the underlying <input type=range> while its value changes;
      // keeping logical selection on the wrapper prevents the focus from
      // falling back to the neighbouring mute button.
      navigableAdjustableSelector: [
        '.osdVolumeSliderContainer',
        '.videoOsdVolumeSliderContainer',
        '.volumeSliderContainer'
      ].join(', '),
      adjustableInputSelector: [
        '.osdVolumeSlider',
        '.videoOsdVolumeSlider',
        '.volumeSlider',
        'input[type="range"]'
      ].join(', '),
      adjustableVisualSelector: '.sliderContainer',
      volumeAdjustStep: 5,

      // LEFT/RIGHT navigation stays inside the current visual row instead of
      // jumping into the OSD header or another lane when a row has large gaps.
      horizontalRowTolerancePx: 34,
      horizontalMinOverlapRatio: 0.35,

      // Releasing F6 should hand ownership back in the same state Jellyfin
      // normally reaches after idle: controls hidden and mouseIdle restored.
      hidePlayerOsdOnRelease: true,
      hidePlayerOsdReleaseDelayMs: 60,

      // Jellyfin hides playback OSD after inactivity. AirNav consumes the
      // physical arrow event, so periodically generate harmless pointer
      // activity while explicit player control is active.
      playerKeepAliveMs: 1000,

      // Strong fallback for clients/themes/plugins that ignore synthetic
      // pointer activity or hide the OSD via CSS classes such as mouseIdle,
      // hide-mouse-idle, pause-screen-active, opacity or visibility rules.
      //
      // This is active ONLY while AirNav explicitly owns player controls.
      forcePlayerOsdVisible: true,
      forcePlayerOsdIntervalMs: 250,
      forcePlayerOsdClass: 'airnav-force-player-osd',
      playerOsdSelector: [
        '.videoOsdBottom',
        '.videoOsdTop',
        '.skinHeader.osdHeader'
      ].join(', '),

      focusClassName: 'airnav-native-focused',
      styleId: 'airnav-native-focus-style',
      focusOutlineWidthPx: 3,
      focusOutlineOffsetPx: 3,
      focusBorderRadiusPx: 8,
      primaryWeight: 1.0,
      secondaryWeight: 1.8,
      offAxisPenalty: 160,
      offAxisThresholdPx: 180,
      epsilonPx: 4
    };

    let cfg = null;
    let savedTextElement = null;
    let nativeSurface = null;
    let nativeFocusedElement = null;
    let nativeFocusVisualElement = null;
    let adjustableMode = false;
    let playerKeepAliveTimer = null;
    let playerForceTimer = null;
    let playerHideTimer = null;
    let playerActivityPulse = 0;
    let playerActivityBroadcastPulse = 0;
    let lastMeaningfulPlayerActivityAt = 0;

    function getSettings() {
      const legacySettings = QoL.settings || {};
      const legacyAirNav = legacySettings.airNav || {};

      let runtime = QoL.runtimeConfig || null;
      if (!runtime && typeof QoL.runtimeSettings?.getConfig === 'function') {
        try {
          runtime = QoL.runtimeSettings.getConfig() || null;
        } catch (_) {}
      }
      runtime = runtime || {};

      const player = runtime.player || {};
      const focus = runtime.focus || {};

      const legacyOverrides = legacyAirNav.controlBridge || {};
      const runtimeOverrides =
        runtime.controlBridge ||
        runtime.airNav?.controlBridge ||
        {};

      const settings = {
        ...DEFAULTS,
        ...legacyOverrides,
        ...runtimeOverrides
      };

      if (
        runtimeOverrides.volumeAdjustStep == null &&
        legacyOverrides.volumeAdjustStep == null &&
        Number.isFinite(Number(player.volumeStep))
      ) {
        settings.volumeAdjustStep = Number(player.volumeStep);
      }

      if (
        runtimeOverrides.hidePlayerOsdOnRelease == null &&
        legacyOverrides.hidePlayerOsdOnRelease == null &&
        typeof player.allowOsdTimeout === 'boolean'
      ) {
        settings.hidePlayerOsdOnRelease =
          player.allowOsdTimeout !== false;
      }

      if (
        runtimeOverrides.focusOutlineWidthPx == null &&
        Number.isFinite(Number(focus.outlineWidthPx))
      ) {
        settings.focusOutlineWidthPx =
          Number(focus.outlineWidthPx);
      }

      if (
        runtimeOverrides.focusOutlineOffsetPx == null &&
        Number.isFinite(Number(focus.outlineOffsetPx))
      ) {
        settings.focusOutlineOffsetPx =
          Number(focus.outlineOffsetPx);
      }

      if (
        runtimeOverrides.focusBorderRadiusPx == null &&
        Number.isFinite(Number(focus.borderRadiusPx))
      ) {
        settings.focusBorderRadiusPx =
          Number(focus.borderRadiusPx);
      }

      settings.debug = !!(
        runtimeOverrides.debug ||
        legacyOverrides.debug ||
        legacyAirNav.debug ||
        runtime.debug ||
        legacySettings.DEBUG
      );

      return settings;
    }

    function ensureConfig() {
      if (!cfg) cfg = getSettings();
      return cfg;
    }

    function log(...args) {
      if (!ensureConfig().debug) return;
      console.log('[AirNav.ControlBridge]', ...args);
    }

    function ensureStyle() {
      const settings = ensureConfig();
      if (document.getElementById(settings.styleId)) return;

      const style = document.createElement('style');
      style.id = settings.styleId;
      style.setAttribute('data-airnav-owner', 'control-bridge');
      style.textContent = `
        .${settings.focusClassName} {
          outline: ${Math.max(1, Number(settings.focusOutlineWidthPx) || 3)}px solid var(--theme-primary-color, #00a4dc) !important;
          outline-offset: ${Number(settings.focusOutlineOffsetPx) || 0}px !important;
          border-radius: ${Math.max(0, Number(settings.focusBorderRadiusPx) || 0)}px !important;
          box-shadow: 0 0 16px rgba(0, 164, 220, .55) !important;
          position: relative;
          z-index: 130 !important;
        }

        .${settings.focusClassName}.airnav-native-adjusting {
          outline-width: 5px !important;
          outline-style: double !important;
        }

        /*
         * Explicit player takeover means AirNav owns OSD visibility.
         * High specificity + !important intentionally beats normal Jellyfin
         * idle rules and plugin/theme rules while the force class is present.
         */
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdBottom,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdTop,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .skinHeader.osdHeader {
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
          z-index: 120 !important;
        }

        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdBottom.hide,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdBottom.videoOsdBottom-hidden,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdBottom.hide-mouse-idle,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdBottom.hide-mouse-idle-tv,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdTop.hide,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdTop.hide-mouse-idle,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .videoOsdTop.hide-mouse-idle-tv {
          display: flex !important;
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
        }

        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .skinHeader.osdHeader.hide,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .skinHeader.osdHeader.osdHeader-hidden,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .skinHeader.osdHeader.hide-mouse-idle,
        html.${settings.forcePlayerOsdClass}:not(.pause-screen-active) body .skinHeader.osdHeader.hide-mouse-idle-tv {
          display: flex !important;
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
        }

      `;
      document.head.appendChild(style);
    }

    function isTextEntry(element) {
      if (!element) return false;
      const tag = element.tagName?.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        element.isContentEditable === true
      );
    }

    function takeFromText() {
      const active = document.activeElement;
      if (!isTextEntry(active)) {
        return { changed: false, reason: 'no-active-text-entry' };
      }

      savedTextElement = active;
      try { active.blur(); } catch (_) {}

      log('took control from text entry', describeElement(active));

      return {
        changed: true,
        reason: 'text-control-taken',
        element: describeElement(active)
      };
    }

    function returnToText() {
      const target = savedTextElement;
      if (!target?.isConnected || typeof target.focus !== 'function') {
        savedTextElement = null;
        return { changed: false, reason: 'saved-text-entry-missing' };
      }

      try { target.focus({ preventScroll: true }); }
      catch (_) { try { target.focus(); } catch (_) {} }

      log('returned control to text entry', describeElement(target));
      return {
        changed: true,
        reason: 'text-control-returned',
        element: describeElement(target)
      };
    }

    function clearSavedText() {
      savedTextElement = null;
    }

    function hasSavedText() {
      return !!savedTextElement?.isConnected;
    }

    function enterNativeSurface(surface = 'player') {
      ensureStyle();
      cancelScheduledPlayerHide();

      // IMPORTANT: Controller.handleModelState() may call enterNativeSurface()
      // again when Scanner publishes a model update. That is NOT new physical
      // user input and must never restart ownership, emit activity or choose a
      // new initial control.
      //
      // Keeping this idempotent also preserves a logical volume-wrapper target
      // even though document.activeElement may still be the previous Mute
      // button (range wrappers intentionally do not receive DOM focus).
      if (nativeSurface === surface) {
        return {
          changed: false,
          reason: 'native-surface-already-active',
          surface,
          controls: getNativeControls().length,
          target: describeElement(nativeFocusedElement),
          pauseOverlayActive: isPauseOverlayActive()
        };
      }

      // Actual ownership transition.
      stopPlayerKeepAlive();
      stopPlayerVisibilityForce();
      releaseForcedPlayerOsdVisibility();

      nativeSurface = surface;

      if (surface === 'player') {
        // This path is reached once for the real F6 ownership transition.
        notifyMeaningfulPlayerActivity('enter-native-control');
        forcePlayerOsdVisibility();
        startPlayerVisibilityForce();
        signalPlayerActivity();
        startPlayerKeepAlive();
      } else {
        stopPlayerVisibilityForce();
        releaseForcedPlayerOsdVisibility();
        stopPlayerKeepAlive();
      }

      const controls = getNativeControls();
      if (!controls.length) {
        clearNativeFocus();
        return { changed: false, reason: 'no-native-controls', surface };
      }

      const active = document.activeElement;
      const existing = controls.includes(active) ? active : null;
      const target = existing || chooseInitialControl(controls);
      renderNativeFocus(target);

      log('entered native surface', {
        surface,
        controls: controls.length,
        target: describeElement(target)
      });

      return {
        changed: true,
        reason: 'native-surface-entered',
        surface,
        controls: controls.length,
        target: describeElement(target)
      };
    }

    function exitNativeSurface() {
      const previous = nativeSurface;

      stopPlayerVisibilityForce();
      releaseForcedPlayerOsdVisibility();
      stopPlayerKeepAlive();

      adjustableMode = false;
      clearNativeFocus();
      nativeSurface = null;

      if (
        previous === 'player' &&
        ensureConfig().hidePlayerOsdOnRelease !== false
      ) {
        schedulePlayerOsdHide();
      }

      return {
        changed: !!previous,
        reason: previous ? 'native-surface-exited' : 'native-surface-not-active',
        surface: previous
      };
    }

    function refreshNativeSurface(surface = nativeSurface) {
      if (!surface) return { changed: false, reason: 'no-native-surface' };
      nativeSurface = surface;

      if (
        surface === 'player' &&
        isPauseOverlayActive()
      ) {
        // The OSD is intentionally hidden by the inactivity overlay. Do not
        // interpret hidden controls as having disappeared and do not clear or
        // restore focus. The next REAL AirNav action will dismiss the overlay
        // and continue from nativeFocusedElement.
        startPlayerVisibilityForce();
        startPlayerKeepAlive();

        return {
          changed: false,
          reason: 'native-refresh-suspended-by-pause-overlay',
          surface,
          target: describeElement(nativeFocusedElement)
        };
      }

      if (surface === 'player') {
        forcePlayerOsdVisibility();
        startPlayerVisibilityForce();
        signalPlayerActivity();
        startPlayerKeepAlive();
      } else {
        stopPlayerVisibilityForce();
        releaseForcedPlayerOsdVisibility();
        stopPlayerKeepAlive();
      }

      const controls = getNativeControls();
      if (!controls.length) {
        clearNativeFocus();
        return { changed: false, reason: 'no-native-controls', surface };
      }

      if (
        nativeFocusedElement?.isConnected &&
        controls.includes(nativeFocusedElement) &&
        isRendered(nativeFocusedElement)
      ) {
        renderNativeFocus(nativeFocusedElement);
        return { changed: false, reason: 'native-focus-preserved', surface };
      }

      const target = chooseInitialControl(controls);
      renderNativeFocus(target);
      return {
        changed: true,
        reason: 'native-focus-restored',
        surface,
        target: describeElement(target)
      };
    }

    function dispatchNativeAction(action) {
      const normalized = String(action || '').toUpperCase();

      if (!nativeSurface) {
        return { handled: false, reason: 'native-surface-not-active' };
      }

      if (nativeSurface === 'player') {
        notifyMeaningfulPlayerActivity(
          `airnav-action:${normalized || 'UNKNOWN'}`
        );
        forcePlayerOsdVisibility();
        signalPlayerActivity();
      }

      if (
        normalized === 'PLAY_PAUSE' &&
        isPlaybackPlayerPresent()
      ) {
        return dispatchPlayerPlayPause();
      }

      const controls = getNativeControls();
      if (!controls.length) {
        // A real action may have just dismissed an inactivity overlay whose
        // CSS/DOM has not settled yet. Preserve the logical target instead of
        // resetting to Pause/Mute on the next model refresh.
        if (
          nativeSurface === 'player' &&
          nativeFocusedElement?.isConnected
        ) {
          return {
            handled: true,
            reason: 'native-controls-waking-after-activity',
            action: normalized,
            target: describeElement(nativeFocusedElement)
          };
        }

        return { handled: false, reason: 'no-native-controls' };
      }

      let current = (
        nativeFocusedElement?.isConnected &&
        controls.includes(nativeFocusedElement)
      ) ? nativeFocusedElement : null;

      if (!current) {
        adjustableMode = false;
        current = chooseInitialControl(controls);
        renderNativeFocus(current);
      }

      // A selected volume slider is still a navigation target until ACTIVATE
      // enters adjustment mode. In adjustment mode arrows change value and
      // ACTIVATE/BACK returns to normal OSD navigation.
      if (adjustableMode && isNavigableAdjustable(current)) {
        if (['LEFT', 'DOWN', 'RIGHT', 'UP'].includes(normalized)) {
          const direction =
            (normalized === 'LEFT' || normalized === 'DOWN')
              ? -1
              : 1;

          const changed = adjustControlValue(current, direction);

          return {
            handled: true,
            reason: changed ? 'native-adjusted' : 'native-adjust-edge',
            action: normalized,
            value: getAdjustableValue(current),
            target: describeElement(current)
          };
        }

        if (normalized === 'ACTIVATE' || normalized === 'BACK') {
          adjustableMode = false;
          renderNativeFocus(current);

          return {
            handled: true,
            reason: 'native-adjust-mode-exited',
            value: getAdjustableValue(current),
            target: describeElement(current)
          };
        }

        return {
          handled: true,
          reason: 'native-adjust-mode-owned',
          action: normalized
        };
      }

      if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(normalized)) {
        const target = chooseDirectionalTarget(current, controls, normalized);
        if (!target) {
          return {
            handled: true,
            reason: 'native-edge-clamped',
            action: normalized,
            current: describeElement(current)
          };
        }

        renderNativeFocus(target);
        return {
          handled: true,
          reason: 'native-focus-moved',
          action: normalized,
          current: describeElement(current),
          target: describeElement(target)
        };
      }

      if (normalized === 'ACTIVATE') {
        const target = nativeFocusedElement || current;
        if (!target?.isConnected) {
          return { handled: false, reason: 'native-activation-target-missing' };
        }

        if (isNavigableAdjustable(target)) {
          adjustableMode = true;
          renderNativeFocus(target);

          return {
            handled: true,
            reason: 'native-adjust-mode-entered',
            value: getAdjustableValue(target),
            target: describeElement(target)
          };
        }

        try {
          if (typeof target.click === 'function') {
            target.click();
            setTimeout(() => {
              if (nativeSurface) refreshNativeSurface(nativeSurface);
            }, 100);
            return {
              handled: true,
              reason: 'native-activated',
              target: describeElement(target)
            };
          }
        } catch (error) {
          console.error('[AirNav.ControlBridge] native activation failed', error);
        }

        return { handled: false, reason: 'native-activation-failed' };
      }

      if (normalized === 'BACK') {
        const sent = dispatchSyntheticKey(
          document.activeElement || document,
          'Escape',
          'Escape'
        );
        return {
          handled: sent,
          reason: sent ? 'native-back-dispatched' : 'native-back-failed'
        };
      }

      return {
        handled: false,
        reason: 'native-action-not-supported',
        action: normalized
      };
    }

    function isPlaybackPlayerPresent() {
      const route = String(
        location.hash ||
        `${location.pathname}${location.search}` ||
        ''
      ).toLowerCase();

      return (
        /^#\/video(?:[/?#]|$)/.test(route) ||
        !!document.querySelector(
          '.videoPlayerContainer video, .videoPlayerContainer .htmlvideoplayer'
        )?.isConnected
      );
    }

    function dispatchPlayerPlayPause() {
      const settings = ensureConfig();
      const candidates = Array.from(
        document.querySelectorAll(
          settings.playerPlayPauseSelector
        )
      ).filter(element =>
        element?.isConnected &&
        !isDisabled(element)
      );
      const target =
        candidates.find(isRendered) ||
        candidates[0] ||
        null;

      if (!target) {
        return {
          handled: false,
          reason: 'player-play-pause-control-missing',
          action: 'PLAY_PAUSE'
        };
      }

      try {
        target.click();
        return {
          handled: true,
          reason: 'player-play-pause-activated',
          action: 'PLAY_PAUSE',
          target: describeElement(target)
        };
      } catch (error) {
        console.error(
          '[AirNav.ControlBridge] player play/pause failed',
          error
        );
        return {
          handled: false,
          reason: 'player-play-pause-failed',
          action: 'PLAY_PAUSE',
          error: String(error?.message || error)
        };
      }
    }

    function getNativeControls() {
      const settings = ensureConfig();
      const roots = getSurfaceRoots();
      const controls = [];

      for (const root of roots) {
        if (!root?.isConnected || !isRendered(root)) continue;

        if (
          matchesControl(root) &&
          !(
            settings.skipAdjustableControls &&
            isAdjustableControl(root)
          )
        ) {
          controls.push(root);
        }

        for (const element of root.querySelectorAll(settings.controlSelector)) {
          if (!isRendered(element) || isDisabled(element)) continue;

          if (
            settings.skipAdjustableControls &&
            isAdjustableControl(element) &&
            !isNavigableAdjustable(element)
          ) {
            continue;
          }

          controls.push(element);
        }

        // Add explicitly navigable adjustable WRAPPERS (currently volume).
        // The wrapper is the stable navigation identity; its descendant range
        // input is only used when changing the value.
        for (
          const element of
          root.querySelectorAll(settings.navigableAdjustableSelector)
        ) {
          if (!isRendered(element) || isDisabled(element)) continue;
          if (!resolveAdjustableInput(element)) continue;
          controls.push(element);
        }
      }

      return dedupeControls(controls);
    }

    function getSurfaceRoots() {
      const settings = ensureConfig();

      if (nativeSurface === 'modal') {
        return Array.from(document.querySelectorAll(settings.modalRootSelector))
          .filter(isRendered);
      }

      if (nativeSurface === 'player') {
        const modalRoots = Array.from(
          document.querySelectorAll(settings.modalRootSelector)
        )
          .filter(isRendered)
          .filter(root => !isPassivePlayerOverlay(root));

        // A genuine player settings/action dialog should own navigation.
        // Presentation-only overlays such as Jellyfin Enhanced's pause screen
        // are ignored so AirNav continues to navigate the actual OSD beneath
        // (which is deliberately raised above the overlay while F6 is active).
        if (modalRoots.length) return modalRoots;

        return Array.from(
          document.querySelectorAll(settings.playerRootSelector)
        ).filter(isRendered);
      }

      return [];
    }

    function isPassivePlayerOverlay(root) {
      if (!root?.matches) return false;

      const selector =
        ensureConfig().playerPassiveOverlaySelector;

      if (!selector) return false;

      try {
        return root.matches(selector);
      } catch (_) {
        return false;
      }
    }

    function getPauseOverlayElement() {
      const selector =
        ensureConfig().playerPassiveOverlaySelector;

      if (!selector) return null;

      try {
        return document.querySelector(selector);
      } catch (_) {
        return null;
      }
    }

    function isPauseOverlayActive() {
      const html = document.documentElement;
      const overlay = getPauseOverlayElement();

      return !!(
        html?.classList?.contains('pause-screen-active') ||
        (
          overlay?.isConnected &&
          overlay.getAttribute?.('aria-hidden') === 'false'
        )
      );
    }

    function getEnhancedPauseScreenInstance() {
      return (
        window.JellyfinEnhanced?.pauseScreenInstance ||
        null
      );
    }

    function notifyExposedJellyfinInputManager() {
      if (
        ensureConfig().notifyExposedJellyfinInputManager === false
      ) {
        return false;
      }

      // jellyfin-web's inputManager is normally module-private. Some wrappers
      // expose it globally, so use it only when the expected notify/idleTime
      // shape is actually present.
      const candidates = [
        window.inputManager,
        window.Jellyfin?.inputManager
      ];

      const manager = candidates.find(item => (
        item &&
        typeof item.notify === 'function' &&
        typeof item.idleTime === 'function'
      ));

      if (!manager) return false;

      try {
        manager.notify();
        return true;
      } catch (_) {
        return false;
      }
    }

    function broadcastMeaningfulPlayerActivity(reason = 'airnav') {
      if (ensureConfig().broadcastPlayerActivity === false) {
        return false;
      }

      const settings = ensureConfig();
      const root =
        document.querySelector('.videoPlayerContainer') ||
        document.body ||
        document.documentElement;

      if (!root?.dispatchEvent) return false;

      const r = root.getBoundingClientRect?.() || {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight
      };

      const movePx = Math.max(
        16,
        Number(settings.playerActivityMovePx) || 24
      );

      // Alternate opposite sides of centre. Consecutive meaningful events are
      // therefore separated by >= 2 * movePx and cross common mouse thresholds.
      playerActivityBroadcastPulse =
        playerActivityBroadcastPulse > 0 ? -1 : 1;

      const clientX =
        r.left +
        Math.max(1, r.width / 2) +
        (playerActivityBroadcastPulse * movePx);

      const clientY =
        r.top +
        Math.max(1, r.height / 2);

      let dispatched = false;

      if (typeof PointerEvent === 'function') {
        try {
          root.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: false,
            composed: true,
            pointerType: 'mouse',
            isPrimary: true,
            clientX,
            clientY
          }));
          dispatched = true;
        } catch (_) {}
      }

      try {
        root.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: false,
          composed: true,
          clientX,
          clientY,
          view: window
        }));
        dispatched = true;
      } catch (_) {}

      // Stable AirNav-specific fanout for other QoL modules/plugins that want
      // to subscribe without interpreting synthetic mouse movement.
      try {
        document.dispatchEvent(new CustomEvent(
          'airnav:useractivity',
          {
            bubbles: false,
            cancelable: false,
            detail: {
              context: 'player',
              reason,
              timestamp: performance.now()
            }
          }
        ));
        dispatched = true;
      } catch (_) {}

      return dispatched;
    }

    function notifyMeaningfulPlayerActivity(reason = 'airnav') {
      lastMeaningfulPlayerActivityAt = Date.now();

      const wasPauseOverlayActive =
        isPauseOverlayActive();

      let pauseOverlayHidden = false;
      let pauseTimerReset = false;

      if (
        ensureConfig().pauseOverlayActivityIntegration !== false
      ) {
        const pauseScreen =
          getEnhancedPauseScreenInstance();

        // hideOverlay(false) is important: false means "temporarily hide due
        // to activity", not "dismiss for the entire current pause".
        if (
          wasPauseOverlayActive &&
          typeof pauseScreen?.hideOverlay === 'function'
        ) {
          try {
            pauseScreen.hideOverlay(false);
            pauseOverlayHidden = true;
          } catch (error) {
            log('pause screen hideOverlay(false) failed', error);
          }
        }

        // Restart Jellyfin Enhanced's own configured inactivity timer instead
        // of duplicating its delay inside AirNav.
        if (
          typeof pauseScreen?.resetPauseScreenTimer === 'function'
        ) {
          try {
            pauseScreen.resetPauseScreenTimer();
            pauseTimerReset = true;
          } catch (error) {
            log('pause screen resetPauseScreenTimer failed', error);
          }
        }

        // Compatibility fallback for older/different pause-screen builds.
        if (
          wasPauseOverlayActive &&
          !pauseOverlayHidden
        ) {
          const overlay = getPauseOverlayElement();
          document.documentElement?.classList?.remove(
            'pause-screen-active'
          );

          if (overlay?.isConnected) {
            overlay.setAttribute('aria-hidden', 'true');
            pauseOverlayHidden = true;
          }
        }
      }

      const jellyfinInputNotified =
        notifyExposedJellyfinInputManager();

      const activityBroadcast =
        broadcastMeaningfulPlayerActivity(reason);

      log('meaningful player activity', {
        reason,
        wasPauseOverlayActive,
        pauseOverlayHidden,
        pauseTimerReset,
        jellyfinInputNotified,
        activityBroadcast
      });

      return {
        notified: true,
        reason,
        wasPauseOverlayActive,
        pauseOverlayHidden,
        pauseTimerReset,
        jellyfinInputNotified,
        activityBroadcast
      };
    }

    function forcePlayerOsdVisibility() {
      const settings = ensureConfig();

      if (
        nativeSurface !== 'player' ||
        settings.forcePlayerOsdVisible === false
      ) {
        return false;
      }

      ensureStyle();

      const html = document.documentElement;
      const body = document.body;

      html?.classList?.add(settings.forcePlayerOsdClass);

      // The custom pause screen is an intentional inactivity surface. Keep F6
      // ownership, but allow the overlay to hide the OSD until the next real
      // AirNav action calls notifyMeaningfulPlayerActivity().
      if (
        settings.yieldOsdToPauseOverlay !== false &&
        isPauseOverlayActive()
      ) {
        return false;
      }

      // Jellyfin's built-in idle stylesheet hides .hide-mouse-idle descendants
      // when mouseIdle/mouseIdle-tv is present. Synthetic events are not always
      // trusted by plugins, so explicit takeover removes those idle flags.
      for (const owner of [html, body]) {
        owner?.classList?.remove('mouseIdle', 'mouseIdle-tv');
      }

      let found = false;

      for (const root of document.querySelectorAll(settings.playerOsdSelector)) {
        if (!root?.isConnected) continue;
        found = true;

        // Remove direct hide tokens. The force stylesheet still provides the
        // final authority if a plugin immediately adds them again.
        root.classList?.remove(
          'hide',
          'hide-mouse-idle',
          'hide-mouse-idle-tv',
          'videoOsdBottom-hidden',
          'osdHeader-hidden'
        );

        // aria-hidden can keep the bridge from seeing otherwise visible
        // controls. During explicit takeover the OSD is intentionally active.
        if (root.getAttribute?.('aria-hidden') === 'true') {
          root.setAttribute('aria-hidden', 'false');
        }
      }

      return found;
    }

    function startPlayerVisibilityForce() {
      const settings = ensureConfig();

      if (
        nativeSurface !== 'player' ||
        settings.forcePlayerOsdVisible === false ||
        playerForceTimer
      ) {
        return;
      }

      const interval =
        Number(settings.forcePlayerOsdIntervalMs) || 0;

      if (interval <= 0) return;

      playerForceTimer = setInterval(() => {
        if (nativeSurface !== 'player') {
          stopPlayerVisibilityForce();
          return;
        }

        forcePlayerOsdVisibility();
      }, Math.max(100, interval));
    }

    function stopPlayerVisibilityForce() {
      if (!playerForceTimer) return;

      clearInterval(playerForceTimer);
      playerForceTimer = null;
    }

    function releaseForcedPlayerOsdVisibility() {
      const settings = ensureConfig();

      document.documentElement?.classList?.remove(
        settings.forcePlayerOsdClass
      );
    }

    function schedulePlayerOsdHide() {
      cancelScheduledPlayerHide();

      const delay = Math.max(
        0,
        Number(ensureConfig().hidePlayerOsdReleaseDelayMs) || 0
      );

      playerHideTimer = setTimeout(() => {
        playerHideTimer = null;

        // Do nothing if the user already took control again.
        if (nativeSurface === 'player') return;

        hidePlayerOsdNow();
      }, delay);
    }

    function cancelScheduledPlayerHide() {
      if (!playerHideTimer) return;
      clearTimeout(playerHideTimer);
      playerHideTimer = null;
    }

    function hidePlayerOsdNow() {
      document.body?.classList?.add('mouseIdle');

      const bottom = document.querySelector('.videoOsdBottom');
      if (bottom?.isConnected) {
        bottom.classList.add(
          'videoOsdBottom-hidden',
          'hide'
        );
      }

      const top = document.querySelector('.videoOsdTop');
      if (top?.isConnected) {
        top.classList.add('hide');
      }

      const header = document.querySelector('.skinHeader.osdHeader');
      if (header?.isConnected) {
        header.classList.add(
          'osdHeader-hidden',
          'hide'
        );
      }

      return true;
    }

    function signalPlayerActivity() {
      const settings = ensureConfig();
      const root =
        document.querySelector('.videoPlayerContainer') ||
        document.querySelector(settings.playerRootSelector);

      if (!root?.isConnected) return false;

      const r = root.getBoundingClientRect();

      // Alternate one pixel so implementations that compare coordinates still
      // see each keepalive as fresh activity.
      playerActivityPulse = playerActivityPulse ? 0 : 1;

      const clientX =
        r.left +
        Math.max(1, r.width / 2) +
        playerActivityPulse;

      const clientY =
        r.top +
        Math.max(1, r.height / 2);

      let dispatched = false;

      // PointerEvent first for modern Jellyfin/browser input paths.
      if (typeof PointerEvent === 'function') {
        try {
          root.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true,
            clientX,
            clientY
          }));
          dispatched = true;
        } catch (_) {}
      }

      // MouseEvent fallback/companion for clients listening specifically for
      // mouse activity.
      try {
        root.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          view: window
        }));
        dispatched = true;
      } catch (_) {}

      return dispatched;
    }

    function startPlayerKeepAlive() {
      if (nativeSurface !== 'player') return;

      const interval =
        Number(ensureConfig().playerKeepAliveMs) || 0;

      if (interval <= 0 || playerKeepAliveTimer) return;

      playerKeepAliveTimer = setInterval(() => {
        if (nativeSurface !== 'player') {
          stopPlayerKeepAlive();
          return;
        }

        // Once the inactivity pause overlay is visible, AirNav must become
        // completely quiet. Even a tiny synthetic mousemove can be interpreted
        // by the overlay/plugin as fresh user input and dismiss it.
        if (isPauseOverlayActive()) {
          return;
        }

        forcePlayerOsdVisibility();
        signalPlayerActivity();
      }, Math.max(250, interval));
    }

    function stopPlayerKeepAlive() {
      if (!playerKeepAliveTimer) return;

      clearInterval(playerKeepAliveTimer);
      playerKeepAliveTimer = null;
    }

    // Backwards/internal alias retained for the Phase 6.1 implementation name.
    function revealPlayerOsd() {
      return signalPlayerActivity();
    }

    function isAdjustableControl(element) {
      if (!element?.matches) return false;

      const selector =
        ensureConfig().adjustableControlSelector;

      try {
        if (selector && element.matches(selector)) {
          return true;
        }
      } catch (_) {}

      // Some themed/native sliders expose value bounds but not role=slider.
      const hasValueBounds =
        element.hasAttribute?.('aria-valuemin') &&
        element.hasAttribute?.('aria-valuemax');

      if (hasValueBounds) return true;

      // A focusable wrapper around a range/slider should also be skipped,
      // otherwise AirNav can land on the wrapper and the same arrow semantics
      // leak through to the underlying adjustable control.
      try {
        return !!(
          selector &&
          element.querySelector?.(selector)
        );
      } catch (_) {
        return false;
      }
    }

    function chooseInitialControl(controls) {
      if (!controls.length) return null;

      return [...controls].sort((a, b) => {
        const ar = rect(a);
        const br = rect(b);
        const aBottomBias = Math.abs((window.innerHeight * 0.82) - ar.centerY);
        const bBottomBias = Math.abs((window.innerHeight * 0.82) - br.centerY);

        if (aBottomBias !== bBottomBias) return aBottomBias - bBottomBias;

        return Math.abs((window.innerWidth / 2) - ar.centerX) -
          Math.abs((window.innerWidth / 2) - br.centerX);
      })[0];
    }

    function chooseDirectionalTarget(current, controls, direction) {
      const settings = ensureConfig();
      const currentRect = rect(current);

      if (
        nativeSurface === 'player' &&
        (direction === 'LEFT' || direction === 'RIGHT')
      ) {
        const neighbour = chooseHorizontalRowNeighbour(
          current,
          controls,
          direction
        );

        if (neighbour) return neighbour;
      }

      const candidates = [];

      for (const candidate of controls) {
        if (candidate === current) continue;
        const candidateRect = rect(candidate);
        if (!isDirectional(candidateRect, currentRect, direction)) continue;

        const horizontal = direction === 'LEFT' || direction === 'RIGHT';

        if (
          horizontal &&
          !isSameHorizontalRow(currentRect, candidateRect)
        ) {
          continue;
        }

        const primary = horizontal
          ? Math.abs(candidateRect.centerX - currentRect.centerX)
          : Math.abs(candidateRect.centerY - currentRect.centerY);
        const secondary = horizontal
          ? Math.abs(candidateRect.centerY - currentRect.centerY)
          : Math.abs(candidateRect.centerX - currentRect.centerX);
        const offAxis = secondary > settings.offAxisThresholdPx
          ? settings.offAxisPenalty
          : 0;

        candidates.push({
          element: candidate,
          score: primary * settings.primaryWeight +
            secondary * settings.secondaryWeight +
            offAxis,
          primary,
          secondary
        });
      }

      candidates.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        if (a.primary !== b.primary) return a.primary - b.primary;
        return a.secondary - b.secondary;
      });

      return candidates[0]?.element || null;
    }

    function chooseHorizontalRowNeighbour(current, controls, direction) {
      const currentRect = rect(current);
      const epsilon = Number(ensureConfig().epsilonPx) || 0;

      const candidates = controls
        .filter(candidate => candidate !== current)
        .map(candidate => ({
          element: candidate,
          rect: rect(candidate)
        }))
        .filter(entry =>
          isSameHorizontalRow(currentRect, entry.rect)
        )
        .filter(entry => (
          direction === 'RIGHT'
            ? entry.rect.centerX > currentRect.centerX + epsilon
            : entry.rect.centerX < currentRect.centerX - epsilon
        ));

      if (!candidates.length) return null;

      candidates.sort((a, b) => {
        const aDelta = Math.abs(a.rect.centerX - currentRect.centerX);
        const bDelta = Math.abs(b.rect.centerX - currentRect.centerX);

        if (aDelta !== bDelta) return aDelta - bDelta;

        return Math.abs(a.rect.centerY - currentRect.centerY) -
          Math.abs(b.rect.centerY - currentRect.centerY);
      });

      return candidates[0]?.element || null;
    }

    function isSameHorizontalRow(a, b) {
      const settings = ensureConfig();

      const overlap = Math.max(
        0,
        Math.min(a.bottom, b.bottom) -
          Math.max(a.top, b.top)
      );

      const minHeight = Math.max(
        1,
        Math.min(a.height, b.height)
      );

      const overlapRatio = overlap / minHeight;
      const centerDelta = Math.abs(a.centerY - b.centerY);

      return (
        overlapRatio >=
          Number(settings.horizontalMinOverlapRatio || 0) ||
        centerDelta <=
          Number(settings.horizontalRowTolerancePx || 0)
      );
    }

    function isDirectional(candidate, current, direction) {
      const epsilon = Number(ensureConfig().epsilonPx) || 0;
      switch (direction) {
        case 'LEFT': return candidate.centerX < current.centerX - epsilon;
        case 'RIGHT': return candidate.centerX > current.centerX + epsilon;
        case 'UP': return candidate.centerY < current.centerY - epsilon;
        case 'DOWN': return candidate.centerY > current.centerY + epsilon;
        default: return false;
      }
    }

    function isNavigableAdjustable(element) {
      if (!element?.matches) return false;

      const selector =
        ensureConfig().navigableAdjustableSelector;

      try {
        return !!selector && element.matches(selector);
      } catch (_) {
        return false;
      }
    }

    function resolveAdjustableInput(element) {
      if (!element?.isConnected) return null;

      const settings = ensureConfig();
      const selector = settings.adjustableInputSelector;

      try {
        if (selector && element.matches?.(selector)) {
          return element;
        }

        return selector
          ? element.querySelector?.(selector) || null
          : null;
      } catch (_) {
        return null;
      }
    }

    function getAdjustableVisualElement(element) {
      if (!isNavigableAdjustable(element)) return element;

      const selector =
        ensureConfig().adjustableVisualSelector;

      if (!selector) return element;

      try {
        return element.matches(selector)
          ? element
          : (element.closest(selector) || element);
      } catch (_) {
        return element;
      }
    }

    function getAdjustableValue(element) {
      const input = resolveAdjustableInput(element);
      if (!input) return null;

      const value = Number(input.value);
      return Number.isFinite(value) ? value : null;
    }

    function adjustControlValue(element, direction) {
      if (!isNavigableAdjustable(element)) return false;

      const input = resolveAdjustableInput(element);
      if (!input) return false;

      const min = Number(input.min);
      const max = Number(input.max);
      const current = Number(input.value);

      if (!Number.isFinite(current)) return false;

      let step = Number(ensureConfig().volumeAdjustStep);

      if (!Number.isFinite(step) || step <= 0) {
        step = Number(input.step);
      }

      if (!Number.isFinite(step) || step <= 0) {
        step = 1;
      }

      const low = Number.isFinite(min) ? min : 0;
      const high = Number.isFinite(max) ? max : 100;

      const next = Math.min(
        high,
        Math.max(
          low,
          current + (direction * step)
        )
      );

      if (next === current) return false;

      input.value = String(next);
      input.setAttribute('value', String(next));

      try {
        input.dispatchEvent(
          new Event('input', {
            bubbles: true,
            composed: true
          })
        );
      } catch (_) {}

      try {
        input.dispatchEvent(
          new Event('change', {
            bubbles: true,
            composed: true
          })
        );
      } catch (_) {}

      return true;
    }

    function renderNativeFocus(element) {
      if (!element?.isConnected) return false;

      clearNativeFocus();

      nativeFocusedElement = element;
      nativeFocusVisualElement =
        getAdjustableVisualElement(element);

      nativeFocusVisualElement.classList.add(
        ensureConfig().focusClassName
      );

      if (adjustableMode && isNavigableAdjustable(element)) {
        nativeFocusVisualElement.classList.add(
          'airnav-native-adjusting'
        );
      }

      // Keep DOM focus off the range element. That prevents its browser-native
      // arrow behavior from stealing navigation before ACTIVATE enters adjust.
      if (!isNavigableAdjustable(element)) {
        try {
          element.focus({ preventScroll: true });
        } catch (_) {
          try { element.focus(); } catch (_) {}
        }
      }

      return true;
    }

    function clearNativeFocus() {
      const className = ensureConfig().focusClassName;

      if (nativeFocusVisualElement?.classList) {
        nativeFocusVisualElement.classList.remove(
          className,
          'airnav-native-adjusting'
        );
      }

      if (nativeFocusedElement?.classList) {
        nativeFocusedElement.classList.remove(
          className,
          'airnav-native-adjusting'
        );
      }

      nativeFocusedElement = null;
      nativeFocusVisualElement = null;

      document
        .querySelectorAll(
          `.${className}, .airnav-native-adjusting`
        )
        .forEach(element => {
          element.classList.remove(
            className,
            'airnav-native-adjusting'
          );
        });
    }

    function dispatchSyntheticKey(target, key, code) {
      if (!target?.dispatchEvent) return false;

      const make = type => {
        const event = new KeyboardEvent(type, {
          key,
          code,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        try {
          Object.defineProperty(event, '__airNavNativeBridge', {
            value: true,
            enumerable: false
          });
        } catch (_) {}
        return event;
      };

      try {
        target.dispatchEvent(make('keydown'));
        target.dispatchEvent(make('keyup'));
        return true;
      } catch (_) {
        return false;
      }
    }

    function matchesControl(element) {
      const settings = ensureConfig();

      try {
        if (!element.matches(settings.controlSelector)) {
          return false;
        }

        if (
          settings.skipAdjustableControls &&
          isAdjustableControl(element) &&
          !isNavigableAdjustable(element)
        ) {
          return false;
        }

        return true;
      } catch (_) {
        return false;
      }
    }

    function dedupeControls(elements) {
      const unique = [...new Set(elements)];
      return unique.filter(element =>
        !unique.some(other =>
          other !== element &&
          element.contains(other) &&
          matchesControl(other)
        )
      );
    }

    function isDisabled(element) {
      return !!(
        element?.disabled ||
        element?.getAttribute?.('aria-disabled') === 'true' ||
        element?.classList?.contains('disabled')
      );
    }

    function isRendered(element) {
      if (!element?.isConnected) return false;
      const r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) return false;
      if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
      return true;
    }

    function rect(element) {
      const r = element.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2
      };
    }

    function describeElement(element) {
      if (!element) return null;
      return {
        tag: element.tagName || null,
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className : null,
        ariaLabel: element.getAttribute?.('aria-label') || null,
        title: element.getAttribute?.('title') || null,
        connected: !!element.isConnected
      };
    }

    function reloadSettings(reason = 'api') {
      const previous = cfg ? { ...cfg } : null;
      const previousStyleId =
        previous?.styleId ||
        DEFAULTS.styleId;

      cfg = null;
      const next = ensureConfig();

      const previousStyle =
        document.getElementById(previousStyleId);

      if (
        previousStyle?.getAttribute('data-airnav-owner') ===
        'control-bridge'
      ) {
        previousStyle.remove();
      }

      if (nativeSurface) {
        ensureStyle();

        if (nativeSurface === 'player') {
          stopPlayerVisibilityForce();
          stopPlayerKeepAlive();
          forcePlayerOsdVisibility();
          startPlayerVisibilityForce();
          startPlayerKeepAlive();
        }
      }

      return {
        changed:
          !previous ||
          JSON.stringify(previous) !== JSON.stringify(next),
        reason,
        version: VERSION,
        settings: {
          volumeAdjustStep:
            Number(next.volumeAdjustStep) || 0,
          playerKeepAliveMs:
            Number(next.playerKeepAliveMs) || 0,
          forcePlayerOsdVisible:
            next.forcePlayerOsdVisible !== false,
          hidePlayerOsdOnRelease:
            next.hidePlayerOsdOnRelease !== false,
          focusOutlineWidthPx:
            Number(next.focusOutlineWidthPx) || 0,
          focusOutlineOffsetPx:
            Number(next.focusOutlineOffsetPx) || 0,
          focusBorderRadiusPx:
            Number(next.focusBorderRadiusPx) || 0
        }
      };
    }

    function getState() {
      return {
        bridgeVersion: VERSION,
        legacyBridgeVersion: LEGACY_VERSION,
        production: true,
        runtimeConfigPresent: !!QoL.runtimeConfig,
        savedTextEntry: describeElement(savedTextElement),
        hasSavedText: hasSavedText(),
        nativeSurface,
        nativeFocusedElement: describeElement(nativeFocusedElement),
        nativeControlCount: nativeSurface ? getNativeControls().length : 0,
        adjustableMode,
        adjustableValue:
          isNavigableAdjustable(nativeFocusedElement)
            ? getAdjustableValue(nativeFocusedElement)
            : null,
        playerKeepAliveActive: !!playerKeepAliveTimer,
        playerKeepAliveMs: Number(ensureConfig().playerKeepAliveMs) || 0,
        forcePlayerOsdVisible:
          ensureConfig().forcePlayerOsdVisible !== false,
        playerVisibilityForceActive: !!playerForceTimer,
        forcePlayerOsdIntervalMs:
          Number(ensureConfig().forcePlayerOsdIntervalMs) || 0,
        forcePlayerOsdClass:
          ensureConfig().forcePlayerOsdClass,
        skipAdjustableControls: !!ensureConfig().skipAdjustableControls,
        volumeAdjustStep:
          Number(ensureConfig().volumeAdjustStep) || 0,
        hidePlayerOsdOnRelease:
          ensureConfig().hidePlayerOsdOnRelease !== false,
        horizontalRowTolerancePx:
          Number(ensureConfig().horizontalRowTolerancePx) || 0,
        passivePlayerOverlayPresent: !!Array.from(
          document.querySelectorAll(
            ensureConfig().playerPassiveOverlaySelector || ':not(*)'
          )
        ).find(isRendered),
        playerPassiveOverlaySelector:
          ensureConfig().playerPassiveOverlaySelector || null,
        pauseOverlayActive: isPauseOverlayActive(),
        pauseOverlayActivityIntegration:
          ensureConfig().pauseOverlayActivityIntegration !== false,
        pauseScreenIntegrationAvailable: !!(
          getEnhancedPauseScreenInstance() &&
          (
            typeof getEnhancedPauseScreenInstance().resetPauseScreenTimer === 'function' ||
            typeof getEnhancedPauseScreenInstance().hideOverlay === 'function'
          )
        ),
        yieldOsdToPauseOverlay:
          ensureConfig().yieldOsdToPauseOverlay !== false,
        broadcastPlayerActivity:
          ensureConfig().broadcastPlayerActivity !== false,
        playerActivityMovePx:
          Number(ensureConfig().playerActivityMovePx) || 0,
        lastMeaningfulPlayerActivityAt:
          lastMeaningfulPlayerActivityAt || null,
        keepAliveSuppressedByPauseOverlay:
          isPauseOverlayActive(),
        nativeEnterIsIdempotent: true,
        pauseOverlayPreservesNativeSelection: true,
        adjustableTargetStrategy: 'stable-wrapper',
        horizontalPlayerStrategy: 'immediate-row-neighbour'
      };
    }

    function destroy() {
      cancelScheduledPlayerHide();
      stopPlayerVisibilityForce();
      releaseForcedPlayerOsdVisibility();
      stopPlayerKeepAlive();
      exitNativeSurface();
      clearSavedText();
      const style = document.getElementById(ensureConfig().styleId);
      if (style?.getAttribute('data-airnav-owner') === 'control-bridge') {
        style.remove();
      }
      cfg = null;
    }

    return {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      reloadSettings,
      takeFromText,
      returnToText,
      clearSavedText,
      hasSavedText,
      isTextEntryActive: () => isTextEntry(document.activeElement),
      enterNativeSurface,
      exitNativeSurface,
      refreshNativeSurface,
      dispatchNativeAction,
      notifyPlayerActivity: notifyMeaningfulPlayerActivity,
      getState,
      destroy
    };
  })();

  const originalDestroy = controlBridge.destroy;

  function handleRuntimeSettingsChanged() {
    try {
      controlBridge.reloadSettings(
        'runtime-settings-changed'
      );
    } catch (error) {
      console.warn(
        '[JellyfinQoL.ControlBridge] Could not reload runtime settings.',
        error
      );
    }
  }

  window.addEventListener(
    'jellyfin-qol-runtime-settings-changed',
    handleRuntimeSettingsChanged
  );

  const api = Object.freeze({
    ...controlBridge,

    destroy() {
      window.removeEventListener(
        'jellyfin-qol-runtime-settings-changed',
        handleRuntimeSettingsChanged
      );
      return originalDestroy();
    },

    compatibilityReport() {
      const state = controlBridge.getState();
      return {
        version: VERSION,
        ready: true,
        takeoverReady: true,
        legacyApiCompatible: true,
        legacyVersion: LEGACY_VERSION,
        runtimeConfigPresent: !!QoL.runtimeConfig,
        capabilities: {
          textHandoff: true,
          playerNativeSurface: true,
          modalNativeSurface: true,
          directionalNativeNavigation: true,
          activation: true,
          backEscape: true,
          playerPlayPause: true,
          volumeAdjustmentMode: true,
          playerOsdKeepAlive: true,
          pauseOverlayIntegration: true,
          runtimeSettingsReload: true
        },
        state
      };
    }
  });

  QoL.controlBridgeRuntime = api;
  QoL.airControlBridge = api;

  console.log(
    '[JellyfinQoL.ControlBridge] Production runtime registered.',
    {
      version: VERSION,
      legacyVersion: LEGACY_VERSION
    }
  );

})(window.JellyfinQoL = window.JellyfinQoL || {});
