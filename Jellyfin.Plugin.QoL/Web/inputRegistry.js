(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.inputRegistryRuntime?.version === '1.2.0-takeover') {
        QoL.inputRegistryRuntime.reconcileOwnership?.();
        return;
    }

    const VERSION = '1.2.0-takeover';
    const LOG = '[JellyfinQoL.InputRegistry]';
    const LIVE_ADAPTER_METHODS = Object.freeze([
        'start', 'stop', 'reloadBindings', 'getDeviceInfo'
    ]);
    const CAPTURE_ADAPTER_METHODS = Object.freeze([
        'beginCapture', 'endCapture', 'getCaptureState'
    ]);

    const factories = new Map();
    const instances = new Map();
    const captureInstances = new Map();
    const listeners = new Map();

    let dispatcher = null;
    let suspended = false;
    let suspendReason = null;
    let api = null;
    let lastOwnership = null;

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

    function currentOwnership() {
        const current = QoL.airNavInput || null;
        const takeoverActive = !!api && current === api;
        const legacy = current && current !== api ? current : null;
        return {
            takeoverActive,
            passiveComparisonMode: !!legacy,
            legacyPresent: !!legacy,
            legacy
        };
    }

    function emitOwnershipIfChanged(next) {
        const snapshot = {
            takeoverActive: !!next.takeoverActive,
            passiveComparisonMode: !!next.passiveComparisonMode,
            legacyPresent: !!next.legacyPresent
        };
        const key = JSON.stringify(snapshot);
        if (key === lastOwnership) return;
        lastOwnership = key;
        emit('ownershipChanged', snapshot);
    }

    function reconcileOwnership() {
        if (!api) {
            return {
                takeoverActive: false,
                passiveComparisonMode: false,
                legacyPresent: false,
                reason: 'runtime-not-ready'
            };
        }

        const current = QoL.airNavInput || null;
        if (!current || current === api) {
            QoL.airNavInput = api;
            const result = {
                takeoverActive: true,
                passiveComparisonMode: false,
                legacyPresent: false,
                reason: current === api ? 'already-production-owner' : 'production-owner-claimed'
            };
            emitOwnershipIfChanged(result);
            return result;
        }

        const result = {
            takeoverActive: false,
            passiveComparisonMode: true,
            legacyPresent: true,
            legacyVersion: current.VERSION || current.version || null,
            reason: 'legacy-owner-present'
        };
        emitOwnershipIfChanged(result);
        return result;
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

    function adapterMethodReport(adapter) {
        const methods = {};
        [...LIVE_ADAPTER_METHODS, ...CAPTURE_ADAPTER_METHODS].forEach(method => {
            methods[method] = typeof adapter?.[method] === 'function';
        });

        const missingLiveMethods = LIVE_ADAPTER_METHODS.filter(method => !methods[method]);
        const missingCaptureMethods = CAPTURE_ADAPTER_METHODS.filter(method => !methods[method]);

        return {
            methods,
            missingLiveMethods,
            missingCaptureMethods,
            liveReady: missingLiveMethods.length === 0,
            captureReady: missingCaptureMethods.length === 0,
            ready: missingLiveMethods.length === 0 && missingCaptureMethods.length === 0
        };
    }

    function inspectAdapter(name, options = {}) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) {
            return { ready:false, reason:'adapter-name-required', adapter:normalizedName };
        }

        if (!factories.has(normalizedName)) syncKnownAdapters();
        const factory = factories.get(normalizedName);
        if (!factory) {
            return { ready:false, reason:'adapter-not-registered', adapter:normalizedName };
        }

        let adapter = instances.get(normalizedName) || captureInstances.get(normalizedName) || null;
        const source = instances.has(normalizedName)
            ? 'enabled-instance'
            : (captureInstances.has(normalizedName) ? 'capture-instance' : 'probe-instance');
        let probeOwned = false;

        if (!adapter) {
            try {
                adapter = factory({
                    captureOnly: true,
                    ...(options.adapterOptions || {})
                });
                probeOwned = true;
            } catch (error) {
                return {
                    ready:false,
                    reason:'adapter-probe-create-failed',
                    adapter:normalizedName,
                    error
                };
            }
        }

        const contract = adapterMethodReport(adapter);
        let device = null;
        let captureState = null;

        try { device = adapter.getDeviceInfo?.() || null; }
        catch (error) { device = { error:String(error?.message || error) }; }

        try { captureState = adapter.getCaptureState?.() || null; }
        catch (error) { captureState = { error:String(error?.message || error) }; }

        if (probeOwned) {
            try { adapter.stop?.(); } catch (_) {}
        }

        return {
            adapter: normalizedName,
            source,
            probeOwned,
            ...contract,
            device,
            captureState
        };
    }

    function verifyUniversalIntegration() {
        const sync = syncKnownAdapters();
        const report = inspectAdapter('universal');
        return {
            ...report,
            sync,
            factoryPresent: typeof QoL.airNavUniversalInput?.create === 'function',
            factoryVersion: QoL.airNavUniversalInput?.VERSION || QoL.airNavUniversalInput?.version || null
        };
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

        const contract = adapterMethodReport(adapter);
        if (!contract.liveReady) {
            console.error(
                `${LOG} adapter ${normalizedName} is missing live methods: ${contract.missingLiveMethods.join(', ')}`
            );
            try { adapter?.stop?.(); } catch (_) {}
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

        const contract = adapterMethodReport(adapter);
        if (!contract.captureReady) {
            if (captureOnly) captureInstances.delete(normalizedName);
            return {
                started: false,
                reason: 'adapter-does-not-support-capture',
                adapter: normalizedName,
                missingMethods: contract.missingCaptureMethods
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
        const ownership = currentOwnership();
        return {
            version: VERSION,
            registeredAdapters: [...factories.keys()],
            enabledAdapters: [...instances.keys()],
            captureOnlyAdapters: [...captureInstances.keys()],
            suspended,
            suspendReason,
            hasDispatcher: typeof dispatcher === 'function',
            activeProfileId: activeProfileId(),
            adapterIntegrationReady: verifyUniversalIntegration().ready === true,
            takeoverActive: ownership.takeoverActive,
            passiveComparisonMode: ownership.passiveComparisonMode
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
        const ownership = reconcileOwnership();
        const legacy = ownership.legacyPresent ? (QoL.airNavInput === api ? null : QoL.airNavInput) : null;
        const required = [
            'registerAdapter', 'unregisterAdapter', 'enableAdapter', 'disableAdapter',
            'disableAll', 'reloadBindings', 'beginAdapterCapture', 'endAdapterCapture',
            'getCaptureState', 'setDispatcher', 'dispatch', 'suspend', 'resume',
            'getState', 'getAdapter', 'getDeviceInfo', 'inspectAdapter',
            'verifyUniversalIntegration', 'reconcileOwnership', 'on', 'off'
        ];
        const runtime = QoL.inputRegistryRuntime;
        const missingMethods = required.filter(method => typeof runtime?.[method] !== 'function');
        const universal = verifyUniversalIntegration();

        return {
            version: VERSION,
            ready: missingMethods.length === 0 && universal.ready === true,
            missingMethods,
            adapterIntegrationReady: universal.ready === true,
            universal,
            takeoverActive: ownership.takeoverActive,
            passiveComparisonMode: ownership.passiveComparisonMode,
            legacyPresent: ownership.legacyPresent,
            legacyVersion: legacy?.VERSION || legacy?.version || null,
            legacyRegisteredAdapters: legacy?.getState?.().registeredAdapters || [],
            productionRegisteredAdapters: [...factories.keys()],
            universalFactoryPresent: typeof QoL.airNavUniversalInput?.create === 'function',
            hasDispatcher: typeof dispatcher === 'function',
            activeProfileId: activeProfileId(),
            ownershipReason: ownership.reason,
            state: getState()
        };
    }

    api = Object.freeze({
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
        inspectAdapter,
        verifyUniversalIntegration,
        reconcileOwnership,
        compatibilityReport,
        on,
        off
    });

    QoL.inputRegistryRuntime = api;
    syncKnownAdapters();
    const ownership = reconcileOwnership();

    console.log(
        LOG,
        ownership.takeoverActive
            ? 'Production input registry owns JellyfinQoL.airNavInput.'
            : 'Production input registry registered in passive comparison mode.',
        compatibilityReport()
    );
})();
