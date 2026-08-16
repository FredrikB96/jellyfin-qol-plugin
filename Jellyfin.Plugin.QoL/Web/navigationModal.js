// Jellyfin Air Navigation - Phase 9.0.10 Pane Bridge + Activity Pulse
//
// Responsibilities:
//   - Own logical selection while Scanner reports activeSurfaceHint="modal".
//   - Consume modal.sections/defaultItemKey/closeAction from Scanner.
//   - Navigate LEFT/RIGHT within a modal section.
//   - Navigate UP/DOWN by visual geometry across modal sections.
//   - ACTIVATE the selected modal control.
//   - BACK requests modal close through Scanner-provided closeAction.
//   - Restore the parent page item by stable key after modal close.
//   - Reveal the selected control inside a scrollable modal body when needed.
//
// Non-responsibilities:
//   - No keyboard/controller key codes.
//   - No Jellyfin/plugin DOM selectors. Scanner owns DOM knowledge.
//   - No page FocusManager rendering while the modal is active.
//   - No page GeometryEngine or ScrollManager changes.

// Jellyfin QoL - Production Navigation Modal v1.0.0
// Legacy compatibility: Phase 9.0.10 Pane Bridge + Activity Pulse.
//
// The production API remains passive while the injected ModalNavigation module
// owns JellyfinQoL.airModal. Disable only that old script and reload to transfer
// ownership without changing Scanner, Controller, or canonical input.
(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '9.0.10';
  const LOG = '[JellyfinQoL.NavigationModal]';

  const productionApi = (function () {
    const DEFAULTS = {
      debug: false,
      injectCss: true,
      styleId: 'airnav-modal-focus-style',
      focusClassName: 'airnav-modal-focused',
      outlineWidthPx: 3,
      outlineOffsetPx: 3,
      borderRadiusPx: 10,
      // Keep scale modest because Jellyfin Enhanced/Jellyseerr wraps some
      // modal CTA buttons in overflow:hidden containers. The main selection
      // indicator is therefore an INSIDE ring rather than an outside outline.
      scale: 1.025,
      transitionMs: 100,
      insideRingPx: 3,
      insideRingGapPx: 2,
      focusBrightness: 1.22,
      focusSaturation: 1.08,

      groupActiveClassName:
        'airnav-modal-group-active',
      groupActiveInsetPx: 2,

      // Some plugin-owned settings panels hide/close after inactivity. AirNav
      // consumes the physical keyboard/remote event before plugin listeners
      // see it, so Scanner may request a harmless pointer-move activity pulse.
      modalActivityPulseMinIntervalMs: 180,

      // Settings navigation panes are visually split: nav tabs on the left,
      // setting groups on the right. Scanner publishes neutral pane metadata;
      // ModalNavigation only bridges those semantic model items.
      paneBridgeSectionPenalty: 35,

      epsilonPx: 4,
      primaryAxisWeight: 1.0,
      secondaryAxisWeight: 1.8,
      overlapReward: 220,
      sectionPenalty: 35,
      offAxisPenalty: 160,
      offAxisThresholdPx: 180,
      minimumPerpendicularOverlap: 0.18,

      // Repeated binary controls (season/movie switches) form a semantic
      // vertical lane. Prefer the immediately adjacent switch before global
      // geometry so a stale preferredX from a footer/select cannot skip rows.
      controlLaneTolerancePx: 80,

      // Some plugin modals place their main CTA (for example Jellyseerr's
      // Request button) on its own visual row, while utility controls live far
      // to the left/right. Horizontal navigation normally stays row-local. At
      // a horizontal edge, allow a directional bridge TO the Scanner-tagged
      // modal-primary section instead of hardcoding a button title/plugin.
      horizontalEdgeBridgeToPrimary: true,
      horizontalEdgeBridgeSectionPenalty: 70,

      // Native Jellyfin action sheets (opened by card More/menu) often have no
      // explicit Close/Cancel button. Jellyfin itself closes them when Mouse1
      // lands outside the sheet. Scanner can expose that outside-click target;
      // reuse the same dismissal path for canonical BACK.
      outsideClickDismissFallback: true,
      outsideClickRescanDelayMs: 70,
      outsideClickNativeFallbackDelayMs: 180,

      // Last-resort compatibility path if the outside-click mechanism does not
      // close an unusual sheet.
      nativeBackFallback: true,
      nativeBackRescanDelayMs: 80,

      scrollMarginPx: 24
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
            `[AirNav.Modal] listener failed for ${event}`,
            error
          );
        }
      });
    }

    function getSettings() {
      const settings = QoL.settings || {};
      const airNav = settings.airNav || {};

      return {
        ...DEFAULTS,
        ...(airNav.modal || {}),
        debug: !!(
          airNav.modal?.debug ||
          airNav.debug ||
          settings.DEBUG
        )
      };
    }

    class ModalNavigationContext {
      constructor(options = {}) {
        this.cfg = {
          ...getSettings(),
          ...options
        };

        this.started = false;
        this.active = false;
        this.contextId = null;
        this.context = null;
        this.parentReturnState = null;
        this.selectedItemKey = null;
        this.preferredX = null;
        this.renderedElement = null;
        this.closeRequested = false;
        this.editingControlKey = null;
        this.editingControlKind = null;
        this.lastFormEdit = null;

        this.positionGridContext = null;
        this.positionGridCellKey = null;

        this.activeGroupKey = null;
        this.groupControlKey = null;
        this.groupPreferredX = null;
        this.renderedGroupElement = null;
        this.lastGroupMove = null;
        this.lastGroupActivation = null;

        this.lastActivityPulseAt = 0;
        this.lastActivityPulse = null;

        this.unsubscribeModel = null;
        this.unsubscribeGeometry = null;

        this.lastMove = null;
        this.lastActivation = null;
        this.lastClose = null;
        this.lastRestore = null;

        // Scanner intentionally keeps nested plugin dialogs under one modal
        // surface. When the active modal id changes (outer -> nested -> outer),
        // preserve selection per modal context instead of carrying geometry
        // such as preferredX from the previous dialog.
        this.contextStates = new Map();

        this.start();
      }

      start() {
        if (this.started) return this;

        if (!QoL.airScanner) {
          console.error(
            '[AirNav.Modal] Scanner must be loaded before modal navigation.'
          );
          return this;
        }

        QoL.airScanner.create();
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
        this.exit('destroy', { restore: false });

        for (const unsubscribe of [
          this.unsubscribeModel,
          this.unsubscribeGeometry
        ]) {
          try { unsubscribe?.(); } catch (_) {}
        }

        this.unsubscribeModel = null;
        this.unsubscribeGeometry = null;

        const style = document.getElementById(this.cfg.styleId);
        if (style?.dataset?.airnavOwner === 'modal') {
          style.remove();
        }

        this.started = false;
        this.log('destroyed');
      }

      enter(modalContext = null, parentReturnState = null, reason = 'modal-opened') {
        if (!this.started) this.start();

        const model = QoL.airScanner?.getModel?.();
        const context =
          modalContext ||
          model?.modal ||
          null;

        if (!context?.root?.isConnected) {
          return this.result(false, 'modal-context-missing');
        }

        if (this.active && this.contextId === context.id) {
          this.context = context;
          this.rebindSelection('enter-existing-context');
          return this.result(true, 'modal-context-already-active', this.getState());
        }

        this.clearVisual();

        this.active = true;
        this.contextId = context.id;
        this.context = context;
        this.parentReturnState = this.normalizeReturnState(parentReturnState);
        this.closeRequested = false;

        const first =
          this.findItemByKey(context.defaultItemKey) ||
          this.getAllItems()[0] ||
          null;

        if (first) {
          this.commitSelection(first, reason);
        } else {
          this.selectedItemKey = null;
          this.preferredX = null;
        }

        const payload = {
          active: true,
          reason,
          contextId: this.contextId,
          selectedItemKey: this.selectedItemKey,
          parentReturnState: this.parentReturnState,
          sections: context.sections?.length || 0,
          items: this.getAllItems().length
        };

        emit('entered', payload);
        this.log('entered', payload);

        return this.result(true, 'modal-navigation-entered', payload);
      }

      exit(reason = 'modal-exit', options = {}) {
        const wasActive = this.active;
        const returnState = this.parentReturnState
          ? { ...this.parentReturnState }
          : null;

        this.clearVisual();

        this.active = false;
        this.contextId = null;
        this.context = null;
        this.selectedItemKey = null;
        this.preferredX = null;
        this.closeRequested = false;
        this.parentReturnState = null;
        this.editingControlKey = null;
        this.editingControlKind = null;
        this.clearPositionGridVisual();
        this.positionGridContext = null;
        this.positionGridCellKey = null;
        this.clearGroupState();
        this.contextStates.clear();

        let restore = null;
        if (options.restore !== false && returnState) {
          restore = this.restoreParent(returnState, reason);
        }

        const payload = {
          active: false,
          reason,
          wasActive,
          returnState,
          restore
        };

        if (wasActive) emit('exited', payload);
        this.log('exited', payload);

        return this.result(wasActive, wasActive ? 'modal-navigation-exited' : 'modal-navigation-not-active', payload);
      }

      handleClosed(info = null, reason = 'modal-closed') {
        this.lastClose = {
          timestamp: Date.now(),
          reason,
          info
        };

        return this.exit(reason, { restore: true });
      }

      dispatch(action) {
        const normalized = String(action || '').toUpperCase();

        if (!this.active) {
          return this.result(false, 'modal-navigation-not-active');
        }

        this.pulseModalActivity(
          normalized
        );

        if (this.editingControlKey) {
          if (
            this.editingControlKind ===
              'position-grid'
          ) {
            if (
              normalized === 'BACK'
            ) {
              return this.exitPositionGridEdit(
                'back',
                false
              );
            }

            if (
              normalized === 'ACTIVATE'
            ) {
              return this.commitPositionGridEdit();
            }

            if (
              normalized === 'LEFT' ||
              normalized === 'RIGHT' ||
              normalized === 'UP' ||
              normalized === 'DOWN'
            ) {
              return this.movePositionGrid(
                normalized
              );
            }

            return this.result(
              true,
              'modal-position-grid-edit-clamp',
              {
                action:
                  normalized,
                itemKey:
                  this.editingControlKey,
                cellKey:
                  this.positionGridCellKey
              }
            );
          }

          if (
            normalized === 'ACTIVATE'
          ) {
            return this.exitFormEdit(
              'activate'
            );
          }

          if (
            normalized === 'BACK'
          ) {
            return this.exitFormEdit(
              'back'
            );
          }

          if (
            this.editingControlKind ===
              'select'
          ) {
            if (
              normalized === 'UP' ||
              normalized === 'DOWN'
            ) {
              return this.adjustSelect(
                normalized
              );
            }

            return this.result(
              true,
              'modal-select-edit-clamp',
              {
                action: normalized,
                itemKey:
                  this.editingControlKey
              }
            );
          }

          if (
            this.editingControlKind ===
              'number'
          ) {
            if (
              normalized === 'UP' ||
              normalized === 'DOWN'
            ) {
              return this.adjustNumeric(
                normalized === 'UP'
                  ? 1
                  : -1
              );
            }

            return this.result(
              true,
              'modal-number-edit-clamp',
              {
                action: normalized,
                itemKey:
                  this.editingControlKey
              }
            );
          }

          if (
            this.editingControlKind ===
              'range'
          ) {
            if (
              normalized === 'LEFT' ||
              normalized === 'RIGHT'
            ) {
              return this.adjustNumeric(
                normalized === 'RIGHT'
                  ? 1
                  : -1
              );
            }

            return this.result(
              true,
              'modal-range-edit-clamp',
              {
                action: normalized,
                itemKey:
                  this.editingControlKey
              }
            );
          }
        }

        if (this.activeGroupKey) {
          return this.dispatchGroup(
            normalized
          );
        }

        if (
          normalized === 'LEFT' ||
          normalized === 'RIGHT' ||
          normalized === 'UP' ||
          normalized === 'DOWN'
        ) {
          return this.move(normalized);
        }

        if (normalized === 'ACTIVATE') {
          return this.activate();
        }

        if (normalized === 'BACK') {
          return this.requestClose('back');
        }

        return this.result(false, 'modal-unhandled-action', { action: normalized });
      }

      move(direction) {
        const prepared = QoL.airScanner?.prepareForInput?.(direction);
        if (prepared?.modal) {
          this.context = prepared.modal;
        }

        if (!this.rebindSelection(`pre-move:${direction.toLowerCase()}`)) {
          return this.result(true, 'modal-selection-unavailable', { direction });
        }

        const current = this.findItemByKey(this.selectedItemKey);
        if (!current) {
          return this.result(true, 'modal-selection-missing', { direction });
        }

        const decision = this.resolve(direction, current);

        if (!decision.target) {
          this.lastMove = {
            timestamp: Date.now(),
            direction,
            moved: false,
            reason: decision.reason,
            from: current.item.key
          };

          return this.result(true, decision.reason, {
            direction,
            movement: this.lastMove
          });
        }

        const previousKey = current.item.key;
        this.commitSelection(
          decision.target,
          `modal:${direction.toLowerCase()}`,
          {
            preservePreferredX:
              direction === 'UP' || direction === 'DOWN'
          }
        );

        this.lastMove = {
          timestamp: Date.now(),
          direction,
          moved: true,
          from: previousKey,
          to: this.selectedItemKey,
          reason: decision.reason,
          score: decision.score ?? null
        };

        emit('selectionChanged', {
          contextId: this.contextId,
          itemKey: this.selectedItemKey,
          movement: this.lastMove
        });

        return this.result(true, 'modal-moved', {
          direction,
          movement: this.lastMove
        });
      }

      resolve(direction, current) {
        if (direction === 'LEFT' || direction === 'RIGHT') {
          return this.resolveHorizontal(direction, current);
        }

        return this.resolveVertical(direction, current);
      }

      resolveHorizontal(direction, current) {
        const sign = direction === 'RIGHT' ? 1 : -1;
        const epsilon = Number(this.cfg.epsilonPx) || 4;

        const candidates = (current.section.items || [])
          .filter(item => this.isUsableItem(item) && item.key !== current.item.key)
          .map(item => {
            const rect = this.liveRect(item.element) || item.rect;
            if (!rect) return null;

            const primary = sign > 0
              ? rect.centerX - current.rect.centerX
              : current.rect.centerX - rect.centerX;

            if (primary <= epsilon) return null;

            const secondary = Math.abs(rect.centerY - current.rect.centerY);
            const overlap = this.overlapRatio(current.rect, rect, 'horizontal');

            return {
              section: current.section,
              item,
              rect,
              score:
                primary * Number(this.cfg.primaryAxisWeight) +
                secondary * Number(this.cfg.secondaryAxisWeight) -
                overlap * Number(this.cfg.overlapReward)
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.score - b.score);

        if (candidates.length) {
          return {
            target: candidates[0],
            score: candidates[0].score,
            reason: 'modal-horizontal-candidate'
          };
        }

        const paneBridge =
          this.resolveHorizontalPaneBridge(
            direction,
            current
          );

        if (paneBridge) {
          return {
            target:
              paneBridge,
            score:
              paneBridge.score,
            reason:
              'modal-horizontal-pane-bridge'
          };
        }

        const bridge =
          this.resolveHorizontalPrimaryBridge(
            direction,
            current
          );

        if (bridge) {
          return {
            target: bridge,
            score: bridge.score,
            reason: 'modal-horizontal-primary-bridge'
          };
        }

        return {
          target: null,
          score: null,
          reason: 'modal-horizontal-edge'
        };
      }

      resolveHorizontalPaneBridge(
        direction,
        current
      ) {
        if (!this.context) {
          return null;
        }

        const semanticType =
          current.item?.metadata
            ?.modalSemanticType ||
          null;

        const currentIsGroup =
          this.isSettingGroup(
            current.item
          );

        // RIGHT from a settings tab enters the setting groups belonging to
        // that tab/pane. This avoids requiring an unlikely row-aligned global
        // geometry candidate across the wide left-nav -> content gap.
        if (
          direction === 'RIGHT' &&
          semanticType ===
            'settings-tab'
        ) {
          const paneKey =
            current.item?.metadata
              ?.modalPaneKey ||
            this.context?.metadata
              ?.activePaneKey ||
            null;

          if (!paneKey) {
            return null;
          }

          const candidates = [];

          for (
            const section of
            this.context.sections || []
          ) {
            for (
              const item of
              section.items || []
            ) {
              if (
                !this.isSettingGroup(
                  item
                ) ||
                item.metadata
                  ?.modalGroupPane !==
                  paneKey ||
                !this.isUsableItem(
                  item
                )
              ) {
                continue;
              }

              const rect =
                this.liveRect(
                  item.element
                ) ||
                item.rect;

              if (!rect) continue;

              const primary =
                rect.centerX -
                current.rect.centerX;

              if (
                primary <=
                Number(
                  this.cfg.epsilonPx
                )
              ) {
                continue;
              }

              const secondary =
                Math.abs(
                  rect.centerY -
                  current.rect.centerY
                );

              candidates.push({
                section,
                item,
                rect,
                score:
                  primary *
                    Number(
                      this.cfg
                        .primaryAxisWeight
                    ) +
                  secondary *
                    Number(
                      this.cfg
                        .secondaryAxisWeight
                    ) +
                  Number(
                    this.cfg
                      .paneBridgeSectionPenalty
                  )
              });
            }
          }

          candidates.sort(
            (a, b) =>
              a.rect.top - b.rect.top ||
              a.score - b.score
          );

          return candidates[0] || null;
        }

        // LEFT from an outer setting group returns to the tab that owns the
        // group's active pane.
        if (
          direction === 'LEFT' &&
          currentIsGroup
        ) {
          const paneKey =
            current.item?.metadata
              ?.modalGroupPane ||
            this.context?.metadata
              ?.activePaneKey ||
            null;

          if (!paneKey) {
            return null;
          }

          const candidates = [];

          for (
            const section of
            this.context.sections || []
          ) {
            for (
              const item of
              section.items || []
            ) {
              if (
                item?.metadata
                  ?.modalSemanticType !==
                  'settings-tab' ||
                item?.metadata
                  ?.modalPaneKey !==
                  paneKey ||
                !this.isUsableItem(
                  item
                )
              ) {
                continue;
              }

              const rect =
                this.liveRect(
                  item.element
                ) ||
                item.rect;

              if (!rect) continue;

              const primary =
                current.rect.centerX -
                rect.centerX;

              if (
                primary <=
                Number(
                  this.cfg.epsilonPx
                )
              ) {
                continue;
              }

              const secondary =
                Math.abs(
                  rect.centerY -
                  current.rect.centerY
                );

              candidates.push({
                section,
                item,
                rect,
                score:
                  primary *
                    Number(
                      this.cfg
                        .primaryAxisWeight
                    ) +
                  secondary *
                    Number(
                      this.cfg
                        .secondaryAxisWeight
                    ) +
                  Number(
                    this.cfg
                      .paneBridgeSectionPenalty
                  )
              });
            }
          }

          candidates.sort(
            (a, b) =>
              a.score - b.score
          );

          return candidates[0] || null;
        }

        return null;
      }

      resolveHorizontalPrimaryBridge(direction, current) {
        if (
          this.cfg.horizontalEdgeBridgeToPrimary === false ||
          !this.context
        ) {
          return null;
        }

        // Do not bounce a primary action back into itself. The bridge exists
        // specifically to make isolated CTAs reachable from neighbouring rows.
        if (
          current.section?.type === 'modal-primary' ||
          current.section?.metadata?.role === 'primary'
        ) {
          return null;
        }

        const primarySections =
          (this.context.sections || [])
            .filter(section =>
              section?.type === 'modal-primary' ||
              section?.metadata?.role === 'primary'
            );

        if (!primarySections.length) {
          return null;
        }

        const sign =
          direction === 'RIGHT'
            ? 1
            : -1;

        const epsilon =
          Number(this.cfg.epsilonPx) || 4;

        const candidates = [];

        for (const section of primarySections) {
          for (const item of section.items || []) {
            if (!this.isUsableItem(item)) continue;

            const rect =
              this.liveRect(item.element) ||
              item.rect;

            if (!rect) continue;

            // Direction is authoritative. If the primary CTA is visually to
            // the left, only LEFT can bridge to it; if it is on the right,
            // only RIGHT can bridge to it.
            const primary =
              sign > 0
                ? rect.centerX - current.rect.centerX
                : current.rect.centerX - rect.centerX;

            if (primary <= epsilon) continue;

            const secondary =
              Math.abs(
                rect.centerY -
                current.rect.centerY
              );

            candidates.push({
              section,
              item,
              rect,
              score:
                primary *
                  Number(this.cfg.primaryAxisWeight) +
                secondary *
                  Number(this.cfg.secondaryAxisWeight) +
                Number(
                  this.cfg.horizontalEdgeBridgeSectionPenalty
                )
            });
          }
        }

        candidates.sort(
          (a, b) =>
            a.score - b.score
        );

        return candidates[0] || null;
      }

      resolveVertical(direction, current) {
        const lane =
          this.resolveControlLane(
            direction,
            current
          );

        if (lane) {
          return {
            target: lane,
            score: lane.score,
            reason: 'modal-control-lane-candidate'
          };
        }

        const sign = direction === 'DOWN' ? 1 : -1;
        const epsilon = Number(this.cfg.epsilonPx) || 4;
        const preferredX = Number.isFinite(this.preferredX)
          ? this.preferredX
          : current.rect.centerX;

        const candidates = [];

        for (const section of this.context?.sections || []) {
          for (const item of section.items || []) {
            if (!this.isUsableItem(item) || item.key === current.item.key) continue;

            const rect = this.liveRect(item.element) || item.rect;
            if (!rect) continue;

            const primary = sign > 0
              ? rect.centerY - current.rect.centerY
              : current.rect.centerY - rect.centerY;

            if (primary <= epsilon) continue;

            const secondary = Math.abs(rect.centerX - preferredX);
            const overlap = this.overlapRatio(current.rect, rect, 'vertical');
            const offAxis =
              secondary > Number(this.cfg.offAxisThresholdPx) &&
              overlap < Number(this.cfg.minimumPerpendicularOverlap)
                ? Number(this.cfg.offAxisPenalty)
                : 0;

            const sectionPenalty = section.id === current.section.id
              ? 0
              : Number(this.cfg.sectionPenalty);

            candidates.push({
              section,
              item,
              rect,
              score:
                primary * Number(this.cfg.primaryAxisWeight) +
                secondary * Number(this.cfg.secondaryAxisWeight) -
                overlap * Number(this.cfg.overlapReward) +
                offAxis +
                sectionPenalty
            });
          }
        }

        candidates.sort((a, b) => a.score - b.score);

        return {
          target: candidates[0] || null,
          score: candidates[0]?.score ?? null,
          reason: candidates.length ? 'modal-vertical-candidate' : 'modal-vertical-edge'
        };
      }

      isToggleControl(item) {
        const element =
          item?.element || null;

        return !!(
          item?.metadata?.modalControlKind === 'toggle' ||
          element?.matches?.(
            'input[type="checkbox"], [role="checkbox"], [role="switch"]'
          )
        );
      }

      isSelectControl(item) {
        const element =
          item?.element || null;

        return !!(
          item?.metadata?.modalControlKind === 'select' ||
          element?.matches?.('select')
        );
      }

      isNumberControl(item) {
        return !!(
          item?.metadata
            ?.modalControlKind ===
            'number' ||
          item?.element?.matches?.(
            'input[type="number"]'
          )
        );
      }

      isRangeControl(item) {
        return !!(
          item?.metadata
            ?.modalControlKind ===
            'range' ||
          item?.element?.matches?.(
            'input[type="range"]'
          )
        );
      }

      isPositionGridControl(item) {
        return !!(
          item?.metadata
            ?.modalControlKind ===
            'position-grid'
        );
      }

      resolveControlLane(direction, current) {
        if (!this.isToggleControl(current?.item)) {
          return null;
        }

        const lane =
          current?.item?.metadata
            ?.modalControlLane ||
          null;

        if (!lane) {
          return null;
        }

        const sign =
          direction === 'DOWN'
            ? 1
            : -1;

        const epsilon =
          Number(this.cfg.epsilonPx) || 4;

        const tolerance =
          Math.max(
            24,
            Number(
              this.cfg.controlLaneTolerancePx
            ) || 80
          );

        const candidates = [];

        for (const section of this.context?.sections || []) {
          for (const item of section.items || []) {
            if (
              item.key === current.item.key ||
              !this.isUsableItem(item) ||
              !this.isToggleControl(item) ||
              item?.metadata
                ?.modalControlLane !==
                lane
            ) {
              continue;
            }

            const rect =
              this.liveRect(item.element) ||
              item.rect;

            if (!rect) continue;

            const primary =
              sign > 0
                ? rect.centerY - current.rect.centerY
                : current.rect.centerY - rect.centerY;

            if (primary <= epsilon) continue;

            const laneOffset =
              Math.abs(
                rect.centerX -
                current.rect.centerX
              );

            if (laneOffset > tolerance) {
              continue;
            }

            candidates.push({
              section,
              item,
              rect,
              primary,
              laneOffset,
              // Adjacent row wins first; lateral drift only breaks ties.
              score:
                primary +
                laneOffset * 0.25
            });
          }
        }

        candidates.sort(
          (a, b) =>
            a.primary - b.primary ||
            a.laneOffset - b.laneOffset
        );

        return candidates[0] || null;
      }

      enterPositionGridEdit(
        match
      ) {
        const item =
          match?.item ||
          null;

        if (
          !this.isPositionGridControl(
            item
          )
        ) {
          return this.result(
            true,
            'modal-position-grid-unavailable'
          );
        }

        const scanned =
          QoL.airScanner
            ?.scanModalPositionGrid?.(
              item.key
            ) || {
              handled: false,
              reason:
                'modal-position-grid-scanner-unavailable'
            };

        if (
          !scanned.handled ||
          !Array.isArray(
            scanned.cells
          ) ||
          !scanned.cells.length
        ) {
          return this.result(
            true,
            scanned.reason ||
              'modal-position-grid-empty',
            {
              grid: scanned
            }
          );
        }

        this.editingControlKey =
          item.key;
        this.editingControlKind =
          'position-grid';

        this.positionGridContext =
          scanned;

        this.positionGridCellKey =
          scanned.selectedCellKey ||
          scanned.cells[0]?.key ||
          null;

        try {
          item.element
            ?.setAttribute?.(
              'data-airnav-modal-editing',
              'position-grid'
            );
          item.element?.blur?.();
        } catch (_) {}

        this.renderPositionGridSelection(
          'enter'
        );

        this.lastFormEdit = {
          timestamp:
            Date.now(),
          state:
            'entered',
          itemKey:
            item.key,
          title:
            item.title || null,
          kind:
            'position-grid',
          settingKey:
            scanned.settingKey ||
            null,
          value:
            scanned.selectedValue ||
            null,
          cellKey:
            this.positionGridCellKey
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        return this.result(
          true,
          'modal-position-grid-entered',
          {
            edit:
              this.lastFormEdit,
            grid: {
              settingKey:
                scanned.settingKey ||
                null,
              selectedValue:
                scanned.selectedValue ||
                null,
              cellCount:
                scanned.cells.length
            }
          }
        );
      }

      getPositionGridCellCoordinates(
        cell
      ) {
        const value =
          String(
            cell?.value ||
            cell?.metadata
              ?.modalGridPosition ||
            ''
          ).toLowerCase();

        const known = {
          'top-left': {
            row: 0,
            column: 0
          },
          'top-right': {
            row: 0,
            column: 1
          },
          'bottom-left': {
            row: 1,
            column: 0
          },
          'bottom-right': {
            row: 1,
            column: 1
          }
        };

        if (known[value]) {
          return known[value];
        }

        return null;
      }

      movePositionGrid(
        direction
      ) {
        const grid =
          this.positionGridContext;

        if (
          !grid ||
          !Array.isArray(
            grid.cells
          )
        ) {
          return this.result(
            true,
            'modal-position-grid-context-missing'
          );
        }

        const current =
          grid.cells.find(cell =>
            cell.key ===
              this.positionGridCellKey
          ) ||
          grid.cells[0] ||
          null;

        if (!current) {
          return this.result(
            true,
            'modal-position-grid-cell-missing'
          );
        }

        const coordinates =
          this.getPositionGridCellCoordinates(
            current
          );

        let target = null;

        if (coordinates) {
          let row =
            coordinates.row;

          let column =
            coordinates.column;

          if (direction === 'LEFT') {
            column -= 1;
          } else if (
            direction === 'RIGHT'
          ) {
            column += 1;
          } else if (
            direction === 'UP'
          ) {
            row -= 1;
          } else if (
            direction === 'DOWN'
          ) {
            row += 1;
          }

          target =
            grid.cells.find(cell => {
              const position =
                this.getPositionGridCellCoordinates(
                  cell
                );

              return !!(
                position &&
                position.row === row &&
                position.column ===
                  column
              );
            }) ||
            null;
        }

        // Generic geometry fallback if another plugin later uses the same
        // neutral position-grid control kind with non-standard position names.
        if (!target) {
          const currentRect =
            this.liveRect(
              current.element
            ) ||
            current.rect;

          if (currentRect) {
            const horizontal =
              direction === 'LEFT' ||
              direction === 'RIGHT';

            const positive =
              direction === 'RIGHT' ||
              direction === 'DOWN';

            const candidates =
              grid.cells
                .filter(cell =>
                  cell.key !==
                    current.key
                )
                .map(cell => {
                  const rect =
                    this.liveRect(
                      cell.element
                    ) ||
                    cell.rect;

                  if (!rect) {
                    return null;
                  }

                  const primary =
                    horizontal
                      ? (
                          positive
                            ? rect.centerX -
                              currentRect.centerX
                            : currentRect.centerX -
                              rect.centerX
                        )
                      : (
                          positive
                            ? rect.centerY -
                              currentRect.centerY
                            : currentRect.centerY -
                              rect.centerY
                        );

                  if (primary <= 2) {
                    return null;
                  }

                  const secondary =
                    horizontal
                      ? Math.abs(
                          rect.centerY -
                          currentRect.centerY
                        )
                      : Math.abs(
                          rect.centerX -
                          currentRect.centerX
                        );

                  return {
                    cell,
                    score:
                      primary +
                      secondary * 1.8
                  };
                })
                .filter(Boolean)
                .sort(
                  (a, b) =>
                    a.score -
                    b.score
                );

            target =
              candidates[0]
                ?.cell ||
              null;
          }
        }

        if (!target) {
          return this.result(
            true,
            'modal-position-grid-edge',
            {
              direction,
              cellKey:
                current.key,
              value:
                current.value
            }
          );
        }

        const previous =
          this.positionGridCellKey;

        this.positionGridCellKey =
          target.key;

        this.renderPositionGridSelection(
          `move:${direction.toLowerCase()}`
        );

        this.lastFormEdit = {
          timestamp:
            Date.now(),
          state:
            'preview',
          itemKey:
            this.editingControlKey,
          kind:
            'position-grid',
          direction,
          from:
            current.value ||
            null,
          value:
            target.value ||
            null,
          fromCellKey:
            previous,
          cellKey:
            target.key
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        return this.result(
          true,
          'modal-position-grid-moved',
          {
            edit:
              this.lastFormEdit
          }
        );
      }

      commitPositionGridEdit() {
        const grid =
          this.positionGridContext;

        const cell =
          grid?.cells?.find(
            candidate =>
              candidate.key ===
                this.positionGridCellKey
          ) ||
          null;

        if (
          !cell?.element
            ?.isConnected
        ) {
          return this.exitPositionGridEdit(
            'target-lost',
            false
          );
        }

        const itemKey =
          this.editingControlKey;

        const value =
          cell.value ||
          cell.metadata
            ?.modalGridPosition ||
          null;

        // Child click bubbles to the .position-selector parent, matching the
        // DOM's normal pointer activation path while keeping plugin-specific
        // event handling inside Jellyfin Enhanced.
        try {
          cell.element.click();
        } catch (error) {
          return this.result(
            true,
            'modal-position-grid-click-failed',
            {
              error,
              itemKey,
              value
            }
          );
        }

        const result =
          this.exitPositionGridEdit(
            'activate',
            true
          );

        this.lastFormEdit = {
          timestamp:
            Date.now(),
          state:
            'committed',
          itemKey,
          kind:
            'position-grid',
          settingKey:
            grid?.settingKey ||
            null,
          value,
          cellKey:
            cell.key
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        // JE may repaint the four cells after saving. Refresh only after the
        // commit, never while merely previewing with arrows.
        setTimeout(() => {
          if (!this.active) {
            return;
          }

          try {
            QoL.airScanner
              ?.scan?.(
                'modal-position-grid-commit'
              );
          } catch (_) {}

          if (
            this.activeGroupKey
          ) {
            this.rebindActiveGroup(
              'modal-position-grid-commit'
            );
          } else {
            this.rebindSelection(
              'modal-position-grid-commit'
            );
          }

          this.pulseModalActivity(
            'position-grid-commit'
          );
        }, 60);

        return this.result(
          true,
          'modal-position-grid-committed',
          {
            edit:
              this.lastFormEdit,
            exit:
              result
          }
        );
      }

      exitPositionGridEdit(
        reason = 'back',
        committed = false
      ) {
        const key =
          this.editingControlKey;

        const match =
          this.findItemByKey(
            key
          );

        const control =
          match?.item
            ?.element ||
          null;

        this.clearPositionGridVisual();

        try {
          control
            ?.removeAttribute?.(
              'data-airnav-modal-editing'
            );
          control?.blur?.();
        } catch (_) {}

        this.positionGridContext =
          null;
        this.positionGridCellKey =
          null;

        this.editingControlKey =
          null;
        this.editingControlKind =
          null;

        if (
          match &&
          this.activeGroupKey &&
          this.isControlInActiveGroup(
            match.item?.key
          )
        ) {
          this.groupControlKey =
            match.item.key;

          this.renderGroupSelection(
            `modal-position-grid-exit:${reason}`
          );
        } else if (match) {
          this.commitSelection(
            match,
            `modal-position-grid-exit:${reason}`,
            {
              preservePreferredX:
                false,
              restored: true
            }
          );
        }

        if (!committed) {
          this.lastFormEdit = {
            timestamp:
              Date.now(),
            state:
              'cancelled',
            reason,
            itemKey:
              key || null,
            title:
              match?.item?.title ||
              null,
            kind:
              'position-grid'
          };

          emit(
            'formEditChanged',
            this.lastFormEdit
          );
        }

        return this.result(
          true,
          'modal-position-grid-exited',
          {
            reason,
            committed,
            itemKey:
              key || null
          }
        );
      }

      renderPositionGridSelection(
        reason = 'render'
      ) {
        const grid =
          this.positionGridContext;

        if (!grid) {
          return false;
        }

        for (
          const cell of
          grid.cells || []
        ) {
          try {
            cell.element
              ?.removeAttribute?.(
                'data-airnav-position-grid-selected'
              );
          } catch (_) {}
        }

        const selected =
          (grid.cells || [])
            .find(cell =>
              cell.key ===
                this.positionGridCellKey
            ) ||
          null;

        if (!selected) {
          return false;
        }

        try {
          selected.element
            ?.setAttribute?.(
              'data-airnav-position-grid-selected',
              'true'
            );
        } catch (_) {}

        this.ensureVisible(
          selected.element
        );

        this.log(
          'position grid selected',
          {
            reason,
            itemKey:
              this.editingControlKey,
            cellKey:
              selected.key,
            value:
              selected.value ||
              null
          }
        );

        return true;
      }

      clearPositionGridVisual() {
        const cells =
          this.positionGridContext
            ?.cells ||
          [];

        for (
          const cell of cells
        ) {
          try {
            cell.element
              ?.removeAttribute?.(
                'data-airnav-position-grid-selected'
              );
          } catch (_) {}
        }

        try {
          document
            .querySelectorAll(
              '[data-airnav-position-grid-selected="true"]'
            )
            .forEach(element =>
              element.removeAttribute(
                'data-airnav-position-grid-selected'
              )
            );
        } catch (_) {}
      }

      enterSelectEdit(match) {
        const item =
          match?.item || null;

        const select =
          item?.element || null;

        if (
          !this.isSelectControl(item) ||
          !select?.isConnected
        ) {
          return this.result(
            true,
            'modal-select-edit-unavailable'
          );
        }

        this.editingControlKey =
          item.key;
        this.editingControlKind =
          'select';

        try {
          select.setAttribute(
            'data-airnav-select-editing',
            'true'
          );
          select.blur?.();
        } catch (_) {}

        this.lastFormEdit = {
          timestamp: Date.now(),
          state: 'entered',
          itemKey: item.key,
          title: item.title || null,
          value: select.value
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        return this.result(
          true,
          'modal-select-edit-entered',
          {
            edit: this.lastFormEdit
          }
        );
      }

      exitFormEdit(reason = 'done') {
        const key =
          this.editingControlKey;

        const match =
          this.findItemByKey(key);

        const control =
          match?.item?.element || null;

        try {
          control?.removeAttribute?.(
            'data-airnav-select-editing'
          );
          control?.removeAttribute?.(
            'data-airnav-modal-editing'
          );
          control?.blur?.();
        } catch (_) {}

        const kind =
          this.editingControlKind;

        if (
          kind ===
            'position-grid'
        ) {
          this.clearPositionGridVisual();
          this.positionGridContext =
            null;
          this.positionGridCellKey =
            null;
        }

        this.editingControlKey =
          null;
        this.editingControlKind =
          null;

        this.lastFormEdit = {
          timestamp: Date.now(),
          state: 'exited',
          reason,
          itemKey: key || null,
          title: match?.item?.title || null,
          kind,
          value: control?.value ?? null
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        if (
          match &&
          this.activeGroupKey &&
          this.isControlInActiveGroup(
            match.item?.key
          )
        ) {
          this.groupControlKey =
            match.item.key;

          this.renderGroupSelection(
            `modal-form-edit-exit:${reason}`
          );
        } else if (match) {
          this.commitSelection(
            match,
            `modal-form-edit-exit:${reason}`,
            {
              preservePreferredX: false,
              restored: true
            }
          );
        }

        return this.result(
          true,
          'modal-form-edit-exited',
          {
            edit: this.lastFormEdit
          }
        );
      }

      adjustSelect(direction) {
        const match =
          this.findItemByKey(
            this.editingControlKey
          );

        const select =
          match?.item?.element || null;

        if (
          !match ||
          !select?.isConnected ||
          !select.matches?.('select')
        ) {
          this.editingControlKey = null;
          this.editingControlKind = null;
          return this.result(
            true,
            'modal-select-edit-lost'
          );
        }

        const options =
          Array.from(select.options || []);

        if (!options.length) {
          return this.result(
            true,
            'modal-select-no-options'
          );
        }

        const step =
          direction === 'DOWN'
            ? 1
            : -1;

        let index =
          select.selectedIndex;

        if (index < 0) {
          index = step > 0
            ? -1
            : options.length;
        }

        let next =
          index + step;

        while (
          next >= 0 &&
          next < options.length &&
          options[next]?.disabled
        ) {
          next += step;
        }

        if (
          next < 0 ||
          next >= options.length
        ) {
          return this.result(
            true,
            'modal-select-option-edge',
            {
              direction,
              itemKey:
                match.item.key,
              value:
                select.value
            }
          );
        }

        const before =
          select.value;

        select.selectedIndex =
          next;

        try {
          select.dispatchEvent(
            new Event(
              'input',
              {
                bubbles: true
              }
            )
          );

          select.dispatchEvent(
            new Event(
              'change',
              {
                bubbles: true
              }
            )
          );
        } catch (error) {
          console.warn(
            '[AirNav.Modal] select change dispatch failed',
            error
          );
        }

        this.lastFormEdit = {
          timestamp: Date.now(),
          state: 'changed',
          direction,
          itemKey:
            match.item.key,
          title:
            match.item.title || null,
          before,
          value:
            select.value,
          selectedIndex:
            select.selectedIndex,
          optionText:
            select.options?.[
              select.selectedIndex
            ]?.textContent?.trim?.() ||
            null
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        // Some request forms repopulate dependent selects after changing the
        // server/profile. Rescan shortly, then retain the same semantic select
        // if it still exists.
        setTimeout(() => {
          if (!this.active) return;

          try {
            QoL.airScanner?.scan?.(
              'modal-select-change'
            );
          } catch (_) {}

          if (this.activeGroupKey) {
            this.rebindActiveGroup(
              'modal-select-change'
            );
          } else {
            this.rebindSelection(
              'modal-select-change'
            );
          }

          this.pulseModalActivity(
            'select-change'
          );
        }, 60);

        return this.result(
          true,
          'modal-select-option-changed',
          {
            edit: this.lastFormEdit
          }
        );
      }

      enterNumericEdit(
        match,
        kind
      ) {
        const item =
          match?.item || null;

        const input =
          item?.element || null;

        if (
          !input?.isConnected ||
          ![
            'number',
            'range'
          ].includes(kind)
        ) {
          return this.result(
            true,
            'modal-numeric-edit-unavailable'
          );
        }

        this.editingControlKey =
          item.key;
        this.editingControlKind =
          kind;

        try {
          input.setAttribute(
            'data-airnav-modal-editing',
            kind
          );
          input.blur?.();
        } catch (_) {}

        this.lastFormEdit = {
          timestamp: Date.now(),
          state: 'entered',
          itemKey: item.key,
          title: item.title || null,
          kind,
          value: input.value
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        return this.result(
          true,
          'modal-numeric-edit-entered',
          {
            edit:
              this.lastFormEdit
          }
        );
      }

      adjustNumeric(sign) {
        const match =
          this.findItemByKey(
            this.editingControlKey
          );

        const input =
          match?.item?.element || null;

        if (
          !match ||
          !input?.isConnected
        ) {
          this.editingControlKey =
            null;
          this.editingControlKind =
            null;

          return this.result(
            true,
            'modal-numeric-edit-lost'
          );
        }

        const before =
          String(
            input.value ?? ''
          );

        try {
          if (sign > 0) {
            input.stepUp?.();
          } else {
            input.stepDown?.();
          }
        } catch (_) {
          const current =
            Number(input.value);

          const step =
            Number(
              input.step || 1
            ) || 1;

          if (
            Number.isFinite(current)
          ) {
            let next =
              current +
              sign * step;

            const min =
              Number(
                input.min
              );

            const max =
              Number(
                input.max
              );

            if (
              Number.isFinite(min)
            ) {
              next =
                Math.max(
                  min,
                  next
                );
            }

            if (
              Number.isFinite(max)
            ) {
              next =
                Math.min(
                  max,
                  next
                );
            }

            input.value =
              String(next);
          }
        }

        try {
          input.dispatchEvent(
            new Event(
              'input',
              { bubbles: true }
            )
          );

          input.dispatchEvent(
            new Event(
              'change',
              { bubbles: true }
            )
          );
        } catch (_) {}

        this.lastFormEdit = {
          timestamp: Date.now(),
          state: 'changed',
          itemKey:
            match.item.key,
          title:
            match.item.title || null,
          kind:
            this.editingControlKind,
          before,
          value:
            input.value
        };

        emit(
          'formEditChanged',
          this.lastFormEdit
        );

        setTimeout(() => {
          if (!this.active) return;

          try {
            QoL.airScanner?.scan?.(
              'modal-numeric-change'
            );
          } catch (_) {}

          if (this.activeGroupKey) {
            this.rebindActiveGroup(
              'modal-numeric-change'
            );
          } else {
            this.rebindSelection(
              'modal-numeric-change'
            );
          }

          this.pulseModalActivity(
            'numeric-change'
          );
        }, 60);

        return this.result(
          true,
          'modal-numeric-changed',
          {
            edit:
              this.lastFormEdit
          }
        );
      }

      isEditingFormControl(element = null) {
        if (!this.editingControlKey) {
          return false;
        }

        if (!element) {
          return true;
        }

        const match =
          this.findItemByKey(
            this.editingControlKey
          );

        return !!(
          match?.item?.element === element
        );
      }

      isSettingGroup(item) {
        return !!(
          item?.metadata
            ?.modalSettingGroup ===
            true ||
          item?.metadata
            ?.modalControlKind ===
            'group'
        );
      }

      getActiveGroupMatch() {
        if (!this.activeGroupKey) {
          return null;
        }

        const match =
          this.findItemByKey(
            this.activeGroupKey
          );

        if (
          !match ||
          !this.isSettingGroup(
            match.item
          )
        ) {
          return null;
        }

        return match;
      }

      getUsableGroupControls(
        groupItem
      ) {
        return (
          groupItem?.controls || []
        ).filter(control =>
          this.isUsableItem(
            control
          )
        );
      }

      enterGroup(match) {
        const group =
          match?.item || null;

        if (
          !this.isSettingGroup(group)
        ) {
          return this.result(
            false,
            'modal-setting-group-required'
          );
        }

        const controls =
          this.getUsableGroupControls(
            group
          );

        if (!controls.length) {
          return this.result(
            true,
            'modal-setting-group-empty',
            {
              groupKey:
                group.key
            }
          );
        }

        this.clearGroupState();

        this.activeGroupKey =
          group.key;
        this.groupControlKey =
          controls[0].key;

        const firstRect =
          this.liveRect(
            controls[0].element
          ) ||
          controls[0].rect;

        this.groupPreferredX =
          firstRect?.centerX ??
          null;

        this.renderGroupSelection(
          'enter-group'
        );

        const payload = {
          contextId:
            this.contextId,
          groupKey:
            this.activeGroupKey,
          groupTitle:
            group.title || null,
          controlKey:
            this.groupControlKey,
          controls:
            controls.map(control => ({
              key:
                control.key,
              title:
                control.title || null,
              kind:
                control.metadata
                  ?.modalControlKind ||
                'action'
            }))
        };

        emit(
          'groupEntered',
          payload
        );

        return this.result(
          true,
          'modal-setting-group-entered',
          payload
        );
      }

      exitGroup(
        reason = 'back'
      ) {
        const previous = {
          groupKey:
            this.activeGroupKey,
          controlKey:
            this.groupControlKey
        };

        const groupKey =
          this.activeGroupKey;

        this.clearGroupState();

        const match =
          this.findItemByKey(
            groupKey
          );

        if (match) {
          this.commitSelection(
            match,
            `modal-group-exit:${reason}`,
            {
              preservePreferredX:
                false,
              restored: true
            }
          );
        }

        const payload = {
          contextId:
            this.contextId,
          reason,
          previous,
          selectedItemKey:
            this.selectedItemKey
        };

        emit(
          'groupExited',
          payload
        );

        return this.result(
          true,
          'modal-setting-group-exited',
          payload
        );
      }

      clearGroupState() {
        if (
          this.renderedGroupElement
            ?.classList
        ) {
          this.renderedGroupElement
            .classList.remove(
              this.cfg
                .groupActiveClassName
            );

          this.renderedGroupElement
            .removeAttribute(
              'data-airnav-modal-group-active'
            );
        }

        this.renderedGroupElement =
          null;
        this.activeGroupKey =
          null;
        this.groupControlKey =
          null;
        this.groupPreferredX =
          null;
      }

      isControlInActiveGroup(
        itemKey
      ) {
        const group =
          this.getActiveGroupMatch()
            ?.item ||
          null;

        return !!(
          group &&
          (group.controls || [])
            .some(control =>
              control.key === itemKey
            )
        );
      }

      rebindActiveGroup(
        reason = 'group-rebind'
      ) {
        const match =
          this.getActiveGroupMatch();

        if (!match) {
          this.clearGroupState();

          return this.result(
            false,
            'modal-setting-group-lost',
            { reason }
          );
        }

        const controls =
          this.getUsableGroupControls(
            match.item
          );

        if (!controls.length) {
          return this.exitGroup(
            'group-controls-lost'
          );
        }

        const control =
          controls.find(candidate =>
            candidate.key ===
              this.groupControlKey
          ) ||
          controls[0];

        this.groupControlKey =
          control.key;

        this.renderGroupSelection(
          reason
        );

        return this.result(
          true,
          'modal-setting-group-rebound',
          {
            reason,
            groupKey:
              this.activeGroupKey,
            controlKey:
              this.groupControlKey
          }
        );
      }

      dispatchGroup(action) {
        if (!this.activeGroupKey) {
          return this.result(
            false,
            'modal-setting-group-not-active'
          );
        }

        if (action === 'BACK') {
          return this.exitGroup(
            'back'
          );
        }

        if (
          action === 'LEFT' ||
          action === 'RIGHT' ||
          action === 'UP' ||
          action === 'DOWN'
        ) {
          return this.moveGroup(
            action
          );
        }

        if (
          action === 'ACTIVATE'
        ) {
          return this.activateGroupControl();
        }

        return this.result(
          true,
          'modal-setting-group-clamped',
          { action }
        );
      }

      moveGroup(direction) {
        const prepared =
          QoL.airScanner
            ?.prepareForInput?.(
              direction
            );

        if (prepared?.modal) {
          this.context =
            prepared.modal;
        }

        const rebound =
          this.rebindActiveGroup(
            `pre-group-move:${direction.toLowerCase()}`
          );

        if (!rebound?.handled) {
          return rebound;
        }

        const group =
          this.getActiveGroupMatch()
            ?.item ||
          null;

        const controls =
          this.getUsableGroupControls(
            group
          );

        const current =
          controls.find(control =>
            control.key ===
              this.groupControlKey
          ) ||
          null;

        if (!current) {
          return this.result(
            true,
            'modal-setting-group-control-missing'
          );
        }

        const currentRect =
          this.liveRect(
            current.element
          ) ||
          current.rect;

        if (!currentRect) {
          return this.result(
            true,
            'modal-setting-group-geometry-missing'
          );
        }

        const epsilon =
          Number(
            this.cfg.epsilonPx
          ) || 4;

        const horizontal =
          direction === 'LEFT' ||
          direction === 'RIGHT';

        const sign =
          direction === 'RIGHT' ||
          direction === 'DOWN'
            ? 1
            : -1;

        const preferredX =
          Number.isFinite(
            this.groupPreferredX
          )
            ? this.groupPreferredX
            : currentRect.centerX;

        const candidates =
          controls
            .filter(control =>
              control.key !==
                current.key
            )
            .map(control => {
              const rect =
                this.liveRect(
                  control.element
                ) ||
                control.rect;

              if (!rect) {
                return null;
              }

              const primary =
                horizontal
                  ? (
                      sign > 0
                        ? rect.centerX -
                          currentRect.centerX
                        : currentRect.centerX -
                          rect.centerX
                    )
                  : (
                      sign > 0
                        ? rect.centerY -
                          currentRect.centerY
                        : currentRect.centerY -
                          rect.centerY
                    );

              if (primary <= epsilon) {
                return null;
              }

              const secondary =
                horizontal
                  ? Math.abs(
                      rect.centerY -
                      currentRect.centerY
                    )
                  : Math.abs(
                      rect.centerX -
                      preferredX
                    );

              const overlap =
                this.overlapRatio(
                  currentRect,
                  rect,
                  horizontal
                    ? 'horizontal'
                    : 'vertical'
                );

              if (
                horizontal &&
                overlap <
                  Number(
                    this.cfg
                      .minimumPerpendicularOverlap
                  ) &&
                secondary > 42
              ) {
                return null;
              }

              const offAxis =
                secondary >
                  Number(
                    this.cfg
                      .offAxisThresholdPx
                  ) &&
                overlap <
                  Number(
                    this.cfg
                      .minimumPerpendicularOverlap
                  )
                  ? Number(
                      this.cfg
                        .offAxisPenalty
                    )
                  : 0;

              return {
                item: control,
                rect,
                score:
                  primary *
                    Number(
                      this.cfg
                        .primaryAxisWeight
                    ) +
                  secondary *
                    Number(
                      this.cfg
                        .secondaryAxisWeight
                    ) -
                  overlap *
                    Number(
                      this.cfg
                        .overlapReward
                    ) +
                  offAxis
              };
            })
            .filter(Boolean)
            .sort(
              (a, b) =>
                a.score - b.score
            );

        if (!candidates.length) {
          this.lastGroupMove = {
            timestamp:
              Date.now(),
            direction,
            moved: false,
            from:
              current.key,
            reason:
              'group-directional-edge'
          };

          return this.result(
            true,
            'modal-setting-group-edge',
            {
              movement:
                this.lastGroupMove
            }
          );
        }

        const target =
          candidates[0];

        const previousKey =
          this.groupControlKey;

        this.groupControlKey =
          target.item.key;

        if (
          horizontal ||
          !Number.isFinite(
            this.groupPreferredX
          )
        ) {
          this.groupPreferredX =
            target.rect.centerX;
        }

        this.renderGroupSelection(
          `group:${direction.toLowerCase()}`
        );

        this.lastGroupMove = {
          timestamp:
            Date.now(),
          direction,
          moved: true,
          from:
            previousKey,
          to:
            this.groupControlKey,
          score:
            target.score
        };

        emit(
          'groupSelectionChanged',
          {
            contextId:
              this.contextId,
            groupKey:
              this.activeGroupKey,
            controlKey:
              this.groupControlKey,
            movement:
              this.lastGroupMove
          }
        );

        return this.result(
          true,
          'modal-setting-group-moved',
          {
            movement:
              this.lastGroupMove
          }
        );
      }

      renderGroupSelection(
        reason = 'group-render'
      ) {
        const match =
          this.getActiveGroupMatch();

        const group =
          match?.item || null;

        if (!group) {
          return false;
        }

        const control =
          this.getUsableGroupControls(
            group
          ).find(candidate =>
            candidate.key ===
              this.groupControlKey
          );

        if (!control) {
          return false;
        }

        this.clearVisual();

        if (
          this.renderedGroupElement &&
          this.renderedGroupElement !==
            group.element
        ) {
          this.renderedGroupElement
            ?.classList?.remove(
              this.cfg
                .groupActiveClassName
            );
        }

        this.renderedGroupElement =
          group.element;

        try {
          group.element
            ?.classList?.add(
              this.cfg
                .groupActiveClassName
            );

          group.element
            ?.setAttribute?.(
              'data-airnav-modal-group-active',
              'true'
            );
        } catch (_) {}

        this.renderedElement =
          control.element;

        this.applyVisual(
          control.element,
          {
            focus: false
          }
        );

        try {
          control.element?.blur?.();
        } catch (_) {}

        this.ensureVisible(
          control.element
        );

        this.log(
          'group selected',
          {
            reason,
            groupKey:
              this.activeGroupKey,
            controlKey:
              this.groupControlKey
          }
        );

        return true;
      }

      activateGroupControl() {
        const prepared =
          QoL.airScanner
            ?.prepareForInput?.(
              'ACTIVATE'
            );

        if (prepared?.modal) {
          this.context =
            prepared.modal;
        }

        const rebound =
          this.rebindActiveGroup(
            'pre-group-activate'
          );

        if (!rebound?.handled) {
          return rebound;
        }

        const group =
          this.getActiveGroupMatch()
            ?.item ||
          null;

        const control =
          this.getUsableGroupControls(
            group
          ).find(candidate =>
            candidate.key ===
              this.groupControlKey
          );

        if (!control) {
          return this.result(
            true,
            'modal-setting-group-control-missing'
          );
        }

        const match =
          this.findItemByKey(
            control.key
          );

        if (
          this.isSelectControl(
            control
          )
        ) {
          return this.enterSelectEdit(
            match
          );
        }

        if (
          this.isNumberControl(
            control
          )
        ) {
          return this.enterNumericEdit(
            match,
            'number'
          );
        }

        if (
          this.isRangeControl(
            control
          )
        ) {
          return this.enterNumericEdit(
            match,
            'range'
          );
        }

        if (
          this.isPositionGridControl(
            control
          )
        ) {
          return this.enterPositionGridEdit(
            match
          );
        }

        const target =
          control.activationTarget ||
          control.element ||
          null;

        if (!target?.isConnected) {
          return this.result(
            true,
            'modal-setting-group-target-missing'
          );
        }

        const activation = {
          timestamp:
            performance.now(),
          contextId:
            this.contextId,
          groupKey:
            this.activeGroupKey,
          itemKey:
            control.key,
          title:
            control.title || null,
          kind:
            control.metadata
              ?.modalControlKind ||
            'action'
        };

        try {
          target.click();
        } catch (error) {
          return this.result(
            true,
            'modal-setting-group-click-failed',
            {
              activation,
              error
            }
          );
        }

        this.lastGroupActivation =
          activation;

        emit(
          'groupActivation',
          activation
        );

        setTimeout(() => {
          if (
            !this.active ||
            !this.activeGroupKey
          ) {
            return;
          }

          try {
            QoL.airScanner?.scan?.(
              'modal-group-post-activate'
            );
          } catch (_) {}

          this.rebindActiveGroup(
            'modal-group-post-activate'
          );
        }, 80);

        return this.result(
          true,
          'modal-setting-group-activated',
          { activation }
        );
      }

      activate() {
        const prepared = QoL.airScanner?.prepareForInput?.('ACTIVATE');
        if (prepared?.modal) this.context = prepared.modal;

        if (!this.rebindSelection('pre-activate')) {
          return this.result(true, 'modal-selection-unavailable');
        }

        const match = this.findItemByKey(this.selectedItemKey);
        const item = match?.item || null;
        const target = item?.activationTarget || item?.element || null;

        if (!target?.isConnected) {
          return this.result(true, 'modal-activation-target-missing');
        }

        if (this.isSettingGroup(item)) {
          return this.enterGroup(
            match
          );
        }

        if (this.isSelectControl(item)) {
          return this.enterSelectEdit(match);
        }

        if (this.isNumberControl(item)) {
          return this.enterNumericEdit(
            match,
            'number'
          );
        }

        if (this.isRangeControl(item)) {
          return this.enterNumericEdit(
            match,
            'range'
          );
        }

        if (
          this.isPositionGridControl(
            item
          )
        ) {
          return this.enterPositionGridEdit(
            match
          );
        }

        const activation = {
          timestamp: performance.now(),
          contextId: this.contextId,
          itemKey: item.key,
          title: item.title || null,
          sectionId: match.section.id
        };

        try {
          target.click();
        } catch (error) {
          console.error('[AirNav.Modal] activation failed', error);
          return this.result(true, 'modal-activation-click-failed', {
            activation,
            error
          });
        }

        this.lastActivation = activation;
        emit('activation', activation);

        // Modal controls frequently replace themselves after a toggle/action.
        setTimeout(() => {
          if (!this.active) return;
          try {
            QoL.airScanner?.scan?.('modal-post-activate');
          } catch (_) {}
          this.rebindSelection('post-activate');
        }, 80);

        return this.result(true, 'modal-activated', { activation });
      }

      requestClose(reason = 'back') {
        const closeAction = this.context?.closeAction || null;

        if (!closeAction?.isConnected) {
          const outsideClick =
            this.requestOutsideClickDismiss(
              reason
            );

          if (outsideClick.handled) {
            return outsideClick;
          }

          const nativeFallback =
            this.requestNativeBackFallback(reason);

          if (nativeFallback.handled) {
            return nativeFallback;
          }

          // Final safety fallback: do not trap BACK.
          return this.result(false, 'modal-close-yield-native', {
            reason,
            contextId: this.contextId,
            outsideClick,
            nativeFallback
          });
        }

        this.closeRequested = true;
        this.lastClose = {
          timestamp: Date.now(),
          reason,
          contextId: this.contextId,
          requested: true,
          strategy: 'scanner-close-action'
        };

        try {
          closeAction.click();
        } catch (error) {
          console.error('[AirNav.Modal] close action failed', error);
          return this.result(true, 'modal-close-click-failed', {
            reason,
            error
          });
        }

        emit('closeRequested', this.lastClose);

        return this.result(true, 'modal-close-requested', {
          reason,
          contextId: this.contextId,
          strategy: 'scanner-close-action'
        });
      }

      requestOutsideClickDismiss(
        reason = 'back'
      ) {
        if (
          this.cfg.outsideClickDismissFallback ===
            false
        ) {
          return this.result(
            false,
            'modal-outside-click-disabled',
            {
              reason,
              contextId:
                this.contextId
            }
          );
        }

        const root =
          this.context?.root || null;

        const target =
          this.context?.dismissTarget ||
          null;

        if (
          this.context?.dismissMode !==
            'outside-click' ||
          !root?.isConnected ||
          !target?.isConnected ||
          target === root ||
          root.contains(target)
        ) {
          return this.result(
            false,
            'modal-outside-click-target-unavailable',
            {
              reason,
              contextId:
                this.contextId,
              dismissMode:
                this.context?.dismissMode ||
                null
            }
          );
        }

        const point =
          this.findOutsideDismissPoint(
            root,
            target
          );

        this.closeRequested =
          true;

        this.lastClose = {
          timestamp:
            Date.now(),
          reason,
          contextId:
            this.contextId,
          requested:
            true,
          strategy:
            'outside-click',
          point
        };

        try {
          this.dispatchPrimaryPointerClick(
            target,
            point
          );
        } catch (error) {
          console.warn(
            '[AirNav.Modal] outside-click dismissal failed',
            error
          );

          return this.result(
            false,
            'modal-outside-click-exception',
            {
              reason,
              contextId:
                this.contextId,
              error
            }
          );
        }

        emit(
          'closeRequested',
          this.lastClose
        );

        const rescanDelay =
          Math.max(
            0,
            Number(
              this.cfg.outsideClickRescanDelayMs
            ) || 70
          );

        setTimeout(() => {
          try {
            QoL.airScanner?.scan?.(
              'modal-outside-click-close-probe'
            );
          } catch (_) {}
        }, rescanDelay);

        // If the exact Jellyfin outside-click path did not close the modal,
        // preserve the old native BACK bridge as a delayed last resort. This
        // does not run when Scanner already observed the modal close.
        const fallbackDelay =
          Math.max(
            rescanDelay + 20,
            Number(
              this.cfg.outsideClickNativeFallbackDelayMs
            ) || 180
          );

        const contextId =
          this.contextId;

        setTimeout(() => {
          if (
            !this.active ||
            this.contextId !== contextId ||
            !this.context?.root?.isConnected
          ) {
            return;
          }

          const model =
            QoL.airScanner?.scan?.(
              'modal-outside-click-fallback-probe'
            ) ||
            QoL.airScanner?.getModel?.();

          if (
            model?.activeSurfaceHint !== 'modal' ||
            !model?.modal ||
            model.modal.id !== contextId
          ) {
            return;
          }

          this.requestNativeBackFallback(
            'outside-click-did-not-close'
          );
        }, fallbackDelay);

        return this.result(
          true,
          'modal-close-outside-click-requested',
          {
            reason,
            contextId:
              this.contextId,
            strategy:
              'outside-click',
            point
          }
        );
      }

      findOutsideDismissPoint(
        root,
        target
      ) {
        const rootRect =
          root.getBoundingClientRect();

        const targetRect =
          target.getBoundingClientRect();

        const inset = 6;

        const candidates = [
          {
            x:
              rootRect.left - 12,
            y:
              rootRect.top +
              rootRect.height / 2
          },
          {
            x:
              rootRect.right + 12,
            y:
              rootRect.top +
              rootRect.height / 2
          },
          {
            x:
              rootRect.left +
              rootRect.width / 2,
            y:
              rootRect.top - 12
          },
          {
            x:
              rootRect.left +
              rootRect.width / 2,
            y:
              rootRect.bottom + 12
          }
        ];

        const inside = (
          point,
          rect
        ) =>
          point.x >= rect.left &&
          point.x <= rect.right &&
          point.y >= rect.top &&
          point.y <= rect.bottom;

        for (const candidate of candidates) {
          const point = {
            x:
              Math.max(
                targetRect.left + inset,
                Math.min(
                  targetRect.right - inset,
                  candidate.x
                )
              ),
            y:
              Math.max(
                targetRect.top + inset,
                Math.min(
                  targetRect.bottom - inset,
                  candidate.y
                )
              )
          };

          if (
            inside(point, targetRect) &&
            !inside(point, rootRect)
          ) {
            return point;
          }
        }

        // Coordinates are advisory for listeners. Event target is the
        // important part of Jellyfin's outside-click path, and it is already
        // the ancestor outside the action sheet.
        return {
          x:
            Math.max(
              1,
              Math.min(
                window.innerWidth - 2,
                targetRect.left + inset
              )
            ),
          y:
            Math.max(
              1,
              Math.min(
                window.innerHeight - 2,
                targetRect.top + inset
              )
            )
        };
      }

      dispatchPrimaryPointerClick(
        target,
        point
      ) {
        const common = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX:
            Number(point?.x) || 0,
          clientY:
            Number(point?.y) || 0,
          screenX:
            Number(point?.x) || 0,
          screenY:
            Number(point?.y) || 0,
          button: 0
        };

        const dispatch =
          event =>
            target.dispatchEvent(event);

        if (
          typeof window.PointerEvent ===
            'function'
        ) {
          dispatch(
            new PointerEvent(
              'pointerdown',
              {
                ...common,
                pointerId: 1,
                pointerType:
                  'mouse',
                isPrimary: true,
                buttons: 1
              }
            )
          );
        }

        dispatch(
          new MouseEvent(
            'mousedown',
            {
              ...common,
              buttons: 1,
              detail: 1
            }
          )
        );

        if (
          typeof window.PointerEvent ===
            'function'
        ) {
          dispatch(
            new PointerEvent(
              'pointerup',
              {
                ...common,
                pointerId: 1,
                pointerType:
                  'mouse',
                isPrimary: true,
                buttons: 0
              }
            )
          );
        }

        dispatch(
          new MouseEvent(
            'mouseup',
            {
              ...common,
              buttons: 0,
              detail: 1
            }
          )
        );

        dispatch(
          new MouseEvent(
            'click',
            {
              ...common,
              buttons: 0,
              detail: 1
            }
          )
        );
      }

      requestNativeBackFallback(reason = 'back') {
        if (this.cfg.nativeBackFallback === false) {
          return this.result(false, 'modal-native-back-disabled', {
            reason,
            contextId: this.contextId
          });
        }

        const bridge = QoL.airControlBridge;

        if (
          !bridge?.enterNativeSurface ||
          !bridge?.dispatchNativeAction ||
          !bridge?.exitNativeSurface
        ) {
          return this.result(false, 'modal-native-back-bridge-unavailable', {
            reason,
            contextId: this.contextId
          });
        }

        let enter = null;
        let nativeBack = null;

        try {
          // Temporary native ownership only. The compatibility bridge tags its
          // synthetic Escape event with __airNavNativeBridge, so KeyboardAdapter
          // ignores that synthetic event instead of recursively redispatching it.
          enter = bridge.enterNativeSurface('modal');
          nativeBack = bridge.dispatchNativeAction('BACK');
        } catch (error) {
          console.warn(
            '[AirNav.Modal] native BACK fallback failed',
            error
          );

          return this.result(false, 'modal-native-back-exception', {
            reason,
            contextId: this.contextId,
            error
          });
        } finally {
          try {
            bridge.exitNativeSurface();
          } catch (_) {}
        }

        if (!nativeBack?.handled) {
          return this.result(false, 'modal-native-back-not-handled', {
            reason,
            contextId: this.contextId,
            enter,
            nativeBack
          });
        }

        this.closeRequested = true;
        this.lastClose = {
          timestamp: Date.now(),
          reason,
          contextId: this.contextId,
          requested: true,
          strategy: 'native-back-bridge',
          enter,
          nativeBack
        };

        emit('closeRequested', this.lastClose);

        const delay = Math.max(
          0,
          Number(this.cfg.nativeBackRescanDelayMs) || 80
        );

        setTimeout(() => {
          try {
            QoL.airScanner?.scan?.(
              'modal-native-back-close-probe'
            );
          } catch (_) {}
        }, delay);

        return this.result(true, 'modal-close-native-back-requested', {
          reason,
          contextId: this.contextId,
          strategy: 'native-back-bridge',
          nativeBack
        });
      }

      handleModelUpdate(model, reason = 'model') {
        if (!this.active) return;

        if (
          !model ||
          model.activeSurfaceHint !== 'modal' ||
          !model.modal
        ) {
          // Scanner's modalClosed event/controller performs stable parent
          // restoration. Clear only the modal visual here if a model update is
          // observed first for any unusual client ordering.
          this.clearVisual();
          return;
        }

        if (model.modal.id !== this.contextId) {
          this.adoptNestedModalContext(
            model.modal,
            reason
          );
          return;
        }

        this.context = model.modal;

        if (this.activeGroupKey) {
          const groupMatch =
            this.findItemByKey(
              this.activeGroupKey
            );

          if (
            groupMatch &&
            this.isSettingGroup(
              groupMatch.item
            )
          ) {
            // Keep the outer group logically selected without rendering it;
            // the child control remains the only visible focus target.
            this.selectedItemKey =
              groupMatch.item.key;

            this.rebindActiveGroup(
              reason
            );

            return;
          }

          this.clearGroupState();
        }

        this.rebindSelection(reason);
      }

      rememberCurrentModalContext() {
        if (!this.contextId) return;

        this.contextStates.set(
          this.contextId,
          {
            selectedItemKey:
              this.selectedItemKey || null,
            preferredX:
              Number.isFinite(this.preferredX)
                ? this.preferredX
                : null
          }
        );
      }

      adoptNestedModalContext(
        context,
        reason = 'nested-modal-context-changed'
      ) {
        if (!context?.id || !context?.root?.isConnected) {
          return false;
        }

        const previousContextId =
          this.contextId;

        this.rememberCurrentModalContext();
        this.clearVisual();

        this.contextId =
          context.id;
        this.context =
          context;
        this.closeRequested =
          false;
        this.editingControlKey =
          null;
        this.editingControlKind =
          null;
        this.clearGroupState();

        const saved =
          this.contextStates.get(
            context.id
          ) || null;

        let match = null;

        if (saved?.selectedItemKey) {
          match =
            this.findItemByKey(
              saved.selectedItemKey
            );
        }

        if (match) {
          this.selectedItemKey =
            match.item.key;

          // Restoring a previously visited modal may reuse its X anchor, but
          // only if it still resembles the restored control's actual geometry.
          // A wildly different X is treated as stale.
          const restoredRect =
            this.liveRect(match.item.element) ||
            match.item.rect;

          const savedX =
            Number.isFinite(saved.preferredX)
              ? saved.preferredX
              : null;

          const staleThreshold =
            Math.max(
              120,
              Number(this.cfg.offAxisThresholdPx) || 180
            );

          this.preferredX =
            restoredRect &&
            savedX !== null &&
            Math.abs(
              restoredRect.centerX -
              savedX
            ) <= staleThreshold
              ? savedX
              : restoredRect?.centerX ?? null;

          this.commitSelection(
            match,
            `${reason}:restore-context`,
            {
              preservePreferredX: true,
              restored: true
            }
          );
        } else {
          // Brand-new nested dialog: DO NOT inherit selectedItemKey/preferredX
          // from the outer modal. This was the cause of the collection checkbox
          // lane using the outer dialog's ~1535px X anchor while the toggles are
          // actually around x=202px.
          this.selectedItemKey =
            null;
          this.preferredX =
            null;

          const first =
            this.findItemByKey(
              context.defaultItemKey
            ) ||
            this.getAllItems()[0] ||
            null;

          if (first) {
            this.commitSelection(
              first,
              `${reason}:new-context`
            );
          }
        }

        // Movement/activation diagnostics belong to the current modal context.
        this.lastMove = null;
        this.lastActivation = null;

        emit(
          'contextChanged',
          {
            previousContextId,
            contextId:
              this.contextId,
            restored:
              !!match,
            selectedItemKey:
              this.selectedItemKey,
            preferredX:
              this.preferredX,
            reason
          }
        );

        this.log(
          'nested modal context adopted',
          {
            previousContextId,
            contextId:
              this.contextId,
            restored:
              !!match,
            selectedItemKey:
              this.selectedItemKey,
            preferredX:
              this.preferredX,
            reason
          }
        );

        return true;
      }

      rebindSelection(reason = 'rebind') {
        if (!this.context) return false;

        let match = this.findItemByKey(this.selectedItemKey);

        if (!match) {
          match =
            this.findItemByKey(this.context.defaultItemKey) ||
            this.getAllItems().map(entry => ({
              section: this.findSectionForItem(entry.key),
              item: entry,
              rect: this.liveRect(entry.element) || entry.rect
            })).find(entry => entry.section && entry.item) ||
            null;
        }

        if (!match) {
          this.clearVisual();
          this.selectedItemKey = null;
          return false;
        }

        this.commitSelection(match, reason, { preservePreferredX: true, restored: true });
        return true;
      }

      commitSelection(match, reason = 'select', options = {}) {
        const item = match?.item || match;
        const section = match?.section || this.findSectionForItem(item?.key);
        if (!item || !section || !this.isUsableItem(item)) return null;

        const rect = this.liveRect(item.element) || item.rect;
        if (!rect) return null;

        const previous = this.selectedItemKey;
        this.selectedItemKey = item.key;

        if (!options.preservePreferredX || !Number.isFinite(this.preferredX)) {
          this.preferredX = rect.centerX;
        }

        this.clearVisual();
        this.renderedElement = item.element;
        this.applyVisual(item.element);
        this.ensureVisible(item.element);

        this.log('selected', {
          reason,
          previous,
          itemKey: this.selectedItemKey,
          sectionId: section.id,
          preferredX: this.preferredX,
          restored: !!options.restored
        });

        return {
          section,
          item,
          rect
        };
      }

      restoreParent(returnState, reason = 'modal-close') {
        const model = QoL.airScanner?.getModel?.();

        if (!model || model.activeSurfaceHint !== 'page') {
          const result = {
            restored: false,
            reason: 'parent-page-model-not-ready',
            returnState
          };
          this.lastRestore = result;
          return result;
        }

        let selected = null;

        if (returnState.itemKey) {
          selected = QoL.airFocus?.selectByKey?.(
            returnState.itemKey,
            `modal-return:${reason}`,
            { preservePreferredX: true, restored: true }
          ) || null;
        }

        if (!selected) {
          QoL.airFocus?.refresh?.(`modal-return-fallback:${reason}`);
          selected = QoL.airFocus?.getSelectedItem?.() || null;
        }

        if (!selected) {
          selected = QoL.airFocus?.selectFirst?.({ scope: 'content' }) || null;
        }

        const result = {
          restored: !!selected,
          reason: selected ? 'stable-return-restored' : 'return-fallback-failed',
          requestedKey: returnState.itemKey || null,
          selectedKey: QoL.airFocus?.getState?.()?.itemKey || null,
          sectionId: QoL.airFocus?.getState?.()?.sectionId || null
        };

        this.lastRestore = result;
        emit('restored', result);
        return result;
      }

      normalizeReturnState(value) {
        if (!value?.itemKey) return null;

        return {
          contextId: value.contextId || null,
          route: value.route || null,
          itemKey: value.itemKey,
          sectionId: value.sectionId || null,
          preferredX: Number.isFinite(value.preferredX) ? value.preferredX : null,
          fallbackIndex: Number.isInteger(value.fallbackIndex) ? value.fallbackIndex : null
        };
      }

      getAllItems() {
        return (this.context?.sections || [])
          .flatMap(section => section.items || [])
          .filter(item => this.isUsableItem(item));
      }

      findSectionForItem(itemKey) {
        if (!itemKey) return null;
        return (this.context?.sections || [])
          .find(section => (section.items || []).some(item => item.key === itemKey)) || null;
      }

      findItemByKey(itemKey) {
        if (!itemKey) return null;

        for (const section of this.context?.sections || []) {
          const item =
            (section.items || [])
              .find(candidate =>
                candidate.key === itemKey
              );

          if (item) {
            const rect =
              this.liveRect(item.element) ||
              item.rect;

            if (rect) {
              return {
                section,
                item,
                rect,
                group: null
              };
            }
          }

          for (
            const group of
            section.items || []
          ) {
            if (!this.isSettingGroup(group)) {
              continue;
            }

            const child =
              (group.controls || [])
                .find(candidate =>
                  candidate.key === itemKey
                );

            if (!child) continue;

            const rect =
              this.liveRect(
                child.element
              ) ||
              child.rect;

            if (!rect) continue;

            return {
              section,
              item: child,
              rect,
              group
            };
          }
        }

        return null;
      }

      isUsableItem(item) {
        return !!(
          item &&
          item.key &&
          item.element?.isConnected &&
          item.state?.visible !== false &&
          item.state?.enabled !== false
        );
      }

      liveRect(element) {
        if (!element?.isConnected || typeof element.getBoundingClientRect !== 'function') return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

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

      overlapRatio(a, b, axis) {
        if (!a || !b) return 0;

        if (axis === 'horizontal') {
          const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          return overlap / Math.max(1, Math.min(a.height, b.height));
        }

        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        return overlap / Math.max(1, Math.min(a.width, b.width));
      }

      pulseModalActivity(
        reason = 'airnav'
      ) {
        const hint =
          this.context?.metadata
            ?.activityHint ||
          null;

        if (
          hint !== 'pointer-move' ||
          !this.context?.root
            ?.isConnected
        ) {
          return false;
        }

        const now =
          performance.now();

        const minInterval =
          Math.max(
            50,
            Number(
              this.cfg
                .modalActivityPulseMinIntervalMs
            ) || 180
          );

        if (
          now -
            this.lastActivityPulseAt <
          minInterval
        ) {
          return false;
        }

        const root =
          this.context.root;

        const target =
          (
            this.groupControlKey
              ? this.findItemByKey(
                  this.groupControlKey
                )?.item?.element
              : null
          ) ||
          this.renderedElement ||
          root;

        const rect =
          target
            ?.getBoundingClientRect?.() ||
          root.getBoundingClientRect();

        const clientX =
          Math.round(
            rect.left +
            Math.max(
              1,
              rect.width / 2
            )
          );

        const clientY =
          Math.round(
            rect.top +
            Math.max(
              1,
              rect.height / 2
            )
          );

        let dispatched = false;

        try {
          if (
            typeof PointerEvent ===
              'function'
          ) {
            target.dispatchEvent(
              new PointerEvent(
                'pointermove',
                {
                  bubbles: true,
                  cancelable: false,
                  clientX,
                  clientY,
                  pointerType:
                    'mouse',
                  isPrimary: true
                }
              )
            );

            dispatched = true;
          }
        } catch (_) {}

        try {
          target.dispatchEvent(
            new MouseEvent(
              'mousemove',
              {
                bubbles: true,
                cancelable: false,
                clientX,
                clientY
              }
            )
          );

          dispatched = true;
        } catch (_) {}

        if (dispatched) {
          this.lastActivityPulseAt =
            now;

          this.lastActivityPulse = {
            timestamp:
              Date.now(),
            reason,
            clientX,
            clientY,
            target:
              target?.id ||
              target?.tagName ||
              null
          };
        }

        return dispatched;
      }

      ensureVisible(element) {
        if (!element?.isConnected || !this.context?.root?.contains(element)) return false;

        const scroller = this.findScrollContainer(element);
        if (!scroller) return false;

        const itemRect = element.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const margin = Math.max(0, Number(this.cfg.scrollMarginPx) || 24);

        const usableTop = scrollerRect.top + margin;
        const usableBottom = scrollerRect.bottom - margin;
        let delta = 0;

        if (itemRect.top < usableTop) {
          delta = itemRect.top - usableTop;
        } else if (itemRect.bottom > usableBottom) {
          delta = itemRect.bottom - usableBottom;
        }

        if (Math.abs(delta) < 1) return false;

        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const next = Math.max(0, Math.min(max, scroller.scrollTop + delta));
        scroller.scrollTop = next;
        return true;
      }

      findScrollContainer(element) {
        let node = element?.parentElement || null;
        const root = this.context?.root || null;

        while (node && root?.contains(node)) {
          try {
            const style = getComputedStyle(node);
            const overflowY = style.overflowY;
            const scrollable =
              (overflowY === 'auto' || overflowY === 'scroll') &&
              node.scrollHeight > node.clientHeight + 1;

            if (scrollable) return node;
          } catch (_) {}

          if (node === root) break;
          node = node.parentElement;
        }

        return null;
      }

      applyVisual(
        element,
        options = {}
      ) {
        if (!element?.classList) return;

        element.classList.add(
          this.cfg.focusClassName
        );

        element.setAttribute(
          'data-airnav-modal-focused',
          'true'
        );

        if (
          options.focus !== false &&
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
      }

      clearVisual() {
        if (this.renderedElement) this.removeVisual(this.renderedElement);
        this.renderedElement = null;

        document
          .querySelectorAll(`.${this.escapeCssIdentifier(this.cfg.focusClassName)}`)
          .forEach(element => this.removeVisual(element));
      }

      removeVisual(element) {
        if (!element?.classList) return;
        element.classList.remove(this.cfg.focusClassName);
        element.removeAttribute('data-airnav-modal-focused');
      }

      injectStyles() {
        if (!this.cfg.injectCss) return;

        let style = document.getElementById(this.cfg.styleId);
        if (!style) {
          style = document.createElement('style');
          style.id = this.cfg.styleId;
          style.dataset.airnavOwner = 'modal';
          document.head.appendChild(style);
        }

        const focusClass =
          this.escapeCssIdentifier(
            this.cfg.focusClassName
          );

        const groupClass =
          this.escapeCssIdentifier(
            this.cfg.groupActiveClassName
          );

        style.textContent = `
          .${groupClass} {
            box-shadow:
              inset 0 0 0
                ${Math.max(
                  1,
                  Number(
                    this.cfg
                      .groupActiveInsetPx
                  ) || 2
                )}px
                rgba(119, 91, 244, .72),
              0 0 14px
                rgba(119, 91, 244, .20)
                !important;
            border-radius:
              ${Number(
                this.cfg
                  .borderRadiusPx
              )}px
                !important;
          }

          /*
           * Modal focus must remain obvious even when a plugin wraps buttons
           * in overflow:hidden. Jellyfin Enhanced's .je-more-info-actions is
           * one such container, so an ordinary outside outline/glow can be
           * almost completely clipped. Draw the primary ring INSIDE the
           * selected control and use the outside glow only as enhancement.
           */
          .${focusClass} {
            outline:
              ${Number(this.cfg.outlineWidthPx)}px solid
              rgba(255,255,255,.98) !important;
            outline-offset:
              -${Math.max(
                2,
                Number(this.cfg.outlineWidthPx) + 1
              )}px !important;

            border-radius:
              ${Number(this.cfg.borderRadiusPx)}px !important;

            box-shadow:
              inset 0 0 0 ${Number(this.cfg.insideRingPx)}px
                rgba(255,255,255,.98),
              inset 0 0 0 ${Number(this.cfg.insideRingPx) + Number(this.cfg.insideRingGapPx)}px
                var(--theme-primary-color, var(--primary-accent-color, #00a4dc)),
              0 0 0 2px
                var(--theme-primary-color, var(--primary-accent-color, #00a4dc)),
              0 0 20px rgba(0,164,220,.78) !important;

            filter:
              brightness(${Number(this.cfg.focusBrightness)})
              saturate(${Number(this.cfg.focusSaturation)}) !important;

            transform:
              scale(${Number(this.cfg.scale)}) !important;

            position: relative;
            z-index: 140 !important;

            transition:
              transform ${Number(this.cfg.transitionMs)}ms ease,
              box-shadow ${Number(this.cfg.transitionMs)}ms ease,
              filter ${Number(this.cfg.transitionMs)}ms ease !important;
          }

          /*
           * Preserve a strong visual distinction on plugin CTA buttons whose
           * own state/background colours use !important. We intentionally do
           * NOT replace their semantic colour; the inset white/accent ring and
           * brightness change sit on top of it.
           */
          button.${focusClass},
          a.${focusClass},
          [role="button"].${focusClass} {
            font-weight: 800 !important;
          }

          /*
           * Nested 2x2 position selectors use their own cell ring so the
           * plugin's purple "currently saved" cell remains visible while
           * AirNav previews a different cell before ENTER commits it.
           */
          [data-airnav-position-grid-selected="true"] {
            outline:
              2px solid
              rgba(255,255,255,.98)
              !important;
            outline-offset:
              -1px !important;
            box-shadow:
              0 0 0 2px
                var(
                  --theme-primary-color,
                  var(
                    --primary-accent-color,
                    #00a4dc
                  )
                ),
              0 0 9px
                rgba(0,164,220,.82)
                !important;
            position: relative;
            z-index: 4;
          }
        `;
      }

      escapeCssIdentifier(value) {
        if (window.CSS?.escape) return CSS.escape(value);
        return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      }

      getState() {
        const selected = this.findItemByKey(this.selectedItemKey);

        return {
          version: '9.0.11',
          started: this.started,
          active: this.active,
          contextId: this.contextId,
          rememberedModalContexts:
            this.contextStates.size,
          editingControlKey:
            this.editingControlKey,
          editingControlKind:
            this.editingControlKind,
          positionGrid:
            this.positionGridContext
              ? {
                  settingKey:
                    this.positionGridContext
                      .settingKey ||
                    null,
                  selectedValue:
                    this.positionGridContext
                      .cells?.find(
                        cell =>
                          cell.key ===
                            this.positionGridCellKey
                      )?.value ||
                    null,
                  selectedCellKey:
                    this.positionGridCellKey,
                  cellCount:
                    this.positionGridContext
                      .cells?.length ||
                    0
                }
              : null,
          activeGroupKey:
            this.activeGroupKey,
          groupControlKey:
            this.groupControlKey,
          groupPreferredX:
            this.groupPreferredX,
          lastGroupMove:
            this.lastGroupMove,
          lastGroupActivation:
            this.lastGroupActivation,
          lastActivityPulse:
            this.lastActivityPulse
              ? {
                  ...this.lastActivityPulse
                }
              : null,
          lastFormEdit:
            this.lastFormEdit
              ? { ...this.lastFormEdit }
              : null,
          selectedItemKey: this.selectedItemKey,
          preferredX: this.preferredX,
          closeRequested: this.closeRequested,
          parentReturnState: this.parentReturnState ? { ...this.parentReturnState } : null,
          selected: selected ? {
            key: selected.item.key,
            title: selected.item.title || null,
            sectionId: selected.section.id,
            rect: selected.rect ? { ...selected.rect } : null
          } : null,
          sections: (this.context?.sections || []).map(section => ({
            id: section.id,
            type: section.type,
            title: section.title,
            itemCount: section.items?.length || 0,
            items: (section.items || []).map(item => ({
              key: item.key,
              title: item.title || null,
              enabled: item.state?.enabled !== false,
              kind:
                item.metadata
                  ?.modalControlKind ||
                null,
              groupControlCount:
                item.controls?.length ||
                0
            }))
          })),
          lastMove: this.lastMove,
          lastActivation: this.lastActivation,
          lastClose: this.lastClose,
          lastRestore: this.lastRestore
        };
      }

      result(handled, reason, extra = {}) {
        return {
          handled: !!handled,
          reason,
          ...extra
        };
      }

      log(...args) {
        if (!this.cfg.debug) return;
        console.log('[AirNav.Modal]', ...args);
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,

      create(options = {}) {
        if (!instance) instance = new ModalNavigationContext(options);
        else instance.start();
        return instance;
      },

      destroy() {
        if (!instance) return;
        instance.destroy();
        instance = null;
      },

      enter(context = null, returnState = null, reason = 'modal-opened') {
        return this.create().enter(context, returnState, reason);
      },

      exit(reason = 'modal-exit', options = {}) {
        return instance
          ? instance.exit(reason, options)
          : { handled: false, reason: 'modal-navigation-not-created' };
      },

      handleClosed(info = null, reason = 'modal-closed') {
        return instance
          ? instance.handleClosed(info, reason)
          : { handled: false, reason: 'modal-navigation-not-created' };
      },

      dispatch(action) {
        return instance
          ? instance.dispatch(action)
          : { handled: false, reason: 'modal-navigation-not-created' };
      },

      isActive() {
        return !!instance?.active;
      },

      isEditingFormControl(element = null) {
        return instance
          ? instance.isEditingFormControl(element)
          : false;
      },

      getState() {
        return instance
          ? instance.getState()
          : { version: '9.0.10', started: false, active: false };
      },

      compatibilityReport() {
        const takeoverActive =
          QoL.airModal === api;

        const legacyPresent =
          !!QoL.airModal &&
          QoL.airModal !== api;

        let activeApiVersion = null;

        try {
          activeApiVersion =
            QoL.airModal?.version ||
            QoL.airModal?.VERSION ||
            QoL.airModal?.getState?.()?.version ||
            null;
        } catch (_) {}

        return {
          version: VERSION,
          legacyVersion:
            LEGACY_VERSION,
          production: true,
          takeoverActive,
          legacyPresent,
          activeApiVersion,
          dependencies: {
            scanner:
              !!QoL.airScanner,
            focus:
              !!QoL.airFocus
          }
        };
      },

      on,
      off
    };

    return api;
  })();

  const existingModal =
    QoL.airModal || null;

  QoL.navigationModalRuntime =
    productionApi;

  if (
    !existingModal ||
    existingModal === productionApi
  ) {
    QoL.airModal = productionApi;

    console.log(
      LOG,
      'Production Navigation Modal registered as window.JellyfinQoL.airModal.',
      {
        version: VERSION,
        legacyCompatibility:
          LEGACY_VERSION
      }
    );
  } else {
    console.log(
      LOG,
      'Production Navigation Modal loaded passively; existing window.JellyfinQoL.airModal remains authoritative.',
      {
        version: VERSION,
        legacyCompatibility:
          LEGACY_VERSION
      }
    );
  }

})(window.JellyfinQoL = window.JellyfinQoL || {});