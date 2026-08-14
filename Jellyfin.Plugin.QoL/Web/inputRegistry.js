(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.inputRegistryRuntime?.version === '1.0.0-passive') return;

    const VERSION = '1.0.0-passive';
    const LOG = '[JellyfinQoL.InputRegistry]';

    const factories = new Map();
    const instances = new Map();
    const captureInstances = new Map();
    const listeners = new Map();

    let dispatcher = null;
    let suspended = false;
    let suspendReason = null;

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
            try { callback(payload); }
            catch (error) { console.error(LOG, `Listener failed for ${event}.`, error); }
        });
    }

    function isDebugEnabled() {
        const settings = QoL.settings || {};
        const config = QoL.runtimeConfig || {};
        return !!(
            settings.DEBUG ||
            settings.airNav?.debug ||
            settings.airNav?.input?.debug ||
            config.debug?.enabled ||
            config.input?.debug
        );
    }

    function log(...args) {
        if (isDebugEnabled()) console.log(LOG, ...args);
    }

    function activeProfileId() {
        return (
            QoL.profileRuntime?.getActiveProfileId?.() ||
            QoL.airKeybinds?.getActiveProfileId?.() ||
            QoL.runtimeConfig?.activeProfileId ||
            QoL.settings?.airNav?.input?.activeProfileId ||
            'default'
        );
    }

    function registerAdapter(name, adapterFactory) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName || typeof adapterFactory !== 'function') {
            throw new Error(`${LOG} registerAdapter(name, factory) requires a name and factory function.`);
        }

        if (instances.has(normalizedName)) disableAdapter(normalizedName);
        if (captureInstances.has(normalizedName)) endAdapterCapture(normalizedName, 'adapter-reregistered');

        factories.set(normalizedName, adapterFactory);
        emit('adapterRegistered', { name: normalizedName });
        log(`adapter registered: ${normalizedName}`);
        return true;
    }

    function unregisterAdapter(name) {
        const normalizedName = String(name || '').trim();
        disableAdapter(normalizedName);
        endAdapterCapture(normalizedName, 'adapter-unregistered');
        const existed = factories.delete(normalizedName);
        if (existed) emit('adapterUnregistered', { name: normalizedName });
        return existed;
    }

    function syncKnownAdapters() {
        const results = {};

        if (!factories.has('universal') && typeof QoL.airNavUniversalInput?.create === 'function') {
            registerAdapter('universal', options => QoL.airNavUniversalInput.create(options));
            results.universal = 'registered-from-airNavUniversalInput';
        } else if (factories.has('universal')) {
            results.universal = 'already-registered';
        } else {
            results.universal = 'factory-not-present';
        }

        return results;
    }

    function setDispatcher(nextDispatcher) {
        dispatcher = typeof nextDispatcher === 'function' ? nextDispatcher : null;
        emit('dispatcherChanged', { hasDispatcher: typeof dispatcher === 'function' });
    }

    function dispatchFromAdapter(actionEvent) {
        if (suspended) {
            return {
                handled: false,
                reason: `input-suspended${suspendReason ? `:${suspendReason}` : ''}`
            };
        }

        if (typeof dispatcher !== 'function') {
            return { handled: false, reason: 'no-controller-dispatcher' };
        }

        emit('input', actionEvent);

        let result;
        try {
            result = dispatcher(actionEvent) || {
                handled: false,
                reason: 'dispatcher-returned-nothing'
            };
        } catch (error) {
            console.error(LOG, 'Controller dispatcher failed.', error);
            result = {
                handled: false,
                reason: 'dispatcher-threw',
                error
            };
        }

        if (isDebugEnabled()) {
            const raw = actionEvent?.raw || {};
            log(
                `${actionEvent?.source || '?'} ${raw.code || raw.key || ''} -> ` +
                `${actionEvent?.action || '?'} phase=${actionEvent?.phase || '?'} ` +
                `handled=${!!result.handled} reason=${result.reason || ''}`
            );
        }

        emit('dispatch', { event: actionEvent, result });
        return result;
    }

    function enableAdapter(name, options = {}) {
        const normalizedName = String(name || '').trim();
        if (instances.has(normalizedName)) return instances.get(normalizedName);

        if (!factories.has(normalizedName)) syncKnownAdapters();
        const factory = factories.get(normalizedName);
        if (!factory) {
            console.error(`${LOG} adapter not registered: ${normalizedName}`);
            return null;
        }

        let adapter;
        try {
            adapter = factory(options);
        } catch (error) {
            console.error(`${LOG} failed to create adapter ${normalizedName}.`, error);
            return null;
        }

        if (!adapter || typeof adapter.start !== 'function') {
            console.error(`${LOG} adapter ${normalizedName} does not implement start(dispatch).`);
            return null;
        }

        try {
            adapter.start(dispatchFromAdapter);
        } catch (error) {
            console.error(`${LOG} failed to start adapter ${normalizedName}.`, error);
            try { adapter.stop?.(); } catch (_) {}
            return null;
        }

        instances.set(normalizedName, adapter);
        emit('adapterEnabled', {
            name: normalizedName,
            device: adapter.getDeviceInfo?.() || null
        });
        log(`adapter enabled: ${normalizedName}`);
        return adapter;
    }

    function disableAdapter(name) {
        const normalizedName = String(name || '').trim();
        const adapter = instances.get(normalizedName);
        if (!adapter) return false;

        try { adapter.stop?.(); }
        catch (error) { console.warn(`${LOG} adapter stop failed: ${normalizedName}.`, error); }

        instances.delete(normalizedName);
        emit('adapterDisabled', { name: normalizedName });
        log(`adapter disabled: ${normalizedName}`);
        return true;
    }

    function disableAll() {
        [...instances.keys()].forEach(disableAdapter);
        [...captureInstances.keys()].forEach(name => endAdapterCapture(name, 'disable-all'));
    }

    function reloadBindings(profileId = null) {
        const resolvedProfileId = String(profileId || activeProfileId());
        const results = {};

        for (const [name, adapter] of instances.entries()) {
            try {
                results[name] = typeof adapter.reloadBindings === 'function'
                    ? adapter.reloadBindings(resolvedProfileId)
                    : false;
            } catch (error) {
                results[name] = false;
                console.error(`${LOG} reloadBindings failed for ${name}.`, error);
            }
        }

        emit('bindingsReloaded', { profileId: resolvedProfileId, results });
        return results;
    }

    function beginAdapterCapture(name, callback, options = {}) {
        const normalizedName = String(name || '').trim();
        if (typeof callback !== 'function') {
            return {
                started: false,
                reason: 'capture-callback-required',
                adapter: normalizedName
            };
        }

        let adapter = instances.get(normalizedName) || null;
        let captureOnly = false;

        if (!adapter) {
            adapter = captureInstances.get(normalizedName) || null;
            captureOnly = !!adapter;
        }

        if (!adapter) {
            if (!factories.has(normalizedName)) syncKnownAdapters();
            const factory = factories.get(normalizedName);
            if (!factory) {
                return {
                    started: false,
                    reason: 'adapter-not-registered',
                    adapter: normalizedName
                };
            }

            try {
                adapter = factory({
                    captureOnly: true,
                    ...(options.adapterOptions || {})
                });
                captureOnly = true;
                captureInstances.set(normalizedName, adapter);
            } catch (error) {
                console.error(`${LOG} failed to create capture-only adapter ${normalizedName}.`, error);
                return {
                    started: false,
                    reason: 'capture-adapter-create-failed',
                    adapter: normalizedName,
                    error
                };
            }
        }

        if (typeof adapter.beginCapture !== 'function') {
            if (captureOnly) captureInstances.delete(normalizedName);
            return {
                started: false,
                reason: 'adapter-does-not-support-capture',
                adapter: normalizedName
            };
        }

        try {
            const result = adapter.beginCapture(callback, options) || {
                started: true,
                adapter: normalizedName
            };

            if (!result.started && captureOnly) captureInstances.delete(normalizedName);

            const payload = {
                ...result,
                adapter: normalizedName,
                captureOnly
            };
            emit('captureStarted', payload);
            return payload;
        } catch (error) {
            if (captureOnly) captureInstances.delete(normalizedName);
            console.error(`${LOG} begin capture failed for ${normalizedName}.`, error);
            return {
                started: false,
                reason: 'adapter-capture-start-failed',
                adapter: normalizedName,
                captureOnly,
                error
            };
        }
    }

    function endAdapterCapture(name, reason = 'manual') {
        const normalizedName = String(name || '').trim();
        const normalAdapter = instances.get(normalizedName) || null;
        const captureAdapter = captureInstances.get(normalizedName) || null;
        const adapter = normalAdapter || captureAdapter;
        const captureOnly = !normalAdapter && !!captureAdapter;

        if (!adapter || typeof adapter.endCapture !== 'function') {
            if (captureOnly) captureInstances.delete(normalizedName);
            return {
                ended: false,
                reason: 'adapter-capture-not-available',
                adapter: normalizedName,
                captureOnly
            };
        }

        try {
            const result = adapter.endCapture(reason) || {
                ended: true,
                adapter: normalizedName,
                reason
            };
            const payload = {
                ...result,
                adapter: normalizedName,
                captureOnly
            };
            emit('captureEnded', payload);
            return payload;
        } catch (error) {
            console.warn(`${LOG} end capture failed for ${normalizedName}.`, error);
            return {
                ended: false,
                reason: 'adapter-capture-end-failed',
                adapter: normalizedName,
                captureOnly,
                error
            };
        } finally {
            if (captureOnly) captureInstances.delete(normalizedName);
        }
    }

    function getCaptureState() {
        const result = {};

        for (const [name, adapter] of instances.entries()) {
            if (typeof adapter.getCaptureState === 'function') {
                result[name] = { ...adapter.getCaptureState(), captureOnly: false };
            }
        }

        for (const [name, adapter] of captureInstances.entries()) {
            if (result[name] === undefined && typeof adapter.getCaptureState === 'function') {
                result[name] = { ...adapter.getCaptureState(), captureOnly: true };
            }
        }

        return result;
    }

    function suspend(reason = 'manual') {
        suspended = true;
        suspendReason = reason;
        emit('suspended', { reason });
        return getState();
    }

    function resume() {
        const previousReason = suspendReason;
        suspended = false;
        suspendReason = null;
        emit('resumed', { reason: previousReason });
        return getState();
    }

    function getState() {
        return {
            version: VERSION,
            registeredAdapters: [...factories.keys()],
            enabledAdapters: [...instances.keys()],
            captureOnlyAdapters: [...captureInstances.keys()],
            suspended,
            suspendReason,
            hasDispatcher: typeof dispatcher === 'function',
            activeProfileId: activeProfileId(),
            takeoverActive: false,
            passiveComparisonMode: true
        };
    }

    function getAdapter(name) {
        return instances.get(String(name || '').trim()) || null;
    }

    function getDeviceInfo() {
        return [...instances.entries()].map(([name, adapter]) => ({
            name,
            device: adapter.getDeviceInfo?.() || null
        }));
    }

    function compatibilityReport() {
        const legacy = QoL.airNavInput || null;
        const required = [
            'registerAdapter', 'unregisterAdapter', 'enableAdapter', 'disableAdapter',
            'disableAll', 'reloadBindings', 'beginAdapterCapture', 'endAdapterCapture',
            'getCaptureState', 'setDispatcher', 'dispatch', 'suspend', 'resume',
            'getState', 'getAdapter', 'getDeviceInfo', 'on', 'off'
        ];
        const runtime = QoL.inputRegistryRuntime;
        const missingMethods = required.filter(method => typeof runtime?.[method] !== 'function');

        return {
            version: VERSION,
            ready: missingMethods.length === 0,
            missingMethods,
            takeoverActive: false,
            passiveComparisonMode: true,
            legacyPresent: !!legacy,
            legacyRegisteredAdapters: legacy?.getState?.().registeredAdapters || [],
            productionRegisteredAdapters: getState().registeredAdapters,
            universalFactoryPresent: typeof QoL.airNavUniversalInput?.create === 'function',
            hasDispatcher: typeof dispatcher === 'function',
            activeProfileId: activeProfileId(),
            state: getState()
        };
    }

    const api = Object.freeze({
        version: VERSION,
        VERSION,
        registerAdapter,
        unregisterAdapter,
        enableAdapter,
        disableAdapter,
        disableAll,
        reloadBindings,
        beginAdapterCapture,
        endAdapterCapture,
        getCaptureState,
        setDispatcher,
        dispatch: dispatchFromAdapter,
        suspend,
        resume,
        getState,
        getAdapter,
        getDeviceInfo,
        syncKnownAdapters,
        compatibilityReport,
        on,
        off
    });

    QoL.inputRegistryRuntime = api;
    syncKnownAdapters();

    console.log(LOG, 'Production input registry registered in passive mode.', compatibilityReport());
})();
