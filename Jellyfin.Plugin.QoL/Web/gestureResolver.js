(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.gestureResolverRuntime?.version === '1.0.2') return;

    const VERSION = '1.0.2';
    const LOG = '[JellyfinQoL.GestureResolver]';
    const VALID_GESTURES = new Set(['single', 'double', 'long', 'repeat']);
    const DEFAULT_TIMINGS = Object.freeze({
        doublePressMs: 250,
        longPressMs: 3000,
        repeatDelayMs: 360,
        repeatIntervalMs: 115,
        accelerationEnabled: true,
        minRepeatIntervalMs: 55,
        accelerationFactor: 0.88
    });

    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return value; }
    }

    function diagnosticNodeRef(value) {
        if (!value || typeof value !== 'object') return null;

        const item = value.item || null;
        const section = value.section || null;
        const result = {};

        if (item) {
            result.item = {
                key: item.key || null,
                title: item.title || null,
                type: item.type || null
            };
        }

        if (section) {
            result.section = {
                id: section.id || null,
                key: section.key || null,
                title: section.title || null
            };
        }

        if (Number.isFinite(Number(value.score))) result.score = Number(value.score);
        if (value.key != null) result.key = String(value.key);
        if (value.title != null) result.title = String(value.title);

        return Object.keys(result).length ? result : null;
    }

    function diagnosticDetail(value) {
        if (!value || typeof value !== 'object') return value ?? null;

        const result = {};
        Object.entries(value).forEach(([key, item]) => {
            if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) {
                result[key] = item;
            }
        });

        if (Array.isArray(value.candidates)) result.candidateCount = value.candidates.length;

        for (const key of ['current', 'target', 'selected', 'item', 'section']) {
            const reference = diagnosticNodeRef(
                key === 'item' ? { item:value[key] } :
                key === 'section' ? { section:value[key] } :
                value[key]
            );
            if (reference) result[key] = reference;
        }

        return result;
    }

    // Controller results may reference the full NavigationModel and every
    // scored geometry candidate. Deep-cloning that graph on every physical
    // key made large forms pause for hundreds of milliseconds even though the
    // actual focus move had already completed. Resolver diagnostics only need
    // the outcome and compact navigation references.
    function summarizeDispatchResult(value) {
        if (value == null || typeof value !== 'object') return value ?? null;

        const result = {};
        Object.entries(value).forEach(([key, item]) => {
            if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) {
                result[key] = item;
            }
        });

        if (value.error != null) {
            result.error = String(value.error?.message || value.error);
        }

        if (value.event && typeof value.event === 'object') {
            result.event = diagnosticDetail(value.event);
        }

        for (const key of [
            'movement',
            'pageForm',
            'modal',
            'itemActions',
            'retry',
            'activation',
            'bridgeResult'
        ]) {
            if (value[key] && typeof value[key] === 'object') {
                result[key] = diagnosticDetail(value[key]);
            }
        }

        return result;
    }

    function nowMs() {
        try { return performance.now(); }
        catch (_) { return Date.now(); }
    }

    function clampNumber(value, fallback, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    }

    function normalizeModifiers(value) {
        return {
            ctrl: !!value?.ctrl,
            alt: !!value?.alt,
            shift: !!value?.shift,
            meta: !!value?.meta
        };
    }

    function normalizeGesture(value, fallback = 'single') {
        const gesture = String(value || fallback).toLowerCase();
        return VALID_GESTURES.has(gesture) ? gesture : fallback;
    }

    function normalizeTrigger(value, adapter = '') {
        if (!value || typeof value !== 'object') return null;
        const normalizedAdapter = String(adapter || '').toLowerCase();
        const type = String(value.type || (normalizedAdapter === 'keyboard' ? 'keydown' : '')).toLowerCase();
        if (!type) return null;

        const trigger = { type };

        if (normalizedAdapter === 'keyboard' || type === 'keydown' || type === 'keyup') {
            trigger.code = value.code || null;
            trigger.key = value.key || null;
            trigger.modifiers = normalizeModifiers(value.modifiers);
            return (!trigger.code && !trigger.key) ? null : trigger;
        }

        if (type === 'pointer-button' || type === 'mouse-button') {
            const button = Number(value.button);
            if (!Number.isInteger(button)) return null;
            trigger.button = button;
            trigger.pointerType = value.pointerType ? String(value.pointerType) : null;
            return trigger;
        }

        if (type === 'wheel') {
            const direction = String(value.direction || '').toLowerCase();
            if (!['up', 'down', 'left', 'right'].includes(direction)) return null;
            trigger.direction = direction;
            return trigger;
        }

        if (type === 'gamepad-button') {
            const button = Number(value.button);
            if (!Number.isInteger(button)) return null;
            trigger.button = button;
            trigger.threshold = clampNumber(value.threshold, 0.5, 0, 1);
            return trigger;
        }

        if (type === 'gamepad-axis') {
            const axis = Number(value.axis);
            const direction = String(value.direction || '').toLowerCase();
            if (!Number.isInteger(axis) || !['positive', 'negative'].includes(direction)) return null;
            const threshold = clampNumber(value.threshold, 0.65, 0.2, 0.98);
            trigger.axis = axis;
            trigger.direction = direction;
            trigger.threshold = threshold;
            trigger.releaseThreshold = Math.min(
                threshold,
                clampNumber(value.releaseThreshold, Math.min(0.45, threshold), 0.05, threshold)
            );
            return trigger;
        }

        Object.entries(value).forEach(([key, item]) => {
            if (key === 'type' || item == null) return;
            if (['string', 'number', 'boolean'].includes(typeof item)) trigger[key] = item;
        });

        return trigger;
    }

    function triggerIdentity(adapter, trigger) {
        const normalizedAdapter = String(adapter || '').toLowerCase();
        const normalized = normalizeTrigger(trigger, normalizedAdapter);
        if (!normalized) return '';

        const modifiers = normalizeModifiers(normalized.modifiers);
        const identityType = (normalizedAdapter === 'keyboard' && ['keydown', 'keyup'].includes(normalized.type))
            ? 'key'
            : normalized.type;
        const parts = [normalizedAdapter, identityType];

        if (normalizedAdapter === 'keyboard' || normalized.type === 'keydown' || normalized.type === 'keyup') {
            parts.push(normalized.code || '', normalized.key || '');
            parts.push(modifiers.ctrl ? 'C' : '-', modifiers.alt ? 'A' : '-', modifiers.shift ? 'S' : '-', modifiers.meta ? 'M' : '-');
        } else if (normalized.type === 'pointer-button' || normalized.type === 'mouse-button') {
            parts.push(String(normalized.button), normalized.pointerType || '*');
        } else if (normalized.type === 'wheel') {
            parts.push(normalized.direction || '');
        } else if (normalized.type === 'gamepad-button') {
            parts.push(String(normalized.button));
        } else if (normalized.type === 'gamepad-axis') {
            parts.push(String(normalized.axis), normalized.direction || '');
        } else {
            Object.keys(normalized).sort().forEach(key => {
                if (key === 'type' || key === 'modifiers') return;
                parts.push(`${key}:${String(normalized[key])}`);
            });
        }

        return parts.join('|');
    }

    function triggersMatch(binding, input) {
        if (!binding || !input) return false;
        const adapter = String(binding.adapter || '').toLowerCase();
        if (!adapter || adapter !== input.adapter) return false;

        const expected = normalizeTrigger(binding.trigger, adapter);
        const actual = normalizeTrigger(input.trigger, adapter);
        if (!expected || !actual) return false;

        const expectedType = expected.type || (adapter === 'keyboard' ? 'keydown' : '');
        const actualType = actual.type || (adapter === 'keyboard' ? 'keydown' : '');
        const keyboardTypes = ['keydown', 'keyup'];
        if (expectedType !== actualType && !(adapter === 'keyboard' && keyboardTypes.includes(expectedType) && keyboardTypes.includes(actualType))) return false;

        if (adapter === 'keyboard' || keyboardTypes.includes(expectedType)) {
            const em = normalizeModifiers(expected.modifiers);
            const am = normalizeModifiers(actual.modifiers);
            if (em.ctrl !== am.ctrl || em.alt !== am.alt || em.shift !== am.shift || em.meta !== am.meta) return false;
            if (expected.code && actual.code) return expected.code === actual.code;
            if (expected.code && !actual.code) return false;
            return !!(expected.key && actual.key && expected.key === actual.key);
        }

        if (expectedType === 'pointer-button' || expectedType === 'mouse-button') {
            return Number(expected.button) === Number(actual.button) &&
                (!expected.pointerType || !actual.pointerType || expected.pointerType === actual.pointerType);
        }

        if (expectedType === 'wheel') return String(expected.direction) === String(actual.direction);
        if (expectedType === 'gamepad-button') return Number(expected.button) === Number(actual.button);
        if (expectedType === 'gamepad-axis') {
            return Number(expected.axis) === Number(actual.axis) && String(expected.direction) === String(actual.direction);
        }

        return triggerIdentity(adapter, expected) === triggerIdentity(adapter, actual);
    }

    function normalizeBinding(value, index = 0, profileId = null) {
        if (!value?.action || !value?.adapter || !value?.trigger) return null;
        const action = String(value.action).toUpperCase();
        const adapter = String(value.adapter).toLowerCase();
        const trigger = normalizeTrigger(value.trigger, adapter);
        if (!trigger) return null;

        const meta = QoL.profileRuntime?.getActionMeta?.(action) || {};
        const fallbackGesture = meta.allowRepeat ? 'repeat' : 'single';
        const gesture = normalizeGesture(value.gesture, fallbackGesture);

        return {
            id: value.id || `gesture:${profileId || 'default'}:${action.toLowerCase()}:${adapter}:${index}`,
            action,
            adapter,
            deviceMatch: value.deviceMatch || '*',
            trigger,
            gesture,
            longPressMs: value.longPressMs == null ? null : Number(value.longPressMs),
            allowRepeat: typeof value.allowRepeat === 'boolean' ? value.allowRepeat : meta.allowRepeat !== false,
            profileId: value.profileId || profileId || null,
            global: value.global === true || meta.global === true,
            textHandoff: value.textHandoff === true || meta.textHandoff === true
        };
    }

    function makeInputTrigger(adapter, event) {
        if (event?.trigger) return normalizeTrigger(event.trigger, adapter);
        const raw = event?.raw || {};

        if (adapter === 'keyboard') {
            return normalizeTrigger({
                type: 'keydown',
                code: raw.code || null,
                key: raw.key || null,
                modifiers: raw.modifiers || {
                    ctrl: !!raw.ctrlKey,
                    alt: !!raw.altKey,
                    shift: !!raw.shiftKey,
                    meta: !!raw.metaKey
                }
            }, adapter);
        }

        if (adapter === 'pointer' || adapter === 'mouse') {
            return normalizeTrigger({
                type: 'pointer-button',
                button: raw.button,
                pointerType: raw.pointerType || null
            }, adapter);
        }

        if (adapter === 'wheel') {
            return normalizeTrigger({ type: 'wheel', direction: raw.direction }, adapter);
        }

        if (adapter === 'gamepad') {
            if (raw.button != null) {
                return normalizeTrigger({ type: 'gamepad-button', button: raw.button, threshold: raw.threshold }, adapter);
            }
            if (raw.axis != null) {
                return normalizeTrigger({
                    type: 'gamepad-axis',
                    axis: raw.axis,
                    direction: raw.direction,
                    threshold: raw.threshold,
                    releaseThreshold: raw.releaseThreshold
                }, adapter);
            }
        }

        return null;
    }

    function normalizeInputEvent(event) {
        if (!event || typeof event !== 'object') return null;
        const adapter = String(event.adapter || event.source || '').toLowerCase();
        if (!adapter) return null;
        const phase = String(event.phase || 'press').toLowerCase();
        if (!['press', 'release', 'repeat', 'pulse'].includes(phase)) return null;
        const trigger = makeInputTrigger(adapter, event);
        if (!trigger) return null;

        const raw = { ...(event.raw || {}) };
        const context = {
            textEntryActive: event.context?.textEntryActive ?? raw.textEntryActive ?? false,
            searchEntryActive: event.context?.searchEntryActive ?? raw.searchEntryActive ?? false,
            nativeNavigationRisk: event.context?.nativeNavigationRisk ?? raw.nativeNavigationRisk ?? null
        };

        return {
            adapter,
            source: String(event.source || adapter),
            deviceId: String(event.deviceId || raw.deviceId || `${adapter}:default`),
            deviceMatch: event.deviceMatch || raw.deviceMatch || '*',
            phase,
            trigger,
            raw,
            context,
            timestamp: Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : nowMs()
        };
    }

    function bindingDeviceMatches(binding, input) {
        const scope = String(binding?.deviceMatch || '*');
        if (scope === '*') return true;
        const candidates = new Set([
            String(input?.deviceId || ''),
            String(input?.deviceMatch || ''),
            String(input?.raw?.gamepadId || ''),
            String(input?.raw?.deviceLabel || '')
        ].filter(Boolean));
        return candidates.has(scope);
    }

    function bindingEligibleForContext(binding, input) {
        if (!input?.context?.textEntryActive) return true;
        if (binding.global === true) return true;
        return binding.textHandoff === true && input.context.searchEntryActive === true;
    }

    class GestureResolver {
        constructor(options = {}) {
            this.options = options || {};
            this.dispatch = null;
            this.started = false;
            this.profileId = options.profileId || null;
            this.staticBindings = Array.isArray(options.bindings) ? options.bindings.map(clone) : null;
            this.timingOverrides = { ...(options.timings || {}) };
            this.activePresses = new Map();
            this.pendingTaps = new Map();
            this.listeners = new Map();
            this.bindings = [];
            this.lastInput = null;
            this.lastResolved = null;
            this.lastError = null;
            this.syncUnsubscribers = [];
            this.reloadBindings(this.profileId, 'constructor');
        }

        on(event, callback) {
            if (typeof callback !== 'function') return () => {};
            if (!this.listeners.has(event)) this.listeners.set(event, new Set());
            this.listeners.get(event).add(callback);
            return () => this.off(event, callback);
        }

        off(event, callback) {
            const set = this.listeners.get(event);
            if (!set) return;
            set.delete(callback);
            if (!set.size) this.listeners.delete(event);
        }

        emit(event, payload) {
            const set = this.listeners.get(event);
            if (set) {
                [...set].forEach(callback => {
                    try { callback(clone(payload)); }
                    catch (error) { console.error(LOG, `Listener failed for ${event}.`, error); }
                });
            }
        }

        getActiveProfileId() {
            return String(
                this.profileId ||
                QoL.profileRuntime?.getActiveProfileId?.() ||
                QoL.runtimeConfig?.activeProfileId ||
                'default'
            );
        }

        getTimings() {
            const source = {
                ...DEFAULT_TIMINGS,
                ...(QoL.runtimeConfig?.gestures || {}),
                ...this.timingOverrides
            };

            return {
                doublePressMs: clampNumber(source.doublePressMs, DEFAULT_TIMINGS.doublePressMs, 100, 1000),
                longPressMs: clampNumber(source.longPressMs, DEFAULT_TIMINGS.longPressMs, 300, 10000),
                repeatDelayMs: clampNumber(source.repeatDelayMs, DEFAULT_TIMINGS.repeatDelayMs, 100, 2000),
                repeatIntervalMs: clampNumber(source.repeatIntervalMs, DEFAULT_TIMINGS.repeatIntervalMs, 25, 1000),
                accelerationEnabled: source.accelerationEnabled !== false,
                minRepeatIntervalMs: clampNumber(source.minRepeatIntervalMs, DEFAULT_TIMINGS.minRepeatIntervalMs, 20, 500),
                accelerationFactor: clampNumber(source.accelerationFactor, DEFAULT_TIMINGS.accelerationFactor, 0.5, 0.99)
            };
        }

        configure(options = {}) {
            if (options.profileId !== undefined) this.profileId = options.profileId || null;
            if (Array.isArray(options.bindings)) this.staticBindings = options.bindings.map(clone);
            if (options.useRuntimeBindings === true) this.staticBindings = null;
            if (options.timings && typeof options.timings === 'object') {
                this.timingOverrides = { ...this.timingOverrides, ...options.timings };
            }
            this.cancelAll('configure');
            this.reloadBindings(this.profileId, 'configure');
            return this.getState();
        }

        reloadBindings(profileId = null, reason = 'manual') {
            if (profileId != null) this.profileId = String(profileId);
            const resolvedProfileId = this.getActiveProfileId();
            let source = this.staticBindings;

            if (!Array.isArray(source)) {
                try { source = QoL.profileRuntime?.getBindings?.(resolvedProfileId) || []; }
                catch (error) {
                    this.lastError = error;
                    source = [];
                }
            }

            this.bindings = (Array.isArray(source) ? source : [])
                .map((binding, index) => normalizeBinding(binding, index, resolvedProfileId))
                .filter(Boolean);

            this.emit('bindingsReloaded', {
                reason,
                profileId: resolvedProfileId,
                count: this.bindings.length
            });

            return this.getBindings();
        }

        getBindings() {
            return this.bindings.map(clone);
        }

        setDispatcher(dispatcher) {
            this.dispatch = typeof dispatcher === 'function' ? dispatcher : null;
            return typeof this.dispatch === 'function';
        }

        start(dispatcher, options = {}) {
            if (typeof dispatcher === 'function') this.dispatch = dispatcher;
            if (typeof this.dispatch !== 'function') {
                return { started: false, reason: 'dispatcher-required' };
            }
            if (options.profileId != null) this.profileId = String(options.profileId);
            if (options.timings) this.timingOverrides = { ...this.timingOverrides, ...options.timings };
            if (options.reloadBindings !== false) this.reloadBindings(this.profileId, 'start');
            this.started = true;
            this.attachRuntimeSync();
            this.emit('started', this.getState());
            return this.getState();
        }

        stop(options = {}) {
            if (options.flushPendingSingles === true) this.flushPendingSingles('stop');
            else this.cancelAll('stop');
            this.started = false;
            this.dispatch = null;
            this.detachRuntimeSync();
            this.emit('stopped', this.getState());
            return this.getState();
        }

        destroy() {
            this.stop();
            this.listeners.clear();
            this.bindings = [];
            this.staticBindings = null;
        }

        attachRuntimeSync() {
            if (this.syncUnsubscribers.length || this.options.autoSync === false) return;

            const handleRuntime = () => {
                if (this.staticBindings) return;
                this.cancelAll('runtime-settings-changed');
                this.profileId = null;
                this.reloadBindings(null, 'runtime-settings-changed');
            };

            window.addEventListener('jellyfin-qol-runtime-settings-changed', handleRuntime);
            this.syncUnsubscribers.push(() => window.removeEventListener('jellyfin-qol-runtime-settings-changed', handleRuntime));

            const profileRuntime = QoL.profileRuntime;
            if (profileRuntime?.on) {
                for (const event of ['changed', 'bindingsChanged', 'bindingCommitted', 'bindingRemoved', 'profileChanged', 'profileReset']) {
                    const unsubscribe = profileRuntime.on(event, () => {
                        if (this.staticBindings) return;
                        this.cancelAll(`profile-${event}`);
                        if (event === 'profileChanged') this.profileId = null;
                        this.reloadBindings(null, `profile-${event}`);
                    });
                    if (typeof unsubscribe === 'function') this.syncUnsubscribers.push(unsubscribe);
                }
            }
        }

        detachRuntimeSync() {
            this.syncUnsubscribers.splice(0).forEach(unsubscribe => {
                try { unsubscribe(); } catch (_) {}
            });
        }

        getMatchingBindings(input) {
            const physicalMatches = this.bindings.filter(binding =>
                bindingDeviceMatches(binding, input) && triggersMatch(binding, input)
            );
            const eligible = physicalMatches.filter(binding => bindingEligibleForContext(binding, input));
            return {
                physicalMatches,
                eligible,
                contextBlocked: physicalMatches.length > 0 && eligible.length === 0
            };
        }

        inspectInput(event) {
            const input = normalizeInputEvent(event);
            if (!input) return { valid: false, reason: 'invalid-input-event' };
            const matches = this.getMatchingBindings(input);
            return {
                valid: true,
                input: clone(input),
                identity: this.makeIdentity(input),
                physicalMatches: matches.physicalMatches.map(clone),
                eligibleBindings: matches.eligible.map(clone),
                contextBlocked: matches.contextBlocked,
                gestures: this.groupBindings(matches.eligible)
            };
        }

        makeIdentity(input) {
            return `${input.deviceId}::${triggerIdentity(input.adapter, input.trigger)}`;
        }

        groupBindings(bindings) {
            const groups = { single: [], double: [], long: [], repeat: [] };
            bindings.forEach(binding => {
                const gesture = normalizeGesture(binding.gesture, 'single');
                groups[gesture].push(binding);
            });
            return groups;
        }

        chooseBinding(bindings, gesture, identity) {
            if (!bindings?.length) return null;
            if (bindings.length > 1) {
                this.emit('ambiguousBinding', {
                    identity,
                    gesture,
                    bindings: bindings.map(clone),
                    selected: clone(bindings[0])
                });
            }
            return bindings[0];
        }

        makeResolvedEnvelope(binding, phase, input, gesture, extra = {}) {
            const meta = QoL.profileRuntime?.getActionMeta?.(binding.action) || {};
            const raw = {
                ...(input.raw || {}),
                allowRepeat: binding.allowRepeat !== false,
                bindingId: binding.id,
                gesture,
                profileId: binding.profileId || this.getActiveProfileId(),
                global: binding.global === true || meta.global === true,
                textHandoff: binding.textHandoff === true || meta.textHandoff === true,
                textEntryActive: !!input.context?.textEntryActive,
                searchEntryActive: !!input.context?.searchEntryActive,
                nativeNavigationRisk: input.context?.nativeNavigationRisk ?? input.raw?.nativeNavigationRisk ?? null,
                physicalTrigger: clone(input.trigger),
                ...extra
            };

            return {
                action: binding.action,
                phase,
                source: input.source || input.adapter,
                deviceId: input.deviceId,
                raw,
                timestamp: nowMs()
            };
        }

        dispatchResolved(binding, phase, input, gesture, extra = {}) {
            const envelope = this.makeResolvedEnvelope(binding, phase, input, gesture, extra);
            let result = { handled: false, reason: 'resolver-dispatcher-unavailable' };

            if (typeof this.dispatch === 'function') {
                try {
                    result = this.dispatch(envelope) || { handled: false, reason: 'dispatcher-returned-nothing' };
                } catch (error) {
                    this.lastError = error;
                    console.error(LOG, 'Resolved action dispatcher failed.', error);
                    result = { handled: false, reason: 'dispatcher-threw', error: String(error?.message || error) };
                }
            }

            this.lastResolved = {
                envelope: clone(envelope),
                result: summarizeDispatchResult(result)
            };
            this.emit('resolved', this.lastResolved);
            return { envelope, result };
        }

        scheduleLong(state, binding) {
            if (!binding) return;
            const timings = state.timings;
            const threshold = clampNumber(binding.longPressMs, timings.longPressMs, 300, 10000);
            state.longTimer = setTimeout(() => {
                if (!state.pressed || state.doubleFired || state.repeatMode) return;
                state.longFired = true;
                state.ownedPhysical = true;
                state.activeBinding = binding;
                const dispatched = this.dispatchResolved(binding, 'press', state.input, 'long', {
                    longPressMs: threshold,
                    heldMs: Math.max(0, nowMs() - state.pressAt)
                });
                state.downstreamHandled = !!dispatched.result?.handled;
                this.emit('longPress', {
                    identity: state.identity,
                    binding: clone(binding),
                    threshold,
                    downstreamHandled: state.downstreamHandled
                });
            }, threshold);
        }

        scheduleRepeat(state, binding) {
            if (!binding || binding.allowRepeat === false) return;
            const timings = state.timings;
            state.repeatTimer = setTimeout(() => this.runRepeat(state), timings.repeatDelayMs);
        }

        runRepeat(state) {
            if (!state.pressed || !state.repeatMode || !state.activeBinding) return;
            if (!state.ownedPhysical) return;

            state.repeatCount += 1;
            const timings = state.timings;
            const interval = timings.accelerationEnabled
                ? Math.max(
                    timings.minRepeatIntervalMs,
                    Math.round(timings.repeatIntervalMs * Math.pow(timings.accelerationFactor, Math.max(0, state.repeatCount - 1)))
                )
                : timings.repeatIntervalMs;

            const dispatched = this.dispatchResolved(state.activeBinding, 'repeat', state.input, 'repeat', {
                repeatIndex: state.repeatCount,
                repeatIntervalMs: interval,
                heldMs: Math.max(0, nowMs() - state.pressAt)
            });
            state.downstreamHandled = state.downstreamHandled || !!dispatched.result?.handled;
            state.repeatTimer = setTimeout(() => this.runRepeat(state), interval);
        }

        handlePress(input, identity, groups) {
            const existing = this.activePresses.get(identity);
            if (existing?.pressed) {
                return {
                    handled: !!existing.ownedPhysical,
                    // A mapped physical input is not automatically owned. If
                    // Controller yielded to the active native surface (for
                    // example the player while F6 is off), every keyboard
                    // phase must remain available to Jellyfin.
                    claimed: !!existing.ownedPhysical,
                    reason: input.raw?.repeat ? 'native-repeat-suppressed' : 'duplicate-press-suppressed',
                    identity
                };
            }

            const repeatBinding = this.chooseBinding(groups.repeat, 'repeat', identity);
            const singleBinding = this.chooseBinding(groups.single, 'single', identity);
            const doubleBinding = this.chooseBinding(groups.double, 'double', identity);
            const longBinding = this.chooseBinding(groups.long, 'long', identity);
            const timings = this.getTimings();
            const pending = this.pendingTaps.get(identity) || null;

            const state = {
                identity,
                input,
                pressed: true,
                pressAt: input.timestamp || nowMs(),
                timings,
                groups,
                activeBinding: null,
                longTimer: null,
                repeatTimer: null,
                repeatCount: 0,
                repeatMode: !!repeatBinding,
                longFired: false,
                doubleFired: false,
                immediateSingleFired: false,
                ownedPhysical: false,
                downstreamHandled: false
            };

            this.activePresses.set(identity, state);

            if (repeatBinding) {
                state.activeBinding = repeatBinding;
                const dispatched = this.dispatchResolved(repeatBinding, 'press', input, 'repeat', {
                    repeatIndex: 0,
                    repeatDelayMs: timings.repeatDelayMs
                });
                state.downstreamHandled = !!dispatched.result?.handled;
                state.ownedPhysical = state.downstreamHandled;
                if (state.ownedPhysical) this.scheduleRepeat(state, repeatBinding);
                return {
                    handled: state.ownedPhysical,
                    claimed: state.ownedPhysical,
                    reason: state.ownedPhysical ? 'repeat-press-dispatched' : 'repeat-press-unhandled',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (pending && doubleBinding && input.timestamp - pending.releasedAt <= timings.doublePressMs) {
                clearTimeout(pending.timer);
                this.pendingTaps.delete(identity);
                state.doubleFired = true;
                state.ownedPhysical = true;
                state.activeBinding = doubleBinding;
                const dispatched = this.dispatchResolved(doubleBinding, 'press', input, 'double', {
                    doublePressMs: timings.doublePressMs,
                    gapMs: Math.max(0, input.timestamp - pending.releasedAt)
                });
                state.downstreamHandled = !!dispatched.result?.handled;
                return {
                    handled: true,
                    claimed: true,
                    reason: 'double-press-resolved',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (longBinding) this.scheduleLong(state, longBinding);

            if (singleBinding && !doubleBinding && !longBinding) {
                state.immediateSingleFired = true;
                state.activeBinding = singleBinding;
                const dispatched = this.dispatchResolved(singleBinding, 'press', input, 'single');
                state.downstreamHandled = !!dispatched.result?.handled;
                state.ownedPhysical = state.downstreamHandled;
                return {
                    handled: state.ownedPhysical,
                    claimed: state.ownedPhysical,
                    reason: state.ownedPhysical ? 'single-press-dispatched' : 'single-press-unhandled',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            return {
                handled: true,
                claimed: true,
                reason: doubleBinding ? 'gesture-pending-double' : (longBinding ? 'gesture-pending-long' : 'gesture-pending'),
                identity
            };
        }

        handleRelease(input, identity) {
            const state = this.activePresses.get(identity);
            if (!state) {
                return { handled: false, claimed: false, reason: 'release-without-active-press', identity };
            }

            state.pressed = false;
            if (state.longTimer) clearTimeout(state.longTimer);
            if (state.repeatTimer) clearTimeout(state.repeatTimer);
            state.longTimer = null;
            state.repeatTimer = null;
            this.activePresses.delete(identity);

            const groups = state.groups;
            const singleBinding = this.chooseBinding(groups.single, 'single', identity);
            const doubleBinding = this.chooseBinding(groups.double, 'double', identity);
            const longBinding = this.chooseBinding(groups.long, 'long', identity);

            if (state.repeatMode && state.activeBinding) {
                const dispatched = this.dispatchResolved(state.activeBinding, 'release', input, 'repeat', {
                    repeatIndex: state.repeatCount,
                    heldMs: Math.max(0, input.timestamp - state.pressAt)
                });
                return {
                    handled: !!state.ownedPhysical,
                    claimed: !!state.ownedPhysical,
                    reason: 'repeat-release',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (state.doubleFired && state.activeBinding) {
                const dispatched = this.dispatchResolved(state.activeBinding, 'release', input, 'double');
                return {
                    handled: true,
                    claimed: true,
                    reason: 'double-release',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (state.longFired && state.activeBinding) {
                const dispatched = this.dispatchResolved(state.activeBinding, 'release', input, 'long', {
                    heldMs: Math.max(0, input.timestamp - state.pressAt),
                    longPressMs: clampNumber(longBinding?.longPressMs, state.timings.longPressMs, 300, 10000)
                });
                return {
                    handled: true,
                    claimed: true,
                    reason: 'long-release',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (state.immediateSingleFired && state.activeBinding) {
                const dispatched = this.dispatchResolved(state.activeBinding, 'release', input, 'single');
                return {
                    handled: !!state.ownedPhysical,
                    claimed: !!state.ownedPhysical,
                    reason: 'single-release',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            if (doubleBinding) {
                const releasedAt = input.timestamp || nowMs();
                const pending = {
                    identity,
                    releasedAt,
                    input: clone(input),
                    singleBinding: singleBinding ? clone(singleBinding) : null,
                    timer: null
                };

                pending.timer = setTimeout(() => {
                    const current = this.pendingTaps.get(identity);
                    if (current !== pending) return;
                    this.pendingTaps.delete(identity);
                    if (!pending.singleBinding) {
                        this.emit('doubleWindowExpired', { identity, singleDispatched: false });
                        return;
                    }
                    const dispatched = this.dispatchResolved(pending.singleBinding, 'press', pending.input, 'single', {
                        deferredByDoubleMs: state.timings.doublePressMs
                    });
                    this.dispatchResolved(pending.singleBinding, 'release', pending.input, 'single', {
                        deferredByDoubleMs: state.timings.doublePressMs
                    });
                    this.emit('doubleWindowExpired', {
                        identity,
                        singleDispatched: true,
                        downstreamHandled: !!dispatched.result?.handled
                    });
                }, state.timings.doublePressMs);

                this.pendingTaps.set(identity, pending);
                return {
                    handled: true,
                    claimed: true,
                    reason: 'double-window-open',
                    identity,
                    doublePressMs: state.timings.doublePressMs
                };
            }

            if (longBinding && singleBinding) {
                const dispatched = this.dispatchResolved(singleBinding, 'press', input, 'single', {
                    deferredByLong: true,
                    heldMs: Math.max(0, input.timestamp - state.pressAt)
                });
                this.dispatchResolved(singleBinding, 'release', input, 'single', {
                    deferredByLong: true,
                    heldMs: Math.max(0, input.timestamp - state.pressAt)
                });
                return {
                    handled: true,
                    claimed: true,
                    reason: 'single-resolved-after-short-hold',
                    identity,
                    downstream: summarizeDispatchResult(dispatched.result)
                };
            }

            return {
                handled: true,
                claimed: true,
                reason: longBinding ? 'short-hold-no-single-binding' : 'gesture-release-no-action',
                identity
            };
        }

        ingest(event) {
            const input = normalizeInputEvent(event);
            if (!input) return { handled: false, claimed: false, reason: 'invalid-input-event' };
            this.lastInput = clone(input);

            if (!this.started) {
                return { handled: false, claimed: false, reason: 'resolver-not-started' };
            }

            const matches = this.getMatchingBindings(input);
            if (!matches.physicalMatches.length) {
                return { handled: false, claimed: false, reason: 'no-binding' };
            }
            if (!matches.eligible.length) {
                return {
                    handled: false,
                    claimed: false,
                    reason: 'context-owned-by-text-entry',
                    physicalMatches: matches.physicalMatches.length
                };
            }

            const identity = this.makeIdentity(input);
            const groups = this.groupBindings(matches.eligible);

            if (input.phase === 'repeat') {
                const active = this.activePresses.get(identity);
                return {
                    handled: !!active?.ownedPhysical,
                    claimed: !!active?.ownedPhysical,
                    reason: 'native-repeat-suppressed',
                    identity
                };
            }

            if (input.phase === 'pulse') {
                const pressed = this.handlePress({ ...input, phase: 'press' }, identity, groups);
                const released = this.handleRelease({ ...input, phase: 'release', timestamp: input.timestamp + 0.01 }, identity);
                return {
                    handled: !!(pressed.handled || released.handled),
                    claimed: !!(pressed.claimed || released.claimed),
                    reason: 'pulse-resolved',
                    identity,
                    press: pressed,
                    release: released
                };
            }

            if (input.phase === 'press') return this.handlePress(input, identity, groups);
            return this.handleRelease(input, identity);
        }

        flushPendingSingles(reason = 'manual') {
            const flushed = [];
            for (const [identity, pending] of [...this.pendingTaps.entries()]) {
                clearTimeout(pending.timer);
                this.pendingTaps.delete(identity);
                if (!pending.singleBinding) continue;
                const pressed = this.dispatchResolved(pending.singleBinding, 'press', pending.input, 'single', {
                    flushed: true,
                    flushReason: reason
                });
                this.dispatchResolved(pending.singleBinding, 'release', pending.input, 'single', {
                    flushed: true,
                    flushReason: reason
                });
                flushed.push({
                    identity,
                    binding: clone(pending.singleBinding),
                    downstream: summarizeDispatchResult(pressed.result)
                });
            }
            return { flushed: flushed.length, items: flushed };
        }

        cancelAll(reason = 'manual') {
            for (const state of this.activePresses.values()) {
                if (state.longTimer) clearTimeout(state.longTimer);
                if (state.repeatTimer) clearTimeout(state.repeatTimer);
            }
            for (const pending of this.pendingTaps.values()) {
                if (pending.timer) clearTimeout(pending.timer);
            }
            const result = {
                reason,
                activePresses: this.activePresses.size,
                pendingTaps: this.pendingTaps.size
            };
            this.activePresses.clear();
            this.pendingTaps.clear();
            this.emit('cancelled', result);
            return result;
        }

        getState() {
            return {
                version: VERSION,
                started: this.started,
                profileId: this.getActiveProfileId(),
                bindingCount: this.bindings.length,
                activePressCount: this.activePresses.size,
                pendingTapCount: this.pendingTaps.size,
                hasDispatcher: typeof this.dispatch === 'function',
                timings: this.getTimings(),
                staticBindings: Array.isArray(this.staticBindings),
                lastInput: clone(this.lastInput),
                lastResolved: clone(this.lastResolved),
                lastError: this.lastError ? String(this.lastError?.message || this.lastError) : null
            };
        }

        compatibilityReport() {
            const state = this.getState();
            const byGesture = { single: 0, double: 0, long: 0, repeat: 0 };
            const physicalGroups = new Map();
            this.bindings.forEach(binding => {
                byGesture[binding.gesture] = (byGesture[binding.gesture] || 0) + 1;
                const key = `${binding.deviceMatch || '*'}::${triggerIdentity(binding.adapter, binding.trigger)}`;
                if (!physicalGroups.has(key)) physicalGroups.set(key, []);
                physicalGroups.get(key).push(binding);
            });

            const mixedRepeatTriggers = [];
            for (const [identity, bindings] of physicalGroups.entries()) {
                const gestures = new Set(bindings.map(binding => binding.gesture));
                if (gestures.has('repeat') && gestures.size > 1) {
                    mixedRepeatTriggers.push({ identity, bindings: bindings.map(clone) });
                }
            }

            return {
                version: VERSION,
                ready: true,
                fullGestureSet: true,
                integrationActive: false,
                universalInputMigrationRequired: true,
                profileRuntimePresent: !!QoL.profileRuntime,
                profileRuntimeVersion: QoL.profileRuntime?.version || null,
                activeProfileId: state.profileId,
                bindingCount: state.bindingCount,
                bindingsByGesture: byGesture,
                timings: state.timings,
                capabilities: {
                    single: true,
                    double: true,
                    long: true,
                    repeat: true,
                    acceleration: true,
                    perBindingLongPressMs: true,
                    textEntryOwnership: true,
                    deviceScopedBindings: true,
                    pendingSingleFlush: true
                },
                mixedRepeatTriggers,
                state
            };
        }
    }

    const defaultResolver = new GestureResolver({ autoSync: true });

    const api = Object.freeze({
        version: VERSION,
        VERSION,
        DEFAULT_TIMINGS,
        create: options => new GestureResolver(options),
        normalizeInputEvent,
        normalizeTrigger,
        triggerIdentity,
        inspectInput: event => defaultResolver.inspectInput(event),
        configure: options => defaultResolver.configure(options),
        reloadBindings: (profileId = null, reason = 'manual') => defaultResolver.reloadBindings(profileId, reason),
        getBindings: () => defaultResolver.getBindings(),
        getTimings: () => defaultResolver.getTimings(),
        setDispatcher: dispatcher => defaultResolver.setDispatcher(dispatcher),
        start: (dispatcher, options = {}) => defaultResolver.start(dispatcher, options),
        stop: options => defaultResolver.stop(options),
        ingest: event => defaultResolver.ingest(event),
        flushPendingSingles: reason => defaultResolver.flushPendingSingles(reason),
        cancelAll: reason => defaultResolver.cancelAll(reason),
        getState: () => defaultResolver.getState(),
        compatibilityReport: () => defaultResolver.compatibilityReport(),
        on: (event, callback) => defaultResolver.on(event, callback),
        off: (event, callback) => defaultResolver.off(event, callback),
        destroy: () => defaultResolver.destroy()
    });

    QoL.gestureResolverRuntime = api;
    QoL.airGestureResolver = api;

    const hydrateDefaultResolver = () => {
        try { defaultResolver.reloadBindings(null, 'client-ready'); }
        catch (error) { console.warn(LOG, 'Could not hydrate production bindings after client bootstrap.', error); }
    };

    if (QoL.clientReady) setTimeout(hydrateDefaultResolver, 0);
    else window.addEventListener('jellyfin-qol-client-ready', hydrateDefaultResolver, { once:true });

    console.log(LOG, 'Production gesture resolver registered.', api.compatibilityReport());
})();
