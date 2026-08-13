(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.clientBootstrap?.version === '1.0.0') {
        QoL.clientBootstrap.start?.();
        return;
    }

    const VERSION = '1.0.0';
    const LOG = '[JellyfinQoL.ClientBootstrap]';
    const RESOURCE_BASE = 'JellyfinQoL/Client/';
    const loadedResources = new Map();
    let started = false;
    let startingPromise = null;
    let lastError = null;
    let startedAt = null;

    const MODULES = Object.freeze([
        {
            id: 'runtimeSettings',
            resource: 'runtimeSettings.js',
            required: true,
            ready: () => !!QoL.runtimeSettings?.start,
            start: () => QoL.runtimeSettings.start()
        },
        {
            id: 'userSettingsBridge',
            resource: 'userSettingsBridge.js',
            required: true,
            ready: () => !!QoL.userSettingsBridge?.start,
            start: () => QoL.userSettingsBridge.start()
        }
    ]);

    function waitForApiClient(timeoutMs = 15000) {
        if (window.ApiClient?.getUrl) return Promise.resolve(window.ApiClient);

        return new Promise((resolve, reject) => {
            const startedWaiting = Date.now();
            const timer = setInterval(() => {
                if (window.ApiClient?.getUrl) {
                    clearInterval(timer);
                    resolve(window.ApiClient);
                    return;
                }
                if (Date.now() - startedWaiting >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error('Timed out waiting for Jellyfin ApiClient.'));
                }
            }, 100);
        });
    }

    function resourceUrl(name) {
        const cacheToken = `${VERSION}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return ApiClient.getUrl(`${RESOURCE_BASE}${encodeURIComponent(name)}`) + `?qolcb=${encodeURIComponent(cacheToken)}`;
    }

    function loadScript(module) {
        if (module.ready()) {
            loadedResources.set(module.id, { source:'already-present', loadedAt:Date.now() });
            return Promise.resolve();
        }

        const existing = loadedResources.get(module.id)?.promise;
        if (existing) return existing;

        const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.async = false;
            script.dataset.jellyfinQolModule = module.id;
            script.src = resourceUrl(module.resource);
            script.onload = () => {
                if (!module.ready()) {
                    reject(new Error(`Resource ${module.resource} loaded but module ${module.id} did not register.`));
                    return;
                }
                loadedResources.set(module.id, { source:'dll', loadedAt:Date.now() });
                resolve();
            };
            script.onerror = () => reject(new Error(`Failed to load embedded resource ${module.resource}.`));
            document.head.appendChild(script);
        });

        loadedResources.set(module.id, { promise });
        return promise;
    }

    async function start() {
        if (started) return getState();
        if (startingPromise) return startingPromise;

        startingPromise = (async () => {
            lastError = null;
            await waitForApiClient();

            for (const module of MODULES) {
                try {
                    await loadScript(module);
                    await module.start?.();
                    console.log(LOG, `Module ready: ${module.id}`);
                } catch (error) {
                    if (module.required) throw error;
                    console.warn(LOG, `Optional module failed: ${module.id}`, error);
                }
            }

            started = true;
            startedAt = Date.now();

            const state = getState();
            QoL.clientReady = true;
            try {
                window.dispatchEvent(new CustomEvent('jellyfin-qol-client-ready', { detail:state }));
            } catch (_) {}

            console.log(LOG, 'Production client bootstrap ready.', state);
            return state;
        })().catch(error => {
            lastError = error;
            console.error(LOG, 'Bootstrap failed.', error);
            throw error;
        }).finally(() => {
            startingPromise = null;
        });

        return startingPromise;
    }

    async function refreshSettings(reason = 'bootstrap-api') {
        if (!QoL.runtimeSettings?.refresh) throw new Error('Runtime settings module is not ready.');
        return QoL.runtimeSettings.refresh(reason, { forceServer:true });
    }

    function getState() {
        return {
            version: VERSION,
            started,
            starting: !!startingPromise,
            startedAt,
            lastError: lastError ? String(lastError?.message || lastError) : null,
            modules: MODULES.map(module => ({
                id: module.id,
                resource: module.resource,
                required: module.required,
                ready: module.ready(),
                load: loadedResources.get(module.id)?.source || (module.ready() ? 'already-present' : 'pending')
            })),
            runtimeSettings: QoL.runtimeSettings?.getState?.() || null
        };
    }

    function destroy() {
        try { QoL.runtimeSettings?.stop?.(); } catch (_) {}
        try { QoL.userSettingsBridge?.destroy?.(); } catch (_) {}
        started = false;
        QoL.clientReady = false;
        console.log(LOG, 'Destroyed production client bootstrap.');
        return getState();
    }

    QoL.clientBootstrap = Object.freeze({
        version: VERSION,
        start,
        destroy,
        getState,
        refreshSettings
    });

    start().catch(() => {});
})();
