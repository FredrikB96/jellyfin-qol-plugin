// Jellyfin QoL / AirNav - Production Navigation Focus v1.0.0
// Owns one logical page selection and renders it against Scanner snapshots.
// Device independent: no raw input, directional resolution, scrolling, or activation.

(function (QoL) {
  'use strict';

  const VERSION = '1.0.1';
  const LEGACY_VERSION = '7.4B';
  const LOG = '[JellyfinQoL.NavigationFocus]';

  const productionApi = (function () {
    const DEFAULTS = {
      debug: false,

      // Focus rendering.
      injectCss: true,
      styleId: 'airnav-focus-style',
      className: 'airnav-focused',
      scaleClassName: 'airnav-focus-scale',
      dataAttribute: 'data-airnav-focused',

      outlineWidthPx: 3,
      outlineOffsetPx: 3,
      borderRadiusPx: 12,
      scale: 1.045,
      applyScale: true,
      transitionMs: 120,

      // Keep browser/native focus advisory only. The logical AirNav selection
      // remains authoritative.
      syncDomFocus: true,

      // Phase 3 deliberately does not remember a selection across routes.
      // Per-route focus memory is a future extension in the architecture.
      preserveAcrossRoutes: false,

      // If the selected key disappears during a same-route model rebuild:
      // 1) nearest item in the old section,
      // 2) nearest item by geometry,
      // 3) first valid content item.
      fallbackWithinSection: true,
      fallbackNearestGeometry: true,
      fallbackFirstItem: true,
      queueUntilModelReady: true,
      intentMaxAgeMs: 2000,
      rejectNonDirectional: true
    };

    let instance = null;
    const listeners = new Map();

    function on(event, callback) {
      if (typeof callback !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => off(event, callback);
    }

    function off(event, callback) {
      const set = listeners.get(event);
      if (!set) return;
      set.delete(callback);
      if (!set.size) listeners.delete(event);
    }

    function emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;

      [...set].forEach(callback => {
        try {
          callback(payload);
        } catch (error) {
          console.error(`[AirNav.Focus] listener failed for ${event}`, error);
        }
      });
    }

    function getGlobalSettings() {
      let ownSettings = QoL.settings || {};

      if (typeof QoL.getSettings === 'function') {
        try {
          ownSettings = QoL.getSettings() || ownSettings;
        } catch (error) {
          console.warn(
            '[AirNav.Focus] QoL.getSettings() failed; using local settings.',
            error
          );
        }
      }

      return ownSettings;
    }

    class AirNavFocusManager {
      constructor(options = {}) {
        const globalSettings = getGlobalSettings();
        const airNavSettings = globalSettings.airNav || {};
        const focusSettings = airNavSettings.focus || {};

        this.cfg = Object.assign(
          {},
          DEFAULTS,
          focusSettings,
          options
        );

        this.cfg.debug = !!(
          this.cfg.debug ||
          airNavSettings.debug ||
          globalSettings.DEBUG
        );

        this.started = false;
        this.state = null;

        // The element that currently owns the AirNav visual class. This is
        // intentionally separate from logical state because the DOM node may
        // be replaced while the stable item key remains the same.
        this.renderedElement = null;
        this.renderedFocusTarget = null;

        this.unsubscribeModelChanged = null;
        this.unsubscribeGeometryChanged = null;
        this.pendingIntent = null;
        this.reconcileEpoch = 0;

        this.start();
      }

      start() {
        if (this.started) return this;

        if (!QoL.airScanner) {
          console.error(
            '[AirNav.Focus] airScanner is not available. Load/start scanner.js before FocusManager.'
          );
          return this;
        }

        // Ensure Scanner exists. create() is idempotent.
        QoL.airScanner.create();

        this.injectStyles();

        this.unsubscribeModelChanged = QoL.airScanner.on(
          'modelChanged',
          model => this.handleModelUpdate(model, 'modelChanged')
        );

        this.unsubscribeGeometryChanged = QoL.airScanner.on(
          'geometryChanged',
          event => this.handleModelUpdate(event?.model || QoL.airScanner.getModel(), 'geometryChanged')
        );

        this.started = true;

        // If selection was established before start() for any future reason,
        // rebind it against the current model.
        const model = QoL.airScanner.getModel();
        if (model && this.state?.itemKey) {
          this.handleModelUpdate(model, 'start');
        }

        this.log('started');
        return this;
      }

      destroy() {
        if (this.unsubscribeModelChanged) {
          try { this.unsubscribeModelChanged(); } catch (_) {}
          this.unsubscribeModelChanged = null;
        }

        if (this.unsubscribeGeometryChanged) {
          try { this.unsubscribeGeometryChanged(); } catch (_) {}
          this.unsubscribeGeometryChanged = null;
        }

        this.clearVisual();

        const style = document.getElementById(this.cfg.styleId);
        if (style && style.dataset.airnavOwner === 'focus') {
          style.remove();
        }

        this.pendingIntent = null;
        this.reconcileEpoch += 1;
        this.state = null;
        this.started = false;
        this.log('destroyed');
      }

      // ---------------------------------------------------------------
      // Public selection operations
      // ---------------------------------------------------------------

      selectByKey(itemKey, reason = 'manual', options = {}) {
        if (!itemKey) return null;

        const model = QoL.airScanner?.getModel?.();
        if (!model) {
          this.log('selectByKey ignored: no NavigationModel');
          return null;
        }

        if (model.activeSurfaceHint !== 'page') {
          this.log(`selectByKey ignored on surface=${model.activeSurfaceHint}`);
          return null;
        }

        const match = this.findItemByKey(model, itemKey);
        if (!match) {
          this.log(`selectByKey failed: ${itemKey}`);
          return null;
        }

        return this.commitSelection(match, model, reason, options);
      }

      selectSectionItem(sectionIndex, itemIndex, reason = 'manual-section-index', options = {}) {
        const model = QoL.airScanner?.getModel?.();
        if (!model || model.activeSurfaceHint !== 'page') {
          this.queueIntent('section', { sectionIndex, itemIndex, reason, options });
          return null;
        }

        const section = model.sections?.[sectionIndex];
        const item = section?.items?.[itemIndex];
        if (!this.isNavigableSection(section) || !this.isValidItem(item)) {
          this.queueIntent('section', { sectionIndex, itemIndex, reason, options });
          return null;
        }

        this.pendingIntent = null;
        return this.commitSelection({ section, item }, model, reason, options);
      }

      selectHeaderItem(itemIndex, reason = 'manual-header-index', options = {}) {
        const model = QoL.airScanner?.getModel?.();
        if (!model || model.activeSurfaceHint !== 'page') {
          this.queueIntent('header', { itemIndex, reason, options });
          return null;
        }

        const section = model.header;
        const item = section?.items?.[itemIndex];
        if (!this.isNavigableSection(section) || !this.isValidItem(item)) {
          this.queueIntent('header', { itemIndex, reason, options });
          return null;
        }

        this.pendingIntent = null;
        return this.commitSelection({ section, item }, model, reason, options);
      }

      selectFirst(options = {}) {
        const model = QoL.airScanner?.getModel?.();
        if (!model || model.activeSurfaceHint !== 'page') {
          this.queueIntent('first', { options });
          return null;
        }

        const scope = options.scope || 'content';
        let match = null;

        if (options.sectionId) {
          const section = this.getNavigableSections(model).find(s => s.id === options.sectionId);
          const item = section?.items?.find(candidate => this.isValidItem(candidate));
          match = item ? { section, item, reason: 'manual-first' } : null;
        } else if (scope === 'header' && this.isNavigableSection(model.header)) {
          const item = model.header.items.find(candidate => this.isValidItem(candidate));
          match = item ? { section: model.header, item, reason: 'manual-first-header' } : null;
        } else {
          if (scope === 'all' && this.isNavigableSection(model.header)) {
            const item = model.header.items.find(candidate => this.isValidItem(candidate));
            if (item) match = { section: model.header, item, reason: 'manual-first-all' };
          }
          if (!match) {
            for (const section of (model.sections || []).filter(candidate => this.isNavigableSection(candidate))) {
              const item = section.items.find(candidate => this.isValidItem(candidate));
              if (item) {
                match = { section, item, reason: 'manual-first-content' };
                break;
              }
            }
          }
        }

        if (!match) {
          this.queueIntent('first', { options });
          return null;
        }

        this.pendingIntent = null;
        return this.commitSelection({ section: match.section, item: match.item }, model, match.reason, options);
      }

      queueIntent(type, payload = {}) {
        if (!this.cfg.queueUntilModelReady) return;
        this.pendingIntent = {
          type,
          payload,
          route: window.location.hash || null,
          queuedAt: Date.now()
        };
      }

      flushPendingIntent(model, reason = 'model-ready') {
        const intent = this.pendingIntent;
        if (!intent || !model || model.activeSurfaceHint !== 'page') return null;
        const maxAge = Math.max(0, Number(this.cfg.intentMaxAgeMs) || 0);
        if (maxAge && Date.now() - intent.queuedAt > maxAge) {
          this.pendingIntent = null;
          return null;
        }
        if (intent.route && model.route && intent.route !== model.route) {
          this.pendingIntent = null;
          return null;
        }

        this.pendingIntent = null;
        const payload = intent.payload || {};
        if (intent.type === 'header') {
          return this.selectHeaderItem(payload.itemIndex, `${payload.reason || 'queued-header'}:${reason}`, payload.options || {});
        }
        if (intent.type === 'section') {
          return this.selectSectionItem(payload.sectionIndex, payload.itemIndex, `${payload.reason || 'queued-section'}:${reason}`, payload.options || {});
        }
        return this.selectFirst(payload.options || {});
      }

      clear(reason = 'manual-clear') {
        const previous = this.state ? { ...this.state } : null;
        this.reconcileEpoch += 1;
        this.pendingIntent = null;
        this.clearVisual();
        this.state = null;

        if (previous) {
          emit('selectionChanged', {
            previous,
            state: null,
            item: null,
            reason
          });
        }

        this.log(`selection cleared reason=${reason}`);
      }

      refresh(reason = 'manual-refresh') {
        const model = QoL.airScanner?.getModel?.();
        if (!model) return null;
        this.handleModelUpdate(model, reason);
        return this.getState();
      }

      // ---------------------------------------------------------------
      // Model rebuild / restoration
      // ---------------------------------------------------------------

      handleModelUpdate(model, reason) {
        if (!this.started || !model) return;
        const epoch = ++this.reconcileEpoch;

        if (!this.state?.itemKey) {
          this.flushPendingIntent(model, reason);
          return;
        }

        // Player and modal own the screen. Phase 3 preserves the page selection
        // logically but removes the visual focus until the page surface returns.
        if (model.activeSurfaceHint !== 'page') {
          this.clearVisual();
          this.state.suspended = true;
          this.state.modelVersion = model.version;
          this.log(`selection suspended surface=${model.activeSurfaceHint}`);
          return;
        }

        if (
          !this.cfg.preserveAcrossRoutes &&
          this.state.route &&
          model.route !== this.state.route
        ) {
          this.clear('route-changed');
          return;
        }

        // Stable key is authoritative.
        const exact = this.findItemByKey(model, this.state.itemKey);
        if (exact) {
          this.commitSelection(
            exact,
            model,
            `${reason}:stable-key`,
            { preservePreferredX: true, restored: true, reconcileEpoch: epoch }
          );
          return;
        }

        const fallback = this.resolveFallback(model);
        if (fallback) {
          this.commitSelection(
            fallback,
            model,
            `${reason}:fallback`,
            { preservePreferredX: true, restored: true, reconcileEpoch: epoch }
          );
          return;
        }

        // The old logical selection no longer exists and no safe fallback was
        // available.
        this.clear(`${reason}:selection-lost`);
      }

      resolveFallback(model) {
        const old = this.state;
        const sections = this.getNavigableSections(model);

        if (this.cfg.fallbackWithinSection && old.sectionId) {
          const sameSection = sections.find(section => section.id === old.sectionId);

          if (sameSection) {
            const valid = sameSection.items.filter(item => this.isValidItem(item));

            if (valid.length) {
              // Prefer the old logical/index position before geometry.
              if (Number.isInteger(old.fallbackIndex)) {
                let bestByIndex = valid[0];
                let bestDelta = Number.POSITIVE_INFINITY;

                for (const item of valid) {
                  const index = Number.isInteger(item?.metadata?.domIndex)
                    ? item.metadata.domIndex
                    : sameSection.items.indexOf(item);
                  const delta = Math.abs(index - old.fallbackIndex);

                  if (delta < bestDelta) {
                    bestDelta = delta;
                    bestByIndex = item;
                  }
                }

                if (bestByIndex) return { section: sameSection, item: bestByIndex };
              }

              if (old.rect) {
                const nearest = this.nearestByGeometry(valid, old.rect);
                if (nearest) return { section: sameSection, item: nearest };
              }

              return { section: sameSection, item: valid[0] };
            }
          }
        }

        if (this.cfg.fallbackNearestGeometry && old.rect) {
          const candidates = [];

          for (const section of sections) {
            for (const item of section.items || []) {
              if (this.isValidItem(item)) {
                candidates.push({ section, item });
              }
            }
          }

          if (candidates.length) {
            let winner = null;
            let winnerDistance = Number.POSITIVE_INFINITY;

            for (const candidate of candidates) {
              const distance = this.rectDistance(candidate.item.rect, old.rect);

              if (distance < winnerDistance) {
                winner = candidate;
                winnerDistance = distance;
              }
            }

            if (winner) return winner;
          }
        }

        if (this.cfg.fallbackFirstItem) {
          for (const section of (model.sections || []).filter(candidate => this.isNavigableSection(candidate))) {
            const item = section.items.find(candidate => this.isValidItem(candidate));
            if (item) return { section, item };
          }

          if (model.header) {
            const item = model.header.items.find(candidate => this.isValidItem(candidate));
            if (item) return { section: model.header, item };
          }
        }

        return null;
      }

      // ---------------------------------------------------------------
      // State + rendering
      // ---------------------------------------------------------------

      commitSelection(match, model, reason, options = {}) {
        if (!match?.item || !match?.section) return null;
        if (!this.isNavigableSection(match.section) || !this.isValidItem(match.item)) return null;
        if (Number.isInteger(options.reconcileEpoch) && options.reconcileEpoch !== this.reconcileEpoch) return null;

        const latest = QoL.airScanner?.getModel?.();
        if (latest && latest !== model && latest.version !== model.version) {
          const rebound = this.findItemByKey(latest, match.item.key);
          if (!rebound) return null;
          match = rebound;
          model = latest;
        }

        const previous = this.state ? { ...this.state } : null;
        const item = match.item;
        const section = match.section;
        const logicalChanged = !previous ||
          previous.itemKey !== item.key ||
          previous.sectionId !== section.id;

        const domIndex = Number.isInteger(item?.metadata?.domIndex)
          ? item.metadata.domIndex
          : section.items.indexOf(item);

        this.state = {
          itemKey: item.key,
          instanceKey: item.instanceKey || item.metadata?.instanceKey || item.key,
          entityKey: item.entityKey || item.metadata?.entityKey || null,
          sectionId: section.id,
          preferredX: options.preservePreferredX && previous?.preferredX != null
            ? previous.preferredX
            : item.rect?.centerX ?? null,
          contextId: `page:${model.route}`,
          route: model.route,
          modelVersion: model.version,
          fallbackIndex: domIndex,
          rect: item.rect ? { ...item.rect } : null,
          title: item.title || null,
          type: item.type || null,
          suspended: false,
          restored: !!options.restored
        };

        this.render(item);

        emit(logicalChanged ? 'selectionChanged' : 'selectionReconciled', {
          previous,
          state: this.getState(),
          item,
          section,
          reason
        });

        this.log(
          `selected ${item.key} section=${section.id} ` +
          `title="${item.title || ''}" reason=${reason}`
        );

        return item;
      }

      render(item) {
        const element = item?.element;
        if (!element || !element.isConnected) {
          this.clearVisual();
          return false;
        }

        if (this.renderedElement && this.renderedElement !== element) {
          this.removeVisualFrom(this.renderedElement);
        }

        const selector = `.${this.escapeCssIdentifier(this.cfg.className)}`;
        document.querySelectorAll(selector).forEach(candidate => {
          if (candidate !== element) this.removeVisualFrom(candidate);
        });

        element.classList.add(this.cfg.className);
        if (this.cfg.applyScale && Number(this.cfg.scale) !== 1) {
          element.classList.add(this.cfg.scaleClassName);
        } else {
          element.classList.remove(this.cfg.scaleClassName);
        }

        element.setAttribute(this.cfg.dataAttribute, 'true');
        element.style.setProperty('--airnav-focus-scale', String(this.cfg.scale));

        this.renderedElement = element;

        const focusTarget = this.getFocusTarget(item);
        this.renderedFocusTarget = focusTarget;

        if (this.cfg.syncDomFocus && focusTarget && this.canSafelyFocus(focusTarget)) {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch (_) {
            try { focusTarget.focus(); } catch (_) {}
          }
        }

        return true;
      }

      clearVisual() {
        if (this.renderedElement) {
          this.removeVisualFrom(this.renderedElement);
        }

        this.renderedElement = null;
        this.renderedFocusTarget = null;

        // Defensive cleanup for stale nodes/classes left behind by a DOM swap.
        const selector = `.${this.escapeCssIdentifier(this.cfg.className)}`;
        document.querySelectorAll(selector).forEach(element => {
          this.removeVisualFrom(element);
        });
      }

      removeVisualFrom(element) {
        if (!element?.classList) return;

        element.classList.remove(this.cfg.className);
        element.classList.remove(this.cfg.scaleClassName);
        element.removeAttribute(this.cfg.dataAttribute);
        element.style?.removeProperty('--airnav-focus-scale');
      }

      getFocusTarget(item) {
        const activationTarget = item?.activationTarget;
        if (activationTarget?.isConnected) return activationTarget;

        const element = item?.element;
        if (element?.isConnected) return element;

        return null;
      }

      canSafelyFocus(element) {
        if (!element || !element.isConnected) return false;

        // Preserve genuine text-entry handoff, but do not let a stale
        // select/range/number control keep browser-native arrow ownership
        // after logical AirNav selection has moved elsewhere.
        const active = document.activeElement;
        if (
          active &&
          active !== element &&
          this.isTextInput(active)
        ) {
          return false;
        }

        return typeof element.focus === 'function';
      }

      isTextInput(element) {
        if (!element) return false;

        const tag =
          element.tagName?.toLowerCase();

        if (
          tag === 'textarea' ||
          element.isContentEditable === true
        ) {
          return true;
        }

        if (tag !== 'input') {
          return false;
        }

        const type =
          String(
            element.getAttribute?.('type') ||
            element.type ||
            'text'
          ).toLowerCase();

        // Inputs with native directional semantics are PageForm controls,
        // not text-entry handoff targets. FocusManager may safely move DOM
        // focus away from them when the logical selection changes.
        return ![
          'button',
          'checkbox',
          'color',
          'file',
          'hidden',
          'image',
          'number',
          'radio',
          'range',
          'reset',
          'submit'
        ].includes(type);
      }

      // ---------------------------------------------------------------
      // Model lookup helpers
      // ---------------------------------------------------------------

      getAllSections(model) {
        const sections = [];
        if (model?.header) sections.push(model.header);
        if (Array.isArray(model?.sections)) sections.push(...model.sections);
        return sections;
      }

      isNavigableSection(section) {
        return !!(
          section &&
          (!this.cfg.rejectNonDirectional || section.metadata?.directional !== false)
        );
      }

      getNavigableSections(model) {
        return this.getAllSections(model).filter(section => this.isNavigableSection(section));
      }

      findItemByKey(model, itemKey) {
        for (const section of this.getNavigableSections(model)) {
          const item = (section.items || []).find(candidate => candidate.key === itemKey);
          if (item && this.isValidItem(item)) {
            return { section, item };
          }
        }

        return null;
      }

      isValidItem(item) {
        return !!(
          item &&
          item.key &&
          item.element &&
          item.element.isConnected &&
          item.state?.visible !== false &&
          item.state?.enabled !== false &&
          (!this.cfg.rejectNonDirectional || item.metadata?.directional !== false)
        );
      }

      nearestByGeometry(items, oldRect) {
        let winner = null;
        let winnerDistance = Number.POSITIVE_INFINITY;

        for (const item of items) {
          const distance = this.rectDistance(item.rect, oldRect);
          if (distance < winnerDistance) {
            winner = item;
            winnerDistance = distance;
          }
        }

        return winner;
      }

      rectDistance(a, b) {
        if (!a || !b) return Number.POSITIVE_INFINITY;

        const dx = (a.centerX ?? 0) - (b.centerX ?? 0);
        const dy = (a.centerY ?? 0) - (b.centerY ?? 0);

        return Math.sqrt((dx * dx) + (dy * dy));
      }

      // ---------------------------------------------------------------
      // Style + debug
      // ---------------------------------------------------------------

      injectStyles() {
        if (!this.cfg.injectCss) return;

        let style = document.getElementById(this.cfg.styleId);
        if (!style) {
          style = document.createElement('style');
          style.id = this.cfg.styleId;
          style.dataset.airnavOwner = 'focus';
          document.head.appendChild(style);
        }

        const className = this.escapeCssIdentifier(this.cfg.className);
        const scaleClass = this.escapeCssIdentifier(this.cfg.scaleClassName);

        style.textContent = `
          .${className} {
            outline: ${Number(this.cfg.outlineWidthPx)}px solid
              var(--theme-primary-color, var(--primary-accent-color, #00a4dc)) !important;
            outline-offset: ${Number(this.cfg.outlineOffsetPx)}px !important;
            border-radius: ${Number(this.cfg.borderRadiusPx)}px;
            box-shadow: 0 0 18px rgba(0, 164, 220, .55) !important;
            z-index: 20 !important;
            position: relative;
            transition:
              transform ${Number(this.cfg.transitionMs)}ms ease,
              box-shadow ${Number(this.cfg.transitionMs)}ms ease,
              outline-color ${Number(this.cfg.transitionMs)}ms ease;
          }

          .${className}.${scaleClass} {
            transform: scale(var(--airnav-focus-scale, ${Number(this.cfg.scale)})) !important;
          }

          @media (prefers-reduced-motion: reduce) {
            .${className} {
              transition: none !important;
            }
          }
        `;
      }

      escapeCssIdentifier(value) {
        if (window.CSS?.escape) return window.CSS.escape(String(value));
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      }

      getState() {
        return this.state ? {
          ...this.state,
          rect: this.state.rect ? { ...this.state.rect } : null
        } : null;
      }

      getSelectedItem() {
        const model = QoL.airScanner?.getModel?.();
        if (!model || !this.state?.itemKey) return null;

        return this.findItemByKey(model, this.state.itemKey)?.item || null;
      }

      getDebugSnapshot() {
        const item = this.getSelectedItem();

        return {
          started: this.started,
          state: this.getState(),
          rendered: !!this.renderedElement,
          renderedConnected: !!this.renderedElement?.isConnected,
          renderedElement: this.describeElement(this.renderedElement),
          focusTarget: this.describeElement(this.renderedFocusTarget),
          item: item ? {
            key: item.key,
            title: item.title,
            type: item.type,
            sectionId: item.sectionId,
            inViewport: item.metadata?.inViewport,
            rect: item.rect
          } : null
        };
      }

      describeElement(element) {
        if (!element) return null;

        return {
          tag: element.tagName || null,
          id: element.id || null,
          className: typeof element.className === 'string'
            ? element.className
            : null,
          ariaLabel: element.getAttribute?.('aria-label') || null,
          title: element.getAttribute?.('title') || null,
          connected: !!element.isConnected
        };
      }

      log(message, ...args) {
        if (!this.cfg.debug) return;
        console.log(`[AirNav.Focus] ${message}`, ...args);
      }
    }

    const api = {
      create(options = {}) {
        if (!instance) instance = new AirNavFocusManager(options);
        return instance;
      },

      destroy() {
        if (!instance) return;
        instance.destroy();
        instance = null;
      },

      enable(options = {}) {
        return this.create(options);
      },

      disable() {
        this.destroy();
      },

      isEnabled() {
        return !!instance?.started;
      },

      selectByKey(itemKey, reason, options) {
        return instance ? instance.selectByKey(itemKey, reason, options) : null;
      },

      selectSectionItem(sectionIndex, itemIndex, reason, options) {
        return instance ? instance.selectSectionItem(sectionIndex, itemIndex, reason, options) : null;
      },

      selectHeaderItem(itemIndex, reason, options) {
        return instance ? instance.selectHeaderItem(itemIndex, reason, options) : null;
      },

      selectFirst(options) {
        return instance ? instance.selectFirst(options) : null;
      },

      clear(reason) {
        if (instance) instance.clear(reason);
      },

      refresh(reason) {
        return instance ? instance.refresh(reason) : null;
      },

      getState() {
        return instance ? instance.getState() : null;
      },

      getSelectedItem() {
        return instance ? instance.getSelectedItem() : null;
      },

      getDebugSnapshot() {
        return instance ? instance.getDebugSnapshot() : null;
      },

      compatibilityReport() {
        const takeoverActive = QoL.airFocus === api;
        const legacyPresent = !!QoL.airFocus && QoL.airFocus !== api;
        return {
          version: VERSION,
          legacyVersion: LEGACY_VERSION,
          production: true,
          ready: true,
          takeoverReady: true,
          takeoverActive,
          passiveComparisonMode: legacyPresent,
          legacyPresent,
          started: !!instance?.started,
          queuedIntent: instance?.pendingIntent?.type || null,
          state: instance?.getState?.() || null
        };
      },

      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,
      on,
      off
    };

    return api;
  })();
  const existingFocus = QoL.airFocus || null;
  QoL.navigationFocusRuntime = productionApi;

  if (!existingFocus || existingFocus === productionApi) {
    QoL.airFocus = productionApi;
    console.log(LOG, 'Production Navigation Focus registered as window.JellyfinQoL.airFocus.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected Focus detected; production Focus is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }

})(window.JellyfinQoL = window.JellyfinQoL || {});
