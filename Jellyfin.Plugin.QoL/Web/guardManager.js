// Jellyfin QoL - Production Optional Windows Input Guard v1.0.0
//
// Browser-side companion for the optional localhost Windows input helper v0.5.
//
// Design boundary:
//   - The JSON registry contains ONLY physical input identity, synthetic browser
//     key identity, and block policy. It never contains AirNav actions.
//   - The helper decides whether a configured OS key must be swallowed.
//   - GuardManager publishes current Jellyfin contexts to the helper.
//   - Swallowed keys return over SSE as `keyswallowed` and are re-published as
//     safe synthetic KeyboardEvents. Existing UniversalInput / Record Input /
//     profile code then decides what action, if any, the key means.
//
// This module remains optional. AirNav browser input must continue to work when
// this module or the Windows helper is absent. It consumes Scanner/PageForm
// context only to publish block-policy tags to the helper.
//
// Safety:
//   - Helper binds only to 127.0.0.1.
//   - No configured key is swallowed without a live GuardManager SSE channel
//     and a valid heartbeat lease. Loss of the browser consumer fails open.

(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '12.6';
  const HELPER_PROTOCOL_VERSION = '0.5';
  const LOG = '[JellyfinQoL.Guard]';

  if (QoL.guardRuntime?.version === VERSION) {
    QoL.guardRuntime.reconcileOwnership?.();
    return;
  }

  function getRuntimeConfig() {
    if (QoL.runtimeConfig) return QoL.runtimeConfig;
    try { return QoL.runtimeSettings?.getConfig?.() || null; }
    catch (_) { return null; }
  }

  function runtimeClientConfig() {
    return getRuntimeConfig()?.client || {};
  }

  function normalizeBaseUrl(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    return text || 'http://127.0.0.1:8765';
  }

  const LEGACY_GUARD_SCOPES = new Set([
    'item-actions',
    'modal',
    'settings-surface',
    'page-inline-group',
    'page-form-edit'
  ]);

  const DEFAULTS = Object.freeze({
    baseUrl: 'http://127.0.0.1:8765',
    enabled: false,
    heartbeatMs: 2000,
    reconcileMs: 350,
    postTimeoutMs: 1200,
    helperRetryMs: 2000,
    settingsRoutePattern: /^#\/mypreferences(?:menu)?(?:\?|$)/i,
    debug: false
  });

  class AirNavGuardManager {
    constructor(options = {}) {
      this.options = { ...options };
      this.cfg = this.resolveConfig();

      this.enabled = false;
      this.connected = false;
      this.eventStream = null;
      this.clientId = `airnav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

      this.scopes = new Set();
      this.lastSentActive = null;
      this.lastSentScopes = [];
      this.lastSentClientEnabled = null;
      this.nextSyncAttemptAt = 0;
      this.lastSync = null;
      this.lastHelperStatus = null;
      this.lastHelperInput = null;
      this.lastRelayedKey = null;
      this.relayCount = 0;
      this.lastError = null;

      this.heartbeatTimer = null;
      this.reconcileTimer = null;
      this.unsubscribers = [];
      this.syncInFlight = false;
      this.syncQueued = false;
      this.destroyed = false;

      this.boundRuntimeSettingsChanged = () => {
        try { this.reloadSettings('runtime-settings-changed'); }
        catch (error) { this.log('runtime settings reload failed', error); }
      };
      window.addEventListener(
        'jellyfin-qol-runtime-settings-changed',
        this.boundRuntimeSettingsChanged
      );
    }

    resolveConfig() {
      const client = runtimeClientConfig();
      return {
        ...DEFAULTS,
        ...(QoL.settings?.airNav?.guardManager || {}),
        ...(client.helperBaseUrl ? { baseUrl: normalizeBaseUrl(client.helperBaseUrl) } : {}),
        ...this.options,
        baseUrl: normalizeBaseUrl(
          this.options.baseUrl ??
          client.helperBaseUrl ??
          QoL.settings?.airNav?.guardManager?.baseUrl ??
          DEFAULTS.baseUrl
        )
      };
    }

    reloadSettings(reason = 'manual') {
      const previous = this.cfg;
      const next = this.resolveConfig();
      const baseChanged = normalizeBaseUrl(previous.baseUrl) !== normalizeBaseUrl(next.baseUrl);
      const timingChanged =
        Number(previous.heartbeatMs) !== Number(next.heartbeatMs) ||
        Number(previous.reconcileMs) !== Number(next.reconcileMs);

      if (baseChanged && this.enabled) {
        this.sendGuardState(false, [], `base-url-change:${reason}`, true);
        this.closeEventStream();
      }

      this.cfg = next;
      this.lastSentActive = null;
      this.lastSentScopes = [];
      this.lastSentClientEnabled = null;
      this.nextSyncAttemptAt = 0;

      if (this.enabled && (baseChanged || timingChanged)) this.startTimers();
      if (this.enabled && baseChanged) this.openEventStream();
      if (this.enabled) this.reconcile(`settings-reloaded:${reason}`, true);

      return {
        changed: baseChanged || timingChanged,
        baseChanged,
        timingChanged,
        baseUrl: this.cfg.baseUrl,
        reason
      };
    }

    enable(reason = 'manual') {
      if (this.destroyed) {
        return { enabled: false, reason: 'guard-manager-destroyed' };
      }

      this.reloadSettings(`enable:${reason}`);

      if (this.enabled) {
        this.reconcile('enable-already-active', true);
        return this.getState();
      }

      this.enabled = true;
      this.lastError = null;
      this.attachObservers();
      this.openEventStream();
      this.startTimers();

      this.sendGuardState(false, [], 'enable-awaiting-event-stream', true);
      this.reconcile(`enable:${reason}`, true);

      console.log('[AirNav.Guard] Enabled. Waiting for localhost helper at', this.cfg.baseUrl);
      return this.getState();
    }

    disable(reason = 'manual') {
      if (!this.enabled) return this.getState();

      this.enabled = false;
      this.scopes.clear();
      this.stopTimers();
      this.detachObservers();
      this.sendGuardState(false, [], `disable:${reason}`, true);
      this.closeEventStream();

      this.connected = false;
      this.lastSentActive = false;
      this.lastSentScopes = [];
      this.lastSentClientEnabled = false;

      console.log('[AirNav.Guard] Disabled. All configured OS input guards released.');
      return this.getState();
    }

    destroy() {
      if (this.destroyed) return;
      this.disable('destroy');
      try {
        window.removeEventListener(
          'jellyfin-qol-runtime-settings-changed',
          this.boundRuntimeSettingsChanged
        );
      } catch (_) {}
      this.destroyed = true;
    }

    attachObservers() {
      this.detachObservers();

      const queue = reason => {
        queueMicrotask?.(() => this.reconcile(`${reason}:microtask`));
        setTimeout(() => this.reconcile(`${reason}:settled`), 45);
      };

      const subscribe = (source, event, reason) => {
        if (!source || typeof source.on !== 'function') return;
        const unsubscribe = source.on(event, () => queue(reason));
        if (typeof unsubscribe === 'function') this.unsubscribers.push(unsubscribe);
      };

      subscribe(QoL.airScanner, 'modelChanged', 'scanner-model');
      subscribe(QoL.airScanner, 'routeChanged', 'scanner-route');
      subscribe(QoL.airScanner, 'modalOpened', 'scanner-modal-open');
      subscribe(QoL.airScanner, 'modalClosed', 'scanner-modal-close');
      subscribe(QoL.airItemActions, 'entered', 'item-actions-enter');
      subscribe(QoL.airItemActions, 'exited', 'item-actions-exit');
      subscribe(QoL.airModal, 'entered', 'modal-enter');
      subscribe(QoL.airModal, 'exited', 'modal-exit');
      subscribe(QoL.airNavInput, 'dispatch', 'airnav-dispatch');
    }

    detachObservers() {
      for (const unsubscribe of this.unsubscribers.splice(0)) {
        try { unsubscribe(); } catch (_) {}
      }
    }

    startTimers() {
      this.stopTimers();
      this.heartbeatTimer = setInterval(
        () => this.sendHeartbeat(),
        Math.max(500, Number(this.cfg.heartbeatMs) || 2000)
      );
      this.reconcileTimer = setInterval(
        () => this.reconcile('safety-poll'),
        Math.max(150, Number(this.cfg.reconcileMs) || 350)
      );
    }

    stopTimers() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      this.heartbeatTimer = null;
      this.reconcileTimer = null;
    }

    computeScopes() {
      const next = new Set();
      const model = QoL.airScanner?.getModel?.() || null;
      const route = String(model?.route || location.hash || '');

      next.add('app');

      const surface = String(model?.activeSurfaceHint || '').toLowerCase();
      if (surface === 'page') next.add('page');
      else if (surface === 'player') next.add('player');

      this.addRouteContexts(next, route);

      if (QoL.airItemActions?.isActive?.() === true) next.add('item-actions');

      const modalRoot = model?.modal?.root || null;
      const modalDetected =
        QoL.airModal?.isActive?.() === true ||
        !!(model?.modal && (!modalRoot || modalRoot.isConnected));
      if (modalDetected) next.add('modal');

      const settingsPattern = this.cfg.settingsRoutePattern;
      if (settingsPattern instanceof RegExp && settingsPattern.test(route)) {
        next.add('settings-surface');
        next.add('settings');
      }

      const inlineGroup = QoL.airScanner?.getPageInlineGroupState?.();
      if (inlineGroup?.active) next.add('page-inline-group');

      const pageForm = QoL.airPageForm?.getState?.();
      if (pageForm?.editing || pageForm?.selectMenu) next.add('page-form-edit');

      return next;
    }

    addRouteContexts(target, route) {
      if (!(target instanceof Set)) return;
      const value = String(route || '').toLowerCase();
      if (!value) return;

      if (/^#\/(?:login|selectserver|wizard)/i.test(value)) target.add('login');
      if (/^#\/home(?:\?|$)/i.test(value)) {
        target.add('home');
        target.add('page');
      }
      if (/^#\/(?:movies|tv|library|livetv|music|collections|boxsets|channels)(?:\?|$)/i.test(value)) {
        target.add('library');
        target.add('page');
      }
      if (/^#\/(?:details|item)(?:\?|$)/i.test(value)) {
        target.add('details');
        target.add('page');
      }
      if (/^#\/search(?:\?|$)/i.test(value)) {
        target.add('search');
        target.add('page');
      }
      if (/^#\/mypreferencesmenu(?:\?|$)/i.test(value)) {
        target.add('menu');
        target.add('settings');
        target.add('page');
      }
      if (/^#\/mypreferences(?:\?|$)/i.test(value)) {
        target.add('settings');
        target.add('page');
      }
    }

    reconcile(reason = 'manual', force = false) {
      if (!this.enabled) return { changed: false, reason: 'guard-manager-disabled' };

      const next = this.computeScopes();
      const previous = [...this.scopes].sort();
      const incoming = [...next].sort();
      const changed = JSON.stringify(previous) !== JSON.stringify(incoming);
      this.scopes = next;

      const active = incoming.some(context => LEGACY_GUARD_SCOPES.has(context));
      const helperActive = active && this.connected;
      const clientEnabled = !!(this.enabled && this.connected);

      if (
        force ||
        changed ||
        this.lastSentActive !== helperActive ||
        this.lastSentClientEnabled !== clientEnabled ||
        JSON.stringify(this.lastSentScopes) !== JSON.stringify(incoming)
      ) {
        this.sendGuardState(helperActive, incoming, reason, force);
      }

      return { changed, reason, active, helperActive, scopes: incoming };
    }

    async sendGuardState(active, scopes, reason = 'sync', force = false) {
      if (!this.enabled && active) {
        active = false;
        scopes = [];
      }

      const now = Date.now();
      if (!force && now < this.nextSyncAttemptAt) return null;
      if (this.syncInFlight && !force) {
        this.syncQueued = true;
        return null;
      }

      this.syncInFlight = true;

      try {
        const contexts = Array.isArray(scopes)
          ? [...new Set(scopes.map(String).filter(Boolean))].sort()
          : [];

        const payload = {
          active: !!active,
          scopes: contexts.slice(),
          contexts: contexts.slice(),
          clientEnabled: !!(this.enabled && this.connected),
          reason,
          clientId: this.clientId,
          timestamp: Date.now()
        };

        const response = await this.fetchJson('/guard', { method: 'POST', body: payload });

        this.lastSentActive = !!active;
        this.lastSentScopes = contexts.slice();
        this.lastSentClientEnabled = payload.clientEnabled;
        this.nextSyncAttemptAt = 0;
        this.lastSync = {
          timestamp: Date.now(),
          ok: true,
          active: !!active,
          scopes: contexts.slice(),
          contexts: contexts.slice(),
          clientEnabled: payload.clientEnabled,
          reason
        };
        if (response) this.lastHelperStatus = response;
        return response;
      } catch (error) {
        this.nextSyncAttemptAt = Date.now() + Math.max(500, Number(this.cfg.helperRetryMs) || 2000);
        this.lastError = {
          timestamp: Date.now(),
          operation: 'guard-sync',
          message: String(error?.message || error)
        };
        this.lastSync = {
          timestamp: Date.now(),
          ok: false,
          active: !!active,
          scopes: Array.isArray(scopes) ? scopes.slice() : [],
          contexts: Array.isArray(scopes) ? scopes.slice() : [],
          clientEnabled: !!(this.enabled && this.connected),
          reason,
          error: this.lastError.message
        };
        this.log('guard sync failed', error);
        return null;
      } finally {
        this.syncInFlight = false;
        if (this.syncQueued) {
          this.syncQueued = false;
          setTimeout(() => this.reconcile('queued-sync'), 0);
        }
      }
    }

    async sendHeartbeat() {
      if (!this.enabled) return null;

      try {
        const contexts = [...this.scopes].sort();
        const response = await this.fetchJson('/heartbeat', {
          method: 'POST',
          body: {
            clientId: this.clientId,
            active: this.connected && contexts.some(context => LEGACY_GUARD_SCOPES.has(context)),
            scopes: contexts.slice(),
            contexts: contexts.slice(),
            clientEnabled: !!(this.enabled && this.connected),
            timestamp: Date.now()
          }
        });
        if (response) this.lastHelperStatus = response;
        return response;
      } catch (error) {
        this.lastError = {
          timestamp: Date.now(),
          operation: 'heartbeat',
          message: String(error?.message || error)
        };
        return null;
      }
    }

    openEventStream() {
      this.closeEventStream();

      if (typeof EventSource !== 'function') {
        this.lastError = {
          timestamp: Date.now(),
          operation: 'event-stream',
          message: 'EventSource API unavailable'
        };
        return;
      }

      const url = `${this.cfg.baseUrl}/events?clientId=${encodeURIComponent(this.clientId)}`;
      let stream;
      try {
        stream = new EventSource(url);
      } catch (error) {
        this.lastError = {
          timestamp: Date.now(),
          operation: 'event-stream-create',
          message: String(error?.message || error)
        };
        return;
      }

      this.eventStream = stream;

      stream.onopen = () => {
        this.connected = true;
        this.lastError = null;
        console.log('[AirNav.Guard] Local helper connected.');
        this.reconcile('event-stream-open', true);
        this.sendHeartbeat();
      };

      stream.onerror = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.sendGuardState(false, [], 'event-stream-error', true);
        if (wasConnected) {
          console.warn('[AirNav.Guard] Helper event stream lost; guard will fail open.');
        }
      };

      stream.onmessage = event => this.handleHelperEvent(event);
    }

    closeEventStream() {
      if (!this.eventStream) return;
      try { this.eventStream.close(); } catch (_) {}
      this.eventStream = null;
      this.connected = false;
    }

    handleHelperEvent(event) {
      let message;
      try { message = JSON.parse(event.data); }
      catch (_) { return; }
      if (!message) return;

      if (message.type === 'hello' || message.type === 'status' || message.type === 'config') {
        this.lastHelperStatus = message.status || message;
        return;
      }

      if (message.type !== 'keyswallowed' && message.type !== 'input') return;

      this.lastHelperInput = { ...message, receivedAt: Date.now() };
      const relayed = this.relaySwallowedKey(message);
      this.lastRelayedKey = relayed;
      if (relayed?.relayed) this.relayCount += 1;
      this.log('helper swallowed key relay', { message, relayed });
      setTimeout(() => this.reconcile('helper-key-relayed'), 0);
    }

    relaySwallowedKey(message) {
      const trigger = message?.trigger || {};
      const key = trigger.key ?? message?.key ?? '';
      const code = trigger.code ?? message?.code ?? '';

      if (!key && !code) {
        return {
          relayed: false,
          reason: 'swallowed-key-identity-missing',
          inputId: message?.inputId || message?.id || message?.customId || null
        };
      }

      const phase = String(message?.phase || '').toLowerCase();
      const eventType =
        phase === 'release' || phase === 'up' || message?.eventType === 'keyup'
          ? 'keyup'
          : 'keydown';
      const modifiers = trigger.modifiers || {};

      let synthetic;
      try {
        synthetic = new KeyboardEvent(eventType, {
          key: String(key || ''),
          code: String(code || ''),
          location: Number(trigger.location ?? message?.location ?? 0) || 0,
          ctrlKey: !!modifiers.ctrl,
          altKey: !!modifiers.alt,
          shiftKey: !!modifiers.shift,
          metaKey: !!modifiers.meta,
          repeat: !!message?.repeat,
          bubbles: true,
          cancelable: true,
          composed: true
        });
      } catch (error) {
        return {
          relayed: false,
          reason: 'synthetic-keyboard-event-create-failed',
          error: String(error?.message || error)
        };
      }

      try {
        Object.defineProperties(synthetic, {
          __airNavOsGuardRelay: {
            value: true,
            configurable: false,
            enumerable: false
          },
          __airNavOsGuardInputId: {
            value: message?.inputId || message?.id || message?.customId || null,
            configurable: false,
            enumerable: false
          },
          __airNavOsGuardVkCode: {
            value: message?.vkCode ?? null,
            configurable: false,
            enumerable: false
          }
        });
      } catch (_) {}

      const stopAfterAirNav = relayEvent => {
        if (relayEvent !== synthetic) return;
        try { relayEvent.preventDefault(); } catch (_) {}
        try { relayEvent.stopImmediatePropagation(); } catch (_) {}
      };

      try {
        window.addEventListener(eventType, stopAfterAirNav, {
          capture: true,
          passive: false,
          once: true
        });
        window.dispatchEvent(synthetic);
      } catch (error) {
        try { window.removeEventListener(eventType, stopAfterAirNav, true); } catch (_) {}
        return {
          relayed: false,
          reason: 'synthetic-keyboard-event-dispatch-failed',
          error: String(error?.message || error)
        };
      }

      return {
        relayed: true,
        timestamp: Date.now(),
        inputId: message?.inputId || message?.id || message?.customId || null,
        phase: eventType === 'keyup' ? 'release' : 'press',
        eventType,
        key: synthetic.key || null,
        code: synthetic.code || null,
        vkCode: message?.vkCode ?? null,
        isTrusted: synthetic.isTrusted,
        defaultPrevented: synthetic.defaultPrevented
      };
    }

    async test() {
      try {
        const status = await this.fetchJson('/status', { method: 'GET' });
        this.lastHelperStatus = status;
        this.lastError = null;
        console.log('[AirNav.Guard] Helper status:', status);
        return status;
      } catch (error) {
        this.lastError = {
          timestamp: Date.now(),
          operation: 'test',
          message: String(error?.message || error)
        };
        console.error('[AirNav.Guard] Helper test failed:', error);
        return { ok: false, error: this.lastError.message };
      }
    }

    sync() {
      return this.reconcile('console-sync', true);
    }

    async fetchJson(path, options = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timeout = null;

      if (controller) {
        timeout = setTimeout(
          () => controller.abort(),
          Math.max(250, Number(this.cfg.postTimeoutMs) || 1200)
        );
      }

      try {
        const fetchOptions = {
          method: options.method || 'GET',
          mode: 'cors',
          cache: 'no-store',
          signal: controller?.signal
        };
        if (options.body !== undefined) {
          fetchOptions.headers = { 'Content-Type': 'application/json' };
          fetchOptions.body = JSON.stringify(options.body);
        }

        const response = await fetch(`${this.cfg.baseUrl}${path}`, fetchOptions);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    getState() {
      return {
        version: VERSION,
        legacyVersion: LEGACY_VERSION,
        helperProtocolVersion: HELPER_PROTOCOL_VERSION,
        production: true,
        helperRequired: false,
        configured: runtimeClientConfig().helperEnabled === true,
        enabled: this.enabled,
        connected: this.connected,
        consumerReady: this.enabled && this.connected,
        baseUrl: this.cfg.baseUrl,
        clientId: this.clientId,
        active: this.enabled && [...this.scopes].some(context => LEGACY_GUARD_SCOPES.has(context)),
        helperActive:
          this.enabled &&
          this.connected &&
          [...this.scopes].some(context => LEGACY_GUARD_SCOPES.has(context)),
        scopes: [...this.scopes].sort(),
        lastSentActive: this.lastSentActive,
        lastSentScopes: this.lastSentScopes.slice(),
        lastSentClientEnabled: this.lastSentClientEnabled,
        lastSync: this.lastSync ? { ...this.lastSync } : null,
        lastHelperInput: this.lastHelperInput ? { ...this.lastHelperInput } : null,
        relayCount: this.relayCount,
        lastRelayedKey: this.lastRelayedKey ? { ...this.lastRelayedKey } : null,
        contexts: [...this.scopes].sort(),
        lastHelperStatus: this.lastHelperStatus,
        lastError: this.lastError ? { ...this.lastError } : null
      };
    }

    log(...args) {
      if (!(this.cfg.debug || QoL.settings?.DEBUG || QoL.settings?.airNav?.debug)) return;
      console.log('[AirNav.Guard]', ...args);
    }
  }

  let instance = new AirNavGuardManager();
  let api = null;

  function reconcileOwnership() {
    if (!api) return { takeoverActive: false, reason: 'runtime-not-ready' };

    const current = QoL.airGuard || null;
    if (!current || current === api) {
      QoL.airGuard = api;
      return {
        takeoverActive: true,
        passiveComparisonMode: false,
        legacyPresent: false,
        reason: current === api ? 'already-production-owner' : 'production-owner-claimed'
      };
    }

    return {
      takeoverActive: false,
      passiveComparisonMode: true,
      legacyPresent: true,
      legacyVersion: current.VERSION || current.version || null,
      reason: 'legacy-owner-present'
    };
  }

  function compatibilityReport() {
    const ownership = reconcileOwnership();
    return {
      version: VERSION,
      legacyVersion: LEGACY_VERSION,
      helperProtocolVersion: HELPER_PROTOCOL_VERSION,
      ready: true,
      takeoverReady: true,
      takeoverActive: ownership.takeoverActive,
      passiveComparisonMode: ownership.passiveComparisonMode,
      legacyPresent: ownership.legacyPresent,
      windowsHelperOptional: true,
      windowsHelperRequired: false,
      failOpenLease: true,
      syntheticKeyboardRelay: true,
      runtimeSettingsReload: true,
      scannerContextCompatibility: true,
      state: instance.getState()
    };
  }

  api = Object.freeze({
    version: VERSION,
    VERSION,
    LEGACY_VERSION,
    HELPER_PROTOCOL_VERSION,

    enable(reason = 'console') {
      return instance.enable(reason);
    },

    disable(reason = 'console') {
      return instance.disable(reason);
    },

    reloadSettings(reason = 'console') {
      return instance.reloadSettings(reason);
    },

    sync() {
      return instance.sync();
    },

    test() {
      return instance.test();
    },

    relaySwallowedKey(message) {
      return instance.relaySwallowedKey(message);
    },

    getState() {
      return instance.getState();
    },

    reconcileOwnership,
    compatibilityReport,

    destroy() {
      instance.destroy();
    }
  });

  QoL.guardRuntime = api;
  const ownership = reconcileOwnership();

  console.log(
    LOG,
    ownership.takeoverActive
      ? 'Production optional Windows input guard registered DISABLED.'
      : 'Production guard registered in passive comparison mode.',
    compatibilityReport()
  );
})(window.JellyfinQoL = window.JellyfinQoL || {});
