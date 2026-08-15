// Jellyfin QoL / AirNav - Production Navigation Scanner v1.0.0
//
// DOM -> Surface discovery -> semantic/structural classification -> NavigationModel.
// Device independent: this module never reads keyboard, remote or gamepad input.
//
// Production principles:
//   - The visible DOM is authoritative; URL routes are metadata/hints only.
//   - Browser/ARIA semantics are preferred over Jellyfin/plugin-specific selectors.
//   - Stable logical identity is separate from a concrete visual occurrence.
//   - Media/card child actions are modelled as child contexts, not peer page items.
//   - MutationObserver is primary; route-settle and integrity checks are defensive.
//   - Legacy Scanner 10.2k projection/API remains available while Focus/Geometry/
//     Scroll/PageForm/ItemActions/ModalNavigation/Controller are migrated.

(function (QoL) {
  'use strict';

  const VERSION = '1.0.6';
  const LEGACY_VERSION = '10.2k';
  const MODEL_SCHEMA_VERSION = 1;
  const LOG = '[JellyfinQoL.NavigationScanner]';

  // Build the production API independently first. If an injected legacy Scanner
  // already owns QoL.airScanner, stay passive until that script is disabled and
  // the page reloads. This makes deployment safe while the old injector remains on.
  const productionApi = (function () {

    function getGlobalSettings() {
      let ownSettings = QoL.settings || {};

      if (typeof QoL.getSettings === 'function') {
        try {
          ownSettings = QoL.getSettings() || ownSettings;
        } catch (error) {
          console.warn(
            '[AirNav.Scanner] QoL.getSettings() failed; using local settings.',
            error
          );
        }
      }

      return ownSettings;
    }
    const DEFAULTS = {
      // Structural mutations are coalesced into a bounded-latency scan.
      mutationDebounceMs: 180,
      geometryRefreshMs: 120,

      // Jellyfin Web changes the SPA route before the destination DOM is fully
      // populated. Probe the same route several times while Jellyfin, HSS and
      // Jellyfin Enhanced finish inserting/replacing controls and sections.
      routeSettleDelaysMs: [60, 160, 350, 700, 1100],
      startupSettleDelaysMs: [80, 220, 500, 900],

      // Directional input should use geometry captured very close to the input
      // event. Repeated key events inside this tiny window reuse the latest
      // snapshot to avoid needless forced-layout work.
      inputGeometryMinIntervalMs: 24,

      // MutationObserver marks structure dirty immediately. This periodic
      // fingerprint probe is a second line of defence for plugin changes that
      // occur without an obvious structural mutation signal.
      inputStructureProbeIntervalMs: 250,

      // HSS / plugin home sections can be inserted, removed or replaced
      // asynchronously. MutationObserver remains primary; this low-frequency
      // structural watchdog is a defensive backup only.
      structuralPollMs: 1500,
      structuralPollHomeOnly: true,

      debug: false,

      // Production generic discovery. Known Jellyfin/plugin selectors remain
      // confidence hints/compatibility adapters; these semantic candidates are
      // the primary vocabulary for unknown plugins and future Jellyfin markup.
      genericInteractiveSelector: [
        'button',
        'a[href]',
        'input',
        'select',
        'textarea',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="switch"]',
        '[role="radio"]',
        '[role="slider"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[tabindex]:not([tabindex="-1"])',
        '[data-action]',
        '[data-item-id]',
        '[data-media-id]'
      ].join(', '),

      genericSectionContainerSelector: [
        '[role="list"]',
        '[role="grid"]',
        '[role="toolbar"]',
        '[role="tablist"]',
        '.focuscontainer-x',
        '.focuscontainer-y'
      ].join(', '),

      genericSuspiciousSelector: [
        '[data-preset-index]',
        '[data-setting]',
        '[data-pos]',
        '[onclick]'
      ].join(', '),

      genericOverlaySelector: [
        '[aria-modal="true"]',
        '[role="dialog"]',
        '[data-role="dialog"]'
      ].join(', '),
      passiveOverlaySelector: '#pause-screen-overlay',
      genericOverlayMinimumAreaRatio: 0.08,
      genericOverlayMinimumInteractiveCount: 1,
      genericOverlayMinimumZIndex: 100,

      // Preserve detailed audit output without making normal models huge.
      auditUnknownLimit: 120,
      auditCandidateLimit: 12000,

      // Jellyfin 10.11 can split the visible header across several containers
      // during SPA transitions. Discover the union rather than trusting only
      // the first .skinHeader snapshot.
      headerSelector: '.skinHeader, .headerTop, .headerLeft, .headerRight, .headerTabs',
      headerItemSelector: 'a[href], button, [role="button"], [tabindex]:not([tabindex="-1"])',

      sectionSelector: '.verticalSection, .jellyseerr-section, .mainDetailButtons, .qol-user-settings-preferences-card',

      // Compatibility adapters for visually meaningful controls that are not
      // children of the legacy card/list section projection. These augment the
      // generic model; they are never used to classify ordinary buttons/links.
      sectionTitleActionSelector: [
        '.sectionTitleContainer a[href]',
        '.sectionTitleContainer button',
        '.sectionTitleContainer [role="button"]'
      ].join(', '),
      heroContainerSelector: '#slides-container, .slides-container',
      heroActiveSlideSelector: '.slide.active[data-item-id], .slide.active[tabindex]',
      heroPrimaryActionSelector: '.detail-button, .detailButton.detail-button',
      heroChildActionSelector: '.btnPlay, .play-button, .trailer-button, .favorite-button',
      heroUtilityActionSelector: '.pause-button, .mute-button',
      standaloneContainerSelector: '.itemsContainer, .cardScrollContainer, .vertical-wrap',
      itemSelector: '.card, .listItem, .jellyseerr-card',

      modalSelector: [
        '.je-more-info-modal.active',
        '.jellyseerr-season-modal.show',
        '#jellyfin-enhanced-panel',
        '.dialogContainer .dialog',
        '.actionSheet',
        '[role="dialog"]',
        '[data-role="dialog"]',
        '[aria-modal="true"]',
        '.dialog'
      ].join(', '),

      playerActiveSelector: '.videoPlayerContainer video, .videoOsdBottom',

      activationSelector: [
        '.cardImageContainer.itemAction',
        'a.itemAction[href]',
        '[data-action="link"].itemAction',
        'a[href]',
        'button'
      ].join(', '),

      // Quick actions are discovered only by Scanner and published through
      // NavigationItem.actions. ItemActions/Controller never know these DOM
      // selectors.
      quickActionContainerSelector: [
        '.cardOverlayContainer',
        '.cardOverlayButtons',
        '.cardOverlayButton-br'
      ].join(', '),

      quickActionSelector: [
        'button',
        '[role="button"]',
        'a[href]'
      ].join(', '),

      modalCloseSelector: '#closeSettingsPanel, .modal-close, .btnCloseDialog, .btnClose, [title="Close"], [aria-label="Close"], [aria-label="Back"], [data-action="cancel"], [data-action="back"], .btnCancel',
      modalPrimaryActionSelector: '.btnPlay, .detailButton-play, .btnRequest, .button-submit, .raised.button-submit, .jellyseerr-request-button',

      // Jellyfin's hamburger/main drawer is a persistent off-canvas element.
      // It is always mounted, including while closed, so Scanner must detect
      // VISUAL viewport overlap rather than merely querySelector()/display.
      mainDrawerSelector: '.mainDrawer',
      mainDrawerScrollSelector: '.mainDrawer-scrollContainer',
      mainDrawerItemSelector: '.navMenuOption',
      mainDrawerToggleSelector: '.mainDrawerButton',
      mainDrawerMinimumVisiblePx: 24,

      // Phase 9 modal discovery. Scanner owns these selectors; modal navigation
      // consumes only the resulting model objects. Text fields/sliders are
      // deliberately excluded from first-pass directional ownership so native
      // form semantics remain intact.
      modalItemSelector: [
        'button:not([disabled])',
        'a[href]',
        '[role="button"]:not([aria-disabled="true"])',
        'input[type="checkbox"]:not([disabled])',
        '[role="checkbox"]:not([aria-disabled="true"])',
        '[role="switch"]:not([aria-disabled="true"])',
        'input[type="number"]:not([disabled])',
        'input[type="range"]:not([disabled])',
        'select:not([disabled])',
        '#jellyfin-enhanced-panel .preset-box',
        '#jellyfin-enhanced-panel .position-selector',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', '),

      // Native Jellyfin preference pages are ordinary page surfaces whose
      // content consists mostly of form controls rather than cards.
      // The temporary QoL settings page is intentionally not included.
      pageFormRoutePattern: /^#\/mypreferences(?!menu\b)/i,

      // Keep #/mypreferencesmenu as a normal navigation page, but expose the
      // Jellyfish Theme compound row as a tiny dedicated inline-form section.
      preferencesMenuRoutePattern: /^#\/mypreferencesmenu\b/i,
      preferencesThemeContainerSelector: '#jellyfin-theme-selector',
      preferencesThemeControlSelector:
        '#random-theme-button, #theme-selector-select',

      pageFormControlSelector: [
        'select:not([disabled])',
        'input[type="checkbox"]:not([disabled])',
        'input[type="radio"]:not([disabled])',
        'input[type="range"]:not([disabled])',
        'input[type="number"]:not([disabled])',
        'button:not([disabled])'
      ].join(', '),
      pageFormExcludedAncestorSelector: [
        '.skinHeader',
        '.headerTop',
        '.headerLeft',
        '.headerRight',
        '.mainDrawer',
        '.navMenuOption',
        '#jellyfin-enhanced-panel',
        '[role="dialog"]',
        '.dialog',
        '.actionSheet',
        '.qol-user-settings-page',
        '#qol-user-settings-page'
      ].join(', '),

      // Jellyfin Enhanced settings are visually organized as setting cards.
      // Scanner may collapse the controls inside one card into a semantic
      // parent NavigationItem. ModalNavigation then enters the child controls
      // as a nested group context, similar to ItemActions.
      modalSettingGroupRootSelector:
        '#jellyfin-enhanced-panel .je-pane.active',
      modalSettingGroupContentSelector:
        ':scope > div',

      // Controls whose Y centres fall within this tolerance are treated as one
      // visual modal section/row.
      modalRowTolerancePx: 34
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
          console.error(`[AirNav.Scanner] listener failed for ${event}`, error);
        }
      });
    }

    class JellyfinAirScanner {
      constructor(options = {}) {
        const globalSettings = getGlobalSettings();
        const legacyAirNav = globalSettings.airNav || {};
        const scannerSettings = legacyAirNav.scanner || {};

        // Preserve compatible selector overrides from the old airNav.js while
        // letting the new scanner-specific settings take precedence.
        const legacyOverrides = {
          headerSelector: legacyAirNav.navBarSelector,
          headerItemSelector: legacyAirNav.navBarItemSelector,
          sectionSelector: legacyAirNav.sectionSelector,
          itemSelector: legacyAirNav.cardSelector,
          modalSelector: legacyAirNav.modalSelector,
          playerActiveSelector: legacyAirNav.playerActiveSelector
        };

        this.cfg = Object.assign(
          {},
          DEFAULTS,
          this.compactObject(legacyOverrides),
          scannerSettings,
          options
        );

        this.cfg.debug = !!(
          this.cfg.debug ||
          legacyAirNav.debug ||
          globalSettings.DEBUG
        );

        this.model = null;
        this.version = 0;
        this.lastSignature = '';
        this.lastRoute = null;
        this.lastModalKey = null;
        this.scanTimer = null;
        this.geometryTimer = null;
        this.settleTimers = [];
        this.settleToken = 0;
        this.routeObserver = null;
        this.nativeMutationObserver = null;
        this.nativeResizeObserver = null;
        this.observedResizeRoots = new Set();
        this.structurePollTimer = null;
        this.lastStructureFingerprint = '';
        this.structureDirty = false;
        this.geometryDirty = false;
        this.stateDirty = false;
        this.lastMutationSummary = null;
        this.lastAudit = null;
        this.lastStructuralScanAt = 0;
        this.lastGeometryRefreshAt = 0;
        this.lastInputStructureProbeAt = 0;
        this.lastPrepareResult = null;

        // Page compound controls remain one ordinary NavigationItem until the
        // user explicitly enters them. Scanner owns the DOM interpretation.
        this.activePageInlineGroupKey = null;
        this.activePageInlineGroupId = null;
        this.lastPageInlineGroup = null;

        this.started = false;

        this.boundRouteEvent = () => this.handleRouteEvent();
        this.boundResize = () => {
          this.geometryDirty = true;
          if (this.model) this.refreshGeometry('window-resize');
          else this.scheduleScan('resize', true);
        };
        this.boundVisibility = () => {
          if (!document.hidden) this.scheduleScan('visibility', true);
        };

        this.start();
      }

      compactObject(object) {
        return Object.fromEntries(
          Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== '')
        );
      }

      log(...args) {
        if (this.cfg.debug) console.log('[AirNav.Scanner]', ...args);
      }

      start() {
        if (this.started) return;
        this.started = true;

        // AirNav owns a dedicated observer. This is intentional:
        // - focus classes must not trigger structural rescans;
        // - ScrollManager changes inline transform styles;
        // - AirNav must remain independent from AutoLogout/pause helpers.
        //
        // Child additions/removals are the important structural signal.
        // For attributes, only visibility/enabled transitions matter.
        if (window.MutationObserver && document.body) {
          this.nativeMutationObserver = new MutationObserver(
            mutations => {
              const summary = this.classifyMutations(mutations);
              this.lastMutationSummary = summary;

              if (summary.structure) {
                // Mark dirty synchronously. prepareForInput() self-heals even if
                // the coalesced structural scan has not run yet.
                this.structureDirty = true;
                this.scheduleScan('mutation:structure');
                return;
              }

              if (summary.state) this.stateDirty = true;
              if (summary.geometry) this.geometryDirty = true;

              // State/geometry-only churn is extremely common in Jellyfin.
              // Do not rebuild semantic identity for hover/animation changes.
              if ((summary.state || summary.geometry) && this.model) {
                this.scheduleGeometryRefresh('mutation:state-geometry');
              }
            }
          );

          this.nativeMutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: [
              'class', 'style', 'hidden', 'aria-hidden', 'aria-disabled',
              'aria-expanded', 'aria-selected', 'aria-checked', 'disabled',
              'tabindex', 'href'
            ]
          });
        }

        if (window.ResizeObserver && document.body) {
          this.nativeResizeObserver = new ResizeObserver(() => {
            if (!this.started) return;
            this.geometryDirty = true;
            this.scheduleGeometryRefresh('resize-observer');
          });
          try { this.nativeResizeObserver.observe(document.body); } catch (_) {}
        }

        window.addEventListener('hashchange', this.boundRouteEvent);
        window.addEventListener('popstate', this.boundRouteEvent);
        window.addEventListener('resize', this.boundResize);
        document.addEventListener('visibilitychange', this.boundVisibility);

        this.scan('initial');

        // The initial document may already be on #/home or #/details while
        // Jellyfin/HSS/Enhanced are still populating it. Treat startup like a
        // small settle window even when no hashchange occurs.
        this.scheduleSettleBurst(
          'startup-settle',
          this.detectRoute(),
          this.cfg.startupSettleDelaysMs
        );

        this.startStructuralWatchdog();
        this.log('initialized');
      }

      classifyMutations(mutations) {
        const summary = {
          total: 0,
          childList: 0,
          attributes: 0,
          structure: false,
          geometry: false,
          state: false,
          attributeCounts: {}
        };

        for (const mutation of mutations || []) {
          summary.total += 1;

          if (mutation.type === 'childList') {
            summary.childList += 1;
            if ((mutation.addedNodes?.length || 0) || (mutation.removedNodes?.length || 0)) {
              summary.structure = true;
            }
            continue;
          }

          if (mutation.type !== 'attributes') continue;
          summary.attributes += 1;

          const name = mutation.attributeName || 'unknown';
          summary.attributeCounts[name] = (summary.attributeCounts[name] || 0) + 1;

          if (['href', 'tabindex'].includes(name)) {
            summary.structure = true;
            continue;
          }

          if (['disabled', 'aria-disabled', 'aria-selected', 'aria-checked', 'aria-expanded'].includes(name)) {
            summary.state = true;
            continue;
          }

          if (['hidden', 'aria-hidden'].includes(name)) {
            summary.structure = true;
            summary.state = true;
            continue;
          }

          if (name === 'style') {
            const target = mutation.target;
            const airNavVisual = !!target?.matches?.(
              '[data-airnav-focused="true"], [data-airnav-action-focused="true"], .airnav-native-focused, .airnav-modal-focused'
            );
            if (airNavVisual) continue;
            summary.geometry = true;
            summary.state = true;
            continue;
          }

          if (name === 'class') {
            const oldClasses = new Set(String(mutation.oldValue || '').split(/\s+/).filter(Boolean));
            const newClasses = new Set(Array.from(mutation.target?.classList || []));
            const changedTokens = new Set([
              ...[...oldClasses].filter(token => !newClasses.has(token)),
              ...[...newClasses].filter(token => !oldClasses.has(token))
            ]);

            if (changedTokens.size && [...changedTokens].every(token => token.startsWith('airnav-'))) {
              continue;
            }

            const structuralTokens = [
              'hide', 'hidden', 'section-hidden', 'active', 'show', 'opened',
              'drawer-open', 'is-active', 'dialog', 'actionSheet', 'modal-open'
            ];

            if (structuralTokens.some(token => oldClasses.has(token) !== newClasses.has(token))) {
              summary.structure = true;
            } else {
              summary.geometry = true;
              summary.state = true;
            }
          }
        }

        return summary;
      }

      scheduleGeometryRefresh(reason = 'geometry-dirty') {
        if (!this.started || !this.model) return;
        if (this.geometryTimer) return;

        const delay = Math.max(0, Number(this.cfg.geometryRefreshMs) || 80);
        this.geometryTimer = setTimeout(() => {
          this.geometryTimer = null;
          if (!this.started || !this.model) return;
          if (this.structureDirty) {
            this.scheduleScan(`${reason}:structural-dirty`);
            return;
          }
          this.refreshGeometry(reason);
        }, delay);
      }

      shouldRescanForMutations(mutations) {
        for (const mutation of mutations || []) {
          if (mutation.type === 'childList') {
            // HSS and Jellyfin both insert/replace whole rows and card sets
            // asynchronously. Any real child-list change is worth one debounced
            // structural scan; the debounce coalesces bursts.
            if (
              (mutation.addedNodes && mutation.addedNodes.length) ||
              (mutation.removedNodes && mutation.removedNodes.length)
            ) {
              return true;
            }
          }

          if (mutation.type !== 'attributes') continue;

          const name = mutation.attributeName;
          const target = mutation.target;

          if (name === 'hidden' || name === 'aria-hidden' || name === 'disabled') {
            return true;
          }

          if (name === 'class') {
            const oldClasses = new Set(
              String(mutation.oldValue || '')
                .split(/\s+/)
                .filter(Boolean)
            );

            const newClasses = new Set(
              Array.from(target?.classList || [])
            );

            // Ignore AirNav's own purely visual focus classes and ordinary
            // hover/focus styling churn. Only classes that can materially
            // add/remove a navigation surface cause a structural scan.
            const structuralTokens = [
              'hide',
              'hidden',
              'section-hidden',
              'active',
              'show',
              'is-active',
              'dialog',
              'actionSheet'
            ];

            for (const token of structuralTokens) {
              if (oldClasses.has(token) !== newClasses.has(token)) {
                return true;
              }
            }
          }
        }

        return false;
      }

      startStructuralWatchdog() {
        this.stopStructuralWatchdog();

        const interval = Number(this.cfg.structuralPollMs) || 0;
        if (interval <= 0) return;

        this.lastStructureFingerprint = this.makeStructureFingerprint();

        this.structurePollTimer = setInterval(() => {
          if (!this.started || document.hidden) return;

          if (
            this.cfg.structuralPollHomeOnly &&
            !this.isHomeLikeRoute()
          ) {
            this.lastStructureFingerprint = this.makeStructureFingerprint();
            return;
          }

          const next = this.makeStructureFingerprint();

          if (
            this.lastStructureFingerprint &&
            next !== this.lastStructureFingerprint
          ) {
            this.lastStructureFingerprint = next;
            this.scheduleScan('structure-watchdog');
          } else {
            this.lastStructureFingerprint = next;
          }
        }, interval);
      }

      stopStructuralWatchdog() {
        if (this.structurePollTimer) {
          clearInterval(this.structurePollTimer);
          this.structurePollTimer = null;
        }
      }

      isHomeLikeRoute() {
        const route = this.detectRoute();
        return (
          route === '#/home' ||
          route === '#/home.html' ||
          route.startsWith('#/home?')
        );
      }

      makeStructureFingerprint() {
        const roots = Array.from(
          document.querySelectorAll(
            '.verticalSection, .jellyseerr-section, .mainDetailButtons'
          )
        ).filter(element => this.isRendered(element));

        const sections = roots.map(element => {
          const title =
            this.getSectionTitle(element) ||
            element.getAttribute('data-section-title') ||
            '';

          const cards = Array.from(
            element.querySelectorAll(this.cfg.itemSelector)
          ).filter(card => this.isRendered(card));

          const sampleIds = cards
            .slice(0, 4)
            .map(card =>
              card.dataset?.id ||
              card.dataset?.tmdbId ||
              card.getAttribute('data-item-id') ||
              card.getAttribute('data-tmdb-id') ||
              ''
            );

          return [
            element.id || '',
            title,
            element.getAttribute('data-page') || '',
            element.style?.order || '',
            cards.length,
            sampleIds.join(',')
          ].join('|');
        });

        const headerRoots = Array.from(
          document.querySelectorAll(this.cfg.headerSelector)
        ).filter(element => this.isRendered(element));

        const headerItems = [];
        for (const root of headerRoots) {
          headerItems.push(
            ...root.querySelectorAll(this.cfg.headerItemSelector)
          );
        }

        const header = this.dedupeInteractiveElements(headerItems)
          .filter(element => this.isRendered(element))
          .slice(0, 12)
          .map(element => [
            element.id || '',
            element.getAttribute('aria-label') || '',
            element.getAttribute('title') || '',
            element.getAttribute('href') || '',
            element.getAttribute('data-index') || ''
          ].join('|'));

        return JSON.stringify({
          route: this.detectRoute(),
          header,
          sections
        });
      }

      clearSettleTimers() {
        this.settleToken += 1;

        for (const timer of this.settleTimers) {
          clearTimeout(timer);
        }

        this.settleTimers = [];
      }

      scheduleSettleBurst(reason, route, delays) {
        if (!this.started) return;

        const token = this.settleToken;
        const list = Array.isArray(delays) ? delays : [];

        for (const rawDelay of list) {
          const delay = Math.max(0, Number(rawDelay) || 0);

          const timer = setTimeout(() => {
            this.settleTimers = this.settleTimers.filter(
              pending => pending !== timer
            );

            if (
              !this.started ||
              token !== this.settleToken ||
              this.detectRoute() !== route
            ) {
              return;
            }

            // Full scan is intentional during settling. Jellyfin can create
            // the page shell, section shells, cards and plugin enhancements in
            // separate async waves.
            this.scan(`${reason}:${delay}ms`);
          }, delay);

          this.settleTimers.push(timer);
        }
      }

      handleRouteEvent() {
        if (!this.started) return;

        // A hash/popstate event tells us only that routing changed, not that
        // the destination DOM is finished. Invalidate immediately, then probe
        // while the new route settles.
        this.clearSettleTimers();

        const route = this.detectRoute();

        this.scheduleScan(
          'route-event:immediate',
          true
        );

        this.scheduleSettleBurst(
          'route-settle',
          route,
          this.cfg.routeSettleDelaysMs
        );
      }

      scheduleScan(reason = 'mutation', immediate = false) {
        if (!this.started) return;

        if (immediate) {
          if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
          }

          this.scan(reason);
          return;
        }

        // Do not use a trailing debounce that resets on every mutation. A
        // Jellyfin detail/home page can mutate continuously while metadata and
        // plugins render, which can otherwise starve Scanner for seconds.
        // First mutation opens one bounded-latency scan window; later mutations
        // are folded into it.
        if (this.scanTimer) return;

        const delay = Math.max(
          0,
          Number(this.cfg.mutationDebounceMs) || 180
        );

        this.scanTimer = setTimeout(() => {
          this.scanTimer = null;
          this.scan(reason);
        }, delay);
      }

      scan(reason = 'manual') {
        if (!this.started) return this.model;

        // Any full scan satisfies a pending mutation request. Cancelling the
        // timer avoids a redundant second rebuild shortly after an input- or
        // route-triggered scan.
        if (this.scanTimer) {
          clearTimeout(this.scanTimer);
          this.scanTimer = null;
        }

        const route = this.detectRoute();
        const modal = this.scanActiveOverlay();
        const playerActive = this.isAnyRendered(document.querySelectorAll(this.cfg.playerActiveSelector));
        const header = modal ? null : this.scanHeader();
        const sections = modal
          ? []
          : this.discoverSections()
              .map((el, index) =>
                this.scanSection(el, index)
              )
              .filter(Boolean);

        if (!modal) {
          const preferencesThemeSection =
            this.scanPreferencesThemeSection(
              route,
              sections
            );

          if (preferencesThemeSection) {
            sections.push(
              preferencesThemeSection
            );
          }

          const formSection =
            this.scanPageFormSection(
              route,
              sections
            );

          if (formSection) {
            sections.push(
              formSection
            );
          }

          const adapterSections =
            this.scanProductionAdapterSections(
              route,
              sections
            );

          if (adapterSections.length) {
            sections.push(...adapterSections);
          }
        }

        sections.sort((a, b) => {
          if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
          return a.rect.left - b.rect.left;
        });
        sections.forEach((section, index) => { section.order = index; });

        const activeSurfaceHint = playerActive ? 'player' : (modal ? 'modal' : 'page');
        const nextLogical = {
          route,
          header,
          sections,
          modal,
          activeSurfaceHint
        };

        const signature = this.makeLogicalSignature(nextLogical);
        const logicalChanged = signature !== this.lastSignature;

        if (logicalChanged) {
          this.version += 1;
          this.lastSignature = signature;
        }

        const previousRoute = this.lastRoute;
        const previousModalKey = this.lastModalKey;

        this.model = {
          version: this.version,
          timestamp: Date.now(),
          route,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          },
          header,
          sections,
          modal,
          activeSurfaceHint
        };

        this.decorateProductionModel(this.model, reason);
        this.refreshResizeObserverRoots();

        this.lastRoute = route;
        this.lastModalKey = modal ? modal.id : null;
        this.lastStructureFingerprint = this.makeStructureFingerprint();
        this.structureDirty = false;
        this.geometryDirty = false;
        this.stateDirty = false;
        this.lastStructuralScanAt = performance.now();
        this.lastGeometryRefreshAt = this.lastStructuralScanAt;

        if (previousRoute !== null && previousRoute !== route) {
          emit('routeChanged', route);
        }

        if (!previousModalKey && this.lastModalKey) {
          emit('modalOpened', modal);
        } else if (previousModalKey && !this.lastModalKey) {
          emit('modalClosed', { id: previousModalKey, route });
        }

        if (logicalChanged) {
          this.logModel(reason);
          emit('modelChanged', this.model);
        } else {
          // Keep geometry fresh without falsely advancing model version.
          emit('geometryChanged', {
            version: this.version,
            timestamp: this.model.timestamp,
            reason,
            model: this.model
          });
        }

        return this.model;
      }

      refreshResizeObserverRoots() {
        if (!this.nativeResizeObserver || !this.model) return;
        const roots = new Set();
        if (this.model.header?.element) roots.add(this.model.header.element);
        for (const section of this.model.sections || []) {
          if (section.element) roots.add(section.element);
          if (section.scroll?.container) roots.add(section.scroll.container);
        }
        if (this.model.modal?.root) roots.add(this.model.modal.root);

        for (const element of this.observedResizeRoots) {
          if (roots.has(element)) continue;
          try { this.nativeResizeObserver.unobserve(element); } catch (_) {}
          this.observedResizeRoots.delete(element);
        }
        for (const element of roots) {
          if (!element?.isConnected || this.observedResizeRoots.has(element)) continue;
          try {
            this.nativeResizeObserver.observe(element);
            this.observedResizeRoots.add(element);
          } catch (_) {}
        }
      }

      getModel() {
        return this.model;
      }

      getNavigationModel() {
        return this.model;
      }

      getSurfaceStack() {
        return this.model?.surfaces || [];
      }

      // Lightweight Phase 5 geometry refresh.
      // Scrolling changes getBoundingClientRect() values but does not normally
      // change logical structure, so avoid a complete DOM rediscovery after
      // every scroll animation.
      refreshGeometry(reason = 'geometry-refresh') {
        if (!this.started || !this.model) return this.model;

        // If route/surface structure changed, geometry-only refresh is unsafe;
        // fall back to the normal structural scan.
        const currentRoute = this.detectRoute();
        const modalNow = this.scanActiveOverlay();
        const playerActive = this.isAnyRendered(
          document.querySelectorAll(this.cfg.playerActiveSelector)
        );
        const surfaceNow = playerActive
          ? 'player'
          : (modalNow ? 'modal' : 'page');

        if (
          currentRoute !== this.model.route ||
          surfaceNow !== this.model.activeSurfaceHint
        ) {
          return this.scan(`${reason}:structural-fallback`);
        }

        const refreshSection = section => {
          if (!section) return;

          if (section.element?.isConnected) {
            section.rect = this.rectSnapshot(section.element);
            section.visible = this.isRendered(section.element);
          }

          for (const item of section.items || []) {
            if (!item?.element?.isConnected) continue;

            item.rect = this.rectSnapshot(item.element);
            item.state = {
              ...(item.state || {}),
              visible: this.isRendered(item.element)
            };
            item.metadata = {
              ...(item.metadata || {}),
              inViewport: this.rectIntersectsViewport(item.rect)
            };

            for (const action of item.actions || []) {
              if (!action?.element?.isConnected) continue;

              action.rect =
                this.rectSnapshot(
                  action.element
                );

              action.enabled =
                !this.isDisabled(
                  action.element
                );
            }
          }

          const viewport = section.scroll?.container;
          if (viewport?.isConnected) {
            section.scroll.viewportRect = this.rectSnapshot(viewport);
          }
        };

        refreshSection(this.model.header);
        (this.model.sections || []).forEach(refreshSection);

        if (this.model.modal?.root?.isConnected) {
          for (const section of this.model.modal.sections || []) {
            for (const item of section.items || []) {
              if (!item?.element?.isConnected) continue;

              item.rect =
                this.rectSnapshot(
                  item.element
                );

              item.state = {
                ...(item.state || {}),
                visible:
                  this.isRendered(
                    item.element
                  ),
                enabled:
                  !this.isDisabled(
                    item.element
                  )
              };

              item.metadata = {
                ...(item.metadata || {}),
                inViewport:
                  this.rectIntersectsViewport(
                    item.rect
                  )
              };
            }

            const validRects =
              (section.items || [])
                .map(item => item.rect)
                .filter(Boolean);

            if (validRects.length) {
              const left = Math.min(...validRects.map(rect => rect.left));
              const right = Math.max(...validRects.map(rect => rect.right));
              const top = Math.min(...validRects.map(rect => rect.top));
              const bottom = Math.max(...validRects.map(rect => rect.bottom));

              section.rect = {
                top,
                left,
                right,
                bottom,
                width: right - left,
                height: bottom - top,
                centerX: left + (right - left) / 2,
                centerY: top + (bottom - top) / 2
              };
            }
          }

          this.model.modal.metadata = {
            ...(this.model.modal.metadata || {}),
            geometryRefreshedAt: Date.now()
          };
        }

        this.model.timestamp = Date.now();
        this.model.viewport = {
          width: window.innerWidth,
          height: window.innerHeight
        };
        this.lastGeometryRefreshAt = performance.now();
        this.geometryDirty = false;
        this.stateDirty = false;
        this.decorateProductionModel(this.model, reason);

        emit('geometryChanged', {
          version: this.model.version,
          timestamp: this.model.timestamp,
          reason,
          model: this.model
        });

        this.log(`geometry refreshed reason=${reason}`);
        return this.model;
      }

      hasDisconnectedModelNodes() {
        if (!this.model) return true;

        const sections = [
          this.model.header,
          ...(this.model.sections || [])
        ].filter(Boolean);

        for (const section of sections) {
          if (section.element && !section.element.isConnected) return true;

          for (const item of section.items || []) {
            if (item?.element && !item.element.isConnected) return true;

            for (const action of item?.actions || []) {
              if (
                action?.element &&
                !action.element.isConnected
              ) {
                return true;
              }
            }
          }
        }

        if (this.model.modal) {
          if (
            this.model.modal.root &&
            !this.model.modal.root.isConnected
          ) {
            return true;
          }

          for (const section of this.model.modal.sections || []) {
            for (const item of section.items || []) {
              if (
                item?.element &&
                !item.element.isConnected
              ) {
                return true;
              }
            }
          }
        }

        return false;
      }

      // Synchronous preflight used by Controller immediately before a
      // canonical directional action is resolved by GeometryEngine.
      //
      // Fast path: refresh only getBoundingClientRect snapshots.
      // Slow path: perform a full structural scan if route/surface/structure
      // changed. FocusManager's stable-key restoration runs synchronously from
      // the emitted model/geometry event before GeometryEngine consumes it.
      prepareForInput(action = 'INPUT') {
        if (!this.started) return this.model;

        const label = String(action || 'INPUT').toUpperCase();
        const startedAt = performance.now();
        let mode = 'reuse';
        let reason = 'fresh-enough';

        if (!this.model) {
          mode = 'structural';
          reason = 'no-model';
          this.scan(`input:${label}:no-model`);
        } else {
          const currentRoute = this.detectRoute();
          const modalNow = this.scanActiveOverlay();
          const playerActive = this.isAnyRendered(
            document.querySelectorAll(this.cfg.playerActiveSelector)
          );
          const surfaceNow = playerActive
            ? 'player'
            : (modalNow ? 'modal' : 'page');

          if (
            currentRoute !== this.model.route ||
            surfaceNow !== this.model.activeSurfaceHint
          ) {
            mode = 'structural';
            reason = 'route-or-surface-changed';
            this.scan(`input:${label}:route-surface`);
          } else if (this.hasDisconnectedModelNodes()) {
            mode = 'structural';
            reason = 'disconnected-model-node';
            this.scan(`input:${label}:disconnected-node`);
          } else if (this.structureDirty) {
            mode = 'structural';
            reason = 'mutation-dirty';
            this.scan(`input:${label}:mutation-dirty`);
          } else {
            const now = performance.now();
            const probeInterval = Math.max(
              0,
              Number(this.cfg.inputStructureProbeIntervalMs) || 250
            );

            if (
              probeInterval === 0 ||
              now - this.lastInputStructureProbeAt >= probeInterval
            ) {
              this.lastInputStructureProbeAt = now;
              const fingerprint = this.makeStructureFingerprint();

              if (
                this.lastStructureFingerprint &&
                fingerprint !== this.lastStructureFingerprint
              ) {
                mode = 'structural';
                reason = 'fingerprint-changed';
                this.scan(`input:${label}:fingerprint-changed`);
              }
            }

            if (mode !== 'structural') {
              const minInterval = Math.max(
                0,
                Number(this.cfg.inputGeometryMinIntervalMs) || 24
              );

              if (
                minInterval === 0 ||
                now - this.lastGeometryRefreshAt >= minInterval
              ) {
                mode = 'geometry';
                reason = 'input-geometry-refresh';
                this.refreshGeometry(`input:${label}:geometry`);
              }
            }
          }
        }

        this.lastPrepareResult = {
          action: label,
          mode,
          reason,
          durationMs: performance.now() - startedAt,
          route: this.model?.route || null,
          version: this.model?.version || null,
          timestamp: Date.now()
        };

        this.log('prepareForInput', this.lastPrepareResult);
        return this.model;
      }

      getDiagnostics() {
        return {
          runtimeVersion: VERSION,
          legacyVersion: LEGACY_VERSION,
          schemaVersion: MODEL_SCHEMA_VERSION,
          started: this.started,
          route: this.detectRoute(),
          modelRoute: this.model?.route || null,
          modelVersion: this.model?.version || null,
          modelTimestamp: this.model?.timestamp || null,
          structureDirty: this.structureDirty,
          geometryDirty: this.geometryDirty,
          stateDirty: this.stateDirty,
          lastMutationSummary: this.lastMutationSummary ? { ...this.lastMutationSummary } : null,
          pendingMutationScan: !!this.scanTimer,
          pendingGeometryRefresh: !!this.geometryTimer,
          pendingSettleScans: this.settleTimers.length,
          lastStructuralScanAt: this.lastStructuralScanAt,
          lastGeometryRefreshAt: this.lastGeometryRefreshAt,
          lastPrepareResult: this.lastPrepareResult
            ? { ...this.lastPrepareResult }
            : null,
          pageInlineGroup:
            this.getPageInlineGroupState()
        };
      }

      destroy() {
        this.started = false;

        if (this.scanTimer) {
          clearTimeout(this.scanTimer);
          this.scanTimer = null;
        }

        if (this.geometryTimer) {
          clearTimeout(this.geometryTimer);
          this.geometryTimer = null;
        }

        this.clearSettleTimers();

        if (this.routeObserver) {
          try {
            if (typeof this.routeObserver.unsubscribe === 'function') {
              this.routeObserver.unsubscribe();
            } else if (typeof this.routeObserver === 'function') {
              this.routeObserver();
            }
          } catch (error) {
            console.warn('[AirNav.Scanner] failed to unsubscribe shared mutation observer', error);
          }
          this.routeObserver = null;
        }

        if (this.nativeMutationObserver) {
          this.nativeMutationObserver.disconnect();
          this.nativeMutationObserver = null;
        }

        if (this.nativeResizeObserver) {
          try { this.nativeResizeObserver.disconnect(); } catch (_) {}
          this.nativeResizeObserver = null;
        }
        this.observedResizeRoots.clear();

        this.stopStructuralWatchdog();

        window.removeEventListener('hashchange', this.boundRouteEvent);
        window.removeEventListener('popstate', this.boundRouteEvent);
        window.removeEventListener('resize', this.boundResize);
        document.removeEventListener('visibilitychange', this.boundVisibility);

        this.model = null;
        this.lastSignature = '';
        this.lastRoute = null;
        this.lastModalKey = null;
        this.lastStructureFingerprint = '';
        this.structureDirty = false;
        this.geometryDirty = false;
        this.stateDirty = false;
        this.lastMutationSummary = null;
        this.lastAudit = null;
        this.lastStructuralScanAt = 0;
        this.lastGeometryRefreshAt = 0;
        this.lastInputStructureProbeAt = 0;
        this.lastPrepareResult = null;

        this.log('destroyed');
      }

      // ------------------------------------------------------------------
      // NavigationModel discovery
      // ------------------------------------------------------------------
      detectRoute() {
        return location.hash || `${location.pathname}${location.search}` || '/';
      }

      scanHeader() {
        const roots = Array.from(
          document.querySelectorAll(this.cfg.headerSelector)
        ).filter(element => this.isRendered(element));

        if (!roots.length) return null;

        // Jellyfin 10.11 + plugins may split visible navigation between
        // .skinHeader, .headerTop, .headerLeft/.headerRight and .headerTabs,
        // especially during SPA transitions. Scan the union of all visible
        // roots. This prevents a temporary partial header from making the
        // hamburger appear to be the left-most reachable control.
        const candidates = [];

        for (const root of roots) {
          if (root.matches?.(this.cfg.headerItemSelector)) {
            candidates.push(root);
          }

          candidates.push(
            ...root.querySelectorAll(this.cfg.headerItemSelector)
          );
        }

        const elements = this.dedupeInteractiveElements(candidates)
          .filter(element => this.isRendered(element))
          .filter(element => !element.closest(
            '.hide, [hidden], [aria-hidden="true"]'
          ));

        const items = elements
          .map((element, index) =>
            this.buildItem(
              element,
              'section:header',
              index,
              'navigation'
            )
          )
          .filter(Boolean);

        if (!items.length) return null;

        const root = roots.find(element =>
          element.classList?.contains('skinHeader')
        ) || roots[0];

        const rects = roots
          .map(element => this.rectSnapshot(element))
          .filter(Boolean);

        const headerRect = rects.length
          ? {
              top: Math.min(...rects.map(rect => rect.top)),
              left: Math.min(...rects.map(rect => rect.left)),
              right: Math.max(...rects.map(rect => rect.right)),
              bottom: Math.max(...rects.map(rect => rect.bottom))
            }
          : this.rectSnapshot(root);

        if (headerRect) {
          headerRect.width = headerRect.right - headerRect.left;
          headerRect.height = headerRect.bottom - headerRect.top;
          headerRect.centerX = headerRect.left + headerRect.width / 2;
          headerRect.centerY = headerRect.top + headerRect.height / 2;
        }

        return {
          id: 'section:header',
          type: 'header',
          title: 'Header',
          element: root,
          rect: headerRect || this.rectSnapshot(root),
          visible: true,
          order: -1,
          scroll: {
            horizontal: false,
            vertical: false,
            container: null,
            viewportRect: null
          },
          items,
          metadata: {
            source: 'known-selector',
            selectorHint: this.cfg.headerSelector,
            rootCount: roots.length,
            virtualized: false
          }
        };
      }

      discoverSections() {
        const primary = Array.from(document.querySelectorAll(this.cfg.sectionSelector))
          .filter(el => this.isRendered(el));

        const result = [...primary];
        const standalone = Array.from(document.querySelectorAll(this.cfg.standaloneContainerSelector))
          .filter(el => this.isRendered(el));

        for (const candidate of standalone) {
          // If a known logical section already owns this container, don't emit
          // the nested itemsContainer as a second section.
          if (primary.some(section => section === candidate || section.contains(candidate))) continue;

          const cardCount = candidate.querySelectorAll(this.cfg.itemSelector).length;
          if (!cardCount) continue;
          result.push(candidate);
        }

        // Generic fallback for future plugins: semantic list/grid/toolbar/form
        // containers and focus lanes can become sections without a plugin name.
        let generic = [];
        try {
          generic = Array.from(document.querySelectorAll(this.cfg.genericSectionContainerSelector));
        } catch (_) {}

        for (const candidate of generic) {
          if (!this.isRendered(candidate)) continue;
          if (result.some(section => section === candidate || section.contains(candidate))) continue;
          if (candidate.closest?.('.skinHeader, .mainDrawer, [aria-modal="true"], [role="dialog"], .dialog, .actionSheet')) continue;

          const rect = candidate.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          let interactiveCount = 0;
          try {
            interactiveCount = this.dedupeInteractiveElements(
              Array.from(candidate.querySelectorAll(this.cfg.genericInteractiveSelector))
            ).filter(el => this.isRendered(el) && !this.isDisabled(el)).length;
          } catch (_) {}

          // Forms can contain one logical control plus labels; row/list/grid
          // inference otherwise requires at least two meaningful descendants.
          const semanticForm = candidate.matches?.('form, fieldset');
          if ((!semanticForm && interactiveCount < 2) || (semanticForm && interactiveCount < 1)) continue;

          result.push(candidate);
        }

        return this.dedupeSectionElements(result);
      }

      scanSection(sectionEl, index) {
        const itemElements = this.findSectionItems(sectionEl);
        if (!itemElements.length) return null;

        // Determine layout from actual item geometry before naming the section.
        // A Jellyfin library grid also uses an .itemsContainer, so the presence
        // of that wrapper alone must never make the section a horizontal row.
        const sectionType = this.detectSectionType(sectionEl, itemElements);
        const title = this.getSectionTitle(sectionEl) ||
          this.getFallbackSectionTitle(sectionType, index);
        const id = this.makeSectionId(sectionEl, title, index);
        const scrollInfo = this.detectScrollInfo(sectionEl, itemElements);

        const items = itemElements
          .map((element, itemIndex) => this.buildItem(element, id, itemIndex))
          .filter(Boolean);

        // A single underlying Jellyfin entity can legitimately appear more
        // than once in the same section with different logical roles. Cast &
        // Crew is the common example: the same person may be Director, Writer
        // and Producer. Preserve all logical cards, but disambiguate only the
        // colliding stable keys using semantic credit/action context.
        this.ensureUniqueItemKeys(items);

        if (!items.length) return null;

        return {
          id,
          type: sectionType,
          title,
          element: sectionEl,
          rect: this.rectSnapshot(sectionEl),
          visible: true,
          order: index,
          scroll: scrollInfo,
          items,
          metadata: {
            source: this.isKnownSection(sectionEl) ? 'known-selector' : 'structural',
            selectorHint: this.selectorHint(sectionEl),
            virtualized: !!scrollInfo.virtualized,
            scrollMode: scrollInfo.mode,
            visualRows: this.countVisualRows(itemElements),
            contentElement: scrollInfo.contentElement || null
          }
        };
      }

      scanPreferencesThemeSection(
        route,
        existingSections = []
      ) {
        const pattern =
          this.cfg
            .preferencesMenuRoutePattern;

        if (
          !(pattern instanceof RegExp) ||
          !pattern.test(
            String(route || '')
          )
        ) {
          if (
            this.activePageInlineGroupId ===
              'preferences-theme'
          ) {
            this.activePageInlineGroupKey =
              null;
            this.activePageInlineGroupId =
              null;
          }

          return null;
        }

        const container =
          document.querySelector(
            this.cfg
              .preferencesThemeContainerSelector
          );

        if (
          !container ||
          !this.isRendered(container)
        ) {
          return null;
        }

        let ownerSection = null;
        let ownerIndex = -1;
        let ownerItem = null;

        // The Theme DOM is already represented as one normal preferences-menu
        // row. Keep that row in the normal vertical flow until ENTER.
        for (
          const section of
          existingSections || []
        ) {
          const items =
            Array.isArray(section.items)
              ? section.items
              : [];

          const index =
            items.findIndex(item => {
              const element =
                item?.element;

              if (!element) {
                return false;
              }

              return !!(
                element === container ||
                container.contains?.(
                  element
                ) ||
                element.contains?.(
                  container
                )
              );
            });

          if (index >= 0) {
            ownerSection =
              section;
            ownerIndex =
              index;
            ownerItem =
              items[index];
            break;
          }
        }

        if (
          !ownerSection ||
          !ownerItem
        ) {
          return null;
        }

        ownerItem.title =
          'Theme';

        ownerItem.metadata = {
          ...(ownerItem.metadata || {}),
          pageInlineGroup:
            true,
          pageInlineGroupId:
            'preferences-theme',
          pageInlineGroupSelector:
            this.cfg
              .preferencesThemeContainerSelector,
          pageInlineGroupControlSelector:
            this.cfg
              .preferencesThemeControlSelector
        };

        const expanded =
          this.activePageInlineGroupKey ===
            ownerItem.key &&
          this.activePageInlineGroupId ===
            'preferences-theme';

        if (!expanded) {
          return null;
        }

        // ENTER on the parent asks Scanner for a fresh, immediate read of the
        // group's real interactive children.
        let controls = [];

        try {
          controls =
            Array.from(
              container.querySelectorAll(
                this.cfg
                  .preferencesThemeControlSelector
              )
            )
              .filter(element =>
                this.isPageFormControlUsable(
                  element
                )
              );
        } catch (_) {
          controls = [];
        }

        controls =
          this.dedupeInteractiveElements(
            controls
          );

        if (!controls.length) {
          return null;
        }

        controls.sort((a, b) => {
          const ar =
            a.getBoundingClientRect();

          const br =
            b.getBoundingClientRect();

          if (
            Math.abs(
              ar.top - br.top
            ) > 4
          ) {
            return ar.top - br.top;
          }

          return ar.left - br.left;
        });

        const childItems =
          controls
            .map((element, index) =>
              this.buildPageFormItem(
                element,
                ownerSection.id,
                index
              )
            )
            .filter(Boolean);

        if (!childItems.length) {
          return null;
        }

        childItems.forEach(item => {
          if (
            item.element?.id ===
            'random-theme-button'
          ) {
            item.title =
              'Random Daily Theme';
          } else if (
            item.element?.id ===
            'theme-selector-select'
          ) {
            item.title =
              'Theme';
          }

          item.sectionId =
            ownerSection.id;

          item.metadata = {
            ...(item.metadata || {}),
            pageInlineGroupChild:
              true,
            parentPageInlineGroupKey:
              ownerItem.key,
            parentPageInlineGroupId:
              'preferences-theme',
            compoundRow:
              true
          };
        });

        // Replace the parent IN PLACE. This preserves the exact menu position
        // between the neighboring preferences rows.
        ownerSection.items.splice(
          ownerIndex,
          1,
          ...childItems
        );

        this.ensureUniqueItemKeys(
          ownerSection.items
        );

        ownerSection.metadata = {
          ...(ownerSection.metadata || {}),
          activePageInlineGroup: {
            id:
              'preferences-theme',
            parentKey:
              ownerItem.key,
            childKeys:
              childItems.map(
                item => item.key
              )
          }
        };

        this.lastPageInlineGroup = {
          timestamp:
            Date.now(),
          state:
            'expanded',
          id:
            'preferences-theme',
          parentKey:
            ownerItem.key,
          childKeys:
            childItems.map(
              item => item.key
            )
        };

        return null;
      }

      findPageInlineGroupItem(
        groupKey
      ) {
        if (!groupKey) {
          return null;
        }

        for (
          const section of
          this.model?.sections || []
        ) {
          const item =
            (section.items || [])
              .find(candidate =>
                candidate.key ===
                  groupKey &&
                candidate.metadata
                  ?.pageInlineGroup ===
                  true
              );

          if (item) {
            return {
              section,
              item
            };
          }
        }

        return null;
      }

      enterPageInlineGroup(
        groupKey
      ) {
        const match =
          this.findPageInlineGroupItem(
            groupKey
          );

        if (!match) {
          return {
            handled: false,
            reason:
              'page-inline-group-not-found',
            groupKey
          };
        }

        const groupId =
          match.item.metadata
            ?.pageInlineGroupId ||
          null;

        if (!groupId) {
          return {
            handled: false,
            reason:
              'page-inline-group-id-missing',
            groupKey
          };
        }

        this.activePageInlineGroupKey =
          match.item.key;
        this.activePageInlineGroupId =
          groupId;

        const model =
          this.scan(
            'page-inline-group-enter'
          );

        const children = [];

        for (
          const section of
          model?.sections || []
        ) {
          for (
            const item of
            section.items || []
          ) {
            if (
              item.metadata
                ?.pageInlineGroupChild ===
                true &&
              item.metadata
                ?.parentPageInlineGroupKey ===
                groupKey
            ) {
              children.push(
                item
              );
            }
          }
        }

        const result = {
          handled:
            children.length > 0,
          reason:
            children.length
              ? 'page-inline-group-entered'
              : 'page-inline-group-no-children',
          groupKey,
          groupId,
          childKeys:
            children.map(
              item => item.key
            ),
          firstChildKey:
            children[0]?.key ||
            null
        };

        this.lastPageInlineGroup = {
          timestamp:
            Date.now(),
          state:
            result.handled
              ? 'entered'
              : 'enter-failed',
          ...result
        };

        if (!result.handled) {
          this.activePageInlineGroupKey =
            null;
          this.activePageInlineGroupId =
            null;

          this.scan(
            'page-inline-group-enter-rollback'
          );
        }

        return result;
      }

      exitPageInlineGroup(
        reason = 'back'
      ) {
        const groupKey =
          this.activePageInlineGroupKey;

        const groupId =
          this.activePageInlineGroupId;

        if (!groupKey) {
          return {
            handled: false,
            reason:
              'page-inline-group-not-active'
          };
        }

        this.activePageInlineGroupKey =
          null;
        this.activePageInlineGroupId =
          null;

        const model =
          this.scan(
            `page-inline-group-exit:${reason}`
          );

        const parentFound =
          (model?.sections || [])
            .some(section =>
              (section.items || [])
                .some(item =>
                  item.key ===
                    groupKey
                )
            );

        const result = {
          handled: true,
          reason:
            'page-inline-group-exited',
          exitReason:
            reason,
          groupKey,
          groupId,
          parentFound
        };

        this.lastPageInlineGroup = {
          timestamp:
            Date.now(),
          state:
            'exited',
          ...result
        };

        return result;
      }

      getPageInlineGroupState() {
        const groupKey =
          this.activePageInlineGroupKey;

        if (!groupKey) {
          return {
            active: false,
            groupKey: null,
            groupId: null,
            childKeys: []
          };
        }

        const childKeys = [];

        for (
          const section of
          this.model?.sections || []
        ) {
          for (
            const item of
            section.items || []
          ) {
            if (
              item.metadata
                ?.pageInlineGroupChild ===
                true &&
              item.metadata
                ?.parentPageInlineGroupKey ===
                groupKey
            ) {
              childKeys.push(
                item.key
              );
            }
          }
        }

        return {
          active: true,
          groupKey,
          groupId:
            this.activePageInlineGroupId,
          childKeys,
          last:
            this.lastPageInlineGroup
              ? {
                  ...this.lastPageInlineGroup
                }
              : null
        };
      }


      isLikelyPageFormSurface(route, existingSections = []) {
        const pattern = this.cfg.pageFormRoutePattern;
        if (pattern instanceof RegExp) {
          pattern.lastIndex = 0;
          if (pattern.test(String(route || ''))) return true;
        }

        // Route is only a hint. Unknown plugins can render settings forms on any
        // route (or no new route at all), so infer a form surface from actual
        // editable controls that are not already owned by cards/header/overlays.
        let controls = [];
        try {
          controls = Array.from(document.querySelectorAll(this.cfg.pageFormControlSelector));
        } catch (_) {
          return false;
        }

        const owned = existingSections
          .flatMap(section => section.items || [])
          .map(item => item.element)
          .filter(Boolean);

        controls = this.dedupeInteractiveElements(controls)
          .filter(element => this.isPageFormControlUsable(element))
          .filter(element => !owned.some(owner => owner === element || owner.contains?.(element)));

        const editable = controls.filter(element => {
          const kind = this.getPageFormControlKind(element);
          return ['select', 'checkbox', 'radio', 'range', 'number'].includes(kind);
        });

        if (!editable.length) return false;
        if (editable.length >= 2) return true;

        // One editable control is sufficient when semantic form structure exists.
        const only = editable[0];
        return !!only.closest?.('form, fieldset, [role="form"], .formDialogContent, .settingsContainer, #JellyfinQoLUserSettingsPage');
      }

      scanPageFormSection(
        route,
        existingSections = []
      ) {
        if (!this.isLikelyPageFormSurface(route, existingSections)) {
          return null;
        }

        let candidates = [];

        try {
          candidates =
            Array.from(
              document.querySelectorAll(
                this.cfg.pageFormControlSelector
              )
            );
        } catch (_) {
          return null;
        }

        const ownedElements =
          existingSections
            .flatMap(section =>
              section.items || []
            )
            .map(item =>
              item.element
            )
            .filter(Boolean);

        const controls =
          this.dedupeInteractiveElements(
            candidates
          )
            .filter(element =>
              this.isPageFormControlUsable(
                element
              )
            )
            .filter(element =>
              !ownedElements.some(
                owner =>
                  owner === element ||
                  owner.contains?.(element)
              )
            );

        if (!controls.length) {
          return null;
        }

        // The profile/preferences landing surface also lives under a
        // #/mypreferences... route, but it is a navigation/menu surface rather
        // than a settings FORM. In Phase 10.1a the synthetic form section could
        // therefore contain only plugin-added buttons (for example QoL/theme
        // buttons) and steal geometry from the already-working settings menu.
        //
        // Only create the synthetic page-form section when at least one actual
        // editable form control exists. Once the form is confirmed, action
        // buttons such as Save are still included in the same section.
        const hasEditableControl =
          controls.some(element => {
            const kind =
              this.getPageFormControlKind(
                element
              );

            return (
              kind === 'select' ||
              kind === 'checkbox' ||
              kind === 'radio' ||
              kind === 'range' ||
              kind === 'number'
            );
          });

        if (!hasEditableControl) {
          return null;
        }

        controls.sort((a, b) => {
          const ar =
            a.getBoundingClientRect();
          const br =
            b.getBoundingClientRect();

          if (
            Math.abs(
              ar.top - br.top
            ) > 4
          ) {
            return ar.top - br.top;
          }

          return ar.left - br.left;
        });

        const sectionId =
          `section:page-form:${this.hashString(
            String(route || 'settings')
          )}`;

        const items =
          controls
            .map((element, index) =>
              this.buildPageFormItem(
                element,
                sectionId,
                index
              )
            )
            .filter(Boolean);

        this.ensureUniqueItemKeys(
          items
        );

        if (!items.length) {
          return null;
        }

        const root =
          this.findPageFormRoot(
            controls
          );

        return {
          id:
            sectionId,
          type:
            'form',
          title:
            'Settings',
          element:
            root,
          rect:
            root
              ? this.rectSnapshot(root)
              : this.unionItemRects(items),
          visible:
            true,
          order:
            existingSections.length,
          scroll: {
            horizontal: false,
            vertical: true,
            container: null,
            viewportRect: null,
            virtualized: false,
            mode: 'document',
            contentElement:
              root || null
          },
          items,
          metadata: {
            source:
              'page-form-controls',
            selectorHint:
              root
                ? this.selectorHint(root)
                : 'page-form',
            virtualized: false,
            scrollMode:
              'document',
            visualRows:
              this.countVisualRows(
                controls
              ),
            contentElement:
              root || null
          }
        };
      }

      isPageFormControlUsable(
        element
      ) {
        if (
          !element?.isConnected ||
          !this.isRendered(element) ||
          this.isDisabled(element)
        ) {
          return false;
        }

        if (
          this.cfg
            .pageFormExcludedAncestorSelector &&
          element.closest?.(
            this.cfg
              .pageFormExcludedAncestorSelector
          )
        ) {
          return false;
        }

        const rect =
          element.getBoundingClientRect();

        // Keep vertically off-screen controls so long settings pages remain
        // navigable, but reject controls parked horizontally in a closed drawer.
        if (
          rect.right <= 0 ||
          rect.left >= window.innerWidth
        ) {
          return false;
        }

        return true;
      }

      buildPageFormItem(
        element,
        sectionId,
        index
      ) {
        if (!element) return null;

        const stable =
          this.makeElementStableKey(
            element,
            sectionId,
            index,
            element
          );

        const rect =
          this.rectSnapshot(
            element
          );

        if (!rect) return null;

        const kind =
          this.getPageFormControlKind(
            element
          );

        const title =
          this.getPageFormControlTitle(
            element
          ) ||
          this.getElementTitle(
            element,
            element
          ) ||
          stable.id ||
          stable.key;

        return {
          key:
            stable.key,
          id:
            stable.id,
          type:
            'form-control',
          title,
          element,
          activationTarget:
            element,
          sectionId,
          rect,
          state: {
            visible:
              true,
            enabled:
              !this.isDisabled(element),
            focusable:
              this.isFocusable(element),
            clickable:
              this.isClickable(element),
            checked:
              (
                kind === 'checkbox' ||
                kind === 'radio'
              )
                ? !!element.checked
                : null,
            selectedByJellyfin:
              false
          },
          actions: [],
          metadata: {
            href:
              this.getHref(element),
            itemIdSource:
              stable.source,
            entityKey:
              stable.entityKey || null,
            domIndex:
              index,
            inViewport:
              this.rectIntersectsViewport(
                rect
              ),
            pageFormControl:
              true,
            pageFormControlKind:
              kind,
            value:
              'value' in element
                ? element.value
                : null
          }
        };
      }

      getPageFormControlKind(
        element
      ) {
        if (!element?.matches) {
          return 'action';
        }

        if (
          element.matches(
            'input[type="checkbox"]'
          )
        ) {
          return 'checkbox';
        }

        if (
          element.matches(
            'input[type="radio"]'
          )
        ) {
          return 'radio';
        }

        if (
          element.matches(
            'input[type="range"]'
          )
        ) {
          return 'range';
        }

        if (
          element.matches(
            'input[type="number"]'
          )
        ) {
          return 'number';
        }

        if (
          element.matches(
            'select'
          )
        ) {
          return 'select';
        }

        if (
          element.matches(
            'button, [role="button"]'
          )
        ) {
          return 'action';
        }

        return 'control';
      }

      getPageFormControlTitle(
        element
      ) {
        if (!element) return null;

        const direct =
          this.cleanText(
            element.getAttribute?.(
              'aria-label'
            ) ||
            element.getAttribute?.(
              'title'
            ) ||
            element.getAttribute?.(
              'data-title'
            )
          );

        if (direct) {
          return direct;
        }

        if (element.id) {
          try {
            const escaped =
              window.CSS?.escape
                ? CSS.escape(
                    element.id
                  )
                : element.id;

            const label =
              document.querySelector(
                `label[for="${escaped}"]`
              );

            const labelText =
              this.cleanText(
                label?.textContent
              );

            if (labelText) {
              return labelText;
            }
          } catch (_) {}
        }

        const wrappingLabel =
          element.closest?.('label');

        const wrappingText =
          this.cleanText(
            wrappingLabel?.textContent
          );

        if (wrappingText) {
          return wrappingText;
        }

        const container =
          element.closest?.(
            [
              '.selectContainer',
              '.inputContainer',
              '.checkboxContainer',
              '.sliderContainer',
              '.form-group'
            ].join(', ')
          );

        if (container) {
          const label =
            container.querySelector(
              [
                'label',
                '.label',
                '.inputLabel',
                '.selectLabel'
              ].join(', ')
            );

          const labelText =
            this.cleanText(
              label?.textContent
            );

          if (labelText) {
            return labelText;
          }
        }

        if (
          element.matches?.(
            'button'
          )
        ) {
          return this.cleanText(
            element.textContent
          );
        }

        return null;
      }

      findPageFormRoot(
        controls
      ) {
        const forms =
          controls
            .map(element =>
              element.closest?.(
                'form'
              ) || null
            )
            .filter(Boolean);

        if (
          forms.length &&
          forms.every(
            form =>
              form === forms[0]
          )
        ) {
          return forms[0];
        }

        const first =
          controls[0];

        return (
          first?.closest?.(
            '.page, [data-role="page"], .view'
          ) ||
          first?.parentElement ||
          null
        );
      }

      unionItemRects(
        items
      ) {
        const rects =
          (items || [])
            .map(item =>
              item.rect
            )
            .filter(Boolean);

        if (!rects.length) {
          return null;
        }

        const left =
          Math.min(
            ...rects.map(rect =>
              rect.left
            )
          );
        const top =
          Math.min(
            ...rects.map(rect =>
              rect.top
            )
          );
        const right =
          Math.max(
            ...rects.map(rect =>
              rect.right
            )
          );
        const bottom =
          Math.max(
            ...rects.map(rect =>
              rect.bottom
            )
          );

        return {
          left,
          top,
          right,
          bottom,
          width:
            right - left,
          height:
            bottom - top,
          centerX:
            left +
            (right - left) / 2,
          centerY:
            top +
            (bottom - top) / 2
        };
      }

      scanActiveOverlay() {
        // Real dialogs/action sheets always outrank the persistent hamburger
        // drawer. Example: selecting "Enhanced Panel" from the drawer can open
        // the JE modal before Jellyfin has finished sliding the drawer away.
        return (
          this.scanModal() ||
          this.scanMainDrawer()
        );
      }

      scanMainDrawer() {
        const drawer =
          document.querySelector(
            this.cfg.mainDrawerSelector
          );

        if (
          !drawer?.isConnected ||
          !this.isRendered(drawer)
        ) {
          return null;
        }

        const rect =
          this.rectSnapshot(drawer);

        if (!rect) return null;

        // Closed Jellyfin drawer in the supplied DOM:
        //   width:320px; left:-320px
        // It remains display:block with real dimensions, so isRendered() alone
        // is insufficient. Require actual horizontal viewport overlap.
        const visibleLeft =
          Math.max(
            0,
            rect.left
          );

        const visibleRight =
          Math.min(
            window.innerWidth,
            rect.right
          );

        const visibleWidth =
          Math.max(
            0,
            visibleRight -
              visibleLeft
          );

        const minimumVisible =
          Math.max(
            1,
            Number(
              this.cfg
                .mainDrawerMinimumVisiblePx
            ) || 24
          );

        if (
          visibleWidth <
            minimumVisible
        ) {
          return null;
        }

        const scrollRoot =
          drawer.querySelector(
            this.cfg
              .mainDrawerScrollSelector
          ) ||
          drawer;

        const elements =
          Array.from(
            scrollRoot.querySelectorAll(
              this.cfg
                .mainDrawerItemSelector
            )
          )
            .filter(element =>
              this.isRendered(element) &&
              !this.isDisabled(element) &&
              element.getAttribute?.(
                'aria-hidden'
              ) !== 'true'
            );

        if (!elements.length) {
          return null;
        }

        const modalId =
          'drawer:main-navigation';

        const items =
          elements
            .map((element, index) => {
              const item =
                this.buildModalItem(
                  element,
                  modalId,
                  index
                );

              if (!item) return null;

              // navMenuOption contains Material icon text as well as its
              // visible label. Use Jellyfin's dedicated text node so AirNav's
              // diagnostics/focus label reads "Movies", not "movieMovies".
              const label =
                this.cleanText(
                  element.querySelector(
                    '.navMenuOptionText, .sectionName, .sidebarLinkText'
                  )?.textContent ||
                  element.getAttribute?.(
                    'aria-label'
                  ) ||
                  element.getAttribute?.(
                    'title'
                  ) ||
                  item.title
                );

              if (label) {
                item.title = label;
              }

              item.type =
                'navigation';

              item.metadata = {
                ...(item.metadata || {}),
                drawerControl: true,
                modalControl: true,
                modalControlKind:
                  'action',
                href:
                  this.getHref(element),
                dataItemId:
                  element.getAttribute?.(
                    'data-itemid'
                  ) ||
                  null
              };

              return item;
            })
            .filter(Boolean)
            .sort((a, b) =>
              a.rect.top - b.rect.top ||
              a.rect.left - b.rect.left
            );

        if (!items.length) {
          return null;
        }

        this.ensureUniqueItemKeys(
          items
        );

        // One vertical section is intentional. ModalNavigation already scores
        // UP/DOWN geometrically and its reveal logic scrolls the nearest
        // scrollable ancestor, which here is .mainDrawer-scrollContainer.
        const section = {
          id:
            'drawer:main-navigation:items',
          type:
            'modal',
          title:
            'Navigation Menu',
          element:
            scrollRoot,
          rect:
            this.rectSnapshot(
              scrollRoot
            ) ||
            rect,
          visible: true,
          order: 0,
          scroll: {
            horizontal: false,
            vertical: true,
            container:
              scrollRoot,
            viewportRect:
              this.rectSnapshot(
                scrollRoot
              ),
            mode:
              'native',
            contentElement:
              scrollRoot
          },
          items,
          metadata: {
            role:
              'drawer-navigation',
            source:
              'jellyfin-main-drawer'
          }
        };

        const selected =
          items.find(item =>
            item.state
              ?.selectedByJellyfin ===
              true ||
            item.element
              ?.matches?.(
                '.selected, .active, [aria-current="page"]'
              )
          ) ||
          null;

        const home =
          items.find(item =>
            /^#\/home(?:\?|$)/i
              .test(
                String(
                  item.metadata
                    ?.href ||
                  ''
                )
              )
          ) ||
          null;

        const closeAction =
          Array.from(
            document.querySelectorAll(
              this.cfg
                .mainDrawerToggleSelector
            )
          )
            .find(element =>
              this.isRendered(element) &&
              !this.isDisabled(element)
            ) ||
          null;

        return {
          id:
            modalId,
          type:
            'drawer',
          root:
            drawer,
          sections: [section],
          defaultItemKey:
            selected?.key ||
            home?.key ||
            items[0]?.key ||
            null,

          // BACK reuses existing ModalNavigation requestClose() without adding
          // Jellyfin selectors to Controller/ModalNavigation.
          closeAction,
          closeActionKey: null,
          dismissTarget: null,
          dismissMode: null,
          parentReturnState: null,

          metadata: {
            surfaceType:
              'main-drawer',
            verticalMenu: true,
            itemCount:
              items.length,
            scrollContainer:
              scrollRoot
          }
        };
      }

      isPassiveOverlay(element) {
        if (!element) return true;
        try {
          return !!(
            this.cfg.passiveOverlaySelector &&
            element.matches?.(this.cfg.passiveOverlaySelector)
          );
        } catch (_) {
          return false;
        }
      }

      discoverGenericOverlayRoots() {
        const result = [];
        const seen = new Set();
        let candidates = [];

        try {
          candidates.push(...document.querySelectorAll(this.cfg.genericOverlaySelector));
        } catch (_) {}

        // Some plugins expose no ARIA/modal semantics. Inspect a bounded set of
        // fixed/high-stacking containers containing interactive descendants.
        try {
          const all = document.querySelectorAll(
            'body > div, body > section, body > aside, [style*="position: fixed"], [style*="position:fixed"]'
          );
          let inspected = 0;
          for (const element of all) {
            if (++inspected > 1400 || candidates.length >= 800) break;
            let style;
            try { style = getComputedStyle(element); } catch (_) { continue; }
            if (!['fixed', 'absolute'].includes(style.position)) continue;
            const z = Number.parseInt(style.zIndex, 10) || 0;
            if (z < Number(this.cfg.genericOverlayMinimumZIndex || 100)) continue;
            candidates.push(element);
          }
        } catch (_) {}

        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const minArea = Math.max(0, Number(this.cfg.genericOverlayMinimumAreaRatio) || 0.08);
        const minInteractive = Math.max(0, Number(this.cfg.genericOverlayMinimumInteractiveCount) || 1);

        for (const element of candidates) {
          if (!element?.isConnected || seen.has(element) || this.isPassiveOverlay(element)) continue;
          seen.add(element);
          if (!this.isRendered(element)) continue;
          if (element.closest?.('.skinHeader, .mainDrawer') && !element.matches?.('[role="dialog"], [aria-modal="true"]')) continue;
          if (element.closest?.('.videoPlayerContainer') && !element.matches?.('[role="dialog"], [aria-modal="true"], .dialog, .actionSheet')) continue;

          const rect = element.getBoundingClientRect();
          const intersectionWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
          const intersectionHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          const areaRatio = (intersectionWidth * intersectionHeight) / viewportArea;

          const explicitModal = element.matches?.('[role="dialog"], [aria-modal="true"], [data-role="dialog"]');
          if (!explicitModal && areaRatio < minArea) continue;

          let interactiveCount = 0;
          try {
            interactiveCount = this.dedupeInteractiveElements(
              Array.from(element.querySelectorAll(this.cfg.genericInteractiveSelector))
            ).filter(control => this.isRendered(control) && !this.isDisabled(control)).length;
          } catch (_) {}

          if (!explicitModal && interactiveCount < minInteractive) continue;
          if (explicitModal && interactiveCount < 1 && !element.querySelector?.(this.cfg.modalCloseSelector)) {
            // Keep explicit empty shells only when they visibly block the page;
            // this preserves BACK ownership for loading dialogs.
            if (areaRatio < 0.35) continue;
          }

          result.push(element);
        }

        // If both a full-screen overlay wrapper and its modal child qualify,
        // prefer the descendant that actually owns the interactive controls,
        // unless the ancestor is an explicit aria-modal dialog itself.
        return result.filter(element => !result.some(other => {
          if (other === element || !element.contains(other)) return false;
          const elementExplicit = element.matches?.('[role="dialog"], [aria-modal="true"]');
          const otherExplicit = other.matches?.('[role="dialog"], [aria-modal="true"]');
          return !elementExplicit || otherExplicit;
        }));
      }

      scanModal() {
        let candidates = [];
        try {
          candidates = Array.from(document.querySelectorAll(this.cfg.modalSelector));
        } catch (_) {}

        candidates.push(...this.discoverGenericOverlayRoots());
        candidates = this.dedupeElements(candidates)
          .filter(element => !this.isPassiveOverlay(element));

        // Generic overlay discovery may add an outer shell after a more
        // specific modal descendant already matched modalSelector. Prefer the
        // rendered descendant that actually owns the controls. Keep an
        // explicit aria-modal ancestor unless the descendant is explicit too.
        // This is especially important for Jellyfin's native action sheets:
        // .dialogContainer is only an overlay shell, while its .actionSheet
        // child owns the actionable menu buttons.
        const matchedModalRoots =
          candidates.filter(element =>
            element?.matches?.(
              this.cfg.modalSelector
            )
          );

        candidates =
          candidates.filter(element =>
            !matchedModalRoots.some(other => {
              if (
                other === element ||
                !element.contains?.(other) ||
                !this.isRendered(other)
              ) {
                return false;
              }

              const elementExplicit =
                element.matches?.(
                  '[role="dialog"], [aria-modal="true"]'
                );

              const otherExplicit =
                other.matches?.(
                  '[role="dialog"], [aria-modal="true"]'
                );

              return (
                !elementExplicit ||
                otherExplicit
              );
            })
          );

        // Prefer the topmost visible modal when several dialog shells remain
        // mounted underneath it. z-index is used as a hint, then DOM order.
        const rendered =
          candidates
            .filter(
              element =>
                this.isRendered(element)
            )
            .map((element, index) => ({
              element,
              index,
              zIndex:
                Number.parseInt(
                  getComputedStyle(element).zIndex,
                  10
                ) || 0
            }))
            .sort((a, b) =>
              b.zIndex - a.zIndex ||
              b.index - a.index
            );

        const root =
          rendered[0]?.element || null;

        if (!root) return null;

        const title =
          this.getModalTitle(root) ||
          'Modal';

        const modalIdentity =
          this.getModalIdentity(
            root,
            title
          );

        const modalId =
          `modal:${modalIdentity}`;

        const closeAction =
          root.querySelector(
            this.cfg.modalCloseSelector
          ) || null;

        const primary =
          root.querySelector(
            this.cfg.modalPrimaryActionSelector
          ) || null;

        // Native Jellyfin action sheets intentionally dismiss when the user
        // clicks outside the .actionSheet. Scanner exposes the appropriate
        // outside target so ModalNavigation does not need Jellyfin selectors.
        const dismissTarget =
          this.findModalDismissTarget(
            root
          );

        const elements =
          this.dedupeInteractiveElements(
            Array.from(
              root.querySelectorAll(
                this.cfg.modalItemSelector
              )
            )
          )
            .filter(
              element =>
                this.isModalControlUsable(
                  element,
                  root
                )
            );

        let items =
          elements
            .map((element, index) =>
              this.buildModalItem(
                element,
                modalId,
                index
              )
            )
            .filter(Boolean);

        // Jellyfin Enhanced settings use visual setting cards that may contain
        // one or several interactive controls. At the outer modal level expose
        // one logical group item per card and keep its controls as children.
        // Other modals are left untouched.
        const settingGroups =
          this.buildModalSettingGroups(
            root,
            modalId,
            items
          );

        if (settingGroups?.length) {
          const groupedElements =
            new Set(
              settingGroups.flatMap(
                group =>
                  (group.controls || [])
                    .map(control =>
                      control.element
                    )
                    .filter(Boolean)
              )
            );

          const ungrouped =
            items.filter(item =>
              !groupedElements.has(
                item.element
              )
            );

          items = [
            ...ungrouped,
            ...settingGroups
          ];

          this.ensureUniqueItemKeys([
            ...items,
            ...settingGroups.flatMap(
              group =>
                group.controls || []
            )
          ]);
        } else {
          this.ensureUniqueItemKeys(items);
        }

        const rootRect =
          this.rectSnapshot(root);

        const sections =
          this.groupModalItemsIntoSections(
            items,
            {
              modalId,
              root,
              rootRect,
              closeAction,
              primary
            }
          );

        const flatItems =
          sections.flatMap(
            section =>
              section.items || []
          );

        const primaryItem =
          flatItems.find(
            item =>
              item.element === primary
          ) || null;

        const closeItem =
          flatItems.find(
            item =>
              item.element === closeAction
          ) || null;

        const firstNonClose =
          flatItems.find(
            item =>
              item.element !== closeAction &&
              item.state?.enabled !== false
          ) || null;

        return {
          id: modalId,
          type: 'modal',
          root,
          sections,
          defaultItemKey:
            primaryItem?.key ||
            firstNonClose?.key ||
            closeItem?.key ||
            flatItems[0]?.key ||
            null,
          closeAction,
          closeActionKey:
            closeItem?.key || null,

          // Optional semantic dismissal surface. For native Jellyfin
          // .actionSheet this is the rendered ancestor that receives an
          // outside click. ModalNavigation may dispatch a synthetic primary
          // click here when BACK has no explicit closeAction.
          dismissTarget:
            dismissTarget?.element || null,
          dismissMode:
            dismissTarget?.mode || null,

          // Runtime/controller layer supplies this because Scanner deliberately
          // has no dependency on FocusManager selection state.
          parentReturnState: null,

          metadata: {
            phase: 9,
            title,
            detectedBy:
              this.selectorHint(root),
            rootRect,
            controlCount:
              flatItems.length,
            settingGroupCount:
              settingGroups?.length || 0,
            groupedControlCount:
              settingGroups
                ?.reduce(
                  (sum, group) =>
                    sum +
                    (group.controls?.length || 0),
                  0
                ) || 0,
            sectionCount:
              sections.length,
            dismissMode:
              dismissTarget?.mode || null,
            dismissTarget:
              dismissTarget?.element
                ? this.selectorHint(
                    dismissTarget.element
                  )
                : null,

            // ModalNavigation does not know Jellyfin Enhanced selectors. It
            // only consumes this neutral hint and may emit harmless pointer
            // movement while canonical AirNav input is active so plugin-owned
            // inactivity timers still observe user activity.
            modalFamily:
              root.matches?.(
                '#jellyfin-enhanced-panel'
              )
                ? 'settings-panel'
                : null,
            activityHint:
              root.matches?.(
                '#jellyfin-enhanced-panel'
              )
                ? 'pointer-move'
                : null,
            activePaneKey:
              root.matches?.(
                '#jellyfin-enhanced-panel'
              )
                ? (
                    root.querySelector(
                      '.je-pane.active[data-pane]'
                    )?.getAttribute(
                      'data-pane'
                    ) ||
                    null
                  )
                : null
          }
        };
      }

      findModalDismissTarget(root) {
        if (
          !root?.isConnected ||
          !root.matches?.(
            '.actionSheet'
          )
        ) {
          return null;
        }

        // Jellyfin's native action sheet is dismissed by clicking outside the
        // sheet itself. Event listeners may live on an ancestor or document.
        // Dispatching to a rendered ancestor makes event.target explicitly
        // outside the .actionSheet while keeping the synthetic click inside the
        // modal's own overlay tree instead of hitting the page underneath.
        let ancestor =
          root.parentElement;

        let firstRendered =
          null;

        const rootRect =
          root.getBoundingClientRect();

        while (
          ancestor &&
          ancestor !== document.body &&
          ancestor !== document.documentElement
        ) {
          if (this.isRendered(ancestor)) {
            if (!firstRendered) {
              firstRendered =
                ancestor;
            }

            const rect =
              ancestor.getBoundingClientRect();

            const materiallyLarger =
              rect.width >
                rootRect.width + 8 ||
              rect.height >
                rootRect.height + 8;

            if (materiallyLarger) {
              return {
                mode:
                  'outside-click',
                element:
                  ancestor
              };
            }
          }

          ancestor =
            ancestor.parentElement;
        }

        // Even a same-size wrapper is useful: the event target is still
        // outside root, which is what document-level outside-click handlers
        // normally test.
        if (firstRendered) {
          return {
            mode:
              'outside-click',
            element:
              firstRendered
          };
        }

        return null;
      }

      buildModalSettingGroups(
        root,
        modalId,
        leafItems
      ) {
        if (
          !root?.matches?.(
            '#jellyfin-enhanced-panel'
          ) ||
          !Array.isArray(leafItems) ||
          !leafItems.length
        ) {
          return [];
        }

        const pane =
          root.querySelector(
            this.cfg
              .modalSettingGroupRootSelector
          );

        if (!pane) {
          return [];
        }

        let contentRoot = null;

        try {
          const direct =
            Array.from(
              pane.querySelectorAll(
                this.cfg
                  .modalSettingGroupContentSelector
              )
            );

          contentRoot =
            direct.find(candidate =>
              Array.from(
                candidate.children || []
              ).some(child =>
                leafItems.some(item =>
                  child.contains?.(
                    item.element
                  )
                )
              )
            ) || null;
        } catch (_) {}

        if (!contentRoot) {
          return [];
        }

        const paneKey =
          this.cleanText(
            pane.getAttribute?.(
              'data-pane'
            )
          ) ||
          this.hashString(
            this.cleanText(
              pane.textContent
            ).slice(0, 120)
          );

        const groupElements =
          Array.from(
            contentRoot.children || []
          )
            .filter(element =>
              element?.nodeType === 1 &&
              this.isRendered(element)
            );

        const groups = [];

        groupElements.forEach(
          (groupElement, index) => {
            const controls =
              leafItems.filter(item =>
                groupElement.contains?.(
                  item.element
                )
              );

            if (!controls.length) {
              return;
            }

            const rect =
              this.rectSnapshot(
                groupElement
              );

            if (!rect) {
              return;
            }

            const title =
              this.getModalSettingGroupTitle(
                groupElement,
                controls,
                index
              );

            const firstStrongId =
              controls.find(
                control =>
                  control.id
              )?.id ||
              controls[0]?.metadata
                ?.entityKey ||
              '';

            const entityKey =
              `modal-setting-group:${this.hashString(
                [
                  paneKey,
                  title || '',
                  firstStrongId || '',
                  index
                ].join('|')
              )}`;

            const key =
              `${modalId}::${entityKey}`;

            controls.forEach(
              control => {
                control.metadata = {
                  ...(control.metadata || {}),
                  parentGroupKey:
                    key,
                  parentGroupTitle:
                    title,
                  modalGroupedControl:
                    true
                };
              }
            );

            groups.push({
              key,
              id: null,
              type:
                'setting-group',
              title,
              element:
                groupElement,
              activationTarget:
                groupElement,
              sectionId:
                null,
              rect,
              state: {
                visible: true,
                enabled: true,
                focusable: false,
                clickable: true,
                selectedByJellyfin:
                  false
              },
              actions: [],
              controls,
              metadata: {
                href: null,
                itemIdSource:
                  'modal-setting-group',
                entityKey,
                domIndex:
                  index,
                inViewport:
                  this.rectIntersectsViewport(
                    rect
                  ),
                modalControl:
                  true,
                modalControlKind:
                  'group',
                modalSettingGroup:
                  true,
                modalGroupPane:
                  paneKey,
                modalGroupControlCount:
                  controls.length
              }
            });
          }
        );

        return groups;
      }

      getModalSettingGroupTitle(
        groupElement,
        controls,
        index
      ) {
        if (!groupElement) {
          return `Setting ${index + 1}`;
        }

        const checkboxTitle =
          groupElement.querySelector(
            'label > div > div:first-child, label > div > div > div:first-child'
          );

        const checkboxText =
          this.cleanText(
            checkboxTitle?.textContent
          );

        if (checkboxText) {
          return checkboxText;
        }

        const headingCandidates =
          Array.from(
            groupElement.querySelectorAll(
              'h3, h4, strong, [style*="font-weight: 600"], [style*="font-weight:600"]'
            )
          );

        const heading =
          headingCandidates
            .map(element =>
              this.cleanText(
                element.textContent
              )
            )
            .find(text =>
              text &&
              text.length <= 80
            );

        if (heading) {
          return heading;
        }

        const ids =
          (controls || [])
            .map(control =>
              control.id || ''
            )
            .filter(Boolean);

        if (
          ids.some(id =>
            id.startsWith(
              'customSubtitle'
            )
          )
        ) {
          return 'Subtitle Colors';
        }

        const firstControlTitle =
          this.cleanText(
            controls?.[0]?.title
          );

        if (
          firstControlTitle &&
          !firstControlTitle.startsWith(
            'modal:'
          )
        ) {
          return firstControlTitle;
        }

        return `Setting ${index + 1}`;
      }

      isModalControlUsable(
        element,
        root
      ) {
        if (
          !element?.isConnected ||
          !root?.contains(element)
        ) {
          return false;
        }

        if (!this.isRendered(element)) {
          return false;
        }

        if (
          this.isDisabled(element) ||
          element.getAttribute?.(
            'aria-hidden'
          ) === 'true'
        ) {
          return false;
        }

        // Ignore controls inside a nested visible dialog. That child modal will
        // be selected as the active root by scanModal() itself.
        const nestedModal =
          element.closest(
            this.cfg.modalSelector
          );

        if (
          nestedModal &&
          nestedModal !== root
        ) {
          return false;
        }

        return true;
      }

      buildModalItem(
        element,
        modalId,
        index
      ) {
        if (!element) return null;

        const fallbackStable =
          this.makeElementStableKey(
            element,
            modalId,
            index,
            element
          );

        const rect =
          this.rectSnapshot(element);

        if (!rect) return null;

        const controlKind =
          this.getModalControlKind(
            element
          );

        const semanticContext =
          this.getModalSemanticContext(
            element
          );

        const title =
          this.getModalFormControlTitle(
            element
          ) ||
          this.getElementTitle(
            element,
            element
          ) ||
          fallbackStable.id ||
          fallbackStable.key;

        // Collection movie checkboxes usually have unique DOM ids, but
        // Jellyseerr season checkboxes can be visually distinct controls with
        // the same class and no useful element id. The generic control key
        // builder then collapses several season toggles onto the same semantic
        // key. ModalNavigation correctly moves to the next DOM node, but the
        // next scanner rebind resolves that duplicate key back to the first
        // checkbox. Build a modal-specific semantic identity from row title /
        // season metadata before falling back to the generic key.
        const stable =
          this.makeModalControlStableKey(
            element,
            modalId,
            index,
            controlKind,
            title,
            fallbackStable
          );

        return {
          key: stable.key,
          id: stable.id,
          type: 'action',
          title,
          element,
          activationTarget: element,
          sectionId: null,
          rect,
          state: {
            visible: true,
            enabled:
              !this.isDisabled(element),
            focusable:
              this.isFocusable(element),
            clickable:
              this.isClickable(element),
            selectedByJellyfin:
              element.matches?.(
                '.selected, .emby-button-show-focus, [aria-selected=\"true\"]'
              ) || false
          },
          actions: [],
          metadata: {
            href:
              this.getHref(element),
            itemIdSource:
              stable.source,
            entityKey:
              stable.entityKey || null,
            domIndex: index,
            inViewport:
              this.rectIntersectsViewport(rect),
            modalControl: true,
            modalControlKind:
              controlKind,
            modalControlLane:
              this.getModalControlLane(
                element,
                controlKind
              ),
            modalSemanticType:
              semanticContext?.type ||
              null,
            modalSemanticToken:
              semanticContext?.token ||
              null,
            modalPaneKey:
              semanticContext?.type ===
                'settings-tab'
                ? this.cleanText(
                    element.getAttribute?.(
                      'data-tab'
                    )
                  )
                : null,
            modalGridSettingKey:
              controlKind ===
                'position-grid'
                ? this.cleanText(
                    element.getAttribute?.(
                      'data-setting'
                    )
                  )
                : null
          }
        };
      }

      scanModalPositionGrid(
        itemKey
      ) {
        if (!itemKey) {
          return {
            handled: false,
            reason:
              'modal-position-grid-key-required'
          };
        }

        const modal =
          this.model?.modal ||
          null;

        if (!modal) {
          return {
            handled: false,
            reason:
              'modal-position-grid-no-modal'
          };
        }

        let item = null;

        for (
          const section of
          modal.sections || []
        ) {
          for (
            const candidate of
            section.items || []
          ) {
            if (
              candidate.key === itemKey
            ) {
              item = candidate;
              break;
            }

            for (
              const control of
              candidate.controls || []
            ) {
              if (
                control.key ===
                  itemKey
              ) {
                item = control;
                break;
              }
            }

            if (item) break;
          }

          if (item) break;
        }

        if (
          !item ||
          item.metadata
            ?.modalControlKind !==
            'position-grid'
        ) {
          return {
            handled: false,
            reason:
              'modal-position-grid-item-not-found',
            itemKey
          };
        }

        const root =
          item.element ||
          null;

        if (
          !root?.isConnected
        ) {
          return {
            handled: false,
            reason:
              'modal-position-grid-root-missing',
            itemKey
          };
        }

        // Jellyfin Enhanced currently exposes the four logical positions as
        // direct child DIVs with data-pos. Scanner owns that plugin-specific
        // DOM knowledge; ModalNavigation receives only neutral cell objects.
        const elements =
          Array.from(
            root.children || []
          )
            .filter(element =>
              element?.hasAttribute?.(
                'data-pos'
              )
            )
            .filter(element =>
              this.isRendered(
                element
              )
            );

        if (!elements.length) {
          return {
            handled: false,
            reason:
              'modal-position-grid-no-cells',
            itemKey
          };
        }

        const prettyPosition =
          value =>
            String(value || '')
              .split('-')
              .filter(Boolean)
              .map(part =>
                part.charAt(0)
                  .toUpperCase() +
                part.slice(1)
              )
              .join(' ');

        const alphaOf =
          color => {
            const value =
              String(color || '')
                .trim();

            const rgba =
              value.match(
                /^rgba?\(([^)]+)\)$/i
              );

            if (!rgba) {
              return 0;
            }

            const parts =
              rgba[1]
                .split(',')
                .map(part =>
                  part.trim()
                );

            if (
              /^rgba/i.test(value)
            ) {
              const alpha =
                Number(
                  parts[3]
                );

              return Number.isFinite(
                alpha
              )
                ? alpha
                : 0;
            }

            return 1;
          };

        const cells =
          elements.map(
            (element, index) => {
              const value =
                this.cleanText(
                  element.getAttribute(
                    'data-pos'
                  )
                ) ||
                `cell-${index}`;

              const rect =
                this.rectSnapshot(
                  element
                );

              let selected =
                element.matches?.(
                  '.selected, .active, [aria-selected="true"]'
                ) ||
                false;

              let backgroundAlpha =
                0;

              try {
                backgroundAlpha =
                  alphaOf(
                    getComputedStyle(
                      element
                    ).backgroundColor
                  );
              } catch (_) {}

              return {
                key:
                  `${item.key}::grid:${value}`,
                id: null,
                type:
                  'position-grid-cell',
                title:
                  prettyPosition(
                    value
                  ),
                value,
                element,
                activationTarget:
                  element,
                sectionId:
                  item.sectionId ||
                  null,
                rect,
                state: {
                  visible:
                    !!rect,
                  enabled: true,
                  focusable: false,
                  clickable: true,
                  selectedByJellyfin:
                    selected
                },
                actions: [],
                metadata: {
                  modalControl:
                    true,
                  modalGridCell:
                    true,
                  modalGridPosition:
                    value,
                  parentControlKey:
                    item.key,
                  backgroundAlpha
                }
              };
            }
          )
            .filter(cell =>
              !!cell.rect
            );

        if (!cells.length) {
          return {
            handled: false,
            reason:
              'modal-position-grid-cells-not-rendered',
            itemKey
          };
        }

        let selectedCell =
          cells.find(cell =>
            cell.state
              ?.selectedByJellyfin ===
              true
          ) ||
          null;

        // JE's active cell is currently fully opaque while inactive cells use
        // a translucent background. Use that visual state as a fallback
        // without hard-coding the theme's purple RGB value.
        if (!selectedCell) {
          const ranked =
            cells
              .slice()
              .sort(
                (a, b) =>
                  Number(
                    b.metadata
                      ?.backgroundAlpha ||
                    0
                  ) -
                  Number(
                    a.metadata
                      ?.backgroundAlpha ||
                    0
                  )
              );

          if (
            ranked.length &&
            Number(
              ranked[0]
                .metadata
                ?.backgroundAlpha ||
              0
            ) >
              Number(
                ranked[1]
                  ?.metadata
                  ?.backgroundAlpha ||
                0
              ) + 0.15
          ) {
            selectedCell =
              ranked[0];
          }
        }

        selectedCell =
          selectedCell ||
          cells[0];

        return {
          handled: true,
          reason:
            'modal-position-grid-scanned',
          itemKey:
            item.key,
          title:
            item.title || null,
          settingKey:
            item.metadata
              ?.modalGridSettingKey ||
            null,
          rows: 2,
          columns: 2,
          selectedCellKey:
            selectedCell?.key ||
            null,
          selectedValue:
            selectedCell?.value ||
            null,
          cells
        };
      }

      makeModalControlStableKey(
        element,
        modalId,
        index,
        controlKind,
        title,
        fallbackStable
      ) {
        if (!element) {
          return fallbackStable;
        }

        // A real DOM id is already the strongest possible identity and is what
        // makes collection movie toggles stable today.
        if (
          fallbackStable?.source === 'dom-id' &&
          element.id
        ) {
          return fallbackStable;
        }

        const semanticContext =
          this.getModalSemanticContext(
            element
          );

        const semanticKinds =
          new Set([
            'toggle',
            'select',
            'number',
            'range',
            'position-grid'
          ]);

        if (
          !semanticKinds.has(
            controlKind
          ) &&
          !semanticContext
        ) {
          return fallbackStable;
        }

        const attr = name =>
          this.cleanText(
            element.getAttribute?.(name)
          );

        const semanticParts = [
          controlKind,
          title || '',
          attr('data-season-number') || '',
          attr('data-season') || '',
          attr('data-tmdb-id') || '',
          attr('data-id') || '',
          attr('data-item-id') || '',
          attr('name') || '',
          attr('value') || '',
          attr('aria-label') || '',
          semanticContext?.token || ''
        ];

        // Season rows often keep the useful identity on the row rather than on
        // the checkbox itself.
        const row =
          element.closest?.(
            [
              '.jellyseerr-season-header-row',
              '.jellyseerr-season-item',
              '.jellyseerr-collection-header-row',
              '.jellyseerr-collection-movie-row',
              '.jellyseerr-form-group'
            ].join(', ')
          );

        if (row) {
          semanticParts.push(
            this.cleanText(
              row.getAttribute?.(
                'data-season-number'
              )
            ) || '',
            this.cleanText(
              row.getAttribute?.(
                'data-season'
              )
            ) || '',
            this.cleanText(
              row.getAttribute?.(
                'data-tmdb-id'
              )
            ) || '',
            this.cleanText(
              row.getAttribute?.(
                'data-id'
              )
            ) || ''
          );
        }

        const semantic =
          semanticParts
            .filter(Boolean)
            .join('|');

        if (semantic) {
          const entityKey =
            `modal-${controlKind}:${this.hashString(semantic)}`;

          return {
            key:
              `${modalId}::${entityKey}`,
            entityKey,
            id:
              element.id || null,
            source:
              `modal-${controlKind}-semantic`
          };
        }

        // Last resort: preserve occurrence identity. This is weaker than the
        // semantic path but still prevents multiple anonymous controls in the
        // same rendered modal from sharing one key.
        const entityKey =
          `modal-${controlKind}:index:${index}`;

        return {
          key:
            `${modalId}::${entityKey}`,
          entityKey,
          id:
            element.id || null,
          source:
            `modal-${controlKind}-index`
        };
      }

      getModalSemanticContext(element) {
        if (!element?.closest) {
          return null;
        }

        // Jellyfin Enhanced has several repeated controls without their own
        // IDs (notably the per-category Move up / Move down buttons). The row
        // has the stable semantic identity instead.
        const categoryRow =
          element.closest(
            '.je-quality-cat-row[data-cat-key]'
          );

        if (categoryRow) {
          return {
            type: 'quality-category',
            token:
              `quality-category:${categoryRow.getAttribute('data-cat-key')}`
          };
        }

        const tab =
          element.closest(
            '.tab-button[data-tab]'
          );

        if (tab) {
          return {
            type: 'settings-tab',
            token:
              `settings-tab:${tab.getAttribute('data-tab')}`
          };
        }

        const position =
          element.closest(
            '.position-selector[data-setting]'
          );

        if (position) {
          return {
            type: 'position-selector',
            token:
              `position-selector:${position.getAttribute('data-setting')}`
          };
        }

        const preset =
          element.closest(
            '.preset-box[data-preset-index]'
          );

        if (preset) {
          const family =
            [
              preset.classList?.contains('style-preset')
                ? 'style'
                : '',
              preset.classList?.contains('font-size-preset')
                ? 'font-size'
                : '',
              preset.classList?.contains('font-family-preset')
                ? 'font-family'
                : ''
            ].find(Boolean) || 'preset';

          return {
            type: 'preset',
            token:
              `${family}:${preset.getAttribute('data-preset-index')}`
          };
        }

        return null;
      }

      getModalControlLane(
        element,
        controlKind
      ) {
        if (
          controlKind !== 'toggle' ||
          !element?.closest
        ) {
          return null;
        }

        // The strict toggle lane exists only for the Jellyseerr season/
        // collection request lists. Mixed settings panels frequently place a
        // select/range/number control between checkboxes; treating every modal
        // checkbox as one global lane would skip those intermediate controls.
        if (
          element.closest(
            '.jellyseerr-season-header-row, .jellyseerr-season-item'
          )
        ) {
          return 'jellyseerr-season-toggle-lane';
        }

        if (
          element.closest(
            '.jellyseerr-collection-header-row, .jellyseerr-collection-movie-row'
          )
        ) {
          return 'jellyseerr-collection-toggle-lane';
        }

        return null;
      }

      getModalControlKind(element) {
        if (!element?.matches) {
          return 'action';
        }

        if (
          element.matches(
            'input[type="checkbox"], [role="checkbox"], [role="switch"]'
          )
        ) {
          return 'toggle';
        }

        if (element.matches('select')) {
          return 'select';
        }

        if (
          element.matches(
            'input[type="number"]'
          )
        ) {
          return 'number';
        }

        if (
          element.matches(
            'input[type="range"]'
          )
        ) {
          return 'range';
        }

        if (
          element.matches(
            '.position-selector[data-setting]'
          )
        ) {
          return 'position-grid';
        }

        return 'action';
      }

      getModalFormControlTitle(element) {
        if (!element) return null;

        const kind =
          this.getModalControlKind(element);

        if (
          ![
            'toggle',
            'select',
            'number',
            'range',
            'position-grid'
          ].includes(kind)
        ) {
          return null;
        }

        const direct =
          this.cleanText(
            element.getAttribute?.('aria-label') ||
            element.getAttribute?.('title') ||
            element.getAttribute?.('data-title')
          );

        if (direct) return direct;

        if (element.id) {
          try {
            const escaped =
              window.CSS?.escape
                ? CSS.escape(element.id)
                : element.id;

            const label =
              document.querySelector(
                `label[for="${escaped}"]`
              );

            const labelText =
              this.cleanText(
                label?.textContent
              );

            if (labelText) return labelText;
          } catch (_) {}
        }

        const wrappingLabel =
          element.closest?.('label');

        const wrappingText =
          this.cleanText(
            wrappingLabel?.textContent
          );

        if (wrappingText) return wrappingText;

        // Jellyseerr request dialogs place advanced request selects inside a
        // form group with a visible label (Destination Server, Quality Profile,
        // Root Folder). Scanner owns this DOM interpretation; ModalNavigation
        // consumes only the semantic control item.
        const formGroup =
          element.closest?.(
            '.jellyseerr-form-group'
          );

        if (formGroup) {
          const label =
            formGroup.querySelector(
              'label, .jellyseerr-form-label, .label'
            );

          const labelText =
            this.cleanText(
              label?.textContent
            );

          if (labelText) return labelText;
        }

        // Season / collection switches take their semantic title from their
        // visual row rather than from the native checkbox itself.
        const row =
          element.closest?.(
            [
              '.jellyseerr-season-header-row',
              '.jellyseerr-season-item',
              '.jellyseerr-collection-header-row',
              '.jellyseerr-collection-movie-row'
            ].join(', ')
          );

        if (row) {
          const label =
            row.querySelector(
              [
                '.jellyseerr-season-header-label',
                '.jellyseerr-season-name',
                '.jellyseerr-collection-header-label',
                '.jellyseerr-collection-movie-details .title',
                '.title'
              ].join(', ')
            );

          const labelText =
            this.cleanText(
              label?.textContent
            );

          if (labelText) return labelText;
        }

        return null;
      }

      groupModalItemsIntoSections(
        items,
        context
      ) {
        if (!items?.length) return [];

        const tolerance =
          Math.max(
            8,
            Number(
              this.cfg.modalRowTolerancePx
            ) || 34
          );

        const sorted =
          [...items].sort((a, b) =>
            a.rect.centerY - b.rect.centerY ||
            a.rect.centerX - b.rect.centerX
          );

        const rows = [];

        for (const item of sorted) {
          let row =
            rows.find(candidate =>
              Math.abs(
                candidate.centerY -
                item.rect.centerY
              ) <= tolerance
            );

          if (!row) {
            row = {
              centerY:
                item.rect.centerY,
              items: []
            };
            rows.push(row);
          }

          row.items.push(item);
          row.centerY =
            row.items.reduce(
              (sum, candidate) =>
                sum +
                candidate.rect.centerY,
              0
            ) /
            row.items.length;
        }

        rows.sort(
          (a, b) =>
            a.centerY - b.centerY
        );

        const rootRect =
          context.rootRect ||
          this.rectSnapshot(
            context.root
          );

        return rows.map(
          (row, index) => {
            row.items.sort(
              (a, b) =>
                a.rect.centerX -
                b.rect.centerX
            );

            const containsClose =
              row.items.some(
                item =>
                  item.element ===
                  context.closeAction
              );

            const containsPrimary =
              row.items.some(
                item =>
                  item.element ===
                  context.primary
              );

            const ratio =
              rootRect?.height > 0
                ? (
                    row.centerY -
                    rootRect.top
                  ) /
                  rootRect.height
                : 0.5;

            const role =
              containsClose
                ? 'top'
                : containsPrimary
                  ? 'primary'
                  : ratio <= 0.28
                    ? 'top'
                    : ratio >= 0.78
                      ? 'bottom'
                      : 'content';

            const id =
              `${context.modalId}:section:${role}:${index}`;

            for (const item of row.items) {
              item.sectionId = id;
            }

            const left =
              Math.min(
                ...row.items.map(
                  item => item.rect.left
                )
              );

            const right =
              Math.max(
                ...row.items.map(
                  item => item.rect.right
                )
              );

            const top =
              Math.min(
                ...row.items.map(
                  item => item.rect.top
                )
              );

            const bottom =
              Math.max(
                ...row.items.map(
                  item => item.rect.bottom
                )
              );

            return {
              id,
              type:
                `modal-${role}`,
              title:
                role === 'top'
                  ? 'Modal controls'
                  : role === 'primary'
                    ? 'Primary actions'
                    : role === 'bottom'
                      ? 'Bottom actions'
                      : `Modal content ${index + 1}`,
              element:
                context.root,
              rect: {
                top,
                left,
                right,
                bottom,
                width:
                  right - left,
                height:
                  bottom - top,
                centerX:
                  left +
                  (right - left) / 2,
                centerY:
                  top +
                  (bottom - top) / 2
              },
              visible: true,
              order: index,
              scroll: {
                horizontal: false,
                vertical: false,
                container: null,
                viewportRect: null
              },
              items:
                row.items,
              metadata: {
                source:
                  'modal-visual-row',
                role,
                containsClose,
                containsPrimary
              }
            };
          }
        );
      }

      // ------------------------------------------------------------------
      // NavigationItem generation
      // ------------------------------------------------------------------
      findSectionItems(sectionEl) {
        const cardCandidates = Array.from(sectionEl.querySelectorAll(this.cfg.itemSelector));
        const logicalCards = cardCandidates.filter(card => {
          if (!this.isRendered(card)) return false;

          // Prefer the outer logical card; nested .card/.jellyseerr-card matches
          // should not become duplicate navigation items.
          const parentLogical = card.parentElement && card.parentElement.closest(this.cfg.itemSelector);
          return !parentLogical || !sectionEl.contains(parentLogical);
        });

        if (logicalCards.length) return this.dedupeElements(logicalCards);

        // Structural fallback for non-card grids/rows. Only use direct-ish
        // focusables so a wrapper and its child link aren't both emitted.
        const focusables = Array.from(sectionEl.querySelectorAll(
          [
            'a[href]', 'button', '[role="button"]', '[role="tab"]',
            '[role="menuitem"]', '[tabindex]:not([tabindex="-1"])',
            '[data-action]'
          ].join(', ')
        )).filter(el => this.isRendered(el));

        return this.dedupeInteractiveElements(focusables);
      }

      buildItem(element, sectionId, index, forcedType = null) {
        if (!element || !this.isRendered(element)) return null;

        const activationTarget = this.resolveActivationTarget(element);
        const stable = this.makeElementStableKey(element, sectionId, index, activationTarget);
        const rect = this.rectSnapshot(element);
        const title = this.getElementTitle(element, activationTarget) || stable.id || stable.key;
        const type = forcedType || this.detectItemType(element, activationTarget);
        const href = this.getHref(activationTarget) || this.getHref(element);
        const mediaType =
          (element.dataset && (
            element.dataset.type ||
            element.dataset.mediatype ||
            element.dataset.mediaType
          )) ||
          (activationTarget && activationTarget.dataset && (
            activationTarget.dataset.type ||
            activationTarget.dataset.mediatype ||
            activationTarget.dataset.mediaType
          )) ||
          null;

        const serverId =
          this.getServerId(
            element,
            activationTarget
          );

        const detailsHref =
          this.buildDetailsHref(
            stable,
            href,
            serverId
          );

        const actions =
          type === 'media'
            ? this.scanItemActions(
                element,
                stable
              )
            : [];

        return {
          key: stable.key,
          id: stable.id,
          type,
          title,
          element,
          activationTarget,
          sectionId,
          rect,
          state: {
            visible: this.isRendered(element),
            enabled: !this.isDisabled(activationTarget || element),
            focusable: this.isFocusable(activationTarget || element),
            clickable: this.isClickable(activationTarget || element),
            selectedByJellyfin: this.isSelectedByJellyfin(element, activationTarget)
          },
          actions,
          metadata: {
            href,
            detailsHref,
            serverId,
            mediaType,
            itemIdSource: stable.source,
            entityKey: stable.entityKey || null,
            inViewport: this.rectIntersectsViewport(rect),
            domIndex: index,
            dataAction: (activationTarget && activationTarget.dataset && activationTarget.dataset.action) ||
              (element.dataset && element.dataset.action) || null
          }
        };
      }

      scanItemActions(ownerElement, ownerStable) {
        if (
          !ownerElement?.isConnected ||
          !ownerStable?.key
        ) {
          return [];
        }

        const containers =
          Array.from(
            ownerElement.querySelectorAll(
              this.cfg.quickActionContainerSelector
            )
          );

        if (!containers.length) {
          return [];
        }

        const candidates = [];

        for (const container of containers) {
          candidates.push(
            ...container.querySelectorAll(
              this.cfg.quickActionSelector
            )
          );
        }

        const elements =
          this.dedupeInteractiveElements(
            candidates
          ).filter(
            element =>
              this.isActionLayoutAvailable(
                element
              )
          );

        const result = [];
        const usedKeys = new Set();

        for (
          let index = 0;
          index < elements.length;
          index += 1
        ) {
          const element =
            elements[index];

          const action =
            this.detectQuickActionType(
              element
            );

          const title =
            this.getElementTitle(
              element,
              element
            ) ||
            action;

          let key =
            `${ownerStable.key}:action:${action}`;

          if (usedKeys.has(key)) {
            const discriminator =
              this.hashString(
                [
                  action,
                  element.id || '',
                  element.getAttribute(
                    'data-action'
                  ) || '',
                  element.getAttribute(
                    'is'
                  ) || '',
                  title || '',
                  index
                ].join('|')
              );

            key =
              `${key}:${discriminator}`;
          }

          usedKeys.add(key);

          result.push({
            key,
            action,
            title,
            element,
            rect:
              this.rectSnapshot(
                element
              ),
            enabled:
              !this.isDisabled(
                element
              )
          });
        }

        return result;
      }

      isActionLayoutAvailable(element) {
        if (
          !element ||
          !element.isConnected
        ) {
          return false;
        }

        const rect =
          element.getBoundingClientRect();

        if (
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          return false;
        }

        const style =
          getComputedStyle(element);

        // Card overlay actions are often opacity:0 until hover/focus. Opacity
        // therefore must NOT exclude them from the logical model.
        if (
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          return false;
        }

        if (
          element.hidden ||
          element.getAttribute(
            'aria-hidden'
          ) === 'true'
        ) {
          return false;
        }

        return true;
      }

      detectQuickActionType(element) {
        const dataAction =
          String(
            element?.dataset?.action ||
            ''
          ).toLowerCase();

        const isType =
          String(
            element?.getAttribute?.('is') ||
            ''
          ).toLowerCase();

        const semantic =
          [
            dataAction,
            isType,
            element?.getAttribute?.(
              'aria-label'
            ),
            element?.getAttribute?.(
              'title'
            ),
            typeof element?.className ===
              'string'
              ? element.className
              : ''
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (
          dataAction === 'play' ||
          dataAction === 'resume' ||
          /\bplay\b/.test(semantic) ||
          /\bresume\b/.test(semantic)
        ) {
          return 'play';
        }

        if (
          isType.includes(
            'playstatebutton'
          ) ||
          /\bwatched\b/.test(semantic) ||
          /\bunwatched\b/.test(semantic) ||
          /\bplayed\b/.test(semantic)
        ) {
          return 'watched';
        }

        if (
          isType.includes(
            'ratingbutton'
          ) ||
          /\bfavou?rite\b/.test(semantic)
        ) {
          return 'favorite';
        }

        if (
          dataAction === 'menu' ||
          /\bmore\b/.test(semantic) ||
          /\bmenu\b/.test(semantic)
        ) {
          return 'menu';
        }

        if (
          dataAction === 'link' ||
          /\bdetails?\b/.test(semantic) ||
          /\binfo\b/.test(semantic)
        ) {
          return 'details';
        }

        return 'custom';
      }

      makeElementStableKey(element, sectionId, index, activationTarget = null) {
        const candidates = [element, activationTarget].filter(Boolean);
        const label = this.getElementTitle(element, activationTarget);

        // Navigation identity is occurrence-scoped, not globally entity-scoped.
        //
        // A Jellyfin/JellyNext item may legitimately appear in several
        // sections at once (Recently Added, Because You Watched, Recommended,
        // etc.). The canonical entity remains jf:<id>, but FocusManager needs
        // a distinct key for each rendered occurrence so it never resolves the
        // same media item back to the first section that contains it.
        const scoped = (entityKey, id, source) => ({
          key: `${sectionId}::${entityKey}`,
          entityKey,
          id: id ?? null,
          source
        });

        const isControl = !!(
          element &&
          element.matches &&
          element.matches('button, [role="button"], input, select, textarea')
        );

        // Controls on item-detail pages often carry the media data-id of their
        // owner. That ID is not enough by itself: Playstate and Favourite can
        // share the same data-id while being different controls.
        if (isControl) {
          for (const candidate of candidates) {
            if (candidate.id) {
              const entityKey = `dom:${candidate.id}`;
              return scoped(
                entityKey,
                candidate.id,
                'dom-id'
              );
            }
          }

          const ownerId = candidates
            .map(candidate =>
              (candidate.dataset && (
                candidate.dataset.id ||
                candidate.dataset.itemId ||
                candidate.dataset.mediaId
              )) ||
              candidate.getAttribute?.('data-item-id') ||
              candidate.getAttribute?.('data-media-id')
            )
            .find(Boolean);

          const actionToken = this.slugify(
            (activationTarget && activationTarget.dataset && activationTarget.dataset.action) ||
            (element.dataset && element.dataset.action) ||
            label ||
            this.selectorHint(element) ||
            `control-${index}`
          );

          if (ownerId) {
            const entityKey = `jf:${ownerId}:action:${actionToken}`;
            return scoped(
              entityKey,
              ownerId,
              'data-id-action'
            );
          }

          if (label || actionToken) {
            const entityKey =
              `semantic:action:${this.hashString(actionToken)}`;

            return scoped(
              entityKey,
              null,
              'semantic-action'
            );
          }
        }

        // Native Jellyfin logical item IDs.
        for (const candidate of candidates) {
          const dataId =
            (candidate.dataset && (
              candidate.dataset.id ||
              candidate.dataset.itemId ||
              candidate.dataset.mediaId
            )) ||
            candidate.getAttribute?.('data-item-id') ||
            candidate.getAttribute?.('data-media-id');

          if (dataId) {
            const entityKey = `jf:${dataId}`;
            return scoped(
              entityKey,
              dataId,
              'data-id'
            );
          }
        }

        // External/plugin media identity. Jellyfin Enhanced recommendation
        // cards can use href="#" while exposing data-tmdb-id + media type.
        for (const candidate of candidates) {
          const tmdbId =
            (candidate.dataset && candidate.dataset.tmdbId) ||
            candidate.getAttribute?.('data-tmdb-id');

          if (tmdbId) {
            const mediaType = this.slugify(
              (candidate.dataset && (
                candidate.dataset.mediaType ||
                candidate.dataset.type
              )) ||
              candidate.getAttribute?.('data-media-type') ||
              'item'
            );

            const entityKey = `ext:tmdb:${mediaType}:${tmdbId}`;

            return scoped(
              entityKey,
              String(tmdbId),
              'tmdb-id'
            );
          }
        }

        for (const candidate of candidates) {
          const href = this.getHref(candidate);
          const hrefId = this.extractItemIdFromHref(href);

          if (hrefId) {
            const entityKey = `jf:${hrefId}`;
            return scoped(
              entityKey,
              hrefId,
              'href'
            );
          }
        }

        for (const candidate of candidates) {
          if (candidate.id) {
            const entityKey = `dom:${candidate.id}`;
            return scoped(
              entityKey,
              candidate.id,
              'dom-id'
            );
          }
        }

        // href="#" is a placeholder on several plugin cards and must not be
        // treated as logical identity.
        for (const candidate of candidates) {
          const href = this.getHref(candidate);
          const meaningfulHref = href &&
            href !== '#' &&
            !/^javascript:/i.test(href) &&
            !/^void\(0\)$/i.test(href);

          if (meaningfulHref) {
            const normalizedHref = href
              .replace(location.origin, '')
              .replace(/\s+/g, '');

            const entityKey =
              `href:${this.hashString(normalizedHref)}`;

            return scoped(
              entityKey,
              null,
              'href'
            );
          }
        }

        if (label) {
          const discriminator = [
            label.toLowerCase(),
            element.getAttribute?.('role') || '',
            element.getAttribute?.('data-index') || '',
            element.getAttribute?.('data-type') || ''
          ].join('|');

          const entityKey =
            `semantic:${this.hashString(discriminator)}`;

          return scoped(
            entityKey,
            null,
            'generated'
          );
        }

        const entityKey =
          `temporary:${index}:${this.hashString(this.selectorHint(element))}`;

        return scoped(
          entityKey,
          null,
          'generated'
        );
      }

      ensureUniqueItemKeys(items) {
        if (!Array.isArray(items) || items.length < 2) return items;

        const groups = new Map();

        for (const item of items) {
          if (!item?.key) continue;
          if (!groups.has(item.key)) groups.set(item.key, []);
          groups.get(item.key).push(item);
        }

        for (const [baseKey, collisions] of groups.entries()) {
          if (collisions.length < 2) continue;

          const used = new Set();

          collisions.forEach((item, collisionIndex) => {
            const element = item.element;
            const secondaryText = this.cleanText(
              element?.querySelector?.(
                '.cardText-secondary, .secondaryText, .role, [data-role-name]'
              )?.textContent
            );

            const semanticParts = [
              element?.dataset?.type,
              element?.dataset?.mediaType,
              element?.dataset?.action,
              item.metadata?.dataAction,
              secondaryText,
              item.title
            ].filter(Boolean);

            let discriminator = semanticParts.length
              ? semanticParts.join('|').toLowerCase()
              : '';

            let suffix = discriminator
              ? this.hashString(discriminator)
              : '';

            let nextKey = suffix
              ? `${baseKey}:context:${suffix}`
              : baseKey;

            // If two logical cards are still indistinguishable semantically,
            // use DOM order only as the final collision fallback. Stable
            // identity never uses index unless stronger identity failed.
            if (!suffix || used.has(nextKey)) {
              const domIndex = Number.isInteger(item.metadata?.domIndex)
                ? item.metadata.domIndex
                : collisionIndex;

              nextKey = `${baseKey}:occurrence:${domIndex}`;
            }

            used.add(nextKey);

            item.metadata = {
              ...(item.metadata || {}),
              baseKey,
              keyDisambiguated: true,
              keyDiscriminator: discriminator || null
            };

            item.key = nextKey;
          });

          this.log(
            `disambiguated ${collisions.length} duplicate item keys for ${baseKey}`
          );
        }

        return items;
      }

      getServerId(element, activationTarget = null) {
        const candidates = [
          element,
          activationTarget,
          element?.querySelector?.('[data-serverid]'),
          element?.querySelector?.('[data-server-id]')
        ].filter(Boolean);

        for (const candidate of candidates) {
          const value =
            candidate.dataset?.serverid ||
            candidate.dataset?.serverId ||
            candidate.getAttribute?.('data-serverid') ||
            candidate.getAttribute?.('data-server-id') ||
            null;

          if (
            value &&
            String(value).toLowerCase() !== 'undefined' &&
            String(value).toLowerCase() !== 'null'
          ) {
            return String(value);
          }
        }

        // Current Jellyfin ApiClient is a safe final source when plugin-created
        // virtual cards omit data-serverid but still represent a local jf:<id>.
        try {
          const client = window.ApiClient;

          if (typeof client?.serverId === 'function') {
            const value = client.serverId();
            if (value) return String(value);
          }

          if (typeof client?.serverId === 'string' && client.serverId) {
            return client.serverId;
          }
        } catch (_) {}

        return null;
      }

      buildDetailsHref(stable, href, serverId = null) {
        const rawHref =
          href ? String(href) : '';

        // Existing native details links remain authoritative.
        if (
          rawHref &&
          /#\/details(?:\?|$)/i.test(rawHref)
        ) {
          return rawHref;
        }

        // Only synthesize for a confirmed Jellyfin entity identity. Do not turn
        // TMDB/external/plugin IDs into Jellyfin detail routes.
        const entityKey =
          String(stable?.entityKey || '');

        if (!entityKey.startsWith('jf:')) {
          return null;
        }

        const itemId =
          String(stable?.id || entityKey.slice(3)).trim();

        if (!itemId) {
          return null;
        }

        const params =
          new URLSearchParams();

        params.set('id', itemId);

        if (serverId) {
          params.set(
            'serverId',
            String(serverId)
          );
        }

        return `#/details?${params.toString()}`;
      }

      resolveActivationTarget(element) {
        if (this.matchesAny(element, 'a[href], button, [role="button"]')) {
          return element;
        }

        const preferred =
          element.querySelector(
            this.cfg.activationSelector
          );

        if (
          preferred &&
          this.isRendered(preferred)
        ) {
          return preferred;
        }

        // Jellyfin's preferences menu renders many logical .listItem rows
        // INSIDE an outer <a>. The item itself therefore has no interactive
        // descendant even though its nearest ancestor is the real activation
        // target. Resolve that ancestor before falling back to the logical item.
        const ancestor =
          element.closest(
            'a[href], button, [role="button"]'
          );

        if (
          ancestor &&
          ancestor !== document.body &&
          this.isRendered(ancestor)
        ) {
          return ancestor;
        }

        return element;
      }

      detectItemType(element, activationTarget) {
        // Detail-page buttons may carry the owner's media data-id. They are
        // still controls/actions, not media cards.
        if (element.closest('.mainDetailButtons') &&
            element.matches('button, [role="button"]')) {
          return 'action';
        }

        if (element.closest('.skinHeader, .headerTabs, .headerRight, .headerLeft')) {
          return 'navigation';
        }

        if (element.matches('button, [role="button"]')) {
          return 'button';
        }

        const mediaId =
          (element.dataset && (
            element.dataset.id ||
            element.dataset.itemId ||
            element.dataset.mediaId ||
            element.dataset.tmdbId
          )) ||
          (activationTarget && activationTarget.dataset && (
            activationTarget.dataset.id ||
            activationTarget.dataset.itemId ||
            activationTarget.dataset.mediaId ||
            activationTarget.dataset.tmdbId
          )) ||
          this.extractItemIdFromHref(this.getHref(activationTarget));

        if (element.classList.contains('card') ||
            element.classList.contains('jellyseerr-card') ||
            mediaId) {
          return 'media';
        }

        if (element.closest('.jellyseerr-section, [data-jellyseerr-section], [id^="customTab"], [class*="plugin"]')) {
          return 'plugin';
        }

        if (element.matches('a[href]')) return 'navigation';
        return 'unknown';
      }

      // ------------------------------------------------------------------
      // Section helpers
      // ------------------------------------------------------------------
      detectScrollInfo(sectionEl, items = []) {
        const viewport = sectionEl.matches('.emby-scroller')
          ? sectionEl
          : sectionEl.querySelector('.emby-scroller');
        const content = sectionEl.matches('.itemsContainer')
          ? sectionEl
          : sectionEl.querySelector('.itemsContainer');

        const transformValue = content ? getComputedStyle(content).transform : 'none';
        const hasTransform = !!content && transformValue && transformValue !== 'none';
        const animatedX = !!(content && content.classList.contains('animatedScrollX'));
        const customX = !!(viewport && viewport.dataset && viewport.dataset.scrollModeX === 'custom');
        const scrollableX = !!viewport && viewport.scrollWidth > viewport.clientWidth + 1;

        // Important: .itemsContainer exists on both horizontal home shelves and
        // wrapping library grids. Geometry decides whether the contents wrap.
        const visualRows = this.countVisualRows(items);
        const wraps = visualRows > 1;

        const horizontal = hasTransform ||
          animatedX ||
          customX ||
          scrollableX ||
          (!!content && !wraps && items.length > 1);

        let mode = 'none';
        if (horizontal && (hasTransform || animatedX)) mode = 'transform';
        else if (horizontal && scrollableX) mode = 'native';
        else if (horizontal) mode = 'row';

        return {
          horizontal,
          vertical: false,
          container: horizontal ? (viewport || content || null) : null,
          viewportRect: horizontal && viewport ? this.rectSnapshot(viewport) : null,
          virtualized: horizontal && (
            mode === 'transform' ||
            !!(content && content.classList.contains('scrollSlider'))
          ),
          mode,
          contentElement: content || null
        };
      }

      countVisualRows(items) {
        if (!items || !items.length) return 0;

        // Group card centres using a small tolerance rather than exact pixels.
        // This is resilient to sub-pixel layout values and small theme offsets.
        const tolerance = 16;
        const rows = [];

        for (const el of items) {
          const centerY = this.rectSnapshot(el).centerY;
          const existing = rows.find(y => Math.abs(y - centerY) <= tolerance);
          if (existing === undefined) rows.push(centerY);
        }

        return rows.length;
      }

      detectSectionType(sectionEl, items) {
        // Native item-detail primary controls are a logical action lane.
        if (sectionEl.matches('.mainDetailButtons')) {
          return 'actions';
        }

        const visualRows = this.countVisualRows(items);

        // Multiple visible Y lanes means a wrapping grid even when Jellyfin
        // happens to use an .itemsContainer wrapper.
        if (visualRows > 1) return 'grid';

        const scroll = this.detectScrollInfo(sectionEl, items);
        if (scroll.horizontal || (items && items.length > 1)) return 'row';

        return 'other';
      }

      getSectionTitle(sectionEl) {
        // First prefer a label on the logical section itself.
        const ownLabel = this.cleanText(
          sectionEl.getAttribute('aria-label') ||
          sectionEl.getAttribute('title')
        );
        if (ownLabel) return ownLabel;

        // Do NOT use a generic descendant [aria-label] here: on library grids
        // the first media card may be the first aria-labelled descendant, which
        // incorrectly makes the movie/show title become the section title.
        const titleEl = sectionEl.querySelector(
          '.sectionTitle, .sectionTitleTextButton .sectionTitle, h1, h2, h3'
        );
        if (!titleEl) return null;

        return this.cleanText(
          titleEl.getAttribute('aria-label') ||
          titleEl.textContent ||
          titleEl.getAttribute('title')
        );
      }

      getFallbackSectionTitle(sectionType, index) {
        if (sectionType === 'actions') {
          return 'Actions';
        }

        if (sectionType === 'grid') {
          try {
            const hash = location.hash || '';
            const queryIndex = hash.indexOf('?');
            const params = queryIndex >= 0
              ? new URLSearchParams(hash.substring(queryIndex + 1))
              : new URLSearchParams();
            const collectionType = (params.get('collectionType') || '').toLowerCase();

            if (collectionType === 'movies') return 'Movies';
            if (collectionType === 'tvshows') return 'Shows';
          } catch (_) {
            // Safe fallback below.
          }

          return 'Library Grid';
        }

        return `Section ${index + 1}`;
      }

      makeSectionId(sectionEl, title, index) {
        if (sectionEl.id) return `section:${this.slugify(sectionEl.id)}`;

        // Human/semantic section titles are more stable than generic shared
        // plugin classes. This prevents Recommended and Similar from both
        // becoming "section:jellyseerr-details-section".
        if (title) return `section:${this.slugify(title)}`;

        const meaningfulClass = Array.from(sectionEl.classList).find(name =>
          ![
            'verticalSection',
            'detailVerticalSection',
            'verticalSection-extrabottompadding',
            'emby-scroller-container',
            'jellyseerr-section',
            'jellyseerr-details-section',
            'itemsContainer',
            'cardScrollContainer',
            'vertical-wrap',
            'focuscontainer-x'
          ].includes(name) &&
          !/^section\d+$/i.test(name) &&
          !/^padded-/i.test(name)
        );

        if (meaningfulClass) return `section:${this.slugify(meaningfulClass)}`;
        return `section:generated-${index}`;
      }

      isKnownSection(el) {
        return el.matches('.verticalSection, .jellyseerr-section, .mainDetailButtons');
      }

      // ------------------------------------------------------------------
      // Modal / player / state helpers
      // ------------------------------------------------------------------
      getModalTitle(root) {
        // Prefer explicit content-title locations. A generic [aria-label]
        // selector is intentionally excluded because modal utility buttons such
        // as Refresh/Close frequently appear before the actual media title.
        const selectors = [
          '.header-info > .title',
          '.header-info .title-row > .title',
          '.title-row > .title',
          '.modal-title',
          '[data-modal-title]',
          '[data-role="title"]',
          'h1',
          'h2',
          'h3'
        ];

        for (const selector of selectors) {
          const el = root.querySelector(selector);
          if (!el || !this.isRendered(el)) continue;

          const title = this.cleanText(
            el.getAttribute('data-title') ||
            el.getAttribute('aria-label') ||
            el.textContent ||
            el.getAttribute('title')
          );

          if (title) return title;
        }

        // Root-level semantic labelling is a safe fallback; descendant
        // aria-labels are not.
        return this.cleanText(
          root.getAttribute('data-title') ||
          root.getAttribute('aria-label') ||
          root.getAttribute('title')
        );
      }

      getModalIdentity(root, title) {
        // Prefer explicit media/item identity when the modal exposes it.
        const rootItemId =
          root.getAttribute('data-item-id') ||
          root.getAttribute('data-itemid') ||
          root.getAttribute('data-media-id') ||
          root.getAttribute('data-id');

        if (rootItemId) return `item:${this.slugify(rootItemId)}`;

        const identityNode = root.querySelector(
          '[data-item-id], [data-itemid], [data-media-id]'
        );

        if (identityNode) {
          const itemId =
            identityNode.getAttribute('data-item-id') ||
            identityNode.getAttribute('data-itemid') ||
            identityNode.getAttribute('data-media-id');

          if (itemId) return `item:${this.slugify(itemId)}`;
        }

        // A DOM id is useful only when it is not simply a generic modal-shell id.
        if (root.id && !/^(modal|dialog|je-more-info-modal)$/i.test(root.id)) {
          return `dom:${this.slugify(root.id)}`;
        }

        // The visible media title is the best semantic fallback for plugin
        // detail modals that do not expose a Jellyfin item id on their root.
        if (title && title !== 'Modal') {
          return `title:${this.slugify(title)}`;
        }

        // Last-resort context identity. It is stable for the same route/modal
        // shape without accidentally using a utility button label.
        return `context:${this.hashString(
          `${this.detectRoute()}|${this.selectorHint(root)}`
        )}`;
      }

      isSelectedByJellyfin(element, activationTarget) {
        const target = activationTarget || element;
        return !!(
          element.classList.contains('selected') ||
          element.classList.contains('selectedListItem') ||
          element.getAttribute('aria-selected') === 'true' ||
          target.getAttribute('aria-selected') === 'true'
        );
      }

      // ------------------------------------------------------------------
      // Generic DOM utilities
      // ------------------------------------------------------------------
      isRendered(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;

        return true;
      }

      isAnyRendered(nodeList) {
        return Array.from(nodeList || []).some(el => this.isRendered(el));
      }

      isDisabled(el) {
        if (!el) return true;
        return !!(
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled')
        );
      }

      isFocusable(el) {
        if (!el || this.isDisabled(el)) return false;
        if (el.matches('a[href], button, input, select, textarea, [role="button"]')) return true;
        const tabindex = el.getAttribute('tabindex');
        return tabindex !== null && tabindex !== '-1';
      }

      isClickable(el) {
        if (!el || this.isDisabled(el)) return false;
        return !!(
          el.matches(
            [
              'a[href]',
              'button',
              '[role="button"]',
              'input[type="checkbox"]',
              'input[type="radio"]',
              'input[type="range"]',
              'input[type="number"]',
              'select',
              '[role="checkbox"]',
              '[role="switch"]'
            ].join(', ')
          ) ||
          el.dataset && el.dataset.action ||
          typeof el.onclick === 'function'
        );
      }

      getElementTitle(element, activationTarget = null) {
        const nodes = [activationTarget, element].filter(Boolean);
        for (const node of nodes) {
          const direct = this.cleanText(
            node.getAttribute('aria-label') ||
            node.getAttribute('title') ||
            node.getAttribute('data-title')
          );
          if (direct) return direct;
        }

        const textNode = element.querySelector('.cardText-first, .cardText, .listItemBodyText, .emby-button-foreground');
        if (textNode) {
          const text = this.cleanText(textNode.textContent);
          if (text) return text;
        }

        return this.cleanText(element.textContent);
      }

      getHref(el) {
        if (!el || !el.getAttribute) return null;
        return el.getAttribute('href') || null;
      }

      extractItemIdFromHref(href) {
        if (!href) return null;
        try {
          const normalized = href.startsWith('#') ? href.substring(1) : href;
          const question = normalized.indexOf('?');
          if (question >= 0) {
            const params = new URLSearchParams(normalized.substring(question + 1));
            return params.get('id');
          }
        } catch (_) {
          // fall through to regex
        }

        const match = href.match(/[?&]id=([^&#]+)/i);
        return match ? decodeURIComponent(match[1]) : null;
      }

      rectSnapshot(el) {
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2
        };
      }

      rectIntersectsViewport(rect) {
        return rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight;
      }

      dedupeElements(elements) {
        return [...new Set(elements)];
      }

      dedupeInteractiveElements(elements) {
        const unique = [];
        const seen = new Set();

        for (const el of elements) {
          if (seen.has(el)) continue;

          // If this exact control is nested inside another matched interactive
          // element, prefer the innermost concrete control.
          const parentInteractive = el.parentElement && el.parentElement.closest(
            'a[href], button, [role="button"], [tabindex]:not([tabindex="-1"])'
          );
          if (parentInteractive && parentInteractive !== el && elements.includes(parentInteractive)) {
            seen.add(parentInteractive);
          }

          seen.add(el);
          unique.push(el);
        }

        return unique.filter(el => !unique.some(other => other !== el && el.contains(other) && other.matches('a[href], button, [role="button"]')));
      }

      dedupeSectionElements(elements) {
        const unique = this.dedupeElements(elements);
        return unique.filter(el => {
          return !unique.some(other => {
            if (other === el) return false;
            if (!other.contains(el)) return false;
            return this.isKnownSection(other);
          });
        });
      }

      matchesAny(el, selector) {
        try {
          return !!el && el.matches(selector);
        } catch (_) {
          return false;
        }
      }

      selectorHint(el) {
        if (!el) return '';
        if (el.id) return `#${el.id}`;
        const classes = Array.from(el.classList || []).slice(0, 4);
        return `${el.tagName ? el.tagName.toLowerCase() : 'element'}${classes.length ? '.' + classes.join('.') : ''}`;
      }

      cleanText(value) {
        if (!value) return null;
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text || null;
      }

      slugify(value) {
        return String(value || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'unknown';
      }

      hashString(value) {
        let hash = 2166136261;
        const input = String(value || '');
        for (let i = 0; i < input.length; i += 1) {
          hash ^= input.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
      }

      classifySemanticKind(element, legacyItem = null) {
        if (legacyItem?.type === 'media') return 'media';
        if (!element?.matches) return legacyItem?.type || 'unknown';

        const role = String(element.getAttribute?.('role') || '').toLowerCase();
        const inputType = String(element.getAttribute?.('type') || '').toLowerCase();

        if (element.matches('input[type="checkbox"], [role="checkbox"], [role="switch"]')) return 'toggle';
        if (element.matches('input[type="radio"], [role="radio"]')) return 'radio';
        if (element.matches('input[type="range"], [role="slider"]')) return 'range';
        if (element.matches('input[type="number"]')) return 'number';
        if (element.matches('input[type="color"]')) return 'color';
        if (element.matches('input[type="file"]')) return 'file';
        if (element.matches('input[type="password"]')) return 'password';
        if (element.matches('input[type="text"], input[type="search"], input:not([type])')) return 'text';
        if (element.matches('textarea')) return 'textarea';
        if (element.matches('select, [role="listbox"]')) return 'select';
        if (element.matches('[contenteditable="true"]')) return 'text';
        if (role === 'tab') return 'tab';
        if (role === 'menuitem') return 'menu-item';
        if (role === 'option') return 'option';
        if (legacyItem?.metadata?.pageInlineGroup === true) return 'compound';
        if (legacyItem?.metadata?.modalControlKind === 'position-grid') return 'compound';
        if (element.matches('a[href]')) return 'link';
        if (element.matches('button, [role="button"], [data-action]')) return 'action';
        return legacyItem?.type === 'navigation' ? 'action' : (legacyItem?.type || 'unknown');
      }

      capabilitiesFor(kind, item = null) {
        const caps = {
          activate: false,
          enter: false,
          exit: false,
          toggle: false,
          adjustX: false,
          adjustY: false,
          textEntry: false,
          options: false,
          childActions: false,
          nativeHandoff: false,
          scrollIntoView: true
        };

        switch (kind) {
          case 'media':
            caps.activate = true;
            caps.childActions = !!(item?.actions?.length);
            break;
          case 'toggle':
          case 'radio':
            caps.activate = true;
            caps.toggle = true;
            break;
          case 'range':
            caps.activate = true;
            caps.adjustX = true;
            break;
          case 'number':
            caps.activate = true;
            caps.adjustY = true;
            break;
          case 'select':
            caps.activate = true;
            caps.options = true;
            break;
          case 'text':
          case 'password':
          case 'textarea':
            caps.activate = true;
            caps.textEntry = true;
            caps.nativeHandoff = true;
            break;
          case 'file':
          case 'color':
            caps.activate = true;
            caps.nativeHandoff = true;
            break;
          case 'compound':
            caps.activate = true;
            caps.enter = true;
            break;
          case 'action':
          case 'link':
          case 'tab':
          case 'menu-item':
          case 'option':
            caps.activate = true;
            break;
          default:
            caps.activate = !!item?.state?.clickable;
            break;
        }

        if (item?.actions?.length) caps.childActions = true;
        return caps;
      }

      identityConfidence(source) {
        switch (source) {
          case 'data-id':
          case 'data-id-action':
          case 'tmdb-id':
            return 1;
          case 'dom-id':
            return 0.98;
          case 'href':
            return 0.95;
          case 'semantic-action':
            return 0.86;
          case 'generated':
            return 0.72;
          default:
            return 0.55;
        }
      }

      describeItemVisibility(element, rect = null) {
        const state = {
          connected: !!element?.isConnected,
          rendered: false,
          painted: false,
          hitTestable: false,
          enabled: !this.isDisabled(element),
          surfaceVisible: false,
          viewportVisible: false,
          partiallyVisible: false,
          occluded: false,
          selectable: false
        };

        if (!element?.isConnected) return state;
        rect = rect || this.rectSnapshot(element);
        let style = null;
        try { style = getComputedStyle(element); } catch (_) {}

        const hasBox = !!rect && rect.width > 0 && rect.height > 0;
        const display = style?.display !== 'none';
        const visible = style?.visibility !== 'hidden' && style?.visibility !== 'collapse';
        const ariaVisible = !element.hidden && element.getAttribute?.('aria-hidden') !== 'true';
        const opacity = Number.parseFloat(style?.opacity ?? '1');
        const painted = Number.isFinite(opacity) ? opacity > 0.001 : true;
        const viewport = hasBox && this.rectIntersectsViewport(rect);
        const pointer = style?.pointerEvents !== 'none';

        state.rendered = hasBox && display && visible && ariaVisible;
        state.painted = state.rendered && painted;
        state.hitTestable = state.rendered && pointer;
        state.viewportVisible = viewport;
        state.partiallyVisible = viewport && !!rect && (
          rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight
        );
        state.surfaceVisible = state.rendered && (viewport || rect.bottom > 0);
        state.selectable = state.rendered && state.enabled;
        return state;
      }

      decorateItemV1(item, surfaceId, sectionId) {
        if (!item) return item;
        const element = item.element || item.activationTarget || null;
        const kind = this.classifySemanticKind(element, item);
        const source = item.metadata?.itemIdSource || 'legacy';
        const entityKey = item.metadata?.entityKey || item.entityKey || item.key || null;
        const instanceKey = item.key || null;
        const visibility = this.describeItemVisibility(element, item.rect);

        item.kind = kind;
        item.entityKey = entityKey;
        item.instanceKey = instanceKey;
        item.surfaceId = surfaceId;
        item.sectionId = sectionId || item.sectionId || null;
        item.focusTarget = item.activationTarget || item.element || null;
        item.geometry = item.rect ? { rect: item.rect } : { rect: null };
        item.capabilities = this.capabilitiesFor(kind, item);
        item.visibility = visibility;
        item.identity = {
          entityKey,
          instanceKey,
          confidence: this.identityConfidence(source),
          evidence: [
            { type: source, value: entityKey }
          ]
        };

        if (Array.isArray(item.actions) && item.actions.length) {
          item.childContexts = {
            ...(item.childContexts || {}),
            actions: {
              id: `child:${instanceKey}:actions`,
              kind: 'actions',
              ownerItemKey: instanceKey,
              axis: 'x',
              activeItemKey: null,
              entryPolicy: 'preferred',
              restorePolicy: 'owner',
              items: item.actions
            }
          };
        } else if (!item.childContexts) {
          item.childContexts = {};
        }

        return item;
      }

      sectionKindFromLegacy(section) {
        switch (section?.type) {
          case 'header': return 'header';
          case 'grid': return 'grid';
          case 'row': return 'horizontal-row';
          case 'actions': return 'actions';
          case 'form': return 'form';
          case 'modal': return 'vertical-list';
          default: return 'unknown';
        }
      }

      decorateSectionV1(section, surfaceId) {
        if (!section) return section;
        const kind = this.sectionKindFromLegacy(section);
        section.kind = kind;
        section.surfaceId = surfaceId;
        section.root = section.element || null;
        section.axis = ['header', 'horizontal-row', 'actions'].includes(kind) ? 'x' : 'y';
        section.layout = {
          wrap: kind === 'grid',
          repeatedItemGeometry: (section.items?.length || 0) > 1,
          rowCount: Number(section.metadata?.visualRows || 0) || null,
          columnCount: null
        };

        const scroll = section.scroll || {};
        const scrollId = `scroll:${section.id}`;
        section.scrollContextId = scroll.horizontal || scroll.vertical || scroll.mode === 'document' ? scrollId : null;
        section.scrollContext = section.scrollContextId ? {
          id: scrollId,
          surfaceId,
          sectionId: section.id,
          container: scroll.container || null,
          content: scroll.contentElement || section.element || null,
          axis: scroll.horizontal ? 'x' : 'y',
          mechanism:
            scroll.mode === 'transform' ? 'transform-x' :
            scroll.mode === 'native' && scroll.horizontal ? 'scrollLeft' :
            scroll.mode === 'document' ? 'document' :
            scroll.vertical ? 'scrollTop' : 'unknown',
          viewportRect: scroll.viewportRect || null,
          contentRect: scroll.contentElement?.isConnected ? this.rectSnapshot(scroll.contentElement) : null,
          state: {
            canBackward: scroll.horizontal
              ? Number(scroll.container?.scrollLeft || 0) > 1
              : (window.scrollY || 0) > 1,
            canForward: scroll.horizontal
              ? !!scroll.container && scroll.container.scrollWidth > scroll.container.clientWidth + Number(scroll.container.scrollLeft || 0) + 1
              : document.documentElement.scrollHeight > innerHeight + (window.scrollY || 0) + 1
          }
        } : null;

        for (const item of section.items || []) {
          this.decorateItemV1(item, surfaceId, section.id);
        }
        return section;
      }

      makeAdapterNavigationItem(element, sectionId, index, metadata = {}) {
        if (!element?.isConnected) return null;
        const stable = this.makeElementStableKey(element, sectionId, index, element);
        const rect = this.rectSnapshot(element);
        const title = this.getElementTitle(element, element) || stable.id || stable.key;

        return {
          key: stable.key,
          id: stable.id,
          type: 'navigation',
          title,
          element,
          activationTarget: element,
          sectionId,
          rect,
          state: {
            visible: this.isRenderedRelaxed(element),
            enabled: !this.isDisabled(element),
            focusable: this.isFocusable(element),
            clickable: this.isClickable(element),
            selectedByJellyfin: this.isSelectedByJellyfin(element, element)
          },
          actions: [],
          metadata: {
            href: this.getHref(element),
            itemIdSource: stable.source,
            entityKey: stable.entityKey || null,
            inViewport: this.rectIntersectsViewport(rect),
            domIndex: index,
            adapter: true,
            ...metadata
          }
        };
      }

      makeAdapterOwnerActions(ownerStable, elements) {
        const result = [];
        const usedKeys = new Set();
        const candidates = this.dedupeInteractiveElements(elements || [])
          .filter(element => this.isActionLayoutAvailable(element));

        for (let index = 0; index < candidates.length; index += 1) {
          const element = candidates[index];
          const action = this.detectQuickActionType(element);
          const title = this.getElementTitle(element, element) || action;
          let key = `${ownerStable.key}:action:${action}`;
          if (usedKeys.has(key)) {
            key = `${key}:${this.hashString([element.id || '', element.className || '', title || '', index].join('|'))}`;
          }
          usedKeys.add(key);
          result.push({
            key,
            action,
            title,
            element,
            rect: this.rectSnapshot(element),
            enabled: !this.isDisabled(element)
          });
        }
        return result;
      }

      scanSectionTitleActionSections(existingSections = []) {
        const represented = new Set();
        for (const section of existingSections || []) {
          for (const item of section?.items || []) {
            if (item?.element) represented.add(item.element);
            if (item?.activationTarget) represented.add(item.activationTarget);
          }
        }

        let candidates = [];
        try { candidates = Array.from(document.querySelectorAll(this.cfg.sectionTitleActionSelector)); } catch (_) {}

        const links = this.dedupeInteractiveElements(candidates).filter(element => {
          if (!element?.isConnected || represented.has(element)) return false;
          if (!this.isRenderedRelaxed(element) || this.isDisabled(element)) return false;
          // A section-title adapter must actually own/contain the visual heading.
          // This prevents arbitrary toolbar links inside the same container from
          // being promoted merely because of their location.
          return !!element.querySelector?.('.sectionTitle, h1, h2, h3') ||
            element.classList?.contains('sectionTitleTextButton');
        });

        return links.map((element, index) => {
          const heading = element.querySelector?.('.sectionTitle, h1, h2, h3');
          const title = this.cleanText(heading?.textContent) || this.getElementTitle(element, element) || `Section link ${index + 1}`;
          const sectionId = `section:title-action:${this.slugify(title)}:${this.hashString(this.getHref(element) || index)}`;
          const item = this.makeAdapterNavigationItem(element, sectionId, 0, {
            adapterSource: 'linked-section-heading'
          });
          if (!item) return null;
          item.title = title;
          return {
            id: sectionId,
            type: 'actions',
            title,
            element,
            rect: this.rectSnapshot(element),
            visible: true,
            order: 0,
            items: [item],
            scroll: {
              horizontal: false,
              vertical: false,
              container: null,
              viewportRect: null,
              virtualized: false,
              mode: 'none',
              contentElement: element
            },
            metadata: {
              source: 'linked-section-heading',
              adapter: true,
              visualRows: 1,
              scrollMode: 'none'
            }
          };
        }).filter(Boolean);
      }

      scanHeroCarouselSections() {
        let containers = [];
        try { containers = Array.from(document.querySelectorAll(this.cfg.heroContainerSelector)); } catch (_) {}
        const sections = [];

        for (const container of containers) {
          if (!this.isRenderedRelaxed(container)) continue;
          const containerRect = this.rectSnapshot(container);
          if (!this.rectIntersectsViewport(containerRect)) continue;

          let slide = null;
          try {
            slide = Array.from(container.querySelectorAll(this.cfg.heroActiveSlideSelector))
              .find(element => this.isRenderedRelaxed(element) && this.rectIntersectsViewport(this.rectSnapshot(element))) || null;
          } catch (_) {}
          if (!slide) continue;

          const itemId = slide.getAttribute('data-item-id') || slide.dataset?.itemId || this.hashString(this.selectorHint(slide));
          const mediaSectionId = `section:hero-media:${this.slugify(itemId)}`;
          const primary = slide.querySelector?.(this.cfg.heroPrimaryActionSelector) || slide;
          const stable = this.makeElementStableKey(slide, mediaSectionId, 0, primary);
          const logoTitle = this.cleanText(slide.querySelector?.('.logo[alt]')?.getAttribute('alt'));
          const title = logoTitle || this.getElementTitle(slide, primary) || 'Featured media';
          const actionElements = Array.from(slide.querySelectorAll(this.cfg.heroChildActionSelector))
            .filter(element => element !== primary);
          const actions = this.makeAdapterOwnerActions(stable, actionElements);
          const utilityElements = Array.from(container.querySelectorAll(this.cfg.heroUtilityActionSelector))
            .filter(element => this.isRenderedRelaxed(element) && this.rectIntersectsViewport(this.rectSnapshot(element)));
          const utilityActions = this.makeAdapterOwnerActions(stable, utilityElements)
            .map(action => ({
              ...action,
              metadata: {
                source: 'hero-utility',
                nonSpatial: true
              }
            }));
          actions.push(...utilityActions);
          const rect = this.rectSnapshot(slide);
          const href = this.getHref(primary) || this.getHref(slide);
          const serverId = this.getServerId(slide, primary);

          const mediaItem = {
            key: stable.key,
            id: stable.id,
            type: 'media',
            title,
            element: slide,
            activationTarget: primary,
            sectionId: mediaSectionId,
            rect,
            state: {
              visible: true,
              enabled: !this.isDisabled(primary),
              focusable: this.isFocusable(slide) || this.isFocusable(primary),
              clickable: this.isClickable(primary) || this.isClickable(slide),
              selectedByJellyfin: this.isSelectedByJellyfin(slide, primary)
            },
            actions,
            metadata: {
              href,
              detailsHref: this.buildDetailsHref(stable, href, serverId),
              serverId,
              mediaType: null,
              itemIdSource: stable.source,
              entityKey: stable.entityKey || `hero:${itemId}`,
              inViewport: true,
              domIndex: 0,
              adapter: true,
              adapterSource: 'active-hero-slide',
              directional: false,
              navigationParticipation: 'explicit'
            }
          };

          sections.push({
            id: mediaSectionId,
            type: 'row',
            title: 'Featured',
            element: slide,
            rect,
            visible: true,
            order: 0,
            items: [mediaItem],
            scroll: {
              horizontal: false,
              vertical: false,
              container: null,
              viewportRect: containerRect,
              virtualized: false,
              mode: 'none',
              contentElement: slide
            },
            metadata: {
              source: 'active-hero-slide',
              adapter: true,
              directional: false,
              navigationParticipation: 'explicit',
              visualRows: 1,
              scrollMode: 'none'
            }
          });

        }

        return sections;
      }

      scanProductionAdapterSections(route, existingSections = []) {
        const result = [
          ...this.scanSectionTitleActionSections(existingSections),
          ...this.scanHeroCarouselSections()
        ];
        const usedIds = new Set((existingSections || []).map(section => section?.id).filter(Boolean));
        return result.filter(section => {
          if (!section?.id || usedIds.has(section.id)) return false;
          usedIds.add(section.id);
          return true;
        });
      }

      buildProductionResidualSections(model, surfaceId) {
        const emitted = this.emittedElementSet(model);
        const activePageRoot = this.findActivePageRoot();
        const candidates = this.collectGenericCandidates({
          includeCursorPointer: false,
          root: activePageRoot,
          limit: 6000
        });

        const supportedKinds = new Set([
          'text', 'password', 'textarea', 'file', 'color', 'toggle', 'radio',
          'range', 'number', 'select', 'action', 'link', 'tab', 'menu-item'
        ]);

        const residual = candidates.filter(candidate => {
          const element = candidate.element;
          if (!supportedKinds.has(candidate.kind)) return false;
          if (emitted.has(element)) return false;
          if (!candidate.visibility.rendered || !candidate.visibility.enabled) return false;
          if (element.matches?.('.emby-scrollbuttons-button')) return false;
          // Native Jellyfin cards expose title/subtitle/detail anchors as semantic
          // descendants of the same logical media occurrence. They are activation
          // aliases, not additional production navigation items.
          if (element.closest?.(this.cfg.itemSelector)) return false;
          if (element.closest?.('.skinHeader, .mainDrawer, [role="dialog"], [aria-modal="true"], .dialog, .actionSheet, .videoPlayerContainer')) return false;
          return true;
        });

        if (!residual.length) return [];

        const groups = new Map();
        for (const candidate of residual) {
          const element = candidate.element;
          const root = element.closest?.('form, fieldset, [role="form"], .formDialogContent, .settingsContainer') ||
            element.parentElement ||
            this.findActivePageRoot();
          if (!groups.has(root)) groups.set(root, []);
          groups.get(root).push(candidate);
        }

        const sections = [];
        let sectionIndex = 0;
        for (const [root, group] of groups.entries()) {
          group.sort((a, b) => (a.rect?.top || 0) - (b.rect?.top || 0) || (a.rect?.left || 0) - (b.rect?.left || 0));
          const rootHint = root?.id || root?.getAttribute?.('aria-label') || root?.getAttribute?.('title') || `residual-${sectionIndex}`;
          const sectionId = `section:semantic:${this.slugify(rootHint)}:${sectionIndex}`;
          const items = group.map((candidate, index) => {
            const element = candidate.element;
            const stable = this.makeElementStableKey(element, sectionId, index, element);
            const title = candidate.title || this.getPageFormControlTitle(element) || stable.id || stable.key;
            const item = {
              key: stable.key,
              id: stable.id,
              type: 'semantic-control',
              title,
              element,
              activationTarget: element,
              sectionId,
              rect: candidate.rect,
              state: {
                visible: candidate.visibility.rendered,
                enabled: candidate.visibility.enabled,
                focusable: this.isFocusable(element),
                clickable: this.isClickable(element),
                selectedByJellyfin: this.isSelectedByJellyfin(element, element)
              },
              actions: [],
              metadata: {
                href: this.getHref(element),
                itemIdSource: stable.source,
                entityKey: stable.entityKey || null,
                inViewport: candidate.visibility.viewportVisible,
                domIndex: index,
                productionOnly: true,
                discoveryConfidence: candidate.confidence,
                discoveryEvidence: candidate.evidence
              }
            };
            return this.decorateItemV1(item, surfaceId, sectionId);
          });

          this.ensureUniqueItemKeys(items);
          if (!items.length) continue;

          sections.push({
            id: sectionId,
            type: 'semantic',
            kind: 'form',
            title: this.cleanText(root?.querySelector?.('legend, h1, h2, h3, label')?.textContent) || 'Interactive Controls',
            element: root,
            root,
            rect: this.rectSnapshot(root) || this.unionItemRects(items),
            visible: true,
            order: 10000 + sectionIndex,
            axis: 'y',
            scroll: {
              horizontal: false,
              vertical: true,
              container: null,
              viewportRect: null,
              virtualized: false,
              mode: 'document',
              contentElement: root
            },
            items,
            metadata: {
              source: 'semantic-residual',
              productionOnly: true,
              visualRows: this.countVisualRows(items.map(item => item.element)),
              scrollMode: 'document'
            }
          });
          sectionIndex += 1;
        }

        return sections.map(section => this.decorateSectionV1(section, surfaceId));
      }

      buildSurfaceModel(model) {
        const surfaces = [];
        const route = model.route;
        const pageSurfaceId = `surface:page:${this.hashString(route)}`;

        if (model.activeSurfaceHint !== 'player' || model.header || model.sections?.length) {
          const legacyPageSections = (model.sections || []).map(section => this.decorateSectionV1(section, pageSurfaceId));
          const residualSections = model.activeSurfaceHint === 'page'
            ? this.buildProductionResidualSections(model, pageSurfaceId)
            : [];
          const pageSections = [...legacyPageSections, ...residualSections];
          if (model.header) this.decorateSectionV1(model.header, 'surface:header');

          surfaces.push({
            id: pageSurfaceId,
            kind: 'page',
            root: this.findActivePageRoot(),
            state: {
              connected: true,
              rendered: true,
              visible: model.activeSurfaceHint === 'page',
              interactive: true,
              blocksBelow: false
            },
            geometry: { rect: this.rectSnapshot(this.findActivePageRoot()) },
            ownership: { input: model.activeSurfaceHint === 'page', underlyingSurfaceId: null },
            sections: pageSections,
            scrollContexts: pageSections.map(section => section.scrollContext).filter(Boolean),
            metadata: { routeHint: route, source: 'dom-page' }
          });

          if (model.header) {
            surfaces.push({
              id: 'surface:header',
              kind: 'header',
              root: model.header.element || null,
              state: {
                connected: !!model.header.element?.isConnected,
                rendered: true,
                visible: model.activeSurfaceHint === 'page',
                interactive: true,
                blocksBelow: false
              },
              geometry: { rect: model.header.rect || null },
              ownership: { input: model.activeSurfaceHint === 'page', underlyingSurfaceId: pageSurfaceId },
              sections: [model.header],
              scrollContexts: [],
              metadata: { source: model.header.metadata?.source || 'header' }
            });
          }
        }

        if (model.modal) {
          const modalSurfaceId = `surface:${model.modal.type === 'drawer' ? 'drawer' : (model.modal.root?.matches?.('.actionSheet') ? 'action-sheet' : 'modal')}:${this.hashString(model.modal.id)}`;
          for (const section of model.modal.sections || []) this.decorateSectionV1(section, modalSurfaceId);

          surfaces.push({
            id: modalSurfaceId,
            kind: model.modal.type === 'drawer' ? 'drawer' : (model.modal.root?.matches?.('.actionSheet') ? 'action-sheet' : 'modal'),
            root: model.modal.root || null,
            state: {
              connected: !!model.modal.root?.isConnected,
              rendered: !!model.modal.root && this.isRendered(model.modal.root),
              visible: model.activeSurfaceHint === 'modal',
              interactive: true,
              blocksBelow: true
            },
            geometry: { rect: model.modal.metadata?.rootRect || this.rectSnapshot(model.modal.root) },
            ownership: { input: model.activeSurfaceHint === 'modal', underlyingSurfaceId: pageSurfaceId },
            sections: model.modal.sections || [],
            scrollContexts: (model.modal.sections || []).map(section => section.scrollContext).filter(Boolean),
            metadata: {
              title: model.modal.metadata?.title || null,
              source: model.modal.metadata?.detectedBy || 'overlay'
            }
          });
        }

        if (model.activeSurfaceHint === 'player') {
          const root = this.findPlayerRoot();
          surfaces.push({
            id: 'surface:player',
            kind: 'player',
            root,
            state: {
              connected: !!root?.isConnected,
              rendered: !!root && this.isRenderedRelaxed(root),
              visible: true,
              interactive: false,
              blocksBelow: true
            },
            geometry: { rect: this.rectSnapshot(root) },
            ownership: { input: true, underlyingSurfaceId: pageSurfaceId },
            sections: [],
            scrollContexts: [],
            metadata: { controlMode: document.documentElement.classList.contains('airnav-force-player-osd') ? 'active' : 'passive' }
          });
        }

        return surfaces;
      }

      findActivePageRoot() {
        const candidates = Array.from(document.querySelectorAll('.page, [data-role="page"], .mainAnimatedPage, main'));
        return candidates.find(element => {
          if (!element?.isConnected) return false;
          if (element.classList?.contains('hide') || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth;
        }) || document.body;
      }

      findPlayerRoot() {
        return document.querySelector('.videoPlayerContainer, .videoOsdBottom') || null;
      }

      isRenderedRelaxed(element) {
        if (!element?.isConnected) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
        return true;
      }

      hasDirectPointerIntent(element, computedStyle = null) {
        if (!element?.isConnected) return false;
        let style = computedStyle;
        try { style = style || getComputedStyle(element); } catch (_) { return false; }
        if (style?.cursor !== 'pointer') return false;

        // Semantic controls do not depend on cursor inference at all. Returning
        // true here only preserves useful diagnostic evidence for them.
        try {
          if (element.matches(this.cfg.genericInteractiveSelector) ||
              element.matches(this.cfg.genericSuspiciousSelector)) return true;
        } catch (_) {}

        const parent = element.parentElement;
        if (!parent?.isConnected) return true;
        try {
          return getComputedStyle(parent).cursor !== 'pointer';
        } catch (_) {
          return true;
        }
      }

      isInactiveCarouselCandidate(element) {
        if (!element?.closest) return false;
        const slide = element.closest('.slide');
        if (!slide) return false;
        const container = slide.closest(this.cfg.heroContainerSelector);
        if (!container) return false;
        return !slide.classList.contains('active');
      }

      genericCandidateSnapshot(element) {
        const rect = this.rectSnapshot(element);
        const kind = this.classifySemanticKind(element, null);
        const visibility = this.describeItemVisibility(element, rect);
        const evidence = [];
        if (element.matches?.('button, a[href], input, select, textarea')) evidence.push('native-semantic');
        if (element.getAttribute?.('role')) evidence.push(`role:${element.getAttribute('role')}`);
        if (element.getAttribute?.('tabindex') != null) evidence.push('tabindex');
        if (element.dataset?.action) evidence.push('data-action');
        if (element.dataset?.itemId || element.dataset?.mediaId || element.getAttribute?.('data-item-id') || element.getAttribute?.('data-media-id')) evidence.push('data-identity');
        let style = null;
        try { style = getComputedStyle(element); } catch (_) {}
        if (style?.cursor === 'pointer') {
          evidence.push(
            this.hasDirectPointerIntent(element, style)
              ? 'cursor-pointer-direct'
              : 'cursor-pointer-inherited'
          );
        }

        return {
          kind,
          element,
          path: this.selectorHint(element),
          title: this.getElementTitle(element, element),
          rect,
          visibility,
          evidence,
          confidence: evidence.includes('native-semantic') ? 1 : evidence.some(v => v.startsWith('role:')) ? 0.97 : evidence.includes('tabindex') ? 0.9 : evidence.includes('data-action') ? 0.86 : evidence.includes('cursor-pointer-direct') ? 0.62 : 0.45
        };
      }

      collectGenericCandidates(options = {}) {
        const max = Math.max(100, Number(options.limit) || Number(this.cfg.auditCandidateLimit) || 12000);
        const includeCursorPointer = options.includeCursorPointer !== false;
        const queryRoot = options.root instanceof Element ? options.root : document;
        const candidates = [];
        const seen = new Set();
        let semantic = [];
        let suspicious = [];

        try {
          semantic = Array.from(queryRoot.querySelectorAll(this.cfg.genericInteractiveSelector));
          if (queryRoot instanceof Element && queryRoot.matches?.(this.cfg.genericInteractiveSelector)) semantic.unshift(queryRoot);
        } catch (_) {}
        try {
          suspicious = Array.from(queryRoot.querySelectorAll(this.cfg.genericSuspiciousSelector));
          if (queryRoot instanceof Element && queryRoot.matches?.(this.cfg.genericSuspiciousSelector)) suspicious.unshift(queryRoot);
        } catch (_) {}

        for (const element of [...semantic, ...suspicious]) {
          if (!element?.isConnected || seen.has(element)) continue;
          seen.add(element);
          candidates.push(this.genericCandidateSnapshot(element));
          if (candidates.length >= max) break;
        }

        // Computed cursor:pointer is useful for script-bound plugin DIVs that
        // have no semantic attributes. Bound the scan to avoid turning audit
        // mode into an expensive whole-document hot path.
        if (includeCursorPointer && candidates.length < max) {
          let inspected = 0;
          for (const element of queryRoot.querySelectorAll('div, span, label')) {
            if (++inspected > 5000 || candidates.length >= max) break;
            if (seen.has(element) || !element.isConnected) continue;
            let style;
            try { style = getComputedStyle(element); } catch (_) { continue; }
            if (style.cursor !== 'pointer') continue;
            if (!this.hasDirectPointerIntent(element, style)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            seen.add(element);
            candidates.push(this.genericCandidateSnapshot(element));
          }
        }

        return candidates;
      }

      modelCollectionValues(value, shape = 'item') {
        if (value == null) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Map || value instanceof Set) return Array.from(value.values());
        if (typeof value !== 'object') return [];

        try {
          if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
        } catch (_) {}

        // Compatibility data can expose collections either as arrays or keyed
        // objects. Preserve an object that already looks like one concrete model
        // node; otherwise treat a plain object as a keyed collection.
        const looksSingle = (() => {
          if (shape === 'context') {
            return 'items' in value || 'ownerItemKey' in value ||
              'entryPolicy' in value || 'restorePolicy' in value;
          }
          if (shape === 'section') {
            return 'items' in value && ('id' in value || 'kind' in value || 'root' in value);
          }
          if (shape === 'surface') {
            return 'sections' in value && ('id' in value || 'kind' in value || 'root' in value);
          }
          return 'element' in value || 'activationTarget' in value ||
            'key' in value || 'instanceKey' in value;
        })();

        return looksSingle ? [value] : Object.values(value).filter(Boolean);
      }

      emittedElementSet(model) {
        const set = new Set();
        const visitedItems = new Set();
        const visitedSections = new Set();
        const addItem = item => {
          if (!item || visitedItems.has(item)) return;
          visitedItems.add(item);
          if (item?.element) set.add(item.element);
          if (item?.activationTarget) set.add(item.activationTarget);
          for (const action of this.modelCollectionValues(item?.actions, 'item')) {
            if (action?.element) set.add(action.element);
            if (action?.activationTarget) set.add(action.activationTarget);
          }
          for (const control of this.modelCollectionValues(item?.controls, 'item')) {
            if (control?.element) set.add(control.element);
            if (control?.activationTarget) set.add(control.activationTarget);
          }
          for (const child of this.modelCollectionValues(item?.childContexts, 'context')) {
            for (const childItem of this.modelCollectionValues(child?.items, 'item')) addItem(childItem);
          }
        };
        const addSection = section => {
          if (!section || visitedSections.has(section)) return;
          visitedSections.add(section);
          for (const item of this.modelCollectionValues(section?.items, 'item')) addItem(item);
        };

        if (model?.header) addSection(model.header);
        for (const section of this.modelCollectionValues(model?.sections, 'section')) addSection(section);
        for (const section of this.modelCollectionValues(model?.modal?.sections, 'section')) addSection(section);
        // Scanner v1 production-only semantic controls live on Surface.sections
        // during the compatibility phase and intentionally do not appear in the
        // legacy top-level projection. Audit must count those as emitted too.
        for (const surface of this.modelCollectionValues(model?.surfaces, 'surface')) {
          for (const section of this.modelCollectionValues(surface?.sections, 'section')) addSection(section);
        }
        return set;
      }

      emittedItemCount(model) {
        const keys = new Set();
        const objects = new Set();
        const visitedSections = new Set();
        const addItem = item => {
          if (!item || objects.has(item)) return;
          objects.add(item);
          if (item.key) keys.add(item.key);
          else keys.add(`object:${objects.size}`);
          for (const child of this.modelCollectionValues(item?.childContexts, 'context')) {
            for (const childItem of this.modelCollectionValues(child?.items, 'item')) addItem(childItem);
          }
        };
        const addSection = section => {
          if (!section || visitedSections.has(section)) return;
          visitedSections.add(section);
          for (const item of this.modelCollectionValues(section?.items, 'item')) addItem(item);
        };
        if (model?.header) addSection(model.header);
        for (const section of this.modelCollectionValues(model?.sections, 'section')) addSection(section);
        for (const section of this.modelCollectionValues(model?.modal?.sections, 'section')) addSection(section);
        for (const surface of this.modelCollectionValues(model?.surfaces, 'surface')) {
          for (const section of this.modelCollectionValues(surface?.sections, 'section')) addSection(section);
        }
        return keys.size;
      }

      audit() {
        const model = this.model || this.scan('audit:no-model');
        const emitted = this.emittedElementSet(model);
        const candidates = this.collectGenericCandidates();
        const unknownLimit = Math.max(10, Number(this.cfg.auditUnknownLimit) || 120);
        const rejected = {
          disconnected: 0,
          notRendered: 0,
          disabled: 0,
          emitted: 0,
          inactiveSurface: 0,
          inactiveCarousel: 0,
          scrollChrome: 0,
          redundantCardActivation: 0,
          wrapperOrDecorative: 0
        };
        const unknownInteractiveCandidates = [];
        let unknownInteractiveTotal = 0;

        for (const candidate of candidates) {
          const element = candidate.element;
          if (emitted.has(element)) {
            rejected.emitted += 1;
            continue;
          }
          if (!candidate.visibility.connected) {
            rejected.disconnected += 1;
            continue;
          }
          if (!candidate.visibility.rendered) {
            rejected.notRendered += 1;
            continue;
          }
          if (!candidate.visibility.enabled) {
            rejected.disabled += 1;
            continue;
          }

          // Jellyfin keeps the hamburger drawer mounted at left:-320px when
          // closed. Those links are valid controls on an inactive surface, not
          // missing items on the active page.
          if (
            element.closest?.('.mainDrawer, .mainDrawer-scrollContainer') &&
            !candidate.visibility.viewportVisible
          ) {
            rejected.inactiveSurface += 1;
            continue;
          }

          if (this.isInactiveCarouselCandidate(element)) {
            rejected.inactiveCarousel += 1;
            continue;
          }

          // Row scroll-arrow buttons are implementation chrome. Directional
          // navigation owns row reveal/scrolling and should not surface these as
          // logical navigation targets.
          if (element.matches?.('.emby-scrollbuttons-button')) {
            rejected.scrollChrome += 1;
            continue;
          }

          // Card title/subtitle anchors duplicate the containing card's primary
          // activation and are intentionally normalized into the media item.
          if (
            element.matches?.('.textActionButton') &&
            element.closest?.(this.cfg.itemSelector)
          ) {
            rejected.redundantCardActivation += 1;
            continue;
          }

          const nestedConcrete = element.querySelector?.('button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="switch"]');
          if (nestedConcrete && element !== nestedConcrete && candidate.confidence < 0.9) {
            rejected.wrapperOrDecorative += 1;
            continue;
          }

          unknownInteractiveTotal += 1;
          if (unknownInteractiveCandidates.length < unknownLimit) {
            unknownInteractiveCandidates.push({
              kind: candidate.kind,
              title: candidate.title,
              path: candidate.path,
              confidence: candidate.confidence,
              evidence: candidate.evidence,
              rect: candidate.rect,
              visibility: candidate.visibility
            });
          }
        }

        const itemCount = this.emittedItemCount(model);
        const candidateLimit = Math.max(100, Number(this.cfg.auditCandidateLimit) || 12000);

        this.lastAudit = {
          version: VERSION,
          schemaVersion: MODEL_SCHEMA_VERSION,
          modelVersion: model?.modelVersion ?? model?.version ?? null,
          route: model?.route || this.detectRoute(),
          activeSurfaceId: model?.activeSurfaceId || null,
          activeSurfaceHint: model?.activeSurfaceHint || null,
          candidatesFound: candidates.length,
          candidateLimit,
          candidateLimitReached: candidates.length >= candidateLimit,
          emittedItems: itemCount,
          emittedElements: emitted.size,
          rejected,
          unknownInteractiveCount: unknownInteractiveTotal,
          unknownInteractiveSampleCount: unknownInteractiveCandidates.length,
          unknownInteractiveCandidates,
          warnings: [
            ...(candidates.length >= candidateLimit
              ? [`Audit candidate limit ${candidateLimit} was reached; results may be truncated.`]
              : []),
            ...(unknownInteractiveTotal
              ? [`${unknownInteractiveTotal} interactive candidates are not represented in the production model; inspect the sample before adding an adapter.`]
              : [])
          ]
        };

        return this.lastAudit;
      }

      decorateProductionModel(model, reason = 'scan') {
        if (!model) return model;
        const surfaces = this.buildSurfaceModel(model);
        const active = model.activeSurfaceHint === 'player'
          ? surfaces.find(surface => surface.kind === 'player')
          : model.activeSurfaceHint === 'modal'
            ? [...surfaces].reverse().find(surface => ['drawer', 'modal', 'action-sheet'].includes(surface.kind))
            : surfaces.find(surface => surface.kind === 'page');

        model.schemaVersion = MODEL_SCHEMA_VERSION;
        model.modelVersion = model.version;
        model.generatedAt = performance.now();
        model.routeInfo = {
          hash: location.hash || '',
          pathname: location.pathname || '',
          search: location.search || '',
          semanticHint: this.routeSemanticHint(model.route)
        };
        model.activeSurfaceId = active?.id || null;
        model.surfaces = surfaces;
        model.surfaceStack = surfaces.map(surface => surface.id);
        model.diagnostics = {
          scanReason: reason,
          fullScan: !String(reason).includes('geometry'),
          candidateCount: null,
          itemCount: [
            ...(model.header?.items || []),
            ...(model.sections || []).flatMap(section => section.items || []),
            ...(model.modal?.sections || []).flatMap(section => section.items || [])
          ].length,
          rejectedCount: null,
          unknownInteractiveCount: this.lastAudit?.unknownInteractiveCount ?? null,
          structureDirty: this.structureDirty,
          geometryDirty: this.geometryDirty,
          stateDirty: this.stateDirty
        };

        return model;
      }

      routeSemanticHint(route) {
        const value = String(route || '').toLowerCase();
        if (value.includes('/home')) return 'home';
        if (value.includes('/search')) return 'search';
        if (value.includes('/details')) return 'details';
        if (value.includes('/movies')) return 'library';
        if (value.includes('/tv')) return 'library';
        if (value.includes('/mypreferences')) return 'settings';
        if (value.includes('/login')) return 'login';
        if (value.includes('/video')) return 'player';
        return null;
      }

      // ------------------------------------------------------------------
      // Logical versioning / debug output
      // ------------------------------------------------------------------
      makeLogicalSignature(model) {
        const sectionSignature = (section) => section ? {
          id: section.id,
          type: section.type,
          title: section.title,
          items: section.items.map(item => ({
            key: item.key,
            type: item.type,
            enabled: item.state.enabled,
            actions: (item.actions || []).map(action => ({
              key: action.key,
              action: action.action,
              enabled: action.enabled !== false
            }))
          }))
        } : null;

        return JSON.stringify({
          route: model.route,
          activeSurfaceHint: model.activeSurfaceHint,
          header: sectionSignature(model.header),
          sections: model.sections.map(sectionSignature),
          modal: model.modal ? {
            id: model.modal.id,
            type: model.modal.type,
            defaultItemKey: model.modal.defaultItemKey,
            closeActionKey: model.modal.closeActionKey || null,
            dismissMode: model.modal.dismissMode || null,
            sections: (model.modal.sections || []).map(sectionSignature)
          } : null
        });
      }

      logModel(reason) {
        if (!this.cfg.debug || !this.model) return;

        const headerCount = this.model.header ? this.model.header.items.length : 0;
        console.log(
          `[AirNav.Scanner] model v${this.model.version} route=${this.model.route} ` +
          `surface=${this.model.activeSurfaceHint} header=${headerCount} sections=${this.model.sections.length} reason=${reason}`
        );

        if (this.model.sections.length) {
          console.table(this.model.sections.map(section => ({
            id: section.id,
            title: section.title,
            type: section.type,
            items: section.items.length,
            scroll: section.metadata.scrollMode,
            virtualized: section.metadata.virtualized
          })));
        }

        console.debug('[AirNav.Scanner] NavigationModel', this.model);
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      MODEL_SCHEMA_VERSION,
      production: true,

      create(options = {}) {
        if (!instance) instance = new JellyfinAirScanner(options);
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
        return !!instance;
      },

      getModel() {
        return instance ? instance.getModel() : null;
      },

      getNavigationModel() {
        return instance ? instance.getNavigationModel() : null;
      },

      getSurfaceStack() {
        return instance ? instance.getSurfaceStack() : [];
      },

      scan(reason = 'manual') {
        return instance ? instance.scan(reason) : null;
      },

      refreshGeometry(reason = 'geometry-refresh') {
        return instance ? instance.refreshGeometry(reason) : null;
      },

      prepareForInput(action = 'INPUT') {
        return instance ? instance.prepareForInput(action) : null;
      },

      enterPageInlineGroup(groupKey) {
        return instance
          ? instance.enterPageInlineGroup(
              groupKey
            )
          : {
              handled: false,
              reason:
                'scanner-not-created'
            };
      },

      exitPageInlineGroup(reason = 'back') {
        return instance
          ? instance.exitPageInlineGroup(
              reason
            )
          : {
              handled: false,
              reason:
                'scanner-not-created'
            };
      },

      getPageInlineGroupState() {
        return instance
          ? instance.getPageInlineGroupState()
          : {
              active: false,
              groupKey: null,
              groupId: null,
              childKeys: []
            };
      },

      scanModalPositionGrid(itemKey) {
        return instance
          ? instance.scanModalPositionGrid(
              itemKey
            )
          : {
              handled: false,
              reason:
                'scanner-not-created'
            };
      },

      getDiagnostics() {
        return instance ? instance.getDiagnostics() : null;
      },

      audit() {
        return instance ? instance.audit() : this.create().audit();
      },

      compatibilityReport() {
        const takeoverActive = QoL.airScanner === api;
        const legacyPresent = !!QoL.airScanner && QoL.airScanner !== api;
        const model = instance?.getModel?.() || null;
        return {
          version: VERSION,
          legacyVersion: LEGACY_VERSION,
          schemaVersion: MODEL_SCHEMA_VERSION,
          production: true,
          ready: true,
          takeoverReady: true,
          takeoverActive,
          passiveComparisonMode: legacyPresent,
          legacyPresent,
          genericSurfaceInference: true,
          genericFormInference: true,
          capabilityModel: true,
          entityInstanceIdentity: true,
          childContexts: true,
          mutationClassification: true,
          resizeObserver: typeof ResizeObserver === 'function',
          auditApi: true,
          currentModelVersion: model?.modelVersion ?? model?.version ?? null,
          activeSurfaceHint: model?.activeSurfaceHint || null,
          activeSurfaceId: model?.activeSurfaceId || null
        };
      },

      on,
      off
    };

    return api;
  })();

  const existingScanner = QoL.airScanner || null;
  QoL.navigationScannerRuntime = productionApi;

  if (!existingScanner || existingScanner === productionApi) {
    QoL.airScanner = productionApi;
    console.log(LOG, 'Production Navigation Scanner registered as window.JellyfinQoL.airScanner.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected Scanner detected; production Scanner is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }

})(window.JellyfinQoL = window.JellyfinQoL || {});
