// Jellyfin Air Navigation - Phase 7.4B6 Header-to-Top Snap
//
// Responsibilities:
//   - Reveal the selected NavigationItem after FocusManager changes selection.
//   - Keep horizontal rows scrolling independently from the page.
//   - Support Jellyfin native horizontal scrollLeft rows and translated
//     animatedScrollX / scrollSlider rows behind one API.
//   - Keep vertical selection within a configurable comfort band.
//   - Trigger a lightweight Scanner geometry refresh after scrolling settles.
//
// Non-responsibilities:
//   - No directional candidate choice.
//   - No raw keyboard/controller input.
//   - No activation.
//   - No modal navigation.
//
// Requires when create() is called:
//   JellyfinQoL.airScanner
//   JellyfinQoL.airFocus

// Jellyfin QoL - Production Navigation ScrollManager v1.0.0
// Legacy compatibility: Phase 7.4B6 Header-to-Top Snap.
//
// The production API remains passive while the injected ScrollManager owns
// JellyfinQoL.airScroll. Disable only the old ScrollManager and reload to
// transfer ownership without changing focus or controller behavior.
(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '7.4B6';
  const LOG = '[JellyfinQoL.NavigationScroll]';

  const productionApi = (function () {
    const DEFAULTS = {
      debug: false,

      behavior: 'smooth',

      // Horizontal hysteresis:
      // - triggerInset decides when scrolling begins;
      // - restInset is where the card is placed after scrolling.
      // Keeping restInset > triggerInset prevents a half-visible card from
      // oscillating at the boundary on subsequent geometry refreshes.
      horizontalTriggerInsetPx: 42,
      horizontalRestInsetPx: 88,
      horizontalCenter: false,

      // Legacy architecture band retained for compatibility/debugging.
      verticalBandTop: 0.20,
      verticalBandBottom: 0.75,
      verticalMarginPx: 18,

      // Phase 7.4B3 vertical hysteresis.
      // Trigger wide; rest higher/closer to center so the selected row
      // doesn't sit at the old 75% lower boundary.
      // Keep the selected row around the middle of the usable viewport.
      //
      // The trigger band is deliberately narrow enough that normal row-to-row
      // navigation recenters reliably, but wide enough to avoid tiny jitter
      // when card geometry changes by a few pixels.
      verticalTriggerTopRatio: 0.42,
      verticalTriggerBottomRatio: 0.58,

      // UP and DOWN share the same preferred resting point. Scroll clamping
      // naturally falls back near the top/bottom of the page when true
      // centering is impossible.
      verticalRestTopRatio: 0.50,
      verticalRestBottomRatio: 0.50,

      // Vertical page movement is intentionally immediate. The user may keep
      // smooth horizontal row animation, but a delayed window.scrollTo()
      // leaves Focus several rows ahead of the visible page when navigating
      // quickly with a remote/keyboard.
      verticalBehavior: 'auto',

      // Header/tabs are the top-level navigation surface. Whenever the user
      // intentionally moves selection into the header, return the page content
      // to its natural top position so the header and first rows are shown
      // together.
      headerSelectionScrollTop: true,

      // Refresh geometry after visual movement has actually settled.
      settleMs: 40,
      settleStableFrames: 3,
      settleMaxMs: 750,

      // Horizontal LEFT/RIGHT should not move the page unless vertically
      // clipped. Vertical moves should use the comfort band.
      avoidPageScrollOnHorizontal: true,

      // We intentionally do NOT click Jellyfin's scroll buttons. Plugin-created
      // rows can look like native emby-scrollers without satisfying Jellyfin's
      // internal assumptions; direct button invocation can crash inside the
      // bundled scroller code. AirNav owns only the translateX of the content
      // strip while active.
      useCustomTransformScrolling: true
    };

    let instance = null;

    function getGlobalSettings() {
      let ownSettings = QoL.settings || {};

      if (typeof QoL.getSettings === 'function') {
        try {
          ownSettings = QoL.getSettings() || ownSettings;
        } catch (error) {
          console.warn(
            '[AirNav.Scroll] QoL.getSettings() failed; using local settings.',
            error
          );
        }
      }

      return ownSettings;
    }

    class ScrollManager {
      constructor(options = {}) {
        const globalSettings = getGlobalSettings();
        const airNavSettings = globalSettings.airNav || {};
        const scrollSettings = airNavSettings.scroll || {};

        this.cfg = Object.assign({}, DEFAULTS, scrollSettings, options);

        this.cfg.debug = !!(
          this.cfg.debug ||
          airNavSettings.debug ||
          globalSettings.DEBUG
        );

        this.started = false;
        this.unsubscribeSelection = null;
        this.settleTimer = null;
        this.settleRaf = null;
        this.settleProbeToken = 0;
        this.revealToken = 0;
        this.lastReveal = null;

        this.start();
      }

      start() {
        if (this.started) return this;

        if (!QoL.airScanner) {
          console.error('[AirNav.Scroll] airScanner is not available.');
          return this;
        }

        if (!QoL.airFocus) {
          console.error('[AirNav.Scroll] airFocus is not available.');
          return this;
        }

        QoL.airScanner.create();
        QoL.airFocus.create();

        this.unsubscribeSelection = QoL.airFocus.on(
          'selectionChanged',
          event => this.handleSelectionChanged(event)
        );

        this.started = true;
        this.log('started');
        return this;
      }

      destroy() {
        this.revealToken += 1;

        if (this.unsubscribeSelection) {
          try { this.unsubscribeSelection(); } catch (_) {}
          this.unsubscribeSelection = null;
        }

        if (this.settleTimer) {
          clearTimeout(this.settleTimer);
          this.settleTimer = null;
        }

        if (this.settleRaf) {
          cancelAnimationFrame(this.settleRaf);
          this.settleRaf = null;
        }

        this.settleProbeToken += 1;

        this.lastReveal = null;
        this.started = false;
        this.log('destroyed');
      }

      handleSelectionChanged(event) {
        if (!this.started || !event?.state || !event?.item) return;

        const model = QoL.airScanner?.getModel?.();
        if (!model || model.activeSurfaceHint !== 'page') return;

        const reason = String(event.reason || '');
        const movement = this.parseMovementReason(reason);

        // Scanner geometry/model refreshes re-resolve the same stable key.
        // That is not a new navigation decision and must never launch another
        // smooth scroll. B2 could "chase" an in-flight animation, making the UI
        // sluggish and occasionally leaving stale/off-screen geometry.
        const sameLogicalItem =
          !!event.previous?.itemKey &&
          event.previous.itemKey === event.state.itemKey;

        if (sameLogicalItem && event.state.restored) {
          return;
        }

        this.reveal(event.item.key, {
          reason,
          direction: movement.direction,
          horizontalMove: movement.horizontal,
          verticalMove: movement.vertical
        });
      }

      parseMovementReason(reason) {
        const lower = String(reason || '').toLowerCase();

        const right = lower.includes('geometry:right');
        const left = lower.includes('geometry:left');
        const up = lower.includes('geometry:up');
        const down = lower.includes('geometry:down');

        return {
          direction: right ? 'RIGHT'
            : left ? 'LEFT'
              : up ? 'UP'
                : down ? 'DOWN'
                  : null,
          horizontal: right || left,
          vertical: up || down
        };
      }

      async reveal(itemKey, options = {}) {
        const token = ++this.revealToken;
        const model = QoL.airScanner?.getModel?.();

        if (!model || model.activeSurfaceHint !== 'page') {
          return this.result(false, 'surface-not-page');
        }

        const match = this.findItemByKey(model, itemKey);
        if (!match) {
          return this.result(false, 'item-not-found', { itemKey });
        }

        const horizontalResult = await this.ensureHorizontalVisibility(
          match.item,
          match.section,
          token
        );

        if (token !== this.revealToken) {
          return this.result(false, 'superseded');
        }

        // Re-read live item geometry after horizontal movement before deciding
        // whether page movement is needed.
        const liveRect =
          this.getLiveRect(match.item.element) ||
          match.item.rect;

        let verticalResult =
          this.result(
            false,
            'vertical-not-needed'
          );

        // Header items / top tabs are fixed navigation targets. The selected
        // header itself is already visible, but leaving the document scrolled
        // several rows down makes the transition feel disconnected. Snap the
        // page content back to the top on the real navigation decision.
        if (
          match.section.type === 'header' &&
          this.cfg.headerSelectionScrollTop !== false
        ) {
          verticalResult =
            this.ensureDocumentTop(
              'header-selection-top'
            );
        }

        const shouldUseComfortBand =
          options.verticalMove ||
          !options.horizontalMove ||
          !this.cfg.avoidPageScrollOnHorizontal;

        if (match.section.type !== 'header') {
          if (shouldUseComfortBand) {
            verticalResult = this.ensureVerticalComfort(
              liveRect,
              match.item.element,
              options.direction
            );
          } else if (
            this.isVerticallyClipped(
              liveRect,
              match.item.element
            )
          ) {
            verticalResult = this.ensureVerticalVisibleMinimal(
              liveRect,
              match.item.element
            );
          }
        }

        const changed =
          !!horizontalResult.changed ||
          !!verticalResult.changed;

        const postScrollRect =
          this.getLiveRect(
            match.item.element
          );

        this.lastReveal = {
          timestamp: Date.now(),
          itemKey,
          sectionId: match.section.id,
          reason:
            options.reason || null,
          direction:
            options.direction || null,

          // Geometry before vertical movement.
          liveRect:
            liveRect
              ? { ...liveRect }
              : null,

          // Geometry immediately after the vertical scroll command. With the
          // default immediate vertical snap, this should already be inside the
          // visible viewport and is the quickest way to detect a wrong scroller.
          postScrollRect:
            postScrollRect
              ? { ...postScrollRect }
              : null,

          horizontal:
            horizontalResult,
          vertical:
            verticalResult,
          changed
        };

        if (changed) {
          this.scheduleGeometryRefresh('scroll-settled');
        }

        this.log('reveal', this.getDebugSnapshot());
        return this.lastReveal;
      }

      async ensureHorizontalVisibility(item, section, token) {
        if (!section?.scroll?.horizontal) {
          return this.result(false, 'section-not-horizontal');
        }

        const viewport = section.scroll.container;
        const content = section.scroll.contentElement;
        const element = item?.element;

        if (!viewport?.isConnected || !element?.isConnected) {
          return this.result(false, 'horizontal-elements-missing');
        }

        if (this.isHorizontallyComfortable(element, viewport)) {
          return this.result(false, 'already-horizontal-visible');
        }

        const mode = section.scroll.mode || 'row';

        if (mode === 'transform') {
          return this.ensureTransformVisibility(
            element,
            section,
            viewport,
            content,
            token
          );
        }

        if (mode === 'native') {
          return this.ensureNativeHorizontalVisibility(element, viewport);
        }

        // Some plugin rows expose a logical row but no explicit mode. If the
        // container can scroll natively, use it; otherwise use conservative
        // direct visibility behavior inside the row only.
        if (viewport.scrollWidth > viewport.clientWidth + 1) {
          return this.ensureNativeHorizontalVisibility(element, viewport);
        }

        return this.result(false, 'row-has-no-scroll-mechanism');
      }

      ensureNativeHorizontalVisibility(element, viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        const itemRect = element.getBoundingClientRect();

        const trigger = Math.max(
          0,
          Number(this.cfg.horizontalTriggerInsetPx) || 0
        );
        const rest = Math.max(
          trigger,
          Number(this.cfg.horizontalRestInsetPx) || trigger
        );

        let delta = 0;

        if (this.cfg.horizontalCenter) {
          delta =
            (itemRect.left + itemRect.width / 2) -
            (viewportRect.left + viewportRect.width / 2);
        } else if (itemRect.left < viewportRect.left + trigger) {
          delta = itemRect.left - (viewportRect.left + rest);
        } else if (itemRect.right > viewportRect.right - trigger) {
          delta = itemRect.right - (viewportRect.right - rest);
        }

        if (Math.abs(delta) < 1) {
          return this.result(false, 'native-within-horizontal-hysteresis');
        }

        const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const desired = this.clamp(viewport.scrollLeft + delta, 0, max);

        try {
          viewport.scrollTo({
            left: desired,
            behavior: this.cfg.behavior
          });
        } catch (_) {
          viewport.scrollLeft = desired;
        }

        return this.result(true, 'native-horizontal-scroll', {
          from: viewport.scrollLeft,
          desired
        });
      }

      async ensureTransformVisibility(element, section, viewport, content, token) {
        if (!content?.isConnected) {
          return this.result(false, 'transform-content-missing');
        }

        if (!this.cfg.useCustomTransformScrolling) {
          return this.result(false, 'custom-transform-disabled');
        }

        if (token !== this.revealToken) {
          return this.result(false, 'superseded');
        }

        return this.revealByCustomTransform(
          element,
          section,
          viewport,
          content
        );
      }

      revealByCustomTransform(element, section, viewport, content) {
        const viewportRect = viewport.getBoundingClientRect();
        const itemRect = element.getBoundingClientRect();

        const trigger = Math.max(
          0,
          Number(this.cfg.horizontalTriggerInsetPx) || 0
        );

        const rest = Math.max(
          trigger,
          Number(this.cfg.horizontalRestInsetPx) || trigger
        );

        const triggerLeft = viewportRect.left + trigger;
        const triggerRight = viewportRect.right - trigger;
        const restLeft = viewportRect.left + rest;
        const restRight = viewportRect.right - rest;

        // Hysteresis: a card that is inside the trigger band does not scroll.
        // Once it crosses that band, move it farther inward to the rest band.
        let delta = 0;
        let edge = null;

        if (itemRect.left < triggerLeft) {
          delta = restLeft - itemRect.left;
          edge = 'left';
        } else if (itemRect.right > triggerRight) {
          delta = restRight - itemRect.right;
          edge = 'right';
        }

        if (Math.abs(delta) < 1) {
          return this.result(false, 'within-horizontal-hysteresis');
        }

        const currentX = this.readTranslateX(content);

        const liveItems = (section.items || [])
          .map(item => item.element)
          .filter(item => item?.isConnected);

        const first = liveItems[0] || null;
        const last = liveItems[liveItems.length - 1] || null;

        let minX = Number.NEGATIVE_INFINITY;
        let maxX = 0;

        // Current DOM geometry already includes currentX. Convert the last
        // card's live right edge back into its untransformed position, then
        // compute the furthest-left transform that still keeps the final card
        // comfortably inside the viewport.
        if (last) {
          const lastRect = last.getBoundingClientRect();
          const naturalLastRight = lastRect.right - currentX;
          minX = Math.min(0, restRight - naturalLastRight);
        } else {
          const width = Math.max(
            content.scrollWidth || 0,
            content.getBoundingClientRect().width || 0
          );
          minX = Math.min(0, viewportRect.width - width);
        }

        // Never allow positive translation beyond the row's natural start.
        if (first) {
          const firstRect = first.getBoundingClientRect();
          const naturalFirstLeft = firstRect.left - currentX;

          // If the row naturally starts inset from viewport-left, preserve that
          // origin. maxX remains zero because transform:0 is authoritative.
          void naturalFirstLeft;
        }

        const proposed = currentX + delta;
        const nextX = this.clamp(proposed, minX, maxX);

        if (Math.abs(nextX - currentX) < 0.5) {
          return this.result(false, 'transform-edge-clamped', {
            edge,
            currentX,
            proposed,
            minX,
            maxX
          });
        }

        // Keep Jellyfin's existing animatedScrollX transition. We only own the
        // translated X value; no bundled scroll-button handler is invoked.
        content.style.transform = `translateX(${nextX}px)`;

        return this.result(true, 'custom-transform-horizontal-scroll', {
          edge,
          from: currentX,
          to: nextX,
          delta: nextX - currentX,
          minX,
          maxX
        });
      }

      ensureDocumentTop(reason = 'header-selection-top') {
        const root =
          document.scrollingElement ||
          document.documentElement;

        if (!root) {
          return this.result(
            false,
            'document-scroller-missing'
          );
        }

        const from =
          Number(root.scrollTop) || 0;

        if (from <= 0.5) {
          return this.result(
            false,
            'document-already-at-top',
            {
              scroller: 'document',
              from,
              desired: 0,
              actual: from
            }
          );
        }

        // Header transitions are immediate for the same reason as vertical
        // AirNav row snaps: logical focus and visible page position should not
        // drift apart during an asynchronous browser smooth scroll.
        root.scrollTop = 0;

        const actual =
          Number(root.scrollTop) || 0;

        return this.result(
          Math.abs(actual - from) >= 1,
          reason,
          {
            scroller: 'document',
            behavior: 'auto',
            from,
            desired: 0,
            actual,
            appliedDelta:
              actual - from
          }
        );
      }

      getVerticalViewportContext(element) {
        const scroller =
          this.findVerticalScrollContainer(element);

        const margin =
          Math.max(
            0,
            Number(this.cfg.verticalMarginPx) || 0
          );

        if (this.isDocumentScroller(scroller)) {
          const top = 0;
          const bottom = window.innerHeight;

          return {
            scroller,
            documentScroller: true,
            top,
            bottom,
            height: Math.max(0, bottom - top),
            usableTop: top + margin,
            usableBottom:
              Math.max(
                top + margin,
                bottom - margin
              ),
            margin
          };
        }

        const raw =
          scroller.getBoundingClientRect();

        // A nested Jellyfin page scroller can itself be partially clipped by
        // the browser viewport/header. Only the visible intersection is usable
        // for AirNav positioning.
        const top =
          Math.max(0, raw.top);

        const bottom =
          Math.min(
            window.innerHeight,
            raw.bottom
          );

        return {
          scroller,
          documentScroller: false,
          top,
          bottom,
          height:
            Math.max(0, bottom - top),
          usableTop:
            Math.min(
              bottom,
              top + margin
            ),
          usableBottom:
            Math.max(
              top,
              bottom - margin
            ),
          margin,
          scrollerRect: {
            top: raw.top,
            bottom: raw.bottom,
            left: raw.left,
            right: raw.right,
            width: raw.width,
            height: raw.height
          }
        };
      }

      getVerticalComfortPlan(
        rect,
        element,
        direction = null
      ) {
        if (!rect) {
          return {
            changed: false,
            reason: 'no-vertical-rect',
            delta: 0
          };
        }

        const context =
          this.getVerticalViewportContext(
            element
          );

        const usableTop =
          context.usableTop;

        const usableBottom =
          context.usableBottom;

        const usableHeight =
          Math.max(
            0,
            usableBottom - usableTop
          );

        if (usableHeight <= 0) {
          return {
            changed: false,
            reason: 'no-vertical-viewport',
            delta: 0,
            context
          };
        }

        const ratio = value =>
          this.clamp(
            Number(value),
            0,
            1
          );

        const triggerTop =
          usableTop +
          usableHeight *
            ratio(
              this.cfg.verticalTriggerTopRatio
            );

        const triggerBottom =
          usableTop +
          usableHeight *
            ratio(
              this.cfg.verticalTriggerBottomRatio
            );

        const restTop =
          usableTop +
          usableHeight *
            ratio(
              this.cfg.verticalRestTopRatio
            );

        const restBottom =
          usableTop +
          usableHeight *
            ratio(
              this.cfg.verticalRestBottomRatio
            );

        const itemHeight =
          Math.max(
            0,
            Number(rect.height) ||
            (rect.bottom - rect.top) ||
            0
          );

        const centerY =
          Number.isFinite(rect.centerY)
            ? rect.centerY
            : rect.top +
              (itemHeight / 2);

        const normalizedDirection =
          String(direction || '')
            .toUpperCase();

        let targetCenter = null;
        let reason =
          'within-vertical-trigger-band';

        if (
          normalizedDirection === 'DOWN'
        ) {
          if (
            centerY > triggerBottom ||
            rect.bottom > usableBottom
          ) {
            targetCenter = restBottom;
            reason =
              'down-crossed-vertical-trigger';
          }
        } else if (
          normalizedDirection === 'UP'
        ) {
          if (
            centerY < triggerTop ||
            rect.top < usableTop
          ) {
            targetCenter = restTop;
            reason =
              'up-crossed-vertical-trigger';
          }
        } else {
          // Manual/non-directional reveal.
          if (
            centerY > triggerBottom ||
            rect.bottom > usableBottom
          ) {
            targetCenter = restBottom;
            reason =
              'manual-below-vertical-trigger';
          } else if (
            centerY < triggerTop ||
            rect.top < usableTop
          ) {
            targetCenter = restTop;
            reason =
              'manual-above-vertical-trigger';
          }
        }

        if (targetCenter == null) {
          return {
            changed: false,
            reason,
            delta: 0,
            rect: { ...rect },
            context,
            triggerTop,
            triggerBottom,
            restTop,
            restBottom
          };
        }

        let delta =
          centerY - targetCenter;

        // Edge correction only: after the snap target is applied, ensure a
        // normal-sized card is not left clipped by the actual viewport.
        if (itemHeight <= usableHeight) {
          const predictedTop =
            rect.top - delta;

          const predictedBottom =
            rect.bottom - delta;

          if (predictedTop < usableTop) {
            delta +=
              predictedTop -
              usableTop;
            reason +=
              '+top-edge-correction';
          } else if (
            predictedBottom >
            usableBottom
          ) {
            delta +=
              predictedBottom -
              usableBottom;
            reason +=
              '+bottom-edge-correction';
          }
        } else {
          const viewportCenter =
            usableTop +
            usableHeight / 2;

          delta =
            centerY -
            viewportCenter;

          reason =
            'oversize-item-center';
        }

        if (
          !Number.isFinite(delta) ||
          Math.abs(delta) < 1
        ) {
          return {
            changed: false,
            reason:
              `${reason}:zero-delta`,
            delta: 0,
            rect: { ...rect },
            context,
            triggerTop,
            triggerBottom,
            restTop,
            restBottom
          };
        }

        return {
          changed: true,
          reason,
          delta,
          rect: { ...rect },
          context,
          triggerTop,
          triggerBottom,
          restTop,
          restBottom,
          targetCenter
        };
      }

      ensureVerticalComfort(
        rect,
        element,
        direction = null
      ) {
        const plan =
          this.getVerticalComfortPlan(
            rect,
            element,
            direction
          );

        if (!plan.changed) {
          return this.result(
            false,
            plan.reason,
            {
              delta: plan.delta,
              triggerTop:
                plan.triggerTop,
              triggerBottom:
                plan.triggerBottom,
              restTop:
                plan.restTop,
              restBottom:
                plan.restBottom,
              viewport: plan.context
            }
          );
        }

        return this.scrollVerticalBy(
          element,
          plan.delta,
          'vertical-snap-reveal',
          plan.context,
          {
            direction:
              direction || null,
            planReason:
              plan.reason,
            targetCenter:
              plan.targetCenter
          }
        );
      }

      ensureVerticalVisibleMinimal(rect, element) {
        if (!rect) {
          return this.result(
            false,
            'no-vertical-rect'
          );
        }

        const context =
          this.getVerticalViewportContext(
            element
          );

        let delta = 0;

        if (
          rect.top <
          context.usableTop
        ) {
          delta =
            rect.top -
            context.usableTop;
        } else if (
          rect.bottom >
          context.usableBottom
        ) {
          delta =
            rect.bottom -
            context.usableBottom;
        }

        if (
          !Number.isFinite(delta) ||
          Math.abs(delta) < 1
        ) {
          return this.result(
            false,
            'vertically-visible',
            {
              viewport: context
            }
          );
        }

        return this.scrollVerticalBy(
          element,
          delta,
          'vertical-minimal-reveal',
          context
        );
      }

      scrollVerticalBy(
        element,
        delta,
        reason,
        context = null,
        meta = {}
      ) {
        if (!Number.isFinite(delta) || Math.abs(delta) < 1) {
          return this.result(false, 'vertical-zero-delta');
        }

        const scroller =
          context?.scroller ||
          this.findVerticalScrollContainer(
            element
          );

        if (this.isDocumentScroller(scroller)) {
          const root =
            document.scrollingElement ||
            document.documentElement;

          const from =
            root.scrollTop;

          const max =
            Math.max(
              0,
              root.scrollHeight -
              window.innerHeight
            );

          const desired =
            this.clamp(
              from + delta,
              0,
              max
            );

          const verticalBehavior =
            this.cfg.verticalBehavior === 'smooth'
              ? 'smooth'
              : 'auto';

          if (verticalBehavior === 'smooth') {
            try {
              window.scrollTo({
                top: desired,
                behavior: 'smooth'
              });
            } catch (_) {
              root.scrollTop = desired;
            }
          } else {
            // Direct assignment is intentional. Browser smooth scrolling is
            // asynchronous and can be cancelled/re-targeted by subsequent
            // navigation, leaving logical Focus outside the viewport.
            root.scrollTop = desired;
          }

          const actual =
            root.scrollTop;

          return this.result(
            Math.abs(actual - from) >= 1,
            reason,
            {
              scroller: 'document',
              behavior: verticalBehavior,
              from,
              desired,
              actual,
              max,
              requestedDelta: delta,
              appliedDelta:
                actual - from,
              ...meta
            }
          );
        }

        const from =
          scroller.scrollTop;

        const max =
          Math.max(
            0,
            scroller.scrollHeight -
            scroller.clientHeight
          );

        const desired =
          this.clamp(
            from + delta,
            0,
            max
          );

        const verticalBehavior =
          this.cfg.verticalBehavior === 'smooth'
            ? 'smooth'
            : 'auto';

        if (verticalBehavior === 'smooth') {
          try {
            scroller.scrollTo({
              top: desired,
              behavior: 'smooth'
            });
          } catch (_) {
            scroller.scrollTop = desired;
          }
        } else {
          scroller.scrollTop = desired;
        }

        const actual =
          scroller.scrollTop;

        return this.result(
          Math.abs(actual - from) >= 1,
          reason,
          {
            scroller:
              this.describeElement(
                scroller
              ),
            behavior: verticalBehavior,
            from,
            desired,
            actual,
            max,
            requestedDelta: delta,
            appliedDelta:
              actual - from,
            ...meta
          }
        );
      }

      findVerticalScrollContainer(element) {
        let node = element?.parentElement || null;

        while (node && node !== document.body && node !== document.documentElement) {
          const style = getComputedStyle(node);
          const overflowY = style.overflowY;

          const scrollable =
            /auto|scroll|overlay/i.test(overflowY) &&
            node.scrollHeight > node.clientHeight + 1;

          if (scrollable) {
            // Horizontal row viewports may technically report scrollable
            // dimensions; don't mistake them for the page's vertical scroller.
            if (!node.matches('.emby-scroller[data-scroll-mode-x="custom"]')) {
              return node;
            }
          }

          node = node.parentElement;
        }

        return document.scrollingElement || document.documentElement;
      }

      isDocumentScroller(scroller) {
        return (
          !scroller ||
          scroller === document.body ||
          scroller === document.documentElement ||
          scroller === document.scrollingElement
        );
      }

      isHorizontallyComfortable(element, viewport) {
        if (!element?.isConnected || !viewport?.isConnected) return false;

        const itemRect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        const inset = Math.max(
          0,
          Number(this.cfg.horizontalTriggerInsetPx) || 0
        );

        return (
          itemRect.left >= viewportRect.left + inset &&
          itemRect.right <= viewportRect.right - inset
        );
      }

      isVerticallyClipped(rect, element = null) {
        if (!rect) return true;

        const context =
          this.getVerticalViewportContext(
            element
          );

        return (
          rect.top <
            context.usableTop ||
          rect.bottom >
            context.usableBottom
        );
      }

      findItemByKey(model, itemKey) {
        const sections = [];
        if (model.header) sections.push(model.header);
        if (Array.isArray(model.sections)) sections.push(...model.sections);

        for (const section of sections) {
          const item = (section.items || []).find(
            candidate => candidate.key === itemKey
          );

          if (item) {
            return { section, item };
          }
        }

        return null;
      }

      getLiveRect(element) {
        if (!element?.isConnected) return null;

        const rect = element.getBoundingClientRect();
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

      readTranslateX(element) {
        if (!element) return 0;

        const transform = getComputedStyle(element).transform;

        if (!transform || transform === 'none') return 0;

        try {
          if (window.DOMMatrixReadOnly) {
            return new DOMMatrixReadOnly(transform).m41 || 0;
          }

          if (window.WebKitCSSMatrix) {
            return new WebKitCSSMatrix(transform).m41 || 0;
          }
        } catch (_) {
          // Regex fallback below.
        }

        const matrix = transform.match(/^matrix\(([^)]+)\)$/);
        if (matrix) {
          const parts = matrix[1].split(',').map(Number);
          return Number.isFinite(parts[4]) ? parts[4] : 0;
        }

        const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
        if (matrix3d) {
          const parts = matrix3d[1].split(',').map(Number);
          return Number.isFinite(parts[12]) ? parts[12] : 0;
        }

        const translate = transform.match(/translateX\(([-\d.]+)px\)/);
        return translate ? Number(translate[1]) || 0 : 0;
      }

      scheduleGeometryRefresh(reason) {
        if (this.settleTimer) {
          clearTimeout(this.settleTimer);
          this.settleTimer = null;
        }

        if (this.settleRaf) {
          cancelAnimationFrame(
            this.settleRaf
          );
          this.settleRaf = null;
        }

        const probeToken =
          ++this.settleProbeToken;

        const delayMs =
          Math.max(
            0,
            Number(this.cfg.settleMs) ||
            90
          );

        this.settleTimer =
          setTimeout(() => {
            this.settleTimer = null;

            const startedAt =
              performance.now();

            let stableFrames = 0;
            let previousTop = null;
            let previousLeft = null;

            const requiredStableFrames =
              Math.max(
                2,
                Number(
                  this.cfg.settleStableFrames
                ) || 4
              );

            const maxMs =
              Math.max(
                250,
                Number(
                  this.cfg.settleMaxMs
                ) || 900
              );

            const finish = suffix => {
              if (
                probeToken !==
                this.settleProbeToken
              ) {
                return;
              }

              this.settleRaf = null;

              if (
                typeof
                  QoL.airScanner
                    ?.refreshGeometry ===
                'function'
              ) {
                QoL.airScanner.refreshGeometry(
                  `${reason}:${suffix}`
                );
              } else {
                QoL.airScanner?.scan?.(
                  `${reason}:${suffix}:full-scan-fallback`
                );
              }
            };

            const probe = () => {
              if (
                probeToken !==
                this.settleProbeToken
              ) {
                return;
              }

              const item =
                QoL.airFocus
                  ?.getSelectedItem?.();

              const rect =
                item?.element?.isConnected
                  ? this.getLiveRect(
                      item.element
                    )
                  : null;

              if (!rect) {
                finish('no-live-item');
                return;
              }

              const same =
                previousTop != null &&
                previousLeft != null &&
                Math.abs(
                  rect.top -
                  previousTop
                ) < 0.75 &&
                Math.abs(
                  rect.left -
                  previousLeft
                ) < 0.75;

              stableFrames =
                same
                  ? stableFrames + 1
                  : 0;

              previousTop = rect.top;
              previousLeft = rect.left;

              if (
                stableFrames >=
                requiredStableFrames
              ) {
                finish('visual-stable');
                return;
              }

              if (
                performance.now() -
                  startedAt >=
                maxMs
              ) {
                finish('visual-timeout');
                return;
              }

              this.settleRaf =
                requestAnimationFrame(
                  probe
                );
            };

            this.settleRaf =
              requestAnimationFrame(
                probe
              );
          }, delayMs);
      }

      setBehavior(behavior, reason = 'api') {
        const next =
          behavior === 'auto'
            ? 'auto'
            : 'smooth';

        const previous = this.cfg.behavior;
        this.cfg.behavior = next;

        this.log('runtime behavior changed', {
          previous,
          value: next,
          reason
        });

        return {
          changed: previous !== next,
          previous,
          value: next,
          reason
        };
      }

      forceRevealSelected(reason = 'manual-force-reveal') {
        const state = QoL.airFocus?.getState?.();
        if (!state?.itemKey) return null;

        return this.reveal(state.itemKey, { reason });
      }

      getLastReveal() {
        return this.lastReveal;
      }

      getDebugSnapshot() {
        const state = QoL.airFocus?.getState?.();

        const item =
          QoL.airFocus?.getSelectedItem?.();

        return {
          started: this.started,
          behavior: this.cfg.behavior,
          headerSelectionScrollTop:
            this.cfg.headerSelectionScrollTop !== false,
          verticalSnap: {
            behavior:
              this.cfg.verticalBehavior,
            mode: 'center-preferred',
            triggerTop:
              this.cfg.verticalTriggerTopRatio,
            triggerBottom:
              this.cfg.verticalTriggerBottomRatio,
            restTop:
              this.cfg.verticalRestTopRatio,
            restBottom:
              this.cfg.verticalRestBottomRatio,
            preferredCenter:
              (
                Number(this.cfg.verticalRestTopRatio) +
                Number(this.cfg.verticalRestBottomRatio)
              ) / 2
          },
          selectedKey:
            state?.itemKey || null,
          selectedLiveRect:
            item?.element?.isConnected
              ? this.getLiveRect(
                  item.element
                )
              : null,
          verticalViewport:
            item?.element?.isConnected
              ? this.getVerticalViewportContext(
                  item.element
                )
              : null,
          lastReveal: this.lastReveal
        };
      }

      result(changed, reason, extra = {}) {
        return {
          changed: !!changed,
          reason,
          ...extra
        };
      }

      clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      describeElement(element) {
        if (!element) return null;

        return {
          tag: element.tagName || null,
          id: element.id || null,
          className: typeof element.className === 'string'
            ? element.className
            : null
        };
      }

      log(...args) {
        if (!this.cfg.debug) return;
        console.log('[AirNav.Scroll]', ...args);
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,

      create(options = {}) {
        if (!instance) instance = new ScrollManager(options);

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

      reveal(itemKey, options) {
        return instance ? instance.reveal(itemKey, options) : null;
      },

      setBehavior(behavior, reason = 'api') {
        if (!instance) {
          const next =
            behavior === 'auto'
              ? 'auto'
              : 'smooth';

          QoL.settings = QoL.settings || {};
          QoL.settings.airNav = QoL.settings.airNav || {};
          QoL.settings.airNav.scroll =
            QoL.settings.airNav.scroll || {};
          QoL.settings.airNav.scroll.behavior = next;

          return {
            changed: false,
            previous: null,
            value: next,
            reason: `${reason}:deferred-until-create`
          };
        }

        return instance.setBehavior(behavior, reason);
      },

      forceRevealSelected(reason) {
        return instance ? instance.forceRevealSelected(reason) : null;
      },

      getLastReveal() {
        return instance ? instance.getLastReveal() : null;
      },

      getDebugSnapshot() {
        return instance ? instance.getDebugSnapshot() : null;
      },

      compatibilityReport() {
        const takeoverActive = QoL.airScroll === api;
        const legacyPresent = !!QoL.airScroll && QoL.airScroll !== api;
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
          behavior: instance?.cfg?.behavior || null,
          lastReveal: instance?.getLastReveal?.() || null
        };
      }
    };

    return api;
  })();


  const existingScroll = QoL.airScroll || null;
  QoL.navigationScrollRuntime = productionApi;

  if (!existingScroll || existingScroll === productionApi) {
    QoL.airScroll = productionApi;
    console.log(LOG, 'Production Navigation ScrollManager registered as window.JellyfinQoL.airScroll.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected ScrollManager detected; production ScrollManager is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }
})(window.JellyfinQoL = window.JellyfinQoL || {});
