// Jellyfin QoL / AirNav - Production Navigation Geometry v1.0.0
// Purpose:
//   - Consume NavigationModel + current logical selection.
//   - Resolve LEFT / RIGHT / UP / DOWN using captured geometry.
//   - Preserve preferredX on vertical moves.
//   - Update preferredX on intentional horizontal moves via FocusManager.
//   - NEVER read raw keyboard/controller events.
//   - NEVER scroll or activate items.
//
// Requires when create()/move() is used:
//   window.JellyfinQoL.airScanner
//   window.JellyfinQoL.airFocus

(function (QoL) {
  'use strict';

  const VERSION = '1.0.2';
  const LEGACY_VERSION = '7.4B';
  const LOG = '[JellyfinQoL.NavigationGeometry]';

  const productionApi = (function () {
    const DIRECTION = Object.freeze({
      UP: 'UP',
      DOWN: 'DOWN',
      LEFT: 'LEFT',
      RIGHT: 'RIGHT'
    });

    const DEFAULTS = {
      debug: false,

      epsilonPx: 4,

      // Scoring weights from the architecture draft. Exact constants are
      // intentionally configurable implementation details.
      primaryAxisWeight: 1.0,
      secondaryAxisWeight: 1.8,
      overlapReward: 220,
      sectionPenalty: 40,
      offAxisPenalty: 160,

      // LEFT/RIGHT must remain in the active logical visual lane.
      horizontalRowTolerancePx: 28,
      minimumPerpendicularOverlap: 0.18,

      // A candidate this far off the desired secondary axis receives the
      // configured off-axis penalty when it also has little/no overlap.
      offAxisThresholdPx: 180,

      // Neighboring-section behavior for vertical navigation.
      sectionBandTolerancePx: 24,

      // Clamp when no candidate exists rather than wrapping.
      clampAtEdges: true,

      // Maximum candidates printed in a debug table.
      debugCandidateLimit: 8
    };

    let instance = null;

    function getGlobalSettings() {
      let ownSettings = QoL.settings || {};

      if (typeof QoL.getSettings === 'function') {
        try {
          ownSettings = QoL.getSettings() || ownSettings;
        } catch (error) {
          console.warn(
            '[AirNav.Geometry] QoL.getSettings() failed; using local settings.',
            error
          );
        }
      }

      return ownSettings;
    }

    class GeometryEngine {
      constructor(options = {}) {
        const globalSettings = getGlobalSettings();
        const airNavSettings = globalSettings.airNav || {};
        const geometrySettings = airNavSettings.geometry || {};

        this.cfg = Object.assign({}, DEFAULTS, geometrySettings, options);

        this.cfg.debug = !!(
          this.cfg.debug ||
          airNavSettings.debug ||
          globalSettings.DEBUG
        );

        this.started = false;
        this.lastDecision = null;
        this.start();
      }

      start() {
        if (this.started) return this;

        if (!QoL.airScanner) {
          console.error('[AirNav.Geometry] airScanner is not available.');
          return this;
        }

        if (!QoL.airFocus) {
          console.error('[AirNav.Geometry] airFocus is not available.');
          return this;
        }

        QoL.airScanner.create();
        QoL.airFocus.create();

        this.started = true;
        this.log('started');
        return this;
      }

      destroy() {
        this.lastDecision = null;
        this.started = false;
        this.log('destroyed');
      }

      move(direction) {
        direction = this.normalizeDirection(direction);

        if (!direction) {
          return this.result(false, 'invalid-direction');
        }

        const model = QoL.airScanner?.getModel?.();
        const state = QoL.airFocus?.getState?.();

        if (!model) {
          return this.result(false, 'no-model', { direction });
        }

        // Modal and player navigation are intentionally later phases.
        if (model.activeSurfaceHint !== 'page') {
          return this.result(false, `surface-owned:${model.activeSurfaceHint}`, {
            direction,
            surface: model.activeSurfaceHint
          });
        }

        if (!state?.itemKey) {
          return this.result(false, 'no-selection', { direction });
        }

        const current = this.findItemByKey(model, state.itemKey);
        if (!current) {
          QoL.airFocus.refresh?.('geometry-current-missing');
          return this.result(false, 'selected-item-missing', { direction });
        }

        const decision = this.resolve(direction, current, model, state);
        this.lastDecision = decision;

        if (!decision?.target?.item) {
          this.logDecision(decision);
          return this.result(false, decision?.reason || 'no-candidate', decision);
        }

        // Horizontal movement intentionally updates preferredX to the new item.
        // Vertical movement preserves the previous preferredX anchor.
        const preservePreferredX =
          direction === DIRECTION.UP ||
          direction === DIRECTION.DOWN;

        const selected = QoL.airFocus.selectByKey(
          decision.target.item.key,
          `geometry:${direction.toLowerCase()}`,
          { preservePreferredX }
        );

        const moved = !!selected;

        const result = this.result(
          moved,
          moved ? 'moved' : 'focus-rejected-target',
          {
            ...decision,
            selectedKey: selected?.key || null,
            preferredX: QoL.airFocus.getState?.()?.preferredX ?? null
          }
        );

        this.lastDecision = result;
        this.logDecision(result);

        return result;
      }

      preview(direction) {
        direction = this.normalizeDirection(direction);
        if (!direction) return null;

        const model = QoL.airScanner?.getModel?.();
        const state = QoL.airFocus?.getState?.();

        if (!model || !state?.itemKey || model.activeSurfaceHint !== 'page') {
          return null;
        }

        const current = this.findItemByKey(model, state.itemKey);
        if (!current) return null;

        const decision = this.resolve(direction, current, model, state);
        this.lastDecision = decision;
        this.logDecision(decision);
        return decision;
      }

      resolve(direction, current, model, state) {
        if (direction === DIRECTION.LEFT || direction === DIRECTION.RIGHT) {
          return this.resolveHorizontal(direction, current, model, state);
        }

        return this.resolveVertical(direction, current, model, state);
      }

      resolveHorizontal(direction, current, model, state) {
        // LEFT/RIGHT stay inside the current logical section.
        const candidates = (current.section.items || [])
          .filter(item => this.isValidCandidate(item, current.item))
          .filter(item => this.isInDirection(item.rect, current.item.rect, direction))
          .filter(item => this.sameVisualLane(current.item.rect, item.rect));

        const scored = candidates
          .map(item => this.scoreCandidate({
            direction,
            currentItem: current.item,
            candidate: item,
            currentSection: current.section,
            candidateSection: current.section,
            preferredX: state.preferredX
          }))
          .sort(this.compareScored);

        return {
          moved: false,
          direction,
          reason: scored.length ? 'candidate-found' : 'horizontal-edge',
          current,
          target: scored.length
            ? { section: current.section, item: scored[0].item }
            : null,
          candidates: scored
        };
      }

      resolveVertical(direction, current, model, state) {
        // A wrapping grid or multi-lane header can have a vertical candidate
        // inside the same logical section. Prefer that before leaving it.
        const sameSection = (current.section.items || [])
          .filter(item => this.isValidCandidate(item, current.item))
          .filter(item => this.isInDirection(item.rect, current.item.rect, direction));

        let scored = sameSection
          .map(item => this.scoreCandidate({
            direction,
            currentItem: current.item,
            candidate: item,
            currentSection: current.section,
            candidateSection: current.section,
            preferredX: state.preferredX
          }))
          .sort(this.compareScored);

        if (scored.length) {
          return {
            moved: false,
            direction,
            reason: 'same-section-vertical',
            current,
            target: { section: current.section, item: scored[0].item },
            candidates: scored
          };
        }

        const neighboringSections = this.findNearestDirectionalSections(
          model,
          current.section,
          current.item.rect,
          direction
        );

        const candidates = [];

        for (const section of neighboringSections) {
          for (const item of section.items || []) {
            if (!this.isValidCandidate(item, current.item)) continue;
            if (!this.isInDirection(item.rect, current.item.rect, direction)) continue;

            candidates.push(
              this.scoreCandidate({
                direction,
                currentItem: current.item,
                candidate: item,
                currentSection: current.section,
                candidateSection: section,
                preferredX: state.preferredX
              })
            );
          }
        }

        scored = candidates.sort(this.compareScored);

        return {
          moved: false,
          direction,
          reason: scored.length ? 'neighbor-section' : 'vertical-edge',
          current,
          target: scored.length
            ? {
                section: scored[0].section,
                item: scored[0].item
              }
            : null,
          candidates: scored
        };
      }

      findNearestDirectionalSections(model, currentSection, currentRect, direction) {
        const isUsableSection = section => !!(
          section &&
          section.metadata?.directional !== false &&
          Array.isArray(section.items) &&
          section.items.some(item => this.isValidItem(item))
        );

        const contentSections = (model.sections || []).filter(isUsableSection);
        const header = isUsableSection(model.header) ? model.header : null;
        const currentIsHeader = !!header && (
          currentSection === header ||
          currentSection.id === header.id ||
          currentSection.type === 'header'
        );

        // Do not walk model.sections as a strict ordered chain. Auxiliary
        // sections can sit between two visual bands; a section with no item in
        // the requested physical direction must not clamp navigation.
        const sectionCandidates = [];
        for (let index = 0; index < contentSections.length; index += 1) {
          const section = contentSections[index];
          if (!section || section.id === currentSection.id) continue;

          const directionalItems = (section.items || [])
            .filter(item => this.isValidItem(item))
            .filter(item => this.isInDirection(item.rect, currentRect, direction));
          if (!directionalItems.length) continue;

          let nearestDistance = Number.POSITIVE_INFINITY;
          let nearestCenterDistance = Number.POSITIVE_INFINITY;
          for (const item of directionalItems) {
            const rect = item.rect;
            const edgeDistance = direction === DIRECTION.DOWN
              ? Math.max(0, rect.top - currentRect.bottom)
              : Math.max(0, currentRect.top - rect.bottom);
            const centerDistance = Math.abs(rect.centerY - currentRect.centerY);
            nearestDistance = Math.min(nearestDistance, edgeDistance);
            nearestCenterDistance = Math.min(nearestCenterDistance, centerDistance);
          }

          sectionCandidates.push({ section, index, distance: nearestDistance, centerDistance: nearestCenterDistance });
        }

        sectionCandidates.sort((a, b) =>
          a.distance - b.distance ||
          a.centerDistance - b.centerDistance ||
          a.index - b.index
        );

        if (sectionCandidates.length) {
          const bestDistance = sectionCandidates[0].distance;
          const tolerance = Math.max(0, Number(this.cfg.sectionBandTolerancePx) || 0);
          return sectionCandidates
            .filter(candidate => candidate.distance <= bestDistance + tolerance)
            .map(candidate => candidate.section);
        }

        if (!currentIsHeader && direction === DIRECTION.UP && header) {
          const hasDirectionalHeaderItem = (header.items || [])
            .some(item => this.isValidItem(item) && this.isInDirection(item.rect, currentRect, direction));
          return hasDirectionalHeaderItem ? [header] : [];
        }

        return [];
      }

      scoreCandidate({
        direction,
        currentItem,
        candidate,
        currentSection,
        candidateSection,
        preferredX
      }) {
        const currentRect = currentItem.rect;
        const candidateRect = candidate.rect;

        const horizontal =
          direction === DIRECTION.LEFT ||
          direction === DIRECTION.RIGHT;

        const primaryAxisDistance = horizontal
          ? Math.abs(candidateRect.centerX - currentRect.centerX)
          : Math.abs(candidateRect.centerY - currentRect.centerY);

        const verticalAnchorX = Number.isFinite(preferredX)
          ? preferredX
          : currentRect.centerX;

        const secondaryAxisDistance = horizontal
          ? Math.abs(candidateRect.centerY - currentRect.centerY)
          : Math.abs(candidateRect.centerX - verticalAnchorX);

        const overlapRatio = horizontal
          ? this.intervalOverlapRatio(
              currentRect.top,
              currentRect.bottom,
              candidateRect.top,
              candidateRect.bottom
            )
          : this.intervalOverlapRatio(
              currentRect.left,
              currentRect.right,
              candidateRect.left,
              candidateRect.right
            );

        const sectionPenalty =
          currentSection.id === candidateSection.id
            ? 0
            : this.cfg.sectionPenalty;

        const offAxisPenalty =
          overlapRatio < this.cfg.minimumPerpendicularOverlap &&
          secondaryAxisDistance > this.cfg.offAxisThresholdPx
            ? this.cfg.offAxisPenalty
            : 0;

        const score =
          primaryAxisDistance * this.cfg.primaryAxisWeight +
          secondaryAxisDistance * this.cfg.secondaryAxisWeight -
          overlapRatio * this.cfg.overlapReward +
          sectionPenalty +
          offAxisPenalty;

        return {
          item: candidate,
          section: candidateSection,
          score,
          primaryAxisDistance,
          secondaryAxisDistance,
          overlapRatio,
          sectionPenalty,
          offAxisPenalty
        };
      }

      compareScored(a, b) {
        if (a.score !== b.score) return a.score - b.score;
        if (a.primaryAxisDistance !== b.primaryAxisDistance) {
          return a.primaryAxisDistance - b.primaryAxisDistance;
        }
        if (a.secondaryAxisDistance !== b.secondaryAxisDistance) {
          return a.secondaryAxisDistance - b.secondaryAxisDistance;
        }

        const ai = Number.isInteger(a.item?.metadata?.domIndex)
          ? a.item.metadata.domIndex
          : Number.MAX_SAFE_INTEGER;
        const bi = Number.isInteger(b.item?.metadata?.domIndex)
          ? b.item.metadata.domIndex
          : Number.MAX_SAFE_INTEGER;

        return ai - bi;
      }

      sameVisualLane(a, b) {
        if (!a || !b) return false;

        const centerDelta = Math.abs(a.centerY - b.centerY);
        if (centerDelta <= this.cfg.horizontalRowTolerancePx) return true;

        const overlap = this.intervalOverlapRatio(
          a.top,
          a.bottom,
          b.top,
          b.bottom
        );

        return overlap >= this.cfg.minimumPerpendicularOverlap;
      }

      isInDirection(candidateRect, currentRect, direction) {
        const epsilon = Number(this.cfg.epsilonPx) || 0;

        switch (direction) {
          case DIRECTION.RIGHT:
            return candidateRect.centerX > currentRect.centerX + epsilon;
          case DIRECTION.LEFT:
            return candidateRect.centerX < currentRect.centerX - epsilon;
          case DIRECTION.DOWN:
            return candidateRect.centerY > currentRect.centerY + epsilon;
          case DIRECTION.UP:
            return candidateRect.centerY < currentRect.centerY - epsilon;
          default:
            return false;
        }
      }

      intervalOverlapRatio(a1, a2, b1, b2) {
        const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
        const smallest = Math.max(1, Math.min(a2 - a1, b2 - b1));
        return Math.max(0, Math.min(1, overlap / smallest));
      }

      getEffectiveSectionRect(section) {
        const itemRects = (section.items || [])
          .filter(item => this.isValidItem(item))
          .map(item => item.rect)
          .filter(Boolean);

        if (!itemRects.length) return section.rect || null;

        const top = Math.min(...itemRects.map(rect => rect.top));
        const left = Math.min(...itemRects.map(rect => rect.left));
        const right = Math.max(...itemRects.map(rect => rect.right));
        const bottom = Math.max(...itemRects.map(rect => rect.bottom));

        return {
          top,
          left,
          right,
          bottom,
          width: right - left,
          height: bottom - top,
          centerX: left + ((right - left) / 2),
          centerY: top + ((bottom - top) / 2)
        };
      }

      getAllSections(model) {
        const result = [];
        if (model?.header) result.push(model.header);
        if (Array.isArray(model?.sections)) result.push(...model.sections);
        return result;
      }

      findItemByKey(model, itemKey) {
        for (const section of this.getAllSections(model)) {
          const item = (section.items || []).find(candidate => candidate.key === itemKey);
          if (item && this.isValidItem(item)) {
            return { section, item };
          }
        }

        return null;
      }

      isValidCandidate(item, currentItem) {
        return (
          this.isValidItem(item) &&
          item.key !== currentItem.key
        );
      }

      isValidItem(item) {
        const rect = item?.rect;

        return !!(
          item &&
          item.key &&
          item.element &&
          item.element.isConnected &&
          item.state?.visible !== false &&
          item.state?.enabled !== false &&
          rect &&
          Number.isFinite(rect.centerX) &&
          Number.isFinite(rect.centerY)
        );
      }

      normalizeDirection(direction) {
        const value = String(direction || '').trim().toUpperCase();
        return Object.prototype.hasOwnProperty.call(DIRECTION, value)
          ? DIRECTION[value]
          : null;
      }

      result(moved, reason, detail = {}) {
        // The resolver detail contains provisional moved/reason fields used
        // during candidate scoring. The final move outcome is authoritative
        // and must win so Controller/UniversalInput consume browser-native
        // arrow defaults after a logical selection actually changes.
        return {
          ...detail,
          moved: !!moved,
          reason
        };
      }

      getLastDecision() {
        return this.lastDecision;
      }

      getDebugSnapshot() {
        return {
          started: this.started,
          config: { ...this.cfg },
          lastDecision: this.serializeDecision(this.lastDecision)
        };
      }

      serializeDecision(decision) {
        if (!decision) return null;

        const mapItem = match => {
          if (!match) return null;
          const item = match.item || match;
          const section = match.section || null;

          return {
            key: item?.key || null,
            title: item?.title || null,
            sectionId: section?.id || item?.sectionId || null,
            centerX: item?.rect?.centerX ?? null,
            centerY: item?.rect?.centerY ?? null
          };
        };

        return {
          moved: !!decision.moved,
          reason: decision.reason || null,
          direction: decision.direction || null,
          preferredX: decision.preferredX ?? null,
          current: mapItem(decision.current),
          target: mapItem(decision.target),
          candidates: (decision.candidates || [])
            .slice(0, this.cfg.debugCandidateLimit)
            .map(candidate => ({
              ...mapItem(candidate),
              score: this.round(candidate.score),
              primary: this.round(candidate.primaryAxisDistance),
              secondary: this.round(candidate.secondaryAxisDistance),
              overlap: this.round(candidate.overlapRatio),
              sectionPenalty: candidate.sectionPenalty,
              offAxisPenalty: candidate.offAxisPenalty
            }))
        };
      }

      logDecision(decision) {
        if (!this.cfg.debug || !decision) return;

        const snapshot = this.serializeDecision(decision);

        console.log(
          `[AirNav.Geometry] ${snapshot.direction || '?'} ` +
          `from=${snapshot.current?.key || 'none'} ` +
          `to=${snapshot.target?.key || 'none'} ` +
          `reason=${snapshot.reason}` +
          (snapshot.preferredX != null ? ` preferredX=${this.round(snapshot.preferredX)}` : '')
        );

        if (snapshot.candidates?.length) {
          console.table(snapshot.candidates);
        }
      }

      round(value) {
        return Number.isFinite(value)
          ? Math.round(value * 100) / 100
          : value;
      }

      log(message, ...args) {
        if (!this.cfg.debug) return;
        console.log(`[AirNav.Geometry] ${message}`, ...args);
      }
    }

    const api = {
      version: VERSION,
      VERSION,
      LEGACY_VERSION,
      production: true,
      DIRECTION,

      create(options = {}) {
        if (!instance) instance = new GeometryEngine(options);
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

      move(direction) {
        return instance ? instance.move(direction) : null;
      },

      preview(direction) {
        return instance ? instance.preview(direction) : null;
      },

      getLastDecision() {
        return instance ? instance.getLastDecision() : null;
      },

      getDebugSnapshot() {
        return instance ? instance.getDebugSnapshot() : null;
      },

      compatibilityReport() {
        const takeoverActive = QoL.airGeometry === api;
        const legacyPresent = !!QoL.airGeometry && QoL.airGeometry !== api;
        return {
          version: VERSION,
          legacyVersion: LEGACY_VERSION,
          production: true,
          ready: true,
          takeoverReady: true,
          takeoverActive,
          passiveComparisonMode: legacyPresent,
          legacyPresent,
          geometryFirstSectionSearch: true,
          directionalBandTolerancePx: instance?.cfg?.sectionBandTolerancePx ?? DEFAULTS.sectionBandTolerancePx,
          started: !!instance?.started,
          lastDecision: instance?.getLastDecision?.() || null
        };
      }
    };

    return api;
  })();

  const existingGeometry = QoL.airGeometry || null;
  QoL.navigationGeometryRuntime = productionApi;

  if (!existingGeometry || existingGeometry === productionApi) {
    QoL.airGeometry = productionApi;
    console.log(LOG, 'Production Navigation Geometry registered as window.JellyfinQoL.airGeometry.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  } else {
    console.log(LOG, 'Legacy/injected Geometry detected; production Geometry is passive until the old script is disabled and the page reloads.', {
      version: VERSION,
      legacyCompatibility: LEGACY_VERSION
    });
  }

})(window.JellyfinQoL = window.JellyfinQoL || {});
