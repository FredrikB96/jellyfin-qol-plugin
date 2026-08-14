(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    const VERSION = '1.0.0';
    const RESOLVER_VERSION = '1.1.0';
    const LOG = '[JellyfinQoL.GestureResolverDirectionalPolicy]';
    const DIRECTIONS = Object.freeze(['UP', 'DOWN', 'LEFT', 'RIGHT']);
    const DIRECTION_SET = new Set(DIRECTIONS);

    if (QoL.directionalGesturePolicy?.version === VERSION) return;

    const baseApi = QoL.gestureResolverRuntime;
    if (!baseApi || typeof baseApi.create !== 'function') {
        console.error(LOG, 'gestureResolverRuntime is not available.');
        return;
    }

    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return value; }
    }

    function isDirection(binding) {
        return DIRECTION_SET.has(String(binding?.action || '').toUpperCase());
    }

    function normalizeDirectionalBindings(instance, reason = 'directional-policy') {
        const bindings = Array.isArray(instance?.bindings) ? instance.bindings : [];
        let changed = 0;

        bindings.forEach(binding => {
            if (!isDirection(binding)) return;

            if (binding.gesture !== 'repeat') {
                binding.gesture = 'repeat';
                changed += 1;
            }
            if (binding.allowRepeat !== true) {
                binding.allowRepeat = true;
                changed += 1;
            }
            if (binding.longPressMs != null) {
                binding.longPressMs = null;
                changed += 1;
            }
        });

        if (changed) {
            try {
                instance.emit?.('directionalBindingsNormalized', {
                    reason,
                    actions: DIRECTIONS.slice(),
                    changes: changed
                });
            } catch (_) {}
        }

        return changed;
    }

    function nestedMoveFlag(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 3) return null;
        if (typeof value.moved === 'boolean') return value.moved;

        for (const key of ['movement', 'itemActions', 'modal', 'pageForm', 'nativeResult']) {
            const flag = nestedMoveFlag(value[key], depth + 1);
            if (typeof flag === 'boolean') return flag;
        }

        return null;
    }

    function directionalProgress(result) {
        if (!result || typeof result !== 'object') return false;

        const explicitMove = nestedMoveFlag(result);
        if (typeof explicitMove === 'boolean') return explicitMove;

        const reason = String(result.reason || '').toLowerCase();
        if (
            reason.includes('clamp') ||
            reason.includes('edge') ||
            reason.includes('no-candidate') ||
            reason.includes('no-target') ||
            reason.includes('no-movement') ||
            reason.includes('not-moved') ||
            reason.includes('repeat-blocked') ||
            reason.includes('navigation-missing') ||
            reason.includes('selection-missing')
        ) {
            return false;
        }

        return result.handled !== false;
    }

    let probe = null;
    let prototype = null;

    try {
        probe = baseApi.create({ autoSync: false, bindings: [] });
        prototype = Object.getPrototypeOf(probe);
    } catch (error) {
        console.error(LOG, 'Could not inspect GestureResolver prototype.', error);
        return;
    } finally {
        try { probe?.destroy?.(); } catch (_) {}
    }

    if (!prototype || typeof prototype.reloadBindings !== 'function' || typeof prototype.runRepeat !== 'function') {
        console.error(LOG, 'GestureResolver prototype does not expose required methods.');
        return;
    }

    if (prototype.__jellyfinQolDirectionalPolicyVersion !== VERSION) {
        const originalReloadBindings = prototype.reloadBindings;
        const originalRunRepeat = prototype.runRepeat;

        prototype.reloadBindings = function (...args) {
            originalReloadBindings.apply(this, args);
            normalizeDirectionalBindings(this, args[1] || 'reload-bindings');
            return this.getBindings();
        };

        prototype.runRepeat = function (state) {
            if (!isDirection(state?.activeBinding)) {
                return originalRunRepeat.call(this, state);
            }

            if (!state?.pressed || !state.repeatMode || !state.activeBinding) return;
            if (!state.ownedPhysical) return;

            state.repeatCount += 1;
            const timings = state.timings;
            const interval = timings.accelerationEnabled
                ? Math.max(
                    timings.minRepeatIntervalMs,
                    Math.round(
                        timings.repeatIntervalMs *
                        Math.pow(timings.accelerationFactor, Math.max(0, state.repeatCount - 1))
                    )
                )
                : timings.repeatIntervalMs;

            const dispatched = this.dispatchResolved(
                state.activeBinding,
                'repeat',
                state.input,
                'repeat',
                {
                    repeatIndex: state.repeatCount,
                    repeatIntervalMs: interval,
                    heldMs: Math.max(0, performance.now() - state.pressAt),
                    directionalNavigation: true
                }
            );

            state.downstreamHandled = state.downstreamHandled || !!dispatched.result?.handled;

            if (!directionalProgress(dispatched.result)) {
                state.repeatTimer = null;
                state.repeatStoppedAtBoundary = true;

                try {
                    this.emit?.('repeatStopped', {
                        identity: state.identity,
                        action: state.activeBinding.action,
                        reason: 'directional-boundary',
                        repeatIndex: state.repeatCount,
                        downstream: clone(dispatched.result)
                    });
                } catch (_) {}

                return;
            }

            state.repeatTimer = setTimeout(() => this.runRepeat(state), interval);
        };

        Object.defineProperty(prototype, '__jellyfinQolDirectionalPolicyVersion', {
            configurable: true,
            enumerable: false,
            writable: false,
            value: VERSION
        });
    }

    try {
        baseApi.reloadBindings?.(null, 'directional-policy-installed');
    } catch (error) {
        console.warn(LOG, 'Could not normalize the default resolver immediately.', error);
    }

    const baseCompatibilityReport = baseApi.compatibilityReport?.bind(baseApi);
    const publicApi = Object.freeze({
        ...baseApi,
        version: RESOLVER_VERSION,
        VERSION: RESOLVER_VERSION,
        compatibilityReport() {
            const report = typeof baseCompatibilityReport === 'function'
                ? baseCompatibilityReport()
                : {};

            return {
                ...report,
                version: RESOLVER_VERSION,
                directionalNavigationPolicy: {
                    active: true,
                    actions: DIRECTIONS.slice(),
                    tap: 'one-step',
                    doubleTap: 'two-independent-steps',
                    hold: 'repeat-until-release-or-boundary',
                    longGestureAllowed: false,
                    doubleGestureAllowed: false,
                    storedGestureIgnoredForDirections: true
                }
            };
        }
    });

    QoL.gestureResolverRuntime = publicApi;
    QoL.airGestureResolver = publicApi;
    QoL.directionalGesturePolicy = Object.freeze({
        version: VERSION,
        resolverVersion: RESOLVER_VERSION,
        actions: DIRECTIONS.slice(),
        semantics: Object.freeze({
            tap: 'one-step',
            doubleTap: 'two-independent-steps',
            hold: 'repeat-until-release-or-boundary'
        }),
        directionalProgress
    });

    console.log(LOG, 'Directional navigation semantics active.', publicApi.compatibilityReport());
})();
