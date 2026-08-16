(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.recordInputRuntime?.version === '1.2.0-takeover') return;

    const VERSION = '1.2.0-takeover';
    const LOG = '[JellyfinQoL.RecordInput]';
    const listeners = new Map();
    const VALID_RESOLUTIONS = new Set(['cancel', 'replace', 'keep-both']);

    let state = makeIdleState();

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function now() {
        return typeof performance?.now === 'function' ? performance.now() : Date.now();
    }

    function isTakeoverActive() {
        return !!QoL.recordInputRuntime && QoL.airKeybindRecorder === QoL.recordInputRuntime;
    }

    function makeIdleState(lastResult = null) {
        return {
            version: VERSION,
            mode: 'IDLE',
            action: null,
            profileId: null,
            adapter: null,
            startedAt: null,
            capture: null,
            binding: null,
            conflicts: [],
            lastResult: clone(lastResult),
            readOnly: false,
            captureReady: true,
            commitReady: true,
            takeoverActive: false
        };
    }

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
        if (set) {
            [...set].forEach(callback => {
                try { callback(clone(payload)); }
                catch (error) { console.error(LOG, `Listener failed for ${event}.`, error); }
            });
        }

        try {
            window.dispatchEvent(new CustomEvent(`jellyfin-qol-record-input-${event}`, {
                detail: clone(payload)
            }));
        } catch (_) {}
    }

    function getState() {
        return {
            ...clone(state),
            takeoverActive: isTakeoverActive()
        };
    }

    function getProfileRuntime() {
        return QoL.profileRuntime || null;
    }

    function getInputRegistry() {
        return QoL.airNavInput || null;
    }

    function validateCaptureDependencies(action) {
        const profileRuntime = getProfileRuntime();
        const inputRegistry = getInputRegistry();

        if (!profileRuntime) return { ok:false, reason:'profile-runtime-missing' };
        if (!inputRegistry) return { ok:false, reason:'input-registry-missing' };

        for (const method of ['getActiveProfileId', 'getActionMeta', 'makeCapturedBinding', 'analyzeConflicts']) {
            if (typeof profileRuntime[method] !== 'function') {
                return { ok:false, reason:`profile-runtime-method-missing:${method}` };
            }
        }

        for (const method of ['suspend', 'resume', 'beginAdapterCapture', 'endAdapterCapture']) {
            if (typeof inputRegistry[method] !== 'function') {
                return { ok:false, reason:`input-registry-method-missing:${method}` };
            }
        }

        const normalizedAction = String(action || '').toUpperCase();
        if (!profileRuntime.ACTION_META?.[normalizedAction]) {
            return { ok:false, reason:'unknown-action', action:normalizedAction };
        }

        return { ok:true, action:normalizedAction, profileRuntime, inputRegistry };
    }

    function validateCommitDependencies() {
        const runtime = getProfileRuntime();
        if (!runtime) return { ok:false, reason:'profile-runtime-missing' };
        if (typeof runtime.commitBinding !== 'function') {
            return { ok:false, reason:'profile-runtime-method-missing:commitBinding' };
        }
        return { ok:true, runtime };
    }

    function buildBindingFromCapture(action, capture, profileId = null) {
        const runtime = getProfileRuntime();
        if (!runtime || !capture?.adapter || !capture?.trigger) return null;

        const meta = runtime.getActionMeta(action) || {};
        const current = runtime.getBinding?.(action, profileId) || null;

        return runtime.makeCapturedBinding(action, capture, {
            profileId,
            deviceMatch: '*',
            allowRepeat: meta.allowRepeat !== false,
            gesture: current?.gesture || (meta.allowRepeat ? 'repeat' : 'single'),
            longPressMs: current?.longPressMs ?? null
        });
    }

    function releaseCapture(reason) {
        const registry = getInputRegistry();
        const adapter = state.adapter;

        if (registry && adapter) {
            try { registry.endAdapterCapture(adapter, reason); }
            catch (error) { console.warn(LOG, 'endAdapterCapture failed.', error); }
        }

        if (registry) {
            try { registry.resume(); }
            catch (error) { console.warn(LOG, 'resume failed.', error); }
        }
    }

    function finish(result, event = 'cancelled') {
        const previous = getState();
        releaseCapture(result?.reason || event);
        state = makeIdleState(result);

        emit(event, {
            previous,
            result: clone(result),
            state: getState()
        });

        return result;
    }

    function handleCaptured(capture) {
        if (state.mode !== 'CAPTURING') return;

        const binding = buildBindingFromCapture(state.action, capture, state.profileId);
        if (!binding) {
            finish({
                changed: false,
                reason: 'unsupported-capture',
                capture: clone(capture)
            }, 'captureRejected');
            return;
        }

        const conflicts = getProfileRuntime().analyzeConflicts(binding, state.profileId) || [];

        state = {
            ...state,
            mode: 'PENDING',
            capture: clone(capture),
            binding: clone(binding),
            conflicts: clone(conflicts),
            lastResult: null
        };

        emit('captured', getState());

        console.log(LOG, 'Input captured; awaiting production commit/cancel.', {
            action: state.action,
            binding: state.binding,
            conflicts: state.conflicts
        });
    }

    function start(action, options = {}) {
        if (state.mode !== 'IDLE') {
            return {
                started: false,
                reason: 'recorder-busy',
                state: getState()
            };
        }

        const dependency = validateCaptureDependencies(action);
        if (!dependency.ok) return { started:false, ...dependency };

        const adapter = String(options.adapter || 'universal');
        const profileId = String(
            options.profileId || dependency.profileRuntime.getActiveProfileId() || 'default'
        );

        if (!dependency.profileRuntime.getProfile?.(profileId)) {
            return { started:false, reason:'profile-not-found', profileId };
        }

        state = {
            ...makeIdleState(),
            mode: 'CAPTURING',
            action: dependency.action,
            profileId,
            adapter,
            startedAt: now()
        };

        dependency.inputRegistry.suspend(`production-record-input:${adapter}`);

        const result = dependency.inputRegistry.beginAdapterCapture(
            adapter,
            capture => handleCaptured(capture),
            {
                action: dependency.action,
                profileId,
                source: 'JellyfinQoL.recordInputRuntime'
            }
        );

        if (!result?.started) {
            try { dependency.inputRegistry.resume(); } catch (_) {}
            state = makeIdleState(result || { started:false, reason:'capture-start-failed' });
            return result || { started:false, reason:'capture-start-failed' };
        }

        const payload = {
            started: true,
            reason: 'capture-started',
            action: dependency.action,
            profileId,
            adapter,
            captureOnly: result.captureOnly === true
        };

        emit('captureStarted', payload);
        return payload;
    }

    function commit(options = {}) {
        if (state.mode !== 'PENDING' || !state.binding) {
            return {
                changed: false,
                reason: 'no-pending-capture',
                state: getState()
            };
        }

        const dependency = validateCommitDependencies();
        if (!dependency.ok) {
            state.lastResult = clone(dependency);
            emit('commitRejected', getState());
            return dependency;
        }

        const resolution = String(
            options.resolution || (state.conflicts.length ? 'cancel' : 'replace')
        ).toLowerCase();

        if (!VALID_RESOLUTIONS.has(resolution)) {
            const result = {
                changed: false,
                reason: 'invalid-conflict-resolution',
                resolution,
                allowed: [...VALID_RESOLUTIONS]
            };
            state.lastResult = clone(result);
            emit('commitRejected', getState());
            return result;
        }

        if (resolution === 'cancel') {
            return cancel('capture-cancelled');
        }

        const result = dependency.runtime.commitBinding(
            state.binding,
            {
                profileId: state.profileId,
                mode: options.mode || 'replace-action',
                conflictResolution: resolution,
                allowCriticalUnbound: options.allowCriticalUnbound === true
            }
        );

        // Safety/conflict failures stay pending so the user can choose another
        // resolution or cancel without losing the captured neutral descriptor.
        if (!result?.changed) {
            state.lastResult = clone(result || { changed:false, reason:'commit-failed' });
            emit('commitRejected', getState());
            return result || state.lastResult;
        }

        return finish(result, 'committed');
    }

    async function flushPersistence() {
        const runtime = getProfileRuntime();
        if (typeof runtime?.flushPersistence !== 'function') {
            return { saved:false, reason:'profile-runtime-method-missing:flushPersistence' };
        }
        return await runtime.flushPersistence();
    }

    function cancel(reason = 'cancelled') {
        if (state.mode === 'IDLE') {
            return { changed:false, reason:'recorder-idle' };
        }

        return finish({
            changed: false,
            reason,
            action: state.action,
            profileId: state.profileId,
            capture: clone(state.capture),
            binding: clone(state.binding),
            conflicts: clone(state.conflicts)
        }, 'cancelled');
    }

    function clearPending(reason = 'pending-cleared') {
        return cancel(reason);
    }

    function compatibilityReport() {
        const active = isTakeoverActive();
        const legacy = QoL.airKeybindRecorder && !active ? QoL.airKeybindRecorder : null;
        const registry = getInputRegistry();
        const runtime = getProfileRuntime();
        const captureReady =
            typeof registry?.beginAdapterCapture === 'function' &&
            typeof registry?.endAdapterCapture === 'function' &&
            typeof runtime?.makeCapturedBinding === 'function' &&
            typeof runtime?.analyzeConflicts === 'function';
        const commitReady =
            typeof runtime?.commitBinding === 'function' &&
            typeof runtime?.flushPersistence === 'function';

        return {
            version: VERSION,
            ready: captureReady && commitReady,
            readOnly: false,
            captureReady,
            commitReady,
            persistenceReady: typeof runtime?.flushPersistence === 'function',
            takeoverActive: active,
            passiveComparisonMode: !!legacy,
            legacyPresent: !!legacy,
            legacyVersion: legacy?.VERSION || legacy?.version || null,
            inputRegistryPresent: !!registry,
            profileRuntimePresent: !!runtime,
            activeProfileId: runtime?.getActiveProfileId?.() || null,
            conflictResolutions: [...VALID_RESOLUTIONS],
            state: getState()
        };
    }

    function destroy() {
        if (state.mode !== 'IDLE') cancel('recorder-destroyed');
        listeners.clear();
    }

    QoL.recordInputRuntime = Object.freeze({
        version: VERSION,
        VERSION,
        start,
        commit,
        cancel,
        clearPending,
        flushPersistence,
        getState,
        buildBindingFromCapture,
        compatibilityReport,
        on,
        off,
        destroy
    });

    QoL.recordInputCompatibility = QoL.recordInputRuntime;

    if (!QoL.airKeybindRecorder) {
        QoL.airKeybindRecorder = QoL.recordInputRuntime;
        console.log(LOG, 'Production recorder installed as JellyfinQoL.airKeybindRecorder.');
    } else if (QoL.airKeybindRecorder !== QoL.recordInputRuntime) {
        console.log(LOG, 'Prototype recorder detected; production recorder is passive until the old recorder script is disabled.');
    }

    console.log(LOG, 'Production record-input takeover runtime registered.', compatibilityReport());
})();
