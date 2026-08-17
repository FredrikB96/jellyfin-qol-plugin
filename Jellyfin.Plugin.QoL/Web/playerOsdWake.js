// Jellyfin QoL - Jellyfin 10.11 Native OSD Wake Bridge v1.0.0
//
// Jellyfin's playback controller tracks OSD visibility in private controller
// state (`currentVisibleMenu`). Manipulating .hide / .videoOsdBottom-hidden
// classes alone can make DOM nodes render without updating that state.
//
// The video controller already exposes its intended public-ish input path by
// subscribing to bubbling `command` events on window through inputManager.
// A benign `info` command calls the controller's own showOsd() without invoking
// a playback action. AirNav uses that path once when taking native player
// ownership, then ControlBridge continues to own focus/navigation/keepalive.

(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';

  if (QoL.playerOsdWakeRuntime?.version === VERSION) {
    return;
  }

  const base = QoL.airControlBridge;

  if (!base?.enterNativeSurface || !base?.getState) {
    console.warn(
      '[JellyfinQoL.PlayerOsdWake] ControlBridge unavailable; OSD wake bridge not installed.'
    );
    return;
  }

  let wakeCount = 0;
  let lastWakeAt = null;
  let lastWakeReason = null;
  let lastWakeResult = null;

  function isPlayerRoute() {
    const route = String(
      location.hash ||
      `${location.pathname}${location.search}` ||
      ''
    ).toLowerCase();

    return (
      /^#\/video(?:[/?#]|$)/.test(route) ||
      /^\/video(?:[/?#]|$)/.test(route) ||
      !!document.querySelector(
        '.videoPlayerContainer video, .videoPlayerContainer .htmlvideoplayer'
      )?.isConnected
    );
  }

  function wakePlayerOsd(reason = 'airnav-native-takeover') {
    if (!isPlayerRoute()) {
      lastWakeResult = {
        dispatched: false,
        reason: 'not-player-route'
      };
      return lastWakeResult;
    }

    const event = new CustomEvent('command', {
      detail: {
        // Jellyfin 10.11 playback/video/index.js handles `info` by calling
        // showOsd(). Dispatching the event directly intentionally bypasses
        // inputManager.handleCommand() so no secondary command action runs.
        command: 'info'
      },
      bubbles: true,
      cancelable: true,
      composed: true
    });

    let dispatched = false;

    try {
      dispatched = window.dispatchEvent(event);
    } catch (error) {
      lastWakeResult = {
        dispatched: false,
        reason: 'command-dispatch-failed',
        error: String(error?.message || error)
      };
      return lastWakeResult;
    }

    wakeCount += 1;
    lastWakeAt = Date.now();
    lastWakeReason = reason;
    lastWakeResult = {
      dispatched: true,
      accepted: dispatched !== false,
      reason,
      command: 'info',
      defaultPrevented: event.defaultPrevented === true
    };

    return lastWakeResult;
  }

  const wrapped = Object.freeze({
    ...base,

    enterNativeSurface(surface = 'player') {
      let before = null;
      try { before = base.getState?.() || null; }
      catch (_) {}

      const realTransition =
        surface === 'player' &&
        before?.nativeSurface !== 'player';

      const wake = realTransition
        ? wakePlayerOsd('enter-native-player-surface')
        : null;

      const result = base.enterNativeSurface(surface);

      if (wake) {
        return {
          ...(result || {}),
          jellyfinOsdWake: wake
        };
      }

      return result;
    },

    getState() {
      const state = base.getState?.() || {};
      return {
        ...state,
        jellyfinOsdWake: {
          version: VERSION,
          installed: true,
          strategy: 'window-command-info',
          wakeCount,
          lastWakeAt,
          lastWakeReason,
          lastWakeResult
        }
      };
    },

    compatibilityReport() {
      const report = base.compatibilityReport?.() || {};
      return {
        ...report,
        jellyfinOsdWake: {
          version: VERSION,
          ready: true,
          strategy: 'window-command-info'
        }
      };
    }
  });

  QoL.playerOsdWakeRuntime = Object.freeze({
    version: VERSION,
    VERSION,
    wakePlayerOsd,
    getState() {
      return {
        version: VERSION,
        installed: QoL.airControlBridge === wrapped,
        strategy: 'window-command-info',
        wakeCount,
        lastWakeAt,
        lastWakeReason,
        lastWakeResult
      };
    }
  });

  // NavigationController resolves the bridge dynamically from the namespace,
  // so replacing this public facade is sufficient; the underlying frozen
  // ControlBridge runtime remains untouched and is delegated to for all work.
  QoL.airControlBridge = wrapped;

  console.log(
    '[JellyfinQoL.PlayerOsdWake] Jellyfin-native OSD wake bridge registered.',
    { version: VERSION, strategy: 'window-command-info' }
  );

})(window.JellyfinQoL = window.JellyfinQoL || {});
