// Jellyfin Air Navigation - Phase 8.1.1 Item Action Vertical Exit
//
// Responsibilities:
//   - Own the ITEM_ACTIONS child navigation context.
//   - Consume NavigationItem.actions produced by Scanner.
//   - Keep the parent media card logically selected.
//   - Move between quick actions with canonical LEFT/RIGHT actions.
//   - ACTIVATE the selected action.
//   - BACK / UP / DOWN exits to the parent card.
//   - Render AirNav-owned quick-action focus visuals.
//
// Non-responsibilities:
//   - No raw keyboard/controller handling.
//   - No Jellyfin/plugin selectors. Scanner owns DOM discovery.
//   - No page GeometryEngine decisions.
//   - No page scrolling.
//   - No modal navigation.
//
// Requires when create()/enter() is called:
//   JellyfinQoL.airScanner
//   JellyfinQoL.airFocus

// Jellyfin QoL - Production Navigation ItemActions v1.0.0
// Legacy compatibility: Phase 8.1.1 Item Action Vertical Exit.
//
// The production API remains passive while the injected ItemActions module owns
// JellyfinQoL.airItemActions. Disable only the old ItemActions script and reload
// to transfer ownership without changing Controller or ModalNavigation.
(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '8.1.1';
  const LOG = '[JellyfinQoL.NavigationItemActions]';

  const productionApi = (function () {
    const DEFAULTS = {
      debug: false,
      injectCss: true,
      styleId: 'airnav-item-actions-style',
      ownerClassName: 'airnav-actions-active',
      focusClassName: 'airnav-action-focused',

      outlineWidthPx: 3,
      outlineOffsetPx: 3,
      borderRadiusPx: 999,
      scale: 1.12,
      transitionMs: 100,

      primaryAxisWeight: 1.0,
      secondaryAxisWeight: 1.4,
      epsilonPx: 3
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
          console.error(
            `[AirNav.ItemActions] listener failed for ${event}`,
            error
          );
        }
      });
    }

    function getGlobalSettings() {
      const settings = QoL.settings || {};
      const airNav = settings.airNav || {};

      return {
        ...DEFAULTS,
        ...(airNav.itemActions || {}),
        debug: !!(
          airNav.itemActions?.debug ||
          airNav.debug ||
          settings.DEBUG
        )
      };
    }

    class ItemActionContext {
      constructor(options = {}) {
        this.cfg = {
          ...getGlobalSettings(),
          ...options
        };

        this.started = false;
        this.active = false;

        this.ownerKey = null;
        this.ownerElement = null;
        this.parentSelection = null;

        this.actions = [];
        this.actionKey = null;
        this.renderedActionElement = null;

        this.unsubscribeModel = null;
        this.unsubscribeGeometry = null;

        this.lastMove = null;
        this.lastActivation = null;
        this.lastExit = null;

        this.start();
      }

      start() {
        if (this.started) return this;

        if (!QoL.airScanner || !QoL.airFocus) {
          console.error(
            '[AirNav.ItemActions] Scanner and FocusManager must be loaded first.'
          );
          return this;
        }

        QoL.airScanner.create();
        QoL.airFocus.create();

        this.injectStyles();

        this.unsubscribeModel = QoL.airScanner.on(
          'modelChanged',
          model => this.handleModelUpdate(model, 'modelChanged')
        );

        this.unsubscribeGeometry = QoL.airScanner.on(
          'geometryChanged',
          event => this.handleModelUpdate(
            event?.model || QoL.airScanner.getModel(),
            'geometryChanged'
          )
        );

        this.started = true;
        this.log('started');
        return this;
      }

      destroy() {
        this.exit('destroy');

        for (const unsubscribe of [
          this.unsubscribeModel,
          this.unsubscribeGeometry
        ]) {
          try {
            unsubscribe?.();
          } catch (_) {}
        }

        this.unsubscribeModel = null;
        this.unsubscribeGeometry = null;

        const style =
          document.getElementById(
            this.cfg.styleId
          );

        if (
          style &&
          style.dataset.airnavOwner ===
            'item-actions'
        ) {
          style.remove();
        }

        this.started = false;
        this.log('destroyed');
      }

      enter(ownerKey = null, reason = 'enter-actions') {
        if (!this.started) this.start();

        const prepared =
          QoL.airScanner?.prepareForInput?.(
            'ENTER_ACTIONS'
          ) ||
          QoL.airScanner?.getModel?.();

        if (
          !prepared ||
          prepared.activeSurfaceHint !== 'page'
        ) {
          return this.result(
            false,
            'page-surface-required'
          );
        }

        const selectedKey =
          ownerKey ||
          QoL.airFocus?.getState?.()?.itemKey ||
          null;

        if (!selectedKey) {
          return this.result(
            false,
            'owner-selection-missing'
          );
        }

        let match =
          this.findItemByKey(
            prepared,
            selectedKey
          );

        // One defensive structural retry: quick-action overlays can be inserted
        // after the card itself.
        if (
          !match?.item?.actions?.length
        ) {
          try {
            const rescanned =
              QoL.airScanner?.scan?.(
                'item-actions-enter-refresh'
              );

            match =
              this.findItemByKey(
                rescanned ||
                  QoL.airScanner?.getModel?.(),
                selectedKey
              );
          } catch (_) {}
        }

        if (!match?.item) {
          return this.result(
            false,
            'owner-item-missing',
            { ownerKey: selectedKey }
          );
        }

        const actions =
          this.getUsableActions(
            match.item.actions
          );

        if (!actions.length) {
          return this.result(
            false,
            'no-quick-actions',
            {
              ownerKey: match.item.key,
              title: match.item.title || null
            }
          );
        }

        this.exit(
          'replace-context',
          { emitEvent: false }
        );

        this.active = true;
        this.ownerKey = match.item.key;
        this.ownerElement = match.item.element;
        this.parentSelection =
          QoL.airFocus?.getState?.()
            ? {
                ...QoL.airFocus.getState()
              }
            : null;

        this.actions = actions;

        const preferred =
          actions.find(
            action =>
              action.action === 'play'
          ) ||
          actions[0];

        this.actionKey =
          preferred.key;

        this.render();

        const payload = {
          active: true,
          reason,
          ownerKey: this.ownerKey,
          actionKey: this.actionKey,
          action:
            this.getSelectedActionSnapshot(),
          actions:
            this.actions.map(
              action =>
                this.actionSnapshot(action)
            )
        };

        emit('entered', payload);
        emit('selectionChanged', payload);

        this.log('entered', payload);
        return this.result(
          true,
          'item-actions-entered',
          payload
        );
      }

      exit(
        reason = 'exit-actions',
        options = {}
      ) {
        const wasActive =
          this.active;

        const previous = {
          ownerKey:
            this.ownerKey,
          actionKey:
            this.actionKey
        };

        this.clearVisual();

        this.active = false;
        this.ownerKey = null;
        this.ownerElement = null;
        this.parentSelection = null;
        this.actions = [];
        this.actionKey = null;

        this.lastExit = {
          timestamp: Date.now(),
          reason,
          previous
        };

        const payload = {
          active: false,
          reason,
          previous
        };

        if (
          wasActive &&
          options.emitEvent !== false
        ) {
          emit('exited', payload);
        }

        this.log('exited', payload);

        return this.result(
          wasActive,
          wasActive
            ? 'item-actions-exited'
            : 'item-actions-not-active',
          payload
        );
      }

      dispatch(action) {
        const normalized =
          String(action || '')
            .toUpperCase();

        if (!this.active) {
          return this.result(
            false,
            'item-actions-not-active'
          );
        }

        if (
          normalized === 'LEFT' ||
          normalized === 'RIGHT'
        ) {
          return this.move(normalized);
        }

        if (normalized === 'ACTIVATE') {
          return this.activate();
        }

        if (
          normalized === 'BACK' ||
          normalized === 'UP' ||
          normalized === 'DOWN'
        ) {
          const reason =
            normalized === 'BACK'
              ? 'back-to-parent'
              : normalized === 'UP'
                ? 'up-to-parent'
                : 'down-to-parent';

          return this.exit(reason);
        }

        if (normalized === 'ENTER_ACTIONS') {
          return this.result(
            true,
            'item-actions-owned-clamped',
            {
              action: normalized,
              actionKey: this.actionKey
            }
          );
        }

        return this.result(
          false,
          'item-actions-unhandled-action',
          { action: normalized }
        );
      }

      move(direction) {
        if (!this.refreshFromModel(
          `move:${direction.toLowerCase()}`
        )) {
          return this.exit(
            'owner-or-actions-lost'
          );
        }

        const current =
          this.getSelectedAction();

        if (!current) {
          return this.result(
            false,
            'action-selection-missing'
          );
        }

        const currentRect =
          this.liveRect(current.element) ||
          current.rect;

        if (!currentRect) {
          return this.result(
            false,
            'action-geometry-missing'
          );
        }

        const sign =
          direction === 'RIGHT'
            ? 1
            : -1;

        const candidates =
          this.actions
            .filter(
              action =>
                action.key !== current.key &&
                this.isUsableAction(action)
            )
            .map(action => {
              const rect =
                this.liveRect(
                  action.element
                ) ||
                action.rect;

              if (!rect) return null;

              const primary =
                sign > 0
                  ? rect.centerX -
                    currentRect.centerX
                  : currentRect.centerX -
                    rect.centerX;

              if (
                primary <=
                Number(this.cfg.epsilonPx)
              ) {
                return null;
              }

              const secondary =
                Math.abs(
                  rect.centerY -
                  currentRect.centerY
                );

              return {
                action,
                rect,
                score:
                  primary *
                    Number(
                      this.cfg.primaryAxisWeight
                    ) +
                  secondary *
                    Number(
                      this.cfg.secondaryAxisWeight
                    )
              };
            })
            .filter(Boolean)
            .sort(
              (a, b) =>
                a.score - b.score
            );

        if (!candidates.length) {
          this.lastMove = {
            direction,
            moved: false,
            reason:
              'item-actions-edge',
            actionKey:
              current.key
          };

          return this.result(
            true,
            'item-actions-edge',
            this.lastMove
          );
        }

        const target =
          candidates[0].action;

        this.actionKey =
          target.key;

        this.render();

        this.lastMove = {
          timestamp: Date.now(),
          direction,
          moved: true,
          from: current.key,
          to: target.key,
          score:
            candidates[0].score
        };

        const payload = {
          active: true,
          ownerKey: this.ownerKey,
          actionKey: this.actionKey,
          action:
            this.getSelectedActionSnapshot(),
          move:
            this.lastMove
        };

        emit(
          'selectionChanged',
          payload
        );

        this.log('move', payload);

        return this.result(
          true,
          'item-action-moved',
          payload
        );
      }

      activate() {
        if (!this.refreshFromModel(
          'activate'
        )) {
          return this.exit(
            'owner-or-actions-lost'
          );
        }

        const action =
          this.getSelectedAction();

        if (
          !action ||
          !action.element?.isConnected
        ) {
          return this.result(
            false,
            'action-target-missing'
          );
        }

        if (action.enabled === false) {
          return this.result(
            true,
            'action-disabled',
            {
              actionKey:
                action.key
            }
          );
        }

        const activation = {
          timestamp:
            performance.now(),
          ownerKey:
            this.ownerKey,
          actionKey:
            action.key,
          action:
            action.action,
          title:
            action.title || null
        };

        try {
          action.element.click();
        } catch (error) {
          console.error(
            '[AirNav.ItemActions] action activation failed',
            error
          );

          return this.result(
            false,
            'item-action-click-failed',
            {
              activation,
              error
            }
          );
        }

        this.lastActivation =
          activation;

        emit(
          'activation',
          activation
        );

        // Favourite/watched controls often replace their own DOM or change
        // state after the click. Rebind by stable action key after Jellyfin has
        // processed the action.
        setTimeout(() => {
          if (!this.active) return;

          try {
            QoL.airScanner?.scan?.(
              'item-action-post-activate'
            );
          } catch (_) {}

          this.refreshFromModel(
            'post-activate'
          );
        }, 80);

        this.log(
          'activation',
          activation
        );

        return this.result(
          true,
          'item-action-activated',
          { activation }
        );
      }

      handleModelUpdate(
        model,
        reason = 'model'
      ) {
        if (!this.active) return;

        if (
          !model ||
          model.activeSurfaceHint !== 'page'
        ) {
          this.exit(
            `surface-changed:${model?.activeSurfaceHint || 'missing'}`
          );
          return;
        }

        this.refreshFromModel(reason);
      }

      refreshFromModel(
        reason = 'refresh'
      ) {
        if (!this.active) return false;

        const model =
          QoL.airScanner?.getModel?.();

        if (
          !model ||
          model.activeSurfaceHint !== 'page'
        ) {
          return false;
        }

        const match =
          this.findItemByKey(
            model,
            this.ownerKey
          );

        if (!match?.item) {
          return false;
        }

        const actions =
          this.getUsableActions(
            match.item.actions
          );

        if (!actions.length) {
          return false;
        }

        const previousActionKey =
          this.actionKey;

        this.ownerElement =
          match.item.element;

        this.actions =
          actions;

        if (
          !this.actions.some(
            action =>
              action.key ===
              previousActionKey
          )
        ) {
          this.actionKey =
            (
              this.actions.find(
                action =>
                  action.action ===
                  'play'
              ) ||
              this.actions[0]
            ).key;
        }

        this.render();

        this.log(
          `refreshed reason=${reason}`,
          {
            ownerKey:
              this.ownerKey,
            actionKey:
              this.actionKey,
            actions:
              this.actions.length
          }
        );

        return true;
      }

      findItemByKey(model, itemKey) {
        if (!model || !itemKey) return null;

        const sections = [
          model.header,
          ...(model.sections || [])
        ].filter(Boolean);

        for (const section of sections) {
          const item =
            (section.items || [])
              .find(
                candidate =>
                  candidate.key === itemKey
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

      getUsableActions(actions) {
        return (
          Array.isArray(actions)
            ? actions
            : []
        ).filter(
          action =>
            this.isUsableAction(action)
        );
      }

      isUsableAction(action) {
        return !!(
          action &&
          action.key &&
          action.element &&
          action.element.isConnected &&
          action.enabled !== false
        );
      }

      getSelectedAction() {
        return (
          this.actions.find(
            action =>
              action.key ===
              this.actionKey
          ) ||
          null
        );
      }

      actionSnapshot(action) {
        if (!action) return null;

        return {
          key:
            action.key,
          action:
            action.action,
          title:
            action.title || null,
          enabled:
            action.enabled !== false,
          connected:
            !!action.element?.isConnected,
          rect:
            this.liveRect(
              action.element
            ) ||
            (
              action.rect
                ? { ...action.rect }
                : null
            )
        };
      }

      getSelectedActionSnapshot() {
        return this.actionSnapshot(
          this.getSelectedAction()
        );
      }

      render() {
        if (!this.active) return false;

        this.clearActionVisual();

        if (
          this.ownerElement?.isConnected
        ) {
          this.ownerElement.classList.add(
            this.cfg.ownerClassName
          );
        }

        const action =
          this.getSelectedAction();

        if (
          !action?.element?.isConnected
        ) {
          return false;
        }

        const element =
          action.element;

        element.classList.add(
          this.cfg.focusClassName
        );

        element.setAttribute(
          'data-airnav-action-focused',
          'true'
        );

        element.style.setProperty(
          '--airnav-action-scale',
          String(this.cfg.scale)
        );

        this.renderedActionElement =
          element;

        if (
          typeof element.focus ===
          'function'
        ) {
          try {
            element.focus({
              preventScroll: true
            });
          } catch (_) {
            try {
              element.focus();
            } catch (_) {}
          }
        }

        return true;
      }

      clearActionVisual() {
        if (
          this.renderedActionElement
        ) {
          this.removeActionVisual(
            this.renderedActionElement
          );
        }

        this.renderedActionElement =
          null;

        document
          .querySelectorAll(
            `.${this.escapeCssIdentifier(
              this.cfg.focusClassName
            )}`
          )
          .forEach(
            element =>
              this.removeActionVisual(
                element
              )
          );
      }

      clearVisual() {
        this.clearActionVisual();

        document
          .querySelectorAll(
            `.${this.escapeCssIdentifier(
              this.cfg.ownerClassName
            )}`
          )
          .forEach(element => {
            element.classList.remove(
              this.cfg.ownerClassName
            );
          });
      }

      removeActionVisual(element) {
        if (!element?.classList) return;

        element.classList.remove(
          this.cfg.focusClassName
        );

        element.removeAttribute(
          'data-airnav-action-focused'
        );

        element.style?.removeProperty(
          '--airnav-action-scale'
        );
      }

      liveRect(element) {
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
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          return null;
        }

        return {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX:
            rect.left +
            rect.width / 2,
          centerY:
            rect.top +
            rect.height / 2
        };
      }

      injectStyles() {
        if (!this.cfg.injectCss) return;

        let style =
          document.getElementById(
            this.cfg.styleId
          );

        if (!style) {
          style =
            document.createElement(
              'style'
            );

          style.id =
            this.cfg.styleId;

          style.dataset.airnavOwner =
            'item-actions';

          document.head.appendChild(
            style
          );
        }

        const ownerClass =
          this.escapeCssIdentifier(
            this.cfg.ownerClassName
          );

        const focusClass =
          this.escapeCssIdentifier(
            this.cfg.focusClassName
          );

        style.textContent = `
          .${ownerClass} .cardOverlayContainer,
          .${ownerClass} .cardOverlayButton,
          .${ownerClass} .cardOverlayFab-primary {
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: auto !important;
          }

          .${focusClass} {
            outline:
              ${Number(
                this.cfg.outlineWidthPx
              )}px solid
              var(
                --theme-primary-color,
                var(
                  --primary-accent-color,
                  #00a4dc
                )
              ) !important;
            outline-offset:
              ${Number(
                this.cfg.outlineOffsetPx
              )}px !important;
            border-radius:
              ${Number(
                this.cfg.borderRadiusPx
              )}px !important;
            box-shadow:
              0 0 16px
              rgba(0,164,220,.65)
              !important;
            transform:
              scale(
                var(
                  --airnav-action-scale,
                  ${Number(
                    this.cfg.scale
                  )}
                )
              ) !important;
            position: relative;
            z-index: 50 !important;
            transition:
              transform
              ${Number(
                this.cfg.transitionMs
              )}ms ease,
              box-shadow
              ${Number(
                this.cfg.transitionMs
              )}ms ease;
          }
        `;
      }

      escapeCssIdentifier(value) {
        if (window.CSS?.escape) {
          return CSS.escape(value);
        }

        return String(value || '')
          .replace(
            /[^a-zA-Z0-9_-]/g,
            '\\$&'
          );
      }

      getState() {
        return {
          version: '8.1.1',
          started:
            this.started,
          active:
            this.active,
          ownerKey:
            this.ownerKey,
          parentSelection:
            this.parentSelection
              ? {
                  ...this.parentSelection
                }
              : null,
          actionKey:
            this.actionKey,
          selectedAction:
            this.getSelectedActionSnapshot(),
          actions:
            this.actions.map(
              action =>
                this.actionSnapshot(
                  action
                )
            ),
          lastMove:
            this.lastMove,
          lastActivation:
            this.lastActivation,
          lastExit:
            this.lastExit
        };
      }

      result(
        handled,
        reason,
        extra = {}
      ) {
        return {
          handled:
            !!handled,
          reason,
          ...extra
        };
      }

      log(...args) {
        if (!this.cfg.debug) return;

        console.log(
          '[AirNav.ItemActions]',
          ...args
        );
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,

      create(options = {}) {
        if (!instance) {
          instance =
            new ItemActionContext(
              options
            );
        } else {
          instance.start();
        }

        return instance;
      },

      destroy() {
        if (!instance) return;

        instance.destroy();
        instance = null;
      },

      enter(ownerKey = null, reason = 'enter-actions') {
        return this.create().enter(
          ownerKey,
          reason
        );
      },

      exit(reason = 'exit-actions') {
        return instance
          ? instance.exit(reason)
          : {
              handled: false,
              reason:
                'item-actions-not-created'
            };
      },

      dispatch(action) {
        return instance
          ? instance.dispatch(action)
          : {
              handled: false,
              reason:
                'item-actions-not-created'
            };
      },

      isActive() {
        return !!instance?.active;
      },

      getState() {
        return instance
          ? instance.getState()
          : {
              version: LEGACY_VERSION,
              started: false,
              active: false
            };
      },

      compatibilityReport() {
        const takeoverActive = QoL.airItemActions === api;
        const legacyPresent = !!QoL.airItemActions && QoL.airItemActions !== api;
        const state = instance?.getState?.() || null;
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
          active: !!instance?.active,
          ownerKey: state?.ownerKey || null,
          actionKey: state?.actionKey || null,
          selectedAction: state?.selectedAction || null,
          lastActivation: state?.lastActivation || null,
          lastExit: state?.lastExit || null
        };
      },

      on,
      off
    };

    return api;
  })();


  const existingItemActions = QoL.airItemActions || null;
  QoL.navigationItemActionsRuntime = productionApi;

  if (!existingItemActions || existingItemActions === productionApi) {
    QoL.airItemActions = productionApi;
    console.log(LOG, 'Production Navigation ItemActions registered as window.JellyfinQoL.airItemActions.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected ItemActions detected; production ItemActions is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }
})(window.JellyfinQoL = window.JellyfinQoL || {});

