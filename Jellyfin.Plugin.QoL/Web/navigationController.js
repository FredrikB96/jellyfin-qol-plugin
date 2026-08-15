// Jellyfin Air Navigation - Phase 12.1.3 BACK Surface Guard
// Extends the B8 controller by asking Scanner for a fresh structural/geometry
// snapshot immediately before canonical directional input is resolved.
//
// Responsibilities:
//   - Consume canonical AirNav actions.
//   - Route directional actions to GeometryEngine.
//   - Create the initial logical selection on first navigation input.
//   - Perform basic ACTIVATE using the selected NavigationItem.
//   - Yield when modal/player/native UI owns input.
//   - Publish controller/action/context events.
//
// It MUST NOT know keyboard key codes, remotes, gamepads, plugin selectors,
// scrolling internals, or Jellyfin-specific DOM structure.
//
// Requires when create()/enable() is called:
//   JellyfinQoL.airScanner
//   JellyfinQoL.airFocus
//   JellyfinQoL.airGeometry
//   JellyfinQoL.airScroll

// Jellyfin QoL - Production Navigation Controller v1.0.0
// Legacy compatibility: Phase 12.1.3 BACK Surface Guard.
//
// The production API remains passive while the injected Controller owns
// JellyfinQoL.airNav. Disable only the old Controller and reload to transfer
// ownership without changing the canonical input contract.
(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '12.1.3';
  const LOG = '[JellyfinQoL.NavigationController]';

  const productionApi = (function () {
    const NAV_ACTION = Object.freeze({
      UP: 'UP',
      DOWN: 'DOWN',
      LEFT: 'LEFT',
      RIGHT: 'RIGHT',
      ACTIVATE: 'ACTIVATE',
      BACK: 'BACK',
      ENTER_ACTIONS: 'ENTER_ACTIONS',
      MENU: 'MENU',
      HOME: 'HOME',
      PLAY_PAUSE: 'PLAY_PAUSE',
      TOGGLE_CONTROL: 'TOGGLE_CONTROL',
      TOGGLE_SEARCH_HANDOFF: 'TOGGLE_SEARCH_HANDOFF'
    });

    const VALID_ACTIONS = new Set(Object.values(NAV_ACTION));

    const DEFAULTS = {
      debug: false,
      initialSelectionScope: 'content',

      // Phase 8 will implement alternate card action policies.
      cardActivate: 'openDetails',

      // Directional repeats are accepted. Activation/back/action-entry repeats
      // are blocked unless a future binding/profile explicitly opts in.
      allowDirectionalRepeat: true,

      // External search-field anchors use the same scoring shape as the
      // GeometryEngine without teaching GeometryEngine about DOM text inputs.
      externalAnchor: {
        epsilonPx: 4,
        primaryAxisWeight: 1.0,
        secondaryAxisWeight: 1.8,
        overlapReward: 220,
        minimumPerpendicularOverlap: 0.18,
        offAxisThresholdPx: 180,
        offAxisPenalty: 160,

        // A previously-owned search field is a deliberate logical neighbour.
        // Give it a modest preference over nearby header/card candidates when
        // their geometry is otherwise comparable.
        returnBias: 90
      },

      // Jellyfin SPA detail/home pages populate asynchronously. One input can
      // arrive after the hash changed but before Scanner has a usable model.
      initialSelectionRetryMs: 90,
      initialSelectionRetryAttempts: 3,

      // Some Jellyfin/plugin card handlers can temporarily fail to respond to
      // HTMLElement.click() after SPA back/forward transitions. For real href
      // targets, verify that the route changed and use the href as a defensive
      // fallback if it did not.
      // Initial activation-outcome probe. This is no longer a blind redirect
      // timer: Controller first checks whether the click opened a modal or
      // changed route before considering a details-route recovery.
      activationRouteFallbackMs: 120,
      activationRouteFallbackPollMs: 100,
      activationRouteFallbackMaxWaitMs: 650,

      // BACK is context-aware:
      //   CONTROL_EDIT -> parent form/group
      //   MODAL_GROUP  -> modal settings navigation
      //   MODAL        -> close modal
      //   ITEM_ACTIONS -> parent card
      //   PAGE         -> previous internal Jellyfin route
      //
      // Page history is deliberately AirNav-local. If there is no known
      // previous Jellyfin route, BACK clamps instead of accidentally leaving
      // the Jellyfin web app/browser wrapper.
      pageBack: {
        enabled: true,
        maxEntries: 48,
        fallbackDelayMs: 550,

        // BrowserBack / mouse XButton1 can be firmware/browser-owned and on
        // some wrappers cannot be fully cancelled by JavaScript. For those
        // inputs, briefly wait for Scanner to observe the native Back before
        // invoking history.back() ourselves. This prevents double navigation
        // while keeping ordinary Escape/keyboard BACK immediate.
        nativeNavigationProbeMs: 135
      }
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
          console.error(`[AirNav.Controller] listener failed for ${event}`, error);
        }
      });
    }

    function getGlobalSettings() {
      let settings = QoL.settings || {};

      if (typeof QoL.getSettings === 'function') {
        try {
          settings = QoL.getSettings() || settings;
        } catch (error) {
          console.warn(
            '[AirNav.Controller] QoL.getSettings() failed; using local settings.',
            error
          );
        }
      }

      return settings;
    }

    class AirNavController {
      constructor(options = {}) {
        const settings = getGlobalSettings();
        const airNavSettings = settings.airNav || {};
        const behavior = airNavSettings.behavior || {};
        const controllerSettings = airNavSettings.controller || {};

        this.cfg = Object.assign(
          {},
          DEFAULTS,
          {
            cardActivate:
              behavior.cardActivate ||
              DEFAULTS.cardActivate
          },
          controllerSettings,
          options
        );

        this.cfg.pageBack = Object.assign(
          {},
          DEFAULTS.pageBack,
          controllerSettings.pageBack || {},
          options.pageBack || {}
        );

        this.cfg.debug = !!(
          this.cfg.debug ||
          airNavSettings.debug ||
          settings.DEBUG
        );

        this.enabled = false;
        this.mode = 'DISABLED';
        this.lastAction = null;
        this.lastActivation = null;
        this.textControlOverride = false;
        this.textHandoffAnchor = null;
        this.nativeControlOverride = false;

        this.initialSelectionRetryTimer = null;
        this.initialSelectionRetryToken = 0;
        this.activationFallbackTimer = null;
        this.activationFallbackToken = 0;
        this.lastActivationOutcome = null;

        // Internal route history is intentionally independent of physical
        // input and browser history length. It tracks Jellyfin routes observed
        // by Scanner and gives canonical BACK a safe page-level target.
        this.pageRouteHistory = [];
        this.pageBackPending = null;
        this.pageBackFallbackTimer = null;
        this.pageBackNativeProbeTimer = null;
        this.lastPageBack = null;

        // Diagnostics for the synchronous BACK surface check. This tells us
        // whether BACK was resolved against page/modal/player state freshly
        // discovered on that exact input rather than a stale Controller mode.
        this.lastBackSurfaceGuard = null;

        this.unsubscribeFocus = null;
        this.unsubscribeModel = null;
        this.unsubscribeModalOpened = null;
        this.unsubscribeModalClosed = null;
        this.unsubscribeRoute = null;

        this.enable();
      }

      enable() {
        if (this.enabled) return this;

        if (
          !QoL.airScanner ||
          !QoL.airFocus ||
          !QoL.airGeometry ||
          !QoL.airScroll ||
          !QoL.airModal
        ) {
          console.error(
            '[AirNav.Controller] Scanner/Focus/Geometry/Scroll/Modal must be loaded first.'
          );
          return this;
        }

        QoL.airScanner.create();
        QoL.airFocus.create();
        QoL.airGeometry.create();
        QoL.airScroll.create();

        this.seedPageRouteHistory(
          this.getCurrentRoute(),
          'enable'
        );

        this.unsubscribeFocus = QoL.airFocus.on(
          'selectionChanged',
          event => emit('selectionChanged', event)
        );

        this.unsubscribeModel = QoL.airScanner.on(
          'modelChanged',
          model => this.handleModelState(model, 'modelChanged')
        );

        this.unsubscribeModalOpened = QoL.airScanner.on(
          'modalOpened',
          context => {
            this.cancelActivationRouteFallback(
              'modal-opened'
            );

            // If a quick action opened the modal, leave the child action strip
            // but preserve its parent card in FocusManager as the return key.
            QoL.airItemActions?.exit?.(
              'modal-opened'
            );

            const returnState =
              this.captureReturnState();

            const modalResult =
              QoL.airModal?.enter?.(
                context,
                returnState,
                'scanner:modalOpened'
              ) || null;

            this.updateMode(
              modalResult?.handled
                ? 'MODAL_NAVIGATION'
                : 'MODAL_PENDING',
              {
                reason: 'modalOpened',
                context,
                returnState,
                modalResult
              }
            );
          }
        );

        this.unsubscribeModalClosed = QoL.airScanner.on(
          'modalClosed',
          info => {
            const restore =
              QoL.airModal?.handleClosed?.(
                info,
                'scanner:modalClosed'
              ) || null;

            const model = QoL.airScanner.getModel();
            this.handleModelState(model, 'modalClosed');

            emit('contextChanged', {
              mode: this.mode,
              reason: 'modalClosed',
              info,
              restore
            });
          }
        );

        this.unsubscribeRoute = QoL.airScanner.on(
          'routeChanged',
          route => {
            this.cancelActivationRouteFallback(
              'route-changed'
            );

            const pageHistory =
              this.handlePageRouteChanged(
                route,
                'scanner:routeChanged'
              );

            const anchor =
              this.textHandoffAnchor;

            const searchHandoff =
              (
                anchor &&
                !this.isTextHandoffAnchorCurrentRoute(
                  anchor,
                  route
                )
              )
                ? this.clearTextHandoff(
                    'route-surface-changed'
                  )
                : null;

            emit('contextChanged', {
              mode: this.mode,
              reason: 'routeChanged',
              route,
              searchHandoff,
              pageHistory
            });
          }
        );

        this.enabled = true;
        this.handleModelState(QoL.airScanner.getModel(), 'enable');
        this.log('enabled');
        return this;
      }

      disable() {
        if (!this.enabled) return;

        QoL.airItemActions?.exit?.(
          'controller-disable'
        );

        QoL.airModal?.exit?.(
          'controller-disable',
          { restore: false }
        );

        this.cancelInitialSelectionRetry();

        this.cancelActivationRouteFallback(
          'controller-disable'
        );

        this.cancelPageBackFallback(
          'controller-disable'
        );

        this.pageBackPending = null;
        this.pageRouteHistory = [];

        for (const unsubscribe of [
          this.unsubscribeFocus,
          this.unsubscribeModel,
          this.unsubscribeModalOpened,
          this.unsubscribeModalClosed,
          this.unsubscribeRoute
        ]) {
          try {
            if (typeof unsubscribe === 'function') unsubscribe();
          } catch (_) {}
        }

        this.unsubscribeFocus = null;
        this.unsubscribeModel = null;
        this.unsubscribeModalOpened = null;
        this.unsubscribeModalClosed = null;
        this.unsubscribeRoute = null;

        this.enabled = false;
        this.updateMode('DISABLED', { reason: 'disable' });
        this.log('disabled');
      }

      destroy() {
        this.disable();
        try {
          QoL.airControlBridge?.exitNativeSurface?.();
          QoL.airControlBridge?.clearSavedText?.();
        } catch (_) {}
        this.textControlOverride = false;
        this.textHandoffAnchor = null;
        this.nativeControlOverride = false;
        this.lastAction = null;
        this.lastActivation = null;
      }

      handleModelState(model, reason = 'model') {
        if (!this.enabled) return;

        if (!model) {
          this.updateMode('WAITING_FOR_MODEL', { reason });
          return;
        }

        if (
          model.activeSurfaceHint !== 'page' &&
          QoL.airItemActions?.isActive?.()
        ) {
          QoL.airItemActions.exit?.(
            `surface-changed:${model.activeSurfaceHint}`
          );
        }

        if (model.activeSurfaceHint === 'player') {
          if (this.nativeControlOverride) {
            QoL.airControlBridge?.enterNativeSurface?.('player');
            this.updateMode('NATIVE_CONTROL', { reason, surface: 'player' });
          } else {
            this.updateMode('PLAYER_OWNED', { reason });
          }
          return;
        }

        if (model.activeSurfaceHint === 'modal') {
          if (this.nativeControlOverride) {
            QoL.airControlBridge?.enterNativeSurface?.('modal');
            this.updateMode('NATIVE_CONTROL', { reason, surface: 'modal' });
          } else {
            let modalResult = null;

            if (!QoL.airModal?.isActive?.()) {
              modalResult =
                QoL.airModal?.enter?.(
                  model.modal,
                  this.captureReturnState(),
                  `model:${reason}`
                ) || null;
            }

            this.updateMode(
              QoL.airModal?.isActive?.()
                ? 'MODAL_NAVIGATION'
                : 'MODAL_PENDING',
              {
                reason,
                modalResult
              }
            );
          }
          return;
        }

        if (this.nativeControlOverride) {
          this.nativeControlOverride = false;
          QoL.airControlBridge?.exitNativeSurface?.();
        }

        if (QoL.airItemActions?.isActive?.()) {
          this.updateMode(
            'ITEM_ACTIONS',
            { reason }
          );
          return;
        }

        this.updateMode('PAGE_NAVIGATION', { reason });
      }

      updateMode(nextMode, detail = {}) {
        const previous = this.mode;
        this.mode = nextMode;

        if (previous !== nextMode) {
          emit('contextChanged', {
            previous,
            mode: nextMode,
            ...detail
          });

          this.log(`mode ${previous} -> ${nextMode}`, detail);
        }
      }

      setCardActivatePolicy(policy, reason = 'api') {
        const requested =
          String(policy || '');

        const next =
          ['openDetails', 'activateTarget', 'enterActions', 'smart']
            .includes(requested)
            ? requested
            : 'openDetails';

        const previous = this.cfg.cardActivate;
        this.cfg.cardActivate = next;

        if (previous !== next) {
          emit('runtimeSettingChanged', {
            setting: 'behavior.cardActivate',
            previous,
            value: next,
            reason
          });
        }

        return {
          changed: previous !== next,
          previous,
          value: next,
          reason
        };
      }

      isSearchHandoffEnabled() {
        return QoL.settings?.airNav?.searchHandoff?.enabled !== false;
      }

      setSearchHandoffEnabled(enabled, reason = 'api') {
        QoL.settings = QoL.settings || {};
        QoL.settings.airNav = QoL.settings.airNav || {};
        QoL.settings.airNav.searchHandoff =
          QoL.settings.airNav.searchHandoff || {};

        const previous = this.isSearchHandoffEnabled();
        const next = !!enabled;

        QoL.settings.airNav.searchHandoff.enabled = next;

        if (previous !== next) {
          emit('settingChanged', {
            setting: 'searchHandoff.enabled',
            previous,
            value: next,
            reason
          });

          this.log(
            `search directional handoff ${next ? 'enabled' : 'disabled'}`,
            { reason }
          );
        }

        return next;
      }

      toggleSearchHandoff(reason = 'api') {
        return this.setSearchHandoffEnabled(
          !this.isSearchHandoffEnabled(),
          reason
        );
      }

      dispatch(inputEvent) {
        const event = this.normalizeActionEvent(inputEvent);

        if (!event) {
          return this.result(false, 'invalid-action-event');
        }

        if (!this.enabled) {
          return this.result(false, 'controller-disabled', { event });
        }

        this.lastAction = event;

        emit('action', event);

        let model = QoL.airScanner?.getModel?.();
        this.handleModelState(model, 'dispatch');

        // BACK is context-sensitive and must never be resolved from a stale
        // page mode. Plugin panels such as Jellyfin Enhanced can be inserted
        // between Scanner's debounced mutation passes. On the exact BACK press,
        // synchronously ask Scanner to compare the live DOM surface first.
        //
        // This preserves the ownership hierarchy:
        //   form edit -> inline group -> modal -> item actions -> page history.
        if (
          event.action === NAV_ACTION.BACK &&
          event.phase !== 'release'
        ) {
          const beforeMode =
            this.mode;

          const prepared =
            QoL.airScanner
              ?.prepareForInput?.(
                NAV_ACTION.BACK
              ) ||
            model;

          if (prepared) {
            model = prepared;
            this.handleModelState(
              model,
              'pre-back-surface-guard'
            );
          }

          this.lastBackSurfaceGuard = {
            timestamp:
              Date.now(),
            beforeMode,
            afterMode:
              this.mode,
            route:
              model?.route ||
              null,
            surface:
              model?.activeSurfaceHint ||
              null,
            modalId:
              model?.modal?.id ||
              null,
            modalConnected:
              !!model?.modal?.root
                ?.isConnected,
            modalNavigationActive:
              !!QoL.airModal
                ?.isActive?.()
          };
        }

        // B10: Jellyfin/HSS/Enhanced populate routes in async waves and row
        // transforms can still be moving between key presses. Before any page
        // directional action (including search handoff), ask Scanner to:
        //   1) full-scan if route/surface/structure changed; otherwise
        //   2) refresh live getBoundingClientRect geometry.
        // Scanner stays device-independent: Controller passes only the
        // canonical action, never KeyboardEvent/gamepad/remote details.
        const directionalInput =
          event.action === NAV_ACTION.UP ||
          event.action === NAV_ACTION.DOWN ||
          event.action === NAV_ACTION.LEFT ||
          event.action === NAV_ACTION.RIGHT;

        if (
          directionalInput &&
          event.phase !== 'release' &&
          (
            this.mode === 'PAGE_NAVIGATION' ||
            model?.activeSurfaceHint === 'page'
          )
        ) {
          const prepared =
            QoL.airScanner?.prepareForInput?.(
              event.action
            );

          if (prepared) {
            model = prepared;
            this.handleModelState(
              model,
              'pre-direction-input-refresh'
            );
          }
        }

        // Master gate for automatic search-field directional handoff.
        // This action is global, so it can be used while the search field owns
        // focus. When disabled, UP/DOWN remain entirely available to the input
        // or plugin that currently owns them.
        if (
          event.action === NAV_ACTION.TOGGLE_SEARCH_HANDOFF &&
          event.phase !== 'release'
        ) {
          if (event.phase === 'repeat') {
            return this.result(
              true,
              'toggle-search-handoff-repeat-blocked',
              { event }
            );
          }

          const enabled =
            this.toggleSearchHandoff('canonical-action');

          return this.result(
            true,
            enabled
              ? 'search-handoff-enabled'
              : 'search-handoff-disabled',
            { event, enabled }
          );
        }

        // Device-independent search handoff. Physical adapters only deliver
        // canonical UP/DOWN; the controller decides whether the currently
        // focused text field is a search anchor and whether navigable content
        // actually exists in the requested physical direction.
        if (
          (
            event.action === NAV_ACTION.UP ||
            event.action === NAV_ACTION.DOWN
          ) &&
          event.phase !== 'release' &&
          this.isSearchHandoffEnabled() &&
          this.isActiveSearchEntry(event)
        ) {
          if (event.phase === 'repeat') {
            return this.result(
              true,
              'text-handoff-repeat-blocked',
              { event }
            );
          }

          return this.dispatchTextHandoff(
            event,
            model
          );
        }

        if (
          event.action === NAV_ACTION.TOGGLE_CONTROL &&
          event.phase !== 'release'
        ) {
          if (event.phase === 'repeat') {
            return this.result(true, 'toggle-control-repeat-blocked', { event });
          }
          return this.dispatchToggleControl(event, model);
        }

        // Release is part of the public input envelope but Phase 6 navigation
        // operates on press/repeat only.
        if (event.phase === 'release') {
          return this.result(false, 'release-observed', { event });
        }

        // If a binding disallows repeat, the adapter still sends the envelope
        // so the controller can decide whether the current surface owns it.
        if (
          event.phase === 'repeat' &&
          event.raw?.allowRepeat === false &&
          (
            this.mode === 'PAGE_NAVIGATION' ||
            this.mode === 'ITEM_ACTIONS' ||
            this.mode === 'MODAL_NAVIGATION'
          )
        ) {
          return this.result(true, 'repeat-blocked', { event });
        }

        if (this.mode === 'NATIVE_CONTROL') {
          const nativeResult = QoL.airControlBridge?.dispatchNativeAction?.(
            event.action
          ) || {
            handled: false,
            reason: 'control-bridge-unavailable'
          };

          return this.result(
            !!nativeResult.handled,
            nativeResult.reason || 'native-control-result',
            { event, nativeResult }
          );
        }

        if (this.mode === 'PLAYER_OWNED') {
          return this.result(false, 'player-owned', { event });
        }

        if (this.mode === 'MODAL_NAVIGATION') {
          const modalResult =
            QoL.airModal?.dispatch?.(
              event.action
            ) || {
              handled: false,
              reason: 'modal-navigation-unavailable'
            };

          return this.result(
            !!modalResult.handled,
            modalResult.reason ||
              'modal-navigation-result',
            {
              event,
              modal: modalResult
            },
            // Modal navigation owns directional/activate/back even at edges so
            // browser/native focus cannot escape behind the overlay.
            [
              NAV_ACTION.UP,
              NAV_ACTION.DOWN,
              NAV_ACTION.LEFT,
              NAV_ACTION.RIGHT,
              NAV_ACTION.ACTIVATE,
              NAV_ACTION.BACK
            ].includes(event.action)
              ? true
              : null
          );
        }

        if (this.mode === 'MODAL_PENDING') {
          // A rendered modal shell owns BACK even when it has no usable
          // navigation targets. Yielding a physical BrowserBack here can move
          // Jellyfin history behind the still-open overlay.
          if (event.action === NAV_ACTION.BACK) {
            const pendingModal =
              model?.modal ||
              QoL.airScanner
                ?.getModel?.()
                ?.modal ||
              null;

            // First try to activate ModalNavigation against the live context.
            if (
              pendingModal?.root
                ?.isConnected
            ) {
              const entered =
                QoL.airModal?.enter?.(
                  pendingModal,
                  this.captureReturnState(),
                  'pending-modal-back'
                ) || null;

              if (
                QoL.airModal
                  ?.isActive?.()
              ) {
                this.updateMode(
                  'MODAL_NAVIGATION',
                  {
                    reason:
                      'pending-modal-back-entered',
                    modalResult:
                      entered
                  }
                );

                const modalResult =
                  QoL.airModal.dispatch(
                    NAV_ACTION.BACK
                  );

                return this.result(
                  !!modalResult
                    ?.handled,
                  modalResult?.reason ||
                    'pending-modal-back',
                  {
                    event,
                    modal:
                      modalResult,
                    entered
                  },
                  true
                );
              }

              // Very small defensive path for plugin panels with a close
              // button but no navigable controls. Scanner already discovered
              // the close action; click it directly rather than changing page.
              const closeAction =
                pendingModal
                  .closeAction;

              if (
                closeAction
                  ?.isConnected
              ) {
                try {
                  closeAction.click();

                  return this.result(
                    true,
                    'pending-modal-close-action',
                    {
                      event,
                      modalId:
                        pendingModal.id
                    },
                    true
                  );
                } catch (_) {
                  // Still consume BACK below. Leaving the page behind a modal
                  // is worse than clamping one failed close attempt.
                }
              }
            }

            return this.result(
              true,
              'modal-pending-back-clamped',
              {
                event,
                modalId:
                  pendingModal?.id ||
                  null
              },
              true
            );
          }

          return this.result(
            false,
            'modal-detected-no-navigation-targets',
            { event }
          );
        }

        if (this.mode === 'ITEM_ACTIONS') {
          const actionResult =
            QoL.airItemActions?.dispatch?.(
              event.action
            ) || {
              handled: false,
              reason: 'item-actions-unavailable'
            };

          if (!QoL.airItemActions?.isActive?.()) {
            this.updateMode(
              'PAGE_NAVIGATION',
              {
                reason:
                  actionResult.reason ||
                  'item-actions-exited'
              }
            );
          }

          return this.result(
            !!actionResult.handled,
            actionResult.reason ||
              'item-actions-result',
            {
              event,
              itemActions:
                actionResult
            },
            // Once inside ITEM_ACTIONS, all canonical navigation/activation
            // keys stay owned by AirNav so browser focus cannot escape.
            [
              NAV_ACTION.UP,
              NAV_ACTION.DOWN,
              NAV_ACTION.LEFT,
              NAV_ACTION.RIGHT,
              NAV_ACTION.ACTIVATE,
              NAV_ACTION.BACK,
              NAV_ACTION.ENTER_ACTIONS
            ].includes(event.action)
          );
        }

        if (this.mode !== 'PAGE_NAVIGATION') {
          return this.result(false, `mode:${this.mode}`, { event });
        }

        if (
          QoL.airPageForm?.isEditing?.() &&
          [
            NAV_ACTION.UP,
            NAV_ACTION.DOWN,
            NAV_ACTION.LEFT,
            NAV_ACTION.RIGHT,
            NAV_ACTION.ACTIVATE,
            NAV_ACTION.BACK
          ].includes(
            event.action
          )
        ) {
          const pageFormResult =
            QoL.airPageForm.dispatch(
              event.action
            );

          return this.result(
            !!pageFormResult.handled,
            pageFormResult.reason ||
              'page-form-edit-result',
            {
              event,
              pageForm:
                pageFormResult
            },
            true
          );
        }

        const pageInlineGroup =
          QoL.airScanner
            ?.getPageInlineGroupState?.();

        if (
          pageInlineGroup?.active
        ) {
          if (
            event.action ===
              NAV_ACTION.BACK
          ) {
            return this.dispatchExitPageInlineGroup(
              event,
              'back'
            );
          }

          if (
            event.action ===
              NAV_ACTION.UP ||
            event.action ===
              NAV_ACTION.DOWN ||
            event.action ===
              NAV_ACTION.LEFT ||
            event.action ===
              NAV_ACTION.RIGHT
          ) {
            return this.dispatchPageInlineGroupDirection(
              event
            );
          }

          // ACTIVATE falls through: expanded children are standard PageForm
          // items and reuse the existing select/button edit semantics.
        }

        if (event.action === NAV_ACTION.BACK) {
          return this.dispatchPageBack(
            event
          );
        }

        if (
          event.action === NAV_ACTION.UP ||
          event.action === NAV_ACTION.DOWN ||
          event.action === NAV_ACTION.LEFT ||
          event.action === NAV_ACTION.RIGHT
        ) {
          return this.dispatchDirection(event);
        }

        if (event.action === NAV_ACTION.ACTIVATE) {
          return this.dispatchActivate(event);
        }

        if (event.action === NAV_ACTION.ENTER_ACTIONS) {
          return this.dispatchEnterActions(event);
        }

        // PAGE BACK is handled above. HOME/MENU/PLAY_PAUSE still yield to
        // Jellyfin/native ownership; physical input remains device-independent.
        return this.result(false, 'yield-to-native', { event });
      }

      isActiveSearchEntry(event = null) {
        const active = document.activeElement;

        if (!active) return false;

        const tag = String(
          active.tagName || ''
        ).toLowerCase();

        const isTextEntry =
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          active.isContentEditable === true;

        if (!isTextEntry) return false;

        // Search handoff is deliberately limited to search-like single-purpose
        // fields. Ordinary forms, textareas and contentEditable remain native.
        if (
          tag === 'textarea' ||
          active.isContentEditable === true
        ) {
          return false;
        }

        const type = String(
          active.getAttribute?.('type') || ''
        ).toLowerCase();

        const role = String(
          active.getAttribute?.('role') || ''
        ).toLowerCase();

        const semantic = [
          active.id,
          active.getAttribute?.('name'),
          active.getAttribute?.('aria-label'),
          active.getAttribute?.('placeholder'),
          active.getAttribute?.('title'),
          typeof active.className === 'string'
            ? active.className
            : ''
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        return (
          type === 'search' ||
          role === 'searchbox' ||
          /\bsearch\b/.test(semantic) ||
          event?.raw?.searchEntryActive === true
        );
      }

      rectSnapshot(element) {
        if (
          !element?.isConnected ||
          typeof element.getBoundingClientRect !==
            'function'
        ) {
          return null;
        }

        const rect =
          element.getBoundingClientRect();

        if (
          !Number.isFinite(rect.left) ||
          !Number.isFinite(rect.top) ||
          !Number.isFinite(rect.width) ||
          !Number.isFinite(rect.height)
        ) {
          return null;
        }

        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX:
            rect.left + (rect.width / 2),
          centerY:
            rect.top + (rect.height / 2)
        };
      }

      makeTextHandoffAnchor(element) {
        const rect =
          this.rectSnapshot(element);

        if (!rect) return null;

        return {
          element,
          rect,
          route:
            QoL.airScanner?.getModel?.()?.route ||
            null,
          capturedAt: performance.now()
        };
      }

      getRouteSurface(route = null) {
        const raw =
          String(
            route ||
            this.getCurrentRoute() ||
            ''
          );

        // Search query text can legitimately change while the user remains on
        // the same search page, so scope the saved text handoff by route
        // SURFACE rather than by the full query string.
        const question =
          raw.indexOf('?');

        const surface =
          question >= 0
            ? raw.slice(0, question)
            : raw;

        return surface || '/';
      }

      isTextHandoffAnchorCurrentRoute(
        anchor = this.textHandoffAnchor,
        route = null
      ) {
        if (!anchor?.route) {
          return false;
        }

        return (
          this.getRouteSurface(
            anchor.route
          ) ===
          this.getRouteSurface(
            route ||
            QoL.airScanner?.getModel?.()?.route ||
            this.getCurrentRoute()
          )
        );
      }

      clearTextHandoff(
        reason = 'clear'
      ) {
        const previous =
          this.textHandoffAnchor;

        this.textControlOverride =
          false;
        this.textHandoffAnchor =
          null;

        try {
          QoL.airControlBridge
            ?.clearSavedText?.();
        } catch (_) {}

        if (previous) {
          this.log(
            'text handoff cleared',
            {
              reason,
              anchorRoute:
                previous.route || null,
              currentRoute:
                this.getCurrentRoute()
            }
          );
        }

        return {
          cleared: !!previous,
          reason,
          anchorRoute:
            previous?.route || null,
          currentRoute:
            this.getCurrentRoute()
        };
      }

      refreshTextHandoffAnchor() {
        const anchor =
          this.textHandoffAnchor;

        if (!anchor) {
          return null;
        }

        if (
          !this.isTextHandoffAnchorCurrentRoute(
            anchor
          )
        ) {
          this.clearTextHandoff(
            'stale-route-anchor'
          );
          return null;
        }

        if (anchor.element?.isConnected) {
          const rect =
            this.rectSnapshot(anchor.element);

          if (rect) {
            anchor.rect = rect;
          }
        }

        // Jellyfin may collapse/remove the search input when it loses DOM
        // focus. Keep the last known rect as an ExternalFocusAnchor so AirNav
        // can still navigate back to that logical location.
        return anchor.rect
          ? anchor
          : null;
      }

      findVisibleSearchEntry() {
        const candidates = [
          ...document.querySelectorAll(
            [
              'input[type="search"]',
              '[role="searchbox"]',
              'input[id*="search" i]',
              'input[name*="search" i]',
              'input[aria-label*="search" i]',
              'input[placeholder*="search" i]',
              'input[class*="search" i]'
            ].join(',')
          )
        ];

        return candidates.find(element => {
          if (
            !element?.isConnected ||
            typeof element.focus !== 'function'
          ) {
            return false;
          }

          const rect =
            this.rectSnapshot(element);

          if (!rect) return false;

          const style =
            getComputedStyle(element);

          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        }) || null;
      }

      focusSearchEntry(element) {
        if (
          !element?.isConnected ||
          typeof element.focus !== 'function'
        ) {
          return false;
        }

        try {
          element.focus({
            preventScroll: true
          });
        } catch (_) {
          try {
            element.focus();
          } catch (_) {
            return false;
          }
        }

        return document.activeElement === element;
      }

      reopenSearchEntryAsync() {
        const searchButton =
          document.querySelector(
            '.headerSearchButton'
          );

        if (
          !searchButton?.isConnected ||
          typeof searchButton.click !== 'function'
        ) {
          return {
            scheduled: false,
            reason: 'search-button-missing'
          };
        }

        try {
          searchButton.click();
        } catch (error) {
          return {
            scheduled: false,
            reason: 'search-button-click-failed',
            error
          };
        }

        const tryFocus = attempt => {
          const entry =
            this.findVisibleSearchEntry();

          if (entry && this.focusSearchEntry(entry)) {
            this.textHandoffAnchor =
              this.makeTextHandoffAnchor(entry);

            this.log(
              'search entry reacquired after Jellyfin reopened it',
              {
                attempt,
                element:
                  entry.id ||
                  entry.getAttribute?.('aria-label') ||
                  entry.getAttribute?.('placeholder') ||
                  entry.tagName
              }
            );

            return true;
          }

          return false;
        };

        requestAnimationFrame(() => {
          if (tryFocus('raf')) return;

          setTimeout(() => {
            if (tryFocus('50ms')) return;

            setTimeout(() => {
              tryFocus('150ms');
            }, 100);
          }, 50);
        });

        return {
          scheduled: true,
          reason: 'search-reopen-scheduled'
        };
      }

      scoreSearchAnchorFromItem(
        itemRect,
        anchorRect,
        direction
      ) {
        if (!itemRect || !anchorRect) {
          return null;
        }

        const pseudoItem = {
          key: '__airnav-search-anchor__',
          rect: anchorRect,
          element: null,
          state: {
            visible: true,
            enabled: true
          },
          metadata: {
            domIndex: -1
          }
        };

        const scored =
          this.scoreExternalCandidate(
            itemRect,
            pseudoItem,
            null,
            direction
          );

        if (!scored) return null;

        return {
          ...scored,
          score:
            scored.score -
            (
              Number(
                this.cfg.externalAnchor
                  ?.returnBias
              ) || 0
            )
        };
      }

      shouldReturnToSearchBeforeMove(
        model,
        direction
      ) {
        if (
          !this.isSearchHandoffEnabled() ||
          !this.textControlOverride ||
          (
            direction !== NAV_ACTION.UP &&
            direction !== NAV_ACTION.DOWN
          )
        ) {
          return {
            shouldReturn: false,
            reason: 'not-eligible'
          };
        }

        const anchor =
          this.refreshTextHandoffAnchor();

        if (
          anchor &&
          !this.isTextHandoffAnchorCurrentRoute(
            anchor,
            model?.route
          )
        ) {
          this.clearTextHandoff(
            'search-return-route-mismatch'
          );

          return {
            shouldReturn: false,
            reason:
              'search-anchor-route-mismatch'
          };
        }

        const selectedItem =
          QoL.airFocus?.getSelectedItem?.();

        if (
          !anchor?.rect ||
          !selectedItem?.rect ||
          !this.isRectInDirection(
            anchor.rect,
            selectedItem.rect,
            direction
          )
        ) {
          return {
            shouldReturn: false,
            reason:
              'search-anchor-not-in-direction',
            anchor,
            selectedItem
          };
        }

        const searchScore =
          this.scoreSearchAnchorFromItem(
            selectedItem.rect,
            anchor.rect,
            direction
          );

        const contentCandidate =
          this.findExternalContentCandidate(
            model,
            selectedItem.rect,
            direction
          );

        const shouldReturn =
          !contentCandidate ||
          (
            searchScore &&
            searchScore.score <=
              contentCandidate.score
          );

        return {
          shouldReturn,
          reason:
            shouldReturn
              ? 'search-anchor-preferred'
              : 'content-candidate-preferred',
          anchor,
          selectedItem,
          searchScore,
          contentCandidate
        };
      }

      returnToSavedSearch(
        event,
        context = {}
      ) {
        const bridge =
          QoL.airControlBridge;

        let bridgeResult = null;

        if (bridge?.hasSavedText?.()) {
          bridgeResult =
            bridge.returnToText?.();

          if (bridgeResult?.changed) {
            this.textControlOverride = false;
            QoL.airFocus?.clear?.(
              `text-handoff-${event.action.toLowerCase()}-return`
            );

            // Keep/re-capture the logical anchor while the field owns focus.
            const active =
              document.activeElement;

            if (this.isActiveSearchEntry()) {
              this.textHandoffAnchor =
                this.makeTextHandoffAnchor(
                  active
                );
            }

            return this.result(
              true,
              `text-handoff-${event.action.toLowerCase()}-return`,
              {
                event,
                bridgeResult,
                ...context
              }
            );
          }
        }

        // Jellyfin can remove the original input from the DOM when blur()
        // collapses the search UI. First try to reacquire an already-rendered
        // search field.
        const visibleEntry =
          this.findVisibleSearchEntry();

        if (
          visibleEntry &&
          this.focusSearchEntry(
            visibleEntry
          )
        ) {
          this.textControlOverride = false;
          this.textHandoffAnchor =
            this.makeTextHandoffAnchor(
              visibleEntry
            );

          QoL.airFocus?.clear?.(
            `text-handoff-${event.action.toLowerCase()}-return-reacquired`
          );

          return this.result(
            true,
            'text-handoff-search-reacquired',
            {
              event,
              bridgeResult,
              ...context
            }
          );
        }

        // Last resort: perform the same action as pressing Jellyfin's Search
        // header button, then reacquire/focus the newly-created input.
        const reopenResult =
          this.reopenSearchEntryAsync();

        if (reopenResult?.scheduled) {
          this.textControlOverride = false;

          QoL.airFocus?.clear?.(
            'text-handoff-search-reopen'
          );

          return this.result(
            true,
            'text-handoff-search-reopen',
            {
              event,
              bridgeResult,
              reopenResult,
              ...context
            }
          );
        }

        return this.result(
          false,
          'text-handoff-return-failed',
          {
            event,
            bridgeResult,
            reopenResult,
            ...context
          }
        );
      }

      isRectInDirection(
        candidateRect,
        anchorRect,
        direction
      ) {
        if (!candidateRect || !anchorRect) {
          return false;
        }

        const epsilon =
          Number(
            this.cfg.externalAnchor?.epsilonPx
          ) || 0;

        if (direction === NAV_ACTION.DOWN) {
          return (
            candidateRect.centerY >
            anchorRect.centerY + epsilon
          );
        }

        if (direction === NAV_ACTION.UP) {
          return (
            candidateRect.centerY <
            anchorRect.centerY - epsilon
          );
        }

        return false;
      }

      intervalOverlapRatio(
        a1,
        a2,
        b1,
        b2
      ) {
        const overlap =
          Math.max(
            0,
            Math.min(a2, b2) -
            Math.max(a1, b1)
          );

        const smallest =
          Math.max(
            1,
            Math.min(
              a2 - a1,
              b2 - b1
            )
          );

        return Math.max(
          0,
          Math.min(1, overlap / smallest)
        );
      }

      scoreExternalCandidate(
        anchorRect,
        item,
        section,
        direction
      ) {
        const cfg =
          this.cfg.externalAnchor ||
          DEFAULTS.externalAnchor;

        const rect = item.rect;

        const primaryAxisDistance =
          Math.abs(
            rect.centerY -
            anchorRect.centerY
          );

        const secondaryAxisDistance =
          Math.abs(
            rect.centerX -
            anchorRect.centerX
          );

        const overlapRatio =
          this.intervalOverlapRatio(
            anchorRect.left,
            anchorRect.right,
            rect.left,
            rect.right
          );

        const offAxisPenalty =
          overlapRatio <
            cfg.minimumPerpendicularOverlap &&
          secondaryAxisDistance >
            cfg.offAxisThresholdPx
            ? cfg.offAxisPenalty
            : 0;

        const score =
          primaryAxisDistance *
            cfg.primaryAxisWeight +
          secondaryAxisDistance *
            cfg.secondaryAxisWeight -
          overlapRatio *
            cfg.overlapReward +
          offAxisPenalty;

        return {
          item,
          section,
          score,
          primaryAxisDistance,
          secondaryAxisDistance,
          overlapRatio,
          offAxisPenalty,
          direction
        };
      }

      findExternalContentCandidate(
        model,
        anchorRect,
        direction
      ) {
        if (
          !model ||
          model.activeSurfaceHint !== 'page' ||
          !anchorRect
        ) {
          return null;
        }

        const candidates = [];

        // External focus anchors sit outside the normal NavigationModel item
        // graph, so their directional neighbour search must consider BOTH:
        //
        //   model.header   -> Home/Favorites/Search/profile/plugin actions
        //   model.sections -> shelves/results/content
        //
        // Phase 7.4A1 only searched model.sections, which made the search box
        // a one-way ceiling: results -> search worked, but search -> header did
        // not. Treat the header as just another logical candidate section here.
        const candidateSections = [
          ...(model.header ? [model.header] : []),
          ...(model.sections || [])
        ];

        for (const section of candidateSections) {
          for (
            const item of
            section.items || []
          ) {
            const rect = item?.rect;

            if (
              !item?.key ||
              !item?.element?.isConnected ||
              item.state?.visible === false ||
              item.state?.enabled === false ||
              !rect ||
              !Number.isFinite(rect.centerX) ||
              !Number.isFinite(rect.centerY) ||
              !this.isRectInDirection(
                rect,
                anchorRect,
                direction
              )
            ) {
              continue;
            }

            candidates.push(
              this.scoreExternalCandidate(
                anchorRect,
                item,
                section,
                direction
              )
            );
          }
        }

        candidates.sort((a, b) => {
          if (a.score !== b.score) {
            return a.score - b.score;
          }

          if (
            a.primaryAxisDistance !==
            b.primaryAxisDistance
          ) {
            return (
              a.primaryAxisDistance -
              b.primaryAxisDistance
            );
          }

          if (
            a.secondaryAxisDistance !==
            b.secondaryAxisDistance
          ) {
            return (
              a.secondaryAxisDistance -
              b.secondaryAxisDistance
            );
          }

          const ai =
            Number.isInteger(
              a.item?.metadata?.domIndex
            )
              ? a.item.metadata.domIndex
              : Number.MAX_SAFE_INTEGER;

          const bi =
            Number.isInteger(
              b.item?.metadata?.domIndex
            )
              ? b.item.metadata.domIndex
              : Number.MAX_SAFE_INTEGER;

          return ai - bi;
        });

        return candidates[0] || null;
      }

      dispatchTextHandoff(event, model) {
        const bridge =
          QoL.airControlBridge;

        if (!this.isSearchHandoffEnabled()) {
          return this.result(
            false,
            'search-handoff-disabled',
            { event }
          );
        }

        if (!bridge?.isTextEntryActive?.()) {
          return this.result(
            false,
            'text-handoff-no-active-text-entry',
            { event }
          );
        }

        const active =
          document.activeElement;

        const anchor =
          this.makeTextHandoffAnchor(
            active
          );

        if (!anchor) {
          return this.result(
            false,
            'text-handoff-anchor-unavailable',
            { event }
          );
        }

        // Search results may have changed while typing. Refresh structure first,
        // then choose a content item physically above/below the search field.
        QoL.airScanner?.scan?.(
          `text-handoff-${event.action.toLowerCase()}`
        );

        const freshModel =
          QoL.airScanner?.getModel?.() ||
          model;

        const candidate =
          this.findExternalContentCandidate(
            freshModel,
            anchor.rect,
            event.action
          );

        // No physical candidate means AirNav yields. Most importantly, do not
        // blur the search field merely because UP/DOWN was pressed.
        if (!candidate?.item) {
          return this.result(
            false,
            'text-handoff-no-directional-candidate',
            {
              event,
              anchor: {
                rect: anchor.rect,
                route: anchor.route
              }
            }
          );
        }

        const bridgeResult =
          bridge.takeFromText?.();

        if (!bridgeResult?.changed) {
          return this.result(
            false,
            'text-handoff-failed',
            {
              event,
              bridgeResult
            }
          );
        }

        this.textControlOverride = true;
        this.textHandoffAnchor = anchor;

        const selected =
          QoL.airFocus?.selectByKey?.(
            candidate.item.key,
            `text-handoff:${event.action.toLowerCase()}`
          );

        if (!selected) {
          // FocusManager rejected the candidate: give ownership back rather
          // than leaving the user in an ownerless state.
          const returnResult =
            bridge.returnToText?.();

          this.textControlOverride = false;
          this.textHandoffAnchor = null;

          return this.result(
            !!returnResult?.changed,
            'text-handoff-focus-rejected',
            {
              event,
              candidate,
              bridgeResult,
              returnResult
            }
          );
        }

        return this.result(
          true,
          `text-handoff-${event.action.toLowerCase()}`,
          {
            event,
            selectedKey:
              selected.key ||
              candidate.item.key,
            candidate: {
              key: candidate.item.key,
              sectionId:
                candidate.section?.id || null,
              sectionType:
                candidate.section?.type || null,
              score: candidate.score,
              primaryAxisDistance:
                candidate.primaryAxisDistance,
              secondaryAxisDistance:
                candidate.secondaryAxisDistance,
              overlapRatio:
                candidate.overlapRatio
            },
            anchor: {
              rect: anchor.rect,
              route: anchor.route
            },
            bridgeResult
          }
        );
      }

      dispatchToggleControl(event, model) {
        const bridge = QoL.airControlBridge;

        if (!bridge) {
          return this.result(false, 'control-bridge-unavailable', { event });
        }

        const surface = model?.activeSurfaceHint || 'page';

        if (
          surface === 'player' ||
          surface === 'modal' ||
          this.nativeControlOverride
        ) {
          if (this.nativeControlOverride) {
            this.nativeControlOverride = false;
            bridge.exitNativeSurface?.();
            this.handleModelState(model, 'toggle-control-exit-native');

            return this.result(true, 'native-control-released', {
              event,
              mode: this.mode,
              surface
            });
          }

          this.nativeControlOverride = true;
          const targetSurface = surface === 'modal' ? 'modal' : 'player';
          const bridgeResult = bridge.enterNativeSurface?.(targetSurface);

          this.updateMode('NATIVE_CONTROL', {
            reason: 'toggle-control-enter-native',
            surface: targetSurface
          });

          return this.result(true, 'native-control-taken', {
            event,
            mode: this.mode,
            surface: targetSurface,
            bridgeResult
          });
        }

        if (this.textControlOverride && bridge.hasSavedText?.()) {
          const bridgeResult = bridge.returnToText?.();
          this.textControlOverride = false;
          this.textHandoffAnchor = null;
          QoL.airFocus?.clear?.('toggle-control-return-to-text');

          return this.result(true, bridgeResult?.reason || 'text-control-returned', {
            event,
            bridgeResult
          });
        }

        if (bridge.isTextEntryActive?.()) {
          const bridgeResult = bridge.takeFromText?.();

          if (bridgeResult?.changed) {
            this.textControlOverride = true;

            if (!QoL.airFocus?.getState?.()?.itemKey) {
              QoL.airFocus?.selectFirst?.({
                scope: this.cfg.initialSelectionScope
              });
            }

            return this.result(true, 'text-control-taken', {
              event,
              bridgeResult,
              selectedKey: QoL.airFocus?.getState?.()?.itemKey || null
            });
          }
        }

        return this.result(true, 'page-control-already-active', { event });
      }

      getCurrentRoute() {
        return (
          location.hash ||
          `${location.pathname}${location.search}` ||
          '/'
        );
      }

      normalizePageHistoryRoute(
        route = null
      ) {
        const raw =
          String(
            route ||
            this.getCurrentRoute() ||
            '/'
          );

        // Search text updates commonly rewrite the search query as the user
        // types. Treat that as one page visit, otherwise BACK would walk every
        // previous search string instead of returning to the prior page.
        if (
          /^#\/search(?:\?|$)/i.test(
            raw
          )
        ) {
          return '#/search';
        }

        return raw || '/';
      }

      seedPageRouteHistory(
        route = null,
        reason = 'seed'
      ) {
        const normalized =
          this.normalizePageHistoryRoute(
            route
          );

        if (!normalized) {
          return null;
        }

        if (
          this.pageRouteHistory.length === 0
        ) {
          this.pageRouteHistory.push(
            normalized
          );
        } else {
          const current =
            this.pageRouteHistory[
              this.pageRouteHistory.length -
              1
            ];

          if (
            current !== normalized
          ) {
            this.pageRouteHistory = [
              normalized
            ];
          }
        }

        this.log(
          'page history seeded',
          {
            reason,
            route: normalized
          }
        );

        return normalized;
      }

      handlePageRouteChanged(
        route,
        reason = 'routeChanged'
      ) {
        const normalized =
          this.normalizePageHistoryRoute(
            route
          );

        if (!normalized) {
          return {
            changed: false,
            reason:
              'page-history-route-empty'
          };
        }

        const pending =
          this.pageBackPending;

        if (pending) {
          if (
            normalized ===
            pending.targetRoute
          ) {
            this.cancelPageBackFallback(
              'target-observed'
            );

            this.pageBackPending =
              null;

            // dispatchPageBack already popped the route being left. Keep the
            // observed target at the top without introducing a duplicate.
            if (
              this.pageRouteHistory[
                this.pageRouteHistory.length -
                1
              ] !== normalized
            ) {
              this.pageRouteHistory.push(
                normalized
              );
            }

            this.lastPageBack = {
              ...pending,
              completedAt:
                Date.now(),
              completed: true,
              outcome:
                'history-back-observed',
              route:
                normalized
            };

            emit(
              'pageBack',
              {
                ...this.lastPageBack
              }
            );

            return {
              changed: true,
              reason:
                'page-back-target-observed',
              route:
                normalized
            };
          }

          // Something else navigated while BACK was pending. Do not force the
          // old target later; reconcile with the route the application chose.
          this.cancelPageBackFallback(
            'different-route-observed'
          );

          this.pageBackPending =
            null;

          this.lastPageBack = {
            ...pending,
            completedAt:
              Date.now(),
            completed: false,
            outcome:
              'different-route-observed',
            route:
              normalized
          };
        }

        const current =
          this.pageRouteHistory[
            this.pageRouteHistory.length -
            1
          ] ||
          null;

        if (current === normalized) {
          return {
            changed: false,
            reason:
              'page-history-same-route',
            route:
              normalized
          };
        }

        // If native browser/app BACK was used outside AirNav and the route is
        // already in our stack, truncate to it instead of creating a loop.
        const existingIndex =
          this.pageRouteHistory
            .lastIndexOf(
              normalized
            );

        if (
          existingIndex >= 0 &&
          existingIndex <
            this.pageRouteHistory.length -
            1
        ) {
          this.pageRouteHistory =
            this.pageRouteHistory.slice(
              0,
              existingIndex + 1
            );

          return {
            changed: true,
            reason:
              'page-history-reconciled-back',
            route:
              normalized
          };
        }

        this.pageRouteHistory.push(
          normalized
        );

        const maxEntries =
          Math.max(
            4,
            Number(
              this.cfg.pageBack
                ?.maxEntries
            ) ||
            DEFAULTS.pageBack
              .maxEntries
          );

        if (
          this.pageRouteHistory.length >
          maxEntries
        ) {
          this.pageRouteHistory =
            this.pageRouteHistory.slice(
              -maxEntries
            );
        }

        return {
          changed: true,
          reason,
          route:
            normalized
        };
      }

      dispatchPageBack(event) {
        if (
          this.cfg.pageBack
            ?.enabled === false
        ) {
          return this.result(
            false,
            'page-back-disabled',
            { event }
          );
        }

        if (
          event?.phase === 'repeat'
        ) {
          return this.result(
            true,
            'page-back-repeat-blocked',
            { event }
          );
        }

        const currentRoute =
          this.normalizePageHistoryRoute(
            this.getCurrentRoute()
          );

        // Scanner can update before its routeChanged event is delivered.
        if (
          this.pageRouteHistory[
            this.pageRouteHistory.length -
            1
          ] !== currentRoute
        ) {
          this.handlePageRouteChanged(
            currentRoute,
            'pre-page-back-sync'
          );
        }

        if (
          this.pageBackPending
        ) {
          return this.result(
            true,
            'page-back-already-pending',
            {
              event,
              pageBack:
                this.pageBackPending
            }
          );
        }

        if (
          this.pageRouteHistory.length <
          2
        ) {
          this.lastPageBack = {
            timestamp:
              Date.now(),
            completed: false,
            outcome:
              'no-internal-history',
            currentRoute
          };

          // Do not accidentally navigate outside Jellyfin/browser-wrapper.
          return this.result(
            true,
            'page-back-no-internal-history',
            {
              event,
              pageBack:
                this.lastPageBack
            }
          );
        }

        const fromRoute =
          this.pageRouteHistory[
            this.pageRouteHistory.length -
            1
          ];

        const targetRoute =
          this.pageRouteHistory[
            this.pageRouteHistory.length -
            2
          ];

        // Optimistically pop the route being left. routeChanged either confirms
        // the target or reconciles if Jellyfin chose a different route.
        this.pageRouteHistory.pop();

        const pending = {
          timestamp:
            Date.now(),
          fromRoute,
          targetRoute,
          currentRoute,
          completed: false,
          outcome:
            'history-back-requested'
        };

        this.pageBackPending =
          pending;
        this.lastPageBack =
          pending;

        // Clear page-only transient contexts before changing route. Modal,
        // ItemActions and PageForm edit states are handled earlier in dispatch
        // and therefore never reach this page-level path.
        this.clearTextHandoff(
          'page-back'
        );

        this.cancelInitialSelectionRetry();
        this.cancelActivationRouteFallback(
          'page-back'
        );

        const nativeRisk =
          this.getNativeBackRisk(
            event
          );

        pending.nativeNavigationRisk =
          nativeRisk;

        if (nativeRisk) {
          this.scheduleNativeAwarePageBack(
            event,
            pending
          );

          return this.result(
            true,
            'page-back-native-probe',
            {
              event,
              pageBack:
                { ...pending }
            }
          );
        }

        return this.performHistoryBack(
          event,
          pending
        );
      }

      getNativeBackRisk(event) {
        const hint =
          String(
            event?.raw
              ?.nativeNavigationRisk ||
            ''
          ).toLowerCase();

        if (
          hint === 'browser-back'
        ) {
          return hint;
        }

        // Backward-compatible detection if an older UniversalInput build did
        // not yet publish nativeNavigationRisk.
        const code =
          String(
            event?.raw?.code ||
            ''
          );

        const key =
          String(
            event?.raw?.key ||
            ''
          );

        if (
          code === 'BrowserBack' ||
          key === 'BrowserBack'
        ) {
          return 'browser-back';
        }

        if (
          event?.source ===
            'pointer' &&
          Number(
            event?.raw?.button
          ) === 3
        ) {
          return 'browser-back';
        }

        return null;
      }

      scheduleNativeAwarePageBack(
        event,
        pending
      ) {
        this.cancelPageBackFallback(
          'native-probe-start'
        );

        const delay =
          Math.max(
            40,
            Number(
              this.cfg.pageBack
                ?.nativeNavigationProbeMs
            ) ||
            DEFAULTS.pageBack
              .nativeNavigationProbeMs
          );

        this.pageBackNativeProbeTimer =
          setTimeout(() => {
            this.pageBackNativeProbeTimer =
              null;

            if (
              !this.pageBackPending ||
              this.pageBackPending !==
                pending
            ) {
              return;
            }

            const current =
              this.normalizePageHistoryRoute(
                this.getCurrentRoute()
              );

            // Native browser Back already landed on our expected route.
            if (
              current ===
              pending.targetRoute
            ) {
              this.handlePageRouteChanged(
                current,
                'native-back-probe-observed'
              );

              return;
            }

            // preventDefault worked (or the device did not navigate natively).
            // Perform exactly one AirNav-controlled history step now.
            this.performHistoryBack(
              event,
              pending
            );
          }, delay);
      }

      performHistoryBack(
        event,
        pending =
          this.pageBackPending
      ) {
        if (!pending) {
          return this.result(
            true,
            'page-back-no-pending'
          );
        }

        try {
          window.history.back();
        } catch (error) {
          this.log(
            'history.back failed',
            error
          );

          return this.fallbackPageBack(
            'history-back-threw',
            error
          );
        }

        this.schedulePageBackFallback();

        return this.result(
          true,
          'page-back-requested',
          {
            event,
            pageBack:
              { ...pending }
          }
        );
      }

      schedulePageBackFallback() {
        this.cancelPageBackFallback(
          'reschedule'
        );

        const delay =
          Math.max(
            150,
            Number(
              this.cfg.pageBack
                ?.fallbackDelayMs
            ) ||
            DEFAULTS.pageBack
              .fallbackDelayMs
          );

        this.pageBackFallbackTimer =
          setTimeout(() => {
            this.pageBackFallbackTimer =
              null;

            const pending =
              this.pageBackPending;

            if (!pending) {
              return;
            }

            const current =
              this.normalizePageHistoryRoute(
                this.getCurrentRoute()
              );

            if (
              current ===
              pending.targetRoute
            ) {
              this.handlePageRouteChanged(
                current,
                'page-back-fallback-observed'
              );

              return;
            }

            this.fallbackPageBack(
              'history-back-timeout'
            );
          }, delay);
      }

      cancelPageBackFallback(
        reason = 'cancel'
      ) {
        if (
          this.pageBackFallbackTimer
        ) {
          clearTimeout(
            this.pageBackFallbackTimer
          );

          this.pageBackFallbackTimer =
            null;
        }

        if (
          this.pageBackNativeProbeTimer
        ) {
          clearTimeout(
            this.pageBackNativeProbeTimer
          );

          this.pageBackNativeProbeTimer =
            null;
        }

        return {
          cancelled: true,
          reason
        };
      }

      fallbackPageBack(
        reason = 'fallback',
        error = null
      ) {
        const pending =
          this.pageBackPending;

        if (!pending) {
          return this.result(
            true,
            'page-back-fallback-no-pending'
          );
        }

        this.cancelPageBackFallback(
          reason
        );

        const target =
          pending.targetRoute;

        try {
          if (
            String(target)
              .startsWith('#')
          ) {
            location.hash =
              target.slice(1);
          } else {
            location.assign(
              target
            );
          }

          this.lastPageBack = {
            ...pending,
            fallbackAt:
              Date.now(),
            outcome:
              'direct-route-fallback',
            fallbackReason:
              reason,
            error:
              error
                ? String(error)
                : null
          };

          return this.result(
            true,
            'page-back-direct-fallback',
            {
              pageBack:
                this.lastPageBack
            }
          );
        } catch (
          fallbackError
        ) {
          // Restore the current route to our stack because no navigation
          // occurred and keep BACK consumed rather than escaping the app.
          if (
            this.pageRouteHistory[
              this.pageRouteHistory.length -
              1
            ] !==
            pending.fromRoute
          ) {
            this.pageRouteHistory.push(
              pending.fromRoute
            );
          }

          this.pageBackPending =
            null;

          this.lastPageBack = {
            ...pending,
            completedAt:
              Date.now(),
            completed: false,
            outcome:
              'fallback-failed',
            error:
              String(
                fallbackError
              )
          };

          return this.result(
            true,
            'page-back-fallback-failed',
            {
              pageBack:
                this.lastPageBack
            }
          );
        }
      }

      syncScannerForInput(reason = 'input-sync') {
        let model =
          QoL.airScanner?.getModel?.() ||
          null;

        const currentRoute =
          this.getCurrentRoute();

        const modelLooksEmpty =
          !!model &&
          model.activeSurfaceHint === 'page' &&
          !model.header &&
          !(model.sections || []).some(
            section =>
              Array.isArray(section.items) &&
              section.items.length
          );

        if (
          !model ||
          model.route !== currentRoute ||
          modelLooksEmpty
        ) {
          try {
            model =
              QoL.airScanner?.scan?.(
                reason
              ) ||
              QoL.airScanner?.getModel?.() ||
              model;
          } catch (error) {
            console.warn(
              '[AirNav.Controller] input-time scanner sync failed.',
              error
            );
          }
        }

        return model;
      }

      trySelectInitial(
        reason = 'initial-input'
      ) {
        this.syncScannerForInput(
          `${reason}:scanner-sync`
        );

        return QoL.airFocus.selectFirst({
          scope:
            this.cfg.initialSelectionScope
        });
      }

      cancelInitialSelectionRetry() {
        this.initialSelectionRetryToken += 1;

        if (
          this.initialSelectionRetryTimer
        ) {
          clearTimeout(
            this.initialSelectionRetryTimer
          );
          this.initialSelectionRetryTimer =
            null;
        }
      }

      scheduleInitialSelectionRetry(
        reason = 'route-content-pending'
      ) {
        this.cancelInitialSelectionRetry();

        const token =
          this.initialSelectionRetryToken;

        const route =
          this.getCurrentRoute();

        const delay =
          Math.max(
            30,
            Number(
              this.cfg.initialSelectionRetryMs
            ) || 90
          );

        const maxAttempts =
          Math.max(
            1,
            Number(
              this.cfg.initialSelectionRetryAttempts
            ) || 3
          );

        let attempt = 0;

        const probe = () => {
          if (
            token !==
              this.initialSelectionRetryToken ||
            !this.enabled ||
            this.getCurrentRoute() !== route ||
            QoL.airFocus?.getState?.()
              ?.itemKey
          ) {
            this.initialSelectionRetryTimer =
              null;
            return;
          }

          attempt += 1;

          const selected =
            this.trySelectInitial(
              `${reason}:retry-${attempt}`
            );

          if (selected) {
            this.initialSelectionRetryTimer =
              null;

            this.log(
              'initial selection acquired after route render',
              {
                route,
                attempt,
                itemKey: selected.key
              }
            );
            return;
          }

          if (attempt >= maxAttempts) {
            this.initialSelectionRetryTimer =
              null;

            this.log(
              'initial selection retry exhausted',
              {
                route,
                attempts: attempt
              }
            );
            return;
          }

          this.initialSelectionRetryTimer =
            setTimeout(
              probe,
              delay * attempt
            );
        };

        this.initialSelectionRetryTimer =
          setTimeout(probe, delay);

        return {
          scheduled: true,
          route,
          attempts: maxAttempts,
          firstDelayMs: delay
        };
      }

      normalizeActivationHref(
        item,
        target
      ) {
        const raw =
          item?.metadata?.detailsHref ||
          item?.metadata?.href ||
          target?.getAttribute?.('href') ||
          null;

        if (!raw) return null;

        const value =
          String(raw).trim();

        if (!value) return null;

        try {
          const url =
            new URL(
              value,
              location.href
            );

          if (
            url.origin !==
            location.origin
          ) {
            return null;
          }

          return {
            raw: value,
            href: url.href,
            hash:
              url.hash || null
          };
        } catch (_) {
          return null;
        }
      }

      shouldDirectOpenDetails(
        item,
        hrefInfo,
        policy = this.cfg.cardActivate
      ) {
        if (
          policy !== 'openDetails' ||
          !hrefInfo?.hash
        ) {
          return false;
        }

        if (
          !/^#\/details(?:\?|$)/i.test(
            hrefInfo.hash
          )
        ) {
          return false;
        }

        const entityKey =
          String(
            item?.metadata?.entityKey || ''
          );

        // Restrict direct routing to confirmed Jellyfin media entities.
        return (
          item?.type === 'media' ||
          entityKey.startsWith('jf:')
        );
      }

      navigateActivationHref(
        hrefInfo,
        activation
      ) {
        if (!hrefInfo) {
          return false;
        }

        try {
          if (hrefInfo.hash) {
            if (
              location.hash !==
              hrefInfo.hash
            ) {
              location.hash =
                hrefInfo.hash;
            }
          } else if (
            hrefInfo.href &&
            location.href !== hrefInfo.href
          ) {
            location.assign(
              hrefInfo.href
            );
          } else {
            return false;
          }

          this.log(
            'activation href fallback used',
            {
              itemKey:
                activation?.itemKey ||
                null,
              href:
                hrefInfo.raw
            }
          );

          return true;
        } catch (error) {
          console.error(
            '[AirNav.Controller] activation href fallback failed',
            error
          );
          return false;
        }
      }

      cancelActivationRouteFallback(
        reason = 'cancelled'
      ) {
        this.activationFallbackToken += 1;

        if (this.activationFallbackTimer) {
          clearTimeout(
            this.activationFallbackTimer
          );
          this.activationFallbackTimer = null;
        }

        if (
          this.lastActivationOutcome?.pending === true
        ) {
          this.lastActivationOutcome = {
            ...this.lastActivationOutcome,
            pending: false,
            completedAt: Date.now(),
            outcome:
              reason
          };
        }

        return {
          cancelled: true,
          reason
        };
      }

      isSafeDetailsFallbackHref(
        hrefInfo
      ) {
        return !!(
          hrefInfo?.hash &&
          /^#\/details(?:\?|$)/i.test(
            hrefInfo.hash
          )
        );
      }

      detectActivationSurfaceOutcome(
        beforeRoute
      ) {
        const currentRoute =
          this.getCurrentRoute();

        if (currentRoute !== beforeRoute) {
          return {
            settled: true,
            outcome:
              'route-changed',
            currentRoute
          };
        }

        // Do not wait for Scanner's normal 180 ms mutation window. An
        // activation is a high-priority boundary, so synchronously ask Scanner
        // to observe the resulting DOM before deciding a click "failed".
        let model = null;

        try {
          model =
            QoL.airScanner?.scan?.(
              'activation-outcome-probe'
            ) ||
            QoL.airScanner?.getModel?.() ||
            null;
        } catch (_) {
          model =
            QoL.airScanner?.getModel?.() ||
            null;
        }

        if (
          model?.activeSurfaceHint === 'modal' ||
          !!model?.modal ||
          QoL.airModal?.isActive?.()
        ) {
          return {
            settled: true,
            outcome:
              'modal-opened',
            currentRoute,
            modalId:
              model?.modal?.id ||
              QoL.airModal?.getState?.()?.contextId ||
              null
          };
        }

        if (
          model?.activeSurfaceHint === 'player'
        ) {
          return {
            settled: true,
            outcome:
              'player-opened',
            currentRoute
          };
        }

        return {
          settled: false,
          outcome:
            'page-unchanged',
          currentRoute
        };
      }

      scheduleActivationRouteFallback(
        hrefInfo,
        activation,
        beforeRoute
      ) {
        // The fallback was introduced only to recover broken media-card detail
        // navigation after SPA rerenders. It must never redirect arbitrary
        // plugin/action links. Jellyseerr/Jellyfin Enhanced cards can purposely
        // keep the current route and open a modal instead.
        if (
          !this.isSafeDetailsFallbackHref(
            hrefInfo
          )
        ) {
          return {
            scheduled: false,
            reason:
              hrefInfo
                ? 'non-details-route-no-fallback'
                : 'no-href'
          };
        }

        this.cancelActivationRouteFallback(
          'superseded-by-new-activation'
        );

        const token =
          ++this.activationFallbackToken;

        const firstDelay =
          Math.max(
            50,
            Number(
              this.cfg.activationRouteFallbackMs
            ) || 120
          );

        const pollDelay =
          Math.max(
            50,
            Number(
              this.cfg.activationRouteFallbackPollMs
            ) || 100
          );

        const maxWait =
          Math.max(
            firstDelay,
            Number(
              this.cfg.activationRouteFallbackMaxWaitMs
            ) || 650
          );

        const startedAt =
          performance.now();

        this.lastActivationOutcome = {
          pending: true,
          itemKey:
            activation?.itemKey || null,
          beforeRoute,
          href:
            hrefInfo.raw,
          startedAt:
            Date.now(),
          outcome:
            'waiting'
        };

        const probe = () => {
          if (
            token !==
            this.activationFallbackToken
          ) {
            return;
          }

          const outcome =
            this.detectActivationSurfaceOutcome(
              beforeRoute
            );

          if (outcome.settled) {
            this.activationFallbackTimer =
              null;

            this.lastActivationOutcome = {
              ...this.lastActivationOutcome,
              pending: false,
              completedAt:
                Date.now(),
              ...outcome
            };

            if (activation) {
              activation.activationOutcome =
                outcome.outcome;
            }

            this.log(
              'activation outcome observed; redirect fallback suppressed',
              this.lastActivationOutcome
            );
            return;
          }

          const elapsed =
            performance.now() -
            startedAt;

          if (elapsed < maxWait) {
            this.activationFallbackTimer =
              setTimeout(
                probe,
                pollDelay
              );
            return;
          }

          this.activationFallbackTimer =
            null;

          const redirected =
            this.navigateActivationHref(
              hrefInfo,
              activation
            );

          this.lastActivationOutcome = {
            ...this.lastActivationOutcome,
            pending: false,
            completedAt:
              Date.now(),
            outcome:
              redirected
                ? 'details-fallback-redirect'
                : 'details-fallback-noop',
            waitedMs:
              Math.round(elapsed)
          };

          if (activation) {
            activation.activationOutcome =
              this.lastActivationOutcome.outcome;
          }
        };

        this.activationFallbackTimer =
          setTimeout(
            probe,
            firstDelay
          );

        return {
          scheduled: true,
          reason:
            'details-route-outcome-watch',
          firstDelayMs:
            firstDelay,
          pollMs:
            pollDelay,
          maxWaitMs:
            maxWait,
          href:
            hrefInfo.raw
        };
      }

      dispatchDirection(event) {
        if (!QoL.airFocus.getState()?.itemKey) {
          const first =
            this.trySelectInitial(
              'direction-initial'
            );

          if (!first) {
            const retry =
              this.scheduleInitialSelectionRetry(
                'direction-initial'
              );

            // Consume the key while Jellyfin is building the new route so
            // browser/native focus cannot wander underneath AirNav.
            return this.result(
              true,
              'initial-selection-pending',
              {
                event,
                selectedKey: null,
                retry
              }
            );
          }

          this.cancelInitialSelectionRetry();

          return this.result(
            true,
            'initial-selection',
            {
              event,
              selectedKey:
                first.key || null
            }
          );
        }

        const currentModel =
          QoL.airScanner?.getModel?.() ||
          null;

        // Search is a real ExternalFocusAnchor, not merely a fallback after
        // GeometryEngine clamps. Compare it with the nearest normal content
        // candidate first so UP from the first result can return to the search
        // field even when some header/card element is technically movable.
        if (
          event.action === NAV_ACTION.UP ||
          event.action === NAV_ACTION.DOWN
        ) {
          const preMove =
            this.shouldReturnToSearchBeforeMove(
              currentModel,
              event.action
            );

          if (preMove.shouldReturn) {
            return this.returnToSavedSearch(
              event,
              {
                phase: 'before-geometry',
                searchScore:
                  preMove.searchScore,
                competingCandidate:
                  preMove.contentCandidate
                    ? {
                        key:
                          preMove
                            .contentCandidate
                            .item?.key ||
                          null,
                        sectionId:
                          preMove
                            .contentCandidate
                            .section?.id ||
                          null,
                        score:
                          preMove
                            .contentCandidate
                            .score
                      }
                    : null
              }
            );
          }
        }

        const movement =
          QoL.airGeometry.move(
            event.action
          );

        // Fallback: if normal geometry is clamped and a saved search anchor is
        // physically in that direction, return even if Jellyfin removed the
        // original input node after blur.
        if (
          (
            event.action === NAV_ACTION.UP ||
            event.action === NAV_ACTION.DOWN
          ) &&
          this.isSearchHandoffEnabled() &&
          this.textControlOverride &&
          !movement?.moved
        ) {
          const anchor =
            this.refreshTextHandoffAnchor();

          const selectedItem =
            QoL.airFocus?.getSelectedItem?.();

          if (
            anchor?.rect &&
            selectedItem?.rect &&
            this.isRectInDirection(
              anchor.rect,
              selectedItem.rect,
              event.action
            )
          ) {
            return this.returnToSavedSearch(
              event,
              {
                phase: 'after-geometry-clamp',
                movement,
                anchorRect:
                  anchor.rect
              }
            );
          }
        }

        return this.result(
          !!movement?.moved,
          movement?.reason || 'geometry-result',
          {
            event,
            movement
          }
        );
      }

      captureReturnState() {
        const state =
          QoL.airFocus?.getState?.() ||
          null;

        if (!state?.itemKey) {
          return null;
        }

        return {
          contextId:
            state.contextId ||
            null,
          route:
            state.route ||
            this.getCurrentRoute(),
          itemKey:
            state.itemKey,
          sectionId:
            state.sectionId ||
            null,
          preferredX:
            Number.isFinite(
              state.preferredX
            )
              ? state.preferredX
              : null,
          fallbackIndex:
            Number.isInteger(
              state.fallbackIndex
            )
              ? state.fallbackIndex
              : null
        };
      }

      dispatchEnterPageInlineGroup(
        event,
        item
      ) {
        const entered =
          QoL.airScanner
            ?.enterPageInlineGroup?.(
              item?.key
            ) || {
              handled: false,
              reason:
                'page-inline-group-scanner-unavailable'
            };

        if (
          !entered.handled ||
          !entered.firstChildKey
        ) {
          return this.result(
            true,
            entered.reason ||
              'page-inline-group-enter-failed',
            {
              event,
              pageInlineGroup:
                entered
            },
            true
          );
        }

        QoL.airFocus
          ?.selectByKey?.(
            entered.firstChildKey,
            'page-inline-group-enter',
            {
              preservePreferredX:
                false
            }
          );

        return this.result(
          true,
          'page-inline-group-entered',
          {
            event,
            pageInlineGroup:
              entered,
            selectedKey:
              entered.firstChildKey
          },
          true
        );
      }

      dispatchExitPageInlineGroup(
        event,
        reason = 'back'
      ) {
        const state =
          QoL.airScanner
            ?.getPageInlineGroupState?.();

        if (!state?.active) {
          return this.result(
            false,
            'page-inline-group-not-active',
            { event }
          );
        }

        const exited =
          QoL.airScanner
            ?.exitPageInlineGroup?.(
              reason
            ) || {
              handled: false,
              reason:
                'page-inline-group-scanner-unavailable',
              groupKey:
                state.groupKey
            };

        if (exited.groupKey) {
          QoL.airFocus
            ?.selectByKey?.(
              exited.groupKey,
              `page-inline-group-exit:${reason}`,
              {
                preservePreferredX:
                  false
              }
            );
        }

        return this.result(
          true,
          exited.reason ||
            'page-inline-group-exited',
          {
            event,
            pageInlineGroup:
              exited
          },
          true
        );
      }

      dispatchPageInlineGroupDirection(
        event
      ) {
        const model =
          QoL.airScanner
            ?.prepareForInput?.(
              event.action
            ) ||
          QoL.airScanner
            ?.getModel?.();

        const state =
          QoL.airScanner
            ?.getPageInlineGroupState?.();

        if (
          !state?.active ||
          !state.childKeys?.length
        ) {
          return this.result(
            true,
            'page-inline-group-children-missing',
            {
              event,
              pageInlineGroup:
                state || null
            },
            true
          );
        }

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
              !state.childKeys.includes(
                item.key
              )
            ) {
              continue;
            }

            const live =
              item.element
                ?.getBoundingClientRect?.();

            const rect =
              live &&
              live.width > 0 &&
              live.height > 0
                ? {
                    left:
                      live.left,
                    right:
                      live.right,
                    top:
                      live.top,
                    bottom:
                      live.bottom,
                    width:
                      live.width,
                    height:
                      live.height,
                    centerX:
                      live.left +
                      live.width / 2,
                    centerY:
                      live.top +
                      live.height / 2
                  }
                : item.rect;

            if (rect) {
              children.push({
                item,
                rect
              });
            }
          }
        }

        if (!children.length) {
          return this.result(
            true,
            'page-inline-group-no-usable-children',
            { event },
            true
          );
        }

        const selected =
          QoL.airFocus
            ?.getSelectedItem?.();

        let current =
          children.find(
            candidate =>
              candidate.item.key ===
              selected?.key
          );

        if (!current) {
          current =
            children[0];

          QoL.airFocus
            ?.selectByKey?.(
              current.item.key,
              'page-inline-group-recover',
              {
                preservePreferredX:
                  false
              }
            );

          return this.result(
            true,
            'page-inline-group-selection-recovered',
            {
              event,
              selectedKey:
                current.item.key
            },
            true
          );
        }

        const horizontal =
          event.action ===
            NAV_ACTION.LEFT ||
          event.action ===
            NAV_ACTION.RIGHT;

        const positive =
          event.action ===
            NAV_ACTION.RIGHT ||
          event.action ===
            NAV_ACTION.DOWN;

        const candidates =
          children
            .filter(
              candidate =>
                candidate.item.key !==
                current.item.key
            )
            .map(candidate => {
              const primary =
                horizontal
                  ? (
                      positive
                        ? candidate.rect.centerX -
                          current.rect.centerX
                        : current.rect.centerX -
                          candidate.rect.centerX
                    )
                  : (
                      positive
                        ? candidate.rect.centerY -
                          current.rect.centerY
                        : current.rect.centerY -
                          candidate.rect.centerY
                    );

              if (primary <= 2) {
                return null;
              }

              const secondary =
                horizontal
                  ? Math.abs(
                      candidate.rect.centerY -
                      current.rect.centerY
                    )
                  : Math.abs(
                      candidate.rect.centerX -
                      current.rect.centerX
                    );

              return {
                ...candidate,
                score:
                  primary +
                  secondary * 1.8
              };
            })
            .filter(Boolean)
            .sort(
              (a, b) =>
                a.score - b.score
            );

        if (!candidates.length) {
          // An entered group is a real nested context; arrows never leak out.
          return this.result(
            true,
            'page-inline-group-edge',
            {
              event,
              selectedKey:
                current.item.key
            },
            true
          );
        }

        const target =
          candidates[0];

        QoL.airFocus
          ?.selectByKey?.(
            target.item.key,
            `page-inline-group:${String(
              event.action
            ).toLowerCase()}`,
            {
              preservePreferredX:
                false
            }
          );

        return this.result(
          true,
          'page-inline-group-moved',
          {
            event,
            fromKey:
              current.item.key,
            toKey:
              target.item.key,
            score:
              target.score
          },
          true
        );
      }

      dispatchEnterActions(event, reason = 'canonical-enter-actions') {
        const model =
          QoL.airScanner?.prepareForInput?.(
            'ENTER_ACTIONS'
          ) ||
          this.syncScannerForInput(
            'enter-actions-sync'
          );

        if (
          !model ||
          model.activeSurfaceHint !== 'page'
        ) {
          return this.result(
            false,
            'enter-actions-page-required',
            { event }
          );
        }

        const selected =
          QoL.airFocus?.getSelectedItem?.();

        if (!selected) {
          return this.result(
            true,
            'enter-actions-no-selection',
            { event }
          );
        }

        const itemActions =
          QoL.airItemActions?.enter?.(
            selected.key,
            reason
          ) || {
            handled: false,
            reason:
              'item-actions-module-unavailable'
          };

        if (itemActions.handled) {
          this.updateMode(
            'ITEM_ACTIONS',
            {
              reason:
                itemActions.reason,
              ownerKey:
                selected.key
            }
          );
        }

        return this.result(
          !!itemActions.handled,
          itemActions.reason ||
            'item-actions-result',
          {
            event,
            itemActions
          },
          // ENTER_ACTIONS is an AirNav command even if this particular card has
          // no child actions. Do not leak KeyA / remote action into Jellyfin.
          true
        );
      }

      dispatchActivate(event) {
        // Synchronize route/model before dereferencing the logical selection.
        // This is especially important immediately after Jellyfin's UI Back.
        const model =
          this.syncScannerForInput(
            'activate-input-sync'
          );

        const currentRoute =
          this.getCurrentRoute();

        const focusState =
          QoL.airFocus.getState?.();

        // A stale route selection must never be activated.
        if (
          focusState?.itemKey &&
          (
            focusState.route !==
              currentRoute ||
            (
              model?.route &&
              focusState.route !==
                model.route
            )
          )
        ) {
          QoL.airFocus.clear?.(
            'activate-route-mismatch'
          );
        }

        // First ACTIVATE with no logical selection establishes selection only.
        // If Jellyfin has not rendered the destination yet, queue a short
        // scanner retry so the UI becomes responsive without repeated presses.
        if (
          !QoL.airFocus.getState?.()
            ?.itemKey
        ) {
          const first =
            this.trySelectInitial(
              'activate-initial'
            );

          if (!first) {
            const retry =
              this.scheduleInitialSelectionRetry(
                'activate-initial'
              );

            return this.result(
              true,
              'initial-selection-pending',
              {
                event,
                selectedKey: null,
                retry
              }
            );
          }

          this.cancelInitialSelectionRetry();

          return this.result(
            true,
            'initial-selection',
            {
              event,
              selectedKey:
                first.key || null
            }
          );
        }

        this.cancelInitialSelectionRetry();

        let item =
          QoL.airFocus
            .getSelectedItem?.();

        // Defensive stale-DOM recovery from the architecture requirements.
        if (
          !item?.element?.isConnected
        ) {
          this.syncScannerForInput(
            'activate-stale-dom-sync'
          );

          QoL.airFocus.refresh?.(
            'activate-stale-selection'
          );

          item =
            QoL.airFocus
              .getSelectedItem?.();
        }

        if (!item) {
          return this.result(
            false,
            'selected-item-missing',
            { event }
          );
        }

        if (
          item.metadata
            ?.pageInlineGroup ===
            true
        ) {
          return this.dispatchEnterPageInlineGroup(
            event,
            item
          );
        }

        if (
          QoL.airPageForm
            ?.ownsItem?.(
              item
            )
        ) {
          const pageFormResult =
            QoL.airPageForm
              .activateSelected(
                item
              );

          return this.result(
            !!pageFormResult.handled,
            pageFormResult.reason ||
              'page-form-activation-result',
            {
              event,
              pageForm:
                pageFormResult,
              itemKey:
                item.key
            },
            true
          );
        }

        let effectivePolicy =
          this.cfg.cardActivate;

        if (
          item.type === 'media' &&
          (
            effectivePolicy === 'enterActions' ||
            effectivePolicy === 'smart'
          )
        ) {
          const actionEntry =
            QoL.airItemActions?.enter?.(
              item.key,
              `activate-policy:${effectivePolicy}`
            ) || {
              handled: false,
              reason:
                'item-actions-module-unavailable'
            };

          if (actionEntry.handled) {
            this.updateMode(
              'ITEM_ACTIONS',
              {
                reason:
                  actionEntry.reason,
                ownerKey:
                  item.key
              }
            );

            return this.result(
              true,
              'activate-entered-item-actions',
              {
                event,
                itemActions:
                  actionEntry
              }
            );
          }

          // "smart" and "enterActions" fall back to predictable details
          // activation when the selected card has no quick-action strip.
          effectivePolicy =
            'openDetails';
        }

        let target =
          this.resolveActivationTarget(
            item
          );

        // If the logical item survived but Scanner's original activationTarget
        // was replaced during a SPA render, rebuild the model once and resolve
        // the same stable key against the latest DOM before giving up.
        if (!target) {
          try {
            QoL.airScanner?.scan?.(
              'activate-target-refresh'
            );
            QoL.airFocus.refresh?.(
              'activate-target-refresh'
            );
          } catch (_) {}

          item =
            QoL.airFocus
              .getSelectedItem?.();

          target =
            this.resolveActivationTarget(
              item
            );
        }

        if (!target) {
          return this.result(
            false,
            'activation-target-missing',
            {
              event,
              itemKey:
                item?.key || null
            }
          );
        }

        const hrefInfo =
          this.normalizeActivationHref(
            item,
            target
          );

        const beforeRoute =
          this.getCurrentRoute();

        const activation = {
          action: NAV_ACTION.ACTIVATE,
          policy: effectivePolicy,
          itemKey: item.key,
          entityKey:
            item.metadata?.entityKey ||
            null,
          sectionId: item.sectionId,
          title: item.title || null,
          target:
            this.describeElement(
              target
            ),
          href:
            hrefInfo?.raw || null,
          routeBefore:
            beforeRoute,
          timestamp:
            performance.now()
        };

        // For Jellyfin media cards, openDetails does not need the card's
        // plugin/native click handler at all. Scanner provides one canonical
        // details route even for virtual-library cards whose activation target
        // is only a <div> and has no href.
        if (
          this.shouldDirectOpenDetails(
            item,
            hrefInfo,
            effectivePolicy
          )
        ) {
          const redirected =
            this.navigateActivationHref(
              hrefInfo,
              activation
            );

          if (redirected) {
            activation.activationMode =
              'direct-details-route';

            this.lastActivation =
              activation;

            emit(
              'activation',
              activation
            );

            this.log(
              'activation',
              activation
            );

            return this.result(
              true,
              'activated-direct-details-route',
              {
                event,
                activation
              }
            );
          }
        }

        try {
          target.click();
        } catch (error) {
          console.error(
            '[AirNav.Controller] activation failed',
            error
          );

          // If this is a real same-origin link, the href itself is a safe
          // recovery path even when the DOM click throws.
          const hrefRecovered =
            this.navigateActivationHref(
              hrefInfo,
              activation
            );

          if (!hrefRecovered) {
            return this.result(
              false,
              'activation-click-failed',
              {
                event,
                activation,
                error
              }
            );
          }

          activation.hrefFallback =
            'immediate-after-click-error';
        }

        const fallback =
          this.scheduleActivationRouteFallback(
            hrefInfo,
            activation,
            beforeRoute
          );

        activation.routeFallback =
          fallback;

        this.lastActivation =
          activation;

        emit(
          'activation',
          activation
        );

        this.log(
          'activation',
          activation
        );

        return this.result(
          true,
          'activated',
          {
            event,
            activation
          }
        );
      }

      resolveActivationTarget(item) {
        const preferred = item?.activationTarget;

        if (
          preferred?.isConnected &&
          !this.isDisabled(preferred) &&
          typeof preferred.click === 'function'
        ) {
          return preferred;
        }

        const fallback = item?.element;

        if (
          fallback?.isConnected &&
          !this.isDisabled(fallback) &&
          typeof fallback.click === 'function'
        ) {
          return fallback;
        }

        return null;
      }

      normalizeActionEvent(value) {
        if (typeof value === 'string') {
          const action = String(value).toUpperCase();
          if (!VALID_ACTIONS.has(action)) return null;

          return {
            action,
            phase: 'press',
            source: 'custom',
            deviceId: 'custom:manual',
            raw: null,
            timestamp: performance.now()
          };
        }

        if (!value || typeof value !== 'object') return null;

        const action = String(value.action || '').toUpperCase();
        if (!VALID_ACTIONS.has(action)) return null;

        const phase =
          value.phase === 'repeat' ||
          value.phase === 'release'
            ? value.phase
            : 'press';

        return {
          action,
          phase,
          source: value.source || 'custom',
          deviceId: value.deviceId || `${value.source || 'custom'}:default`,
          raw: value.raw || null,
          timestamp: Number.isFinite(value.timestamp)
            ? value.timestamp
            : performance.now()
        };
      }

      isDisabled(element) {
        return !!(
          element?.disabled ||
          element?.getAttribute?.('aria-disabled') === 'true' ||
          element?.classList?.contains('disabled')
        );
      }

      describeElement(element) {
        if (!element) return null;

        return {
          tag: element.tagName || null,
          id: element.id || null,
          className:
            typeof element.className === 'string'
              ? element.className
              : null,
          ariaLabel: element.getAttribute?.('aria-label') || null,
          title: element.getAttribute?.('title') || null,
          connected: !!element.isConnected
        };
      }

      getState() {
        return {
          enabled: this.enabled,
          mode: this.mode,
          selection: QoL.airFocus?.getState?.() || null,
          route: QoL.airScanner?.getModel?.()?.route || null,
          surface: QoL.airScanner?.getModel?.()?.activeSurfaceHint || null,
          lastAction: this.lastAction,
          lastActivation: this.lastActivation,
          lastActivationOutcome:
            this.lastActivationOutcome,
          routeSync: {
            currentRoute:
              this.getCurrentRoute(),
            modelRoute:
              QoL.airScanner?.getModel?.()?.route ||
              null,
            initialSelectionRetryPending:
              !!this.initialSelectionRetryTimer,
            activationFallbackPending:
              !!this.activationFallbackTimer,
            pageBackPending:
              this.pageBackPending
                ? {
                    ...this.pageBackPending
                  }
                : null,
            pageRouteHistory:
              this.pageRouteHistory.slice(),
            lastPageBack:
              this.lastPageBack
                ? {
                    ...this.lastPageBack
                  }
                : null,
            lastBackSurfaceGuard:
              this.lastBackSurfaceGuard
                ? {
                    ...this.lastBackSurfaceGuard
                  }
                : null
          },
          textControlOverride: this.textControlOverride,
          textHandoffAnchor: this.textHandoffAnchor
            ? {
                connected:
                  !!this.textHandoffAnchor.element?.isConnected,
                rect:
                  this.textHandoffAnchor.rect
                    ? { ...this.textHandoffAnchor.rect }
                    : null,
                route:
                  this.textHandoffAnchor.route || null
              }
            : null,
          nativeControlOverride: this.nativeControlOverride,
          runtimeSettings: {
            cardActivate: this.cfg.cardActivate,
            searchHandoffEnabled: this.isSearchHandoffEnabled()
          },
          itemActions:
            QoL.airItemActions?.getState?.() ||
            null,
          pageForm:
            QoL.airPageForm?.getState?.() ||
            null,
          pageInlineGroup:
            QoL.airScanner
              ?.getPageInlineGroupState?.() ||
            null,
          modal:
            QoL.airModal?.getState?.() ||
            null,
          controlBridge: QoL.airControlBridge?.getState?.() || null
        };
      }

      result(handled, reason, extra = {}, forceHandled = null) {
        return {
          handled: forceHandled === null ? !!handled : !!forceHandled,
          reason,
          ...extra
        };
      }

      log(...args) {
        if (!this.cfg.debug) return;
        console.log('[AirNav.Controller]', ...args);
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,
      NAV_ACTION,

      create(options = {}) {
        if (!instance) {
          instance = new AirNavController(options);
        } else {
          instance.enable();
        }

        return instance;
      },

      enable(options = {}) {
        return this.create(options);
      },

      disable() {
        instance?.disable?.();
      },

      destroy() {
        if (!instance) return;
        instance.destroy();
        instance = null;
      },

      isEnabled() {
        return !!instance?.enabled;
      },

      dispatch(actionEvent) {
        return instance
          ? instance.dispatch(actionEvent)
          : {
              handled: false,
              reason: 'controller-not-created'
            };
      },

      getState() {
        return instance ? instance.getState() : {
          enabled: false,
          mode: 'DISABLED'
        };
      },

      setCardActivatePolicy(policy, reason = 'api') {
        if (!instance) {
          const requested =
            String(policy || '');

          const next =
            ['openDetails', 'activateTarget', 'enterActions', 'smart']
              .includes(requested)
              ? requested
              : 'openDetails';

          QoL.settings = QoL.settings || {};
          QoL.settings.airNav = QoL.settings.airNav || {};
          QoL.settings.airNav.behavior =
            QoL.settings.airNav.behavior || {};
          QoL.settings.airNav.behavior.cardActivate = next;

          return {
            changed: false,
            previous: null,
            value: next,
            reason: `${reason}:deferred-until-create`
          };
        }

        return instance.setCardActivatePolicy(policy, reason);
      },

      isSearchHandoffEnabled() {
        return instance
          ? instance.isSearchHandoffEnabled()
          : QoL.settings?.airNav?.searchHandoff?.enabled !== false;
      },

      setSearchHandoffEnabled(enabled, reason = 'api') {
        if (!instance) this.create();
        return instance.setSearchHandoffEnabled(enabled, reason);
      },

      toggleSearchHandoff(reason = 'api') {
        if (!instance) this.create();
        return instance.toggleSearchHandoff(reason);
      },

      compatibilityReport() {
        const takeoverActive = QoL.airNav === api;
        const legacyPresent = !!QoL.airNav && QoL.airNav !== api;
        return {
          version: VERSION,
          legacyVersion: LEGACY_VERSION,
          production: true,
          ready: true,
          takeoverReady: true,
          takeoverActive,
          passiveComparisonMode: legacyPresent,
          legacyPresent,
          started: !!instance?.enabled,
          mode: instance?.mode || 'DISABLED',
          state: instance?.getState?.() || null
        };
      },

      on,
      off
    };

    return api;
  })();


  const existingController = QoL.airNav || null;
  QoL.navigationControllerRuntime = productionApi;

  if (!existingController || existingController === productionApi) {
    QoL.airNav = productionApi;
    console.log(LOG, 'Production Navigation Controller registered as window.JellyfinQoL.airNav.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected Controller detected; production Controller is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }
})(window.JellyfinQoL = window.JellyfinQoL || {});
