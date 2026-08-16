// Jellyfin QoL - Production AirNav Launcher / Client-Local Gate v1.0.2
(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    const VERSION = '1.0.2';
    const LEGACY_VERSION = '13.1';
    const LOG = '[JellyfinQoL.Launcher]';
    const ENROLLMENT_KEY = 'jellyfin-qol-airnav-client-v1';
    const CLIENT_KEY = 'jellyfin-qol-user-client-v1';
    const SCHEMA_VERSION = 1;
    const SUPERVISOR_MS = 750;

    if (QoL.airNavLauncherRuntime?.version === VERSION) return;

    let started = false;
    let startingPromise = null;
    let supervisorTimer = null;
    let sessionOverride = null; // null = use persistent device enrollment
    let lastStartReason = null;
    let lastStopReason = null;
    let lastError = null;
    let lastAppliedFingerprint = null;
    let lastOptionalHelperResult = null;
    const runtimeUnsubscribers = [];

    const clone = value => {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return value; }
    };

    function readJson(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (_) {
            return null;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            lastError = error;
            console.error(LOG, `Could not write ${key}.`, error);
            return false;
        }
    }

    function readEnrollment() {
        try {
            const raw = localStorage.getItem(ENROLLMENT_KEY);
            if (!raw) {
                return {
                    schemaVersion: SCHEMA_VERSION,
                    configured: false,
                    enabled: false,
                    updatedAt: null,
                    storageAvailable: true,
                    reason: 'not-enrolled'
                };
            }

            const parsed = JSON.parse(raw);
            if (Number(parsed?.schemaVersion || 1) !== SCHEMA_VERSION) {
                throw new Error(`Unsupported enrollment schema ${parsed?.schemaVersion}.`);
            }

            return {
                schemaVersion: SCHEMA_VERSION,
                configured: typeof parsed?.enabled === 'boolean',
                enabled: parsed?.enabled === true,
                updatedAt: Number.isFinite(Number(parsed?.updatedAt)) ? Number(parsed.updatedAt) : null,
                storageAvailable: true,
                reason: parsed?.enabled === true ? 'enrolled-enabled' : 'enrolled-disabled'
            };
        } catch (error) {
            return {
                schemaVersion: SCHEMA_VERSION,
                configured: false,
                enabled: false,
                updatedAt: null,
                storageAvailable: false,
                reason: 'storage-unavailable',
                error: String(error?.message || error)
            };
        }
    }

    function mirrorClientSetting(enabled) {
        const current = readJson(CLIENT_KEY) || {};
        current.schemaVersion = Number(current.schemaVersion || 1);
        current.airNavEnabled = enabled === true;
        return writeJson(CLIENT_KEY, current);
    }

    function writeEnrollment(enabled) {
        const document = {
            schemaVersion: SCHEMA_VERSION,
            enabled: enabled === true,
            updatedAt: Date.now()
        };
        if (!writeJson(ENROLLMENT_KEY, document)) return false;
        mirrorClientSetting(enabled === true);
        return true;
    }

    function clearEnrollmentDocument() {
        try {
            localStorage.removeItem(ENROLLMENT_KEY);
            mirrorClientSetting(false);
            return true;
        } catch (error) {
            lastError = error;
            return false;
        }
    }

    function getRuntimeConfig() {
        if (QoL.runtimeConfig) return QoL.runtimeConfig;
        try { return QoL.runtimeSettings?.getConfig?.() || null; }
        catch (_) { return null; }
    }

    function persistentEnabled() {
        const enrollment = readEnrollment();
        if (enrollment.configured) return enrollment.enabled === true;
        return getRuntimeConfig()?.airNavEnabled === true;
    }

    function effectiveEnabled() {
        return sessionOverride == null ? persistentEnabled() : sessionOverride === true;
    }

    function activeProfileId() {
        return String(
            getRuntimeConfig()?.activeProfileId ||
            QoL.profileRuntime?.getActiveProfileId?.() ||
            'default'
        );
    }

    function helperEnabled() {
        return getRuntimeConfig()?.client?.helperEnabled === true;
    }

    function requiredModules() {
        return [
            ['scanner.js', QoL.airScanner?.create],
            ['focus.js', QoL.airFocus?.create],
            ['geometry.js', QoL.airGeometry?.create],
            ['scroll.js', QoL.airScroll?.create],
            ['item-actions.js', QoL.airItemActions?.enter],
            ['modal-navigation.js', QoL.airModal?.enter],
            ['control-bridge.js', QoL.airControlBridge?.dispatchNativeAction],
            ['controller.js', QoL.airNav?.create],
            ['profile-runtime', QoL.profileRuntime?.getBindings],
            ['input-registry.js', QoL.airNavInput?.enableAdapter],
            ['universal-input.js', QoL.airNavUniversalInput?.create]
        ];
    }

    function getMissingCoreModules() {
        return requiredModules()
            .filter(([, value]) => typeof value !== 'function')
            .map(([name]) => name);
    }

    function settingsFingerprint() {
        const config = getRuntimeConfig();
        if (!config) return 'none';
        return JSON.stringify({
            activeProfileId: config.activeProfileId,
            cardActivate: config.behavior?.cardActivate,
            scrollBehavior: config.scroll?.behavior,
            searchHandoffEnabled: config.search?.handoffEnabled,
            airNavEnabled: config.airNavEnabled,
            helperEnabled: config.client?.helperEnabled === true
        });
    }

    function syncOptionalHelper(reason = 'runtime-sync') {
        const enabled = helperEnabled();
        const guard = QoL.airGuard || null;

        if (!enabled) {
            if (guard?.disable) {
                try { guard.disable(`launcher-helper-disabled:${reason}`); }
                catch (_) {}
            }
            lastOptionalHelperResult = {
                configured: false,
                guardPresent: !!guard,
                active: false,
                reason: 'helper-disabled'
            };
            return clone(lastOptionalHelperResult);
        }

        if (!guard?.enable) {
            lastOptionalHelperResult = {
                configured: true,
                guardPresent: false,
                active: false,
                reason: 'guard-runtime-not-loaded'
            };
            return clone(lastOptionalHelperResult);
        }

        try {
            const result = guard.enable(`launcher-start:${reason}`);
            lastOptionalHelperResult = {
                configured: true,
                guardPresent: true,
                active: true,
                reason: 'guard-enable-requested',
                result: clone(result)
            };
        } catch (error) {
            // The Windows helper is optional. A missing/stopped helper must never
            // prevent browser-native AirNav from starting.
            lastOptionalHelperResult = {
                configured: true,
                guardPresent: true,
                active: false,
                reason: 'guard-enable-failed',
                error: String(error?.message || error)
            };
            console.warn(LOG, 'Optional Windows helper could not be enabled; continuing without it.', error);
        }

        return clone(lastOptionalHelperResult);
    }

    function applyRuntimeConfig(reason = 'runtime-sync', force = false) {
        const config = getRuntimeConfig();
        if (!config) return { applied:false, reason:'runtime-config-not-ready' };

        const fingerprint = settingsFingerprint();
        if (!force && fingerprint === lastAppliedFingerprint) {
            return { applied:false, reason:'unchanged' };
        }

        const result = { applied:true, reason, profileId:activeProfileId() };
        try { result.inputReload = QoL.airNavInput?.reloadBindings?.(result.profileId) || null; }
        catch (error) { result.inputReload = { error:String(error?.message || error) }; }
        try { result.scroll = QoL.airScroll?.setBehavior?.(config.scroll?.behavior || 'smooth', reason) || null; }
        catch (error) { result.scroll = { error:String(error?.message || error) }; }
        try { result.cardActivate = QoL.airNav?.setCardActivatePolicy?.(config.behavior?.cardActivate || 'openDetails', reason) || null; }
        catch (error) { result.cardActivate = { error:String(error?.message || error) }; }
        try { result.searchHandoff = QoL.airNav?.setSearchHandoffEnabled?.(config.search?.handoffEnabled !== false, reason) || null; }
        catch (error) { result.searchHandoff = { error:String(error?.message || error) }; }
        try { QoL.airControlBridge?.reloadSettings?.(`launcher:${reason}`); } catch (_) {}
        if (started) result.optionalHelper = syncOptionalHelper(reason);

        lastAppliedFingerprint = fingerprint;
        return result;
    }

    function subscribeRuntimeChanges() {
        if (runtimeUnsubscribers.length) return;
        const handler = () => queueMicrotask(() => {
            applyRuntimeConfig('runtime-settings-changed', true);
            supervisorTick('runtime-settings-changed').catch(() => {});
        });
        window.addEventListener('jellyfin-qol-runtime-settings-changed', handler);
        runtimeUnsubscribers.push(() => window.removeEventListener('jellyfin-qol-runtime-settings-changed', handler));

        for (const eventName of ['changed','bindingsChanged','bindingCommitted','bindingRemoved','profileChanged','profileReset']) {
            const unsubscribe = QoL.profileRuntime?.on?.(eventName, () => {
                queueMicrotask(() => applyRuntimeConfig(`profile:${eventName}`, true));
            });
            if (typeof unsubscribe === 'function') runtimeUnsubscribers.push(unsubscribe);
        }
    }

    function unsubscribeRuntimeChanges() {
        while (runtimeUnsubscribers.length) {
            try { runtimeUnsubscribers.pop()?.(); } catch (_) {}
        }
    }

    function createDeferredModules() {
        return {
            scanner: QoL.airScanner.create(),
            focus: QoL.airFocus.create(),
            geometry: QoL.airGeometry.create(),
            scroll: QoL.airScroll.create(),
            controller: QoL.airNav.create()
        };
    }

    function destroyDeferredModules() {
        // Only the deferred navigation-model cluster is session-owned. Do not
        // destroy production Profile/Input/Gesture/Universal/ControlBridge runtimes.
        for (const module of [QoL.airNav,QoL.airModal,QoL.airItemActions,QoL.airScroll,QoL.airGeometry,QoL.airFocus,QoL.airScanner]) {
            try { module?.destroy?.(); } catch (_) {}
        }
    }

    function validateUniversalAdapter(adapter) {
        if (!adapter) {
            throw new Error('Universal Input adapter did not start.');
        }

        let state = null;
        try { state = adapter.getState?.() || null; }
        catch (_) {}

        if (state && state.started === false) {
            throw new Error('Universal Input adapter exists but reports started=false.');
        }

        return state;
    }

    async function startCoreRuntime(reason = 'automatic') {
        if (started) return getRuntimeHandles();
        if (startingPromise) return startingPromise;
        if (!effectiveEnabled()) return { started:false, reason:'runtime-disabled', state:getState() };

        const missing = getMissingCoreModules();
        if (missing.length) return { started:false, reason:'modules-not-ready', missing, state:getState() };

        const operation = (async () => {
            let deferred = null;
            try {
                deferred = createDeferredModules();
                QoL.airNavInput.setDispatcher(event => QoL.airNav.dispatch(event));

                const universal = QoL.airNavInput.enableAdapter('universal', {
                    profileId:activeProfileId()
                });
                const universalState = validateUniversalAdapter(universal);
                const adapters = { universal };

                // Do not publish started=true until the required browser input
                // adapter has actually started. Failed starts remain retryable by
                // the supervisor instead of becoming a false-positive running state.
                started = true;
                lastStartReason = reason;
                lastStopReason = null;
                lastError = null;
                subscribeRuntimeChanges();
                const liveSync = applyRuntimeConfig(`start:${reason}`, true);

                console.log(LOG, 'AirNav runtime started.', {
                    reason,
                    profileId:activeProfileId(),
                    adapters,
                    universalState,
                    liveSync
                });
                return getRuntimeHandles(adapters, deferred);
            } catch (error) {
                lastError = error;
                started = false;
                unsubscribeRuntimeChanges();
                try { QoL.airNavInput?.disableAll?.(); } catch (_) {}
                try { QoL.airNavInput?.setDispatcher?.(null); } catch (_) {}
                destroyDeferredModules();
                try { QoL.airGuard?.disable?.(`launcher-start-failed:${reason}`); } catch (_) {}
                lastAppliedFingerprint = null;
                console.error(LOG, 'AirNav runtime start failed; supervisor will retry.', error);
                return { started:false, reason:'startup-failed', error, state:getState() };
            }
        })();

        startingPromise = operation;
        try {
            return await operation;
        } finally {
            if (startingPromise === operation) startingPromise = null;
        }
    }

    function stopCoreRuntime(reason = 'manual') {
        unsubscribeRuntimeChanges();
        try {
            if (QoL.recordInputRuntime?.getState?.().mode !== 'IDLE') {
                QoL.recordInputRuntime.cancel?.(`airnav-runtime-stopped:${reason}`);
            }
        } catch (_) {}
        try { QoL.airGuard?.disable?.(`launcher-stop:${reason}`); } catch (_) {}
        lastOptionalHelperResult = helperEnabled()
            ? { configured:true, guardPresent:!!QoL.airGuard, active:false, reason:'runtime-stopped' }
            : { configured:false, guardPresent:!!QoL.airGuard, active:false, reason:'helper-disabled' };
        try { QoL.airNavInput?.disableAll?.(); } catch (_) {}
        try { QoL.airNavInput?.setDispatcher?.(null); } catch (_) {}

        destroyDeferredModules();
        try { QoL.airControlBridge?.exitNativeSurface?.(); } catch (_) {}
        try { QoL.airControlBridge?.clearSavedText?.(); } catch (_) {}

        const wasStarted = started;
        started = false;
        lastStopReason = reason;
        lastAppliedFingerprint = null;
        if (wasStarted) console.log(LOG, 'AirNav runtime stopped.', { reason });
        return getState();
    }

    async function refreshRuntimeSettings(reason) {
        try {
            if (QoL.runtimeSettings?.refresh) {
                await QoL.runtimeSettings.refresh(reason, { forceServer:false });
            } else {
                window.dispatchEvent(new CustomEvent('jellyfin-qol-runtime-refresh', { detail:{ reason, forceServer:false } }));
            }
        } catch (error) {
            console.warn(LOG, 'Runtime settings refresh failed.', error);
        }
    }

    async function supervisorTick(reason = 'poll') {
        if (!effectiveEnabled()) {
            if (started || startingPromise) stopCoreRuntime(`disabled:${reason}`);
            return getState();
        }
        if (getMissingCoreModules().length) return getState();
        if (!started) await startCoreRuntime(`supervisor:${reason}`);
        else applyRuntimeConfig(`supervisor:${reason}`);
        return getState();
    }

    function startSupervisor() {
        if (supervisorTimer) return getState();
        supervisorTimer = setInterval(() => supervisorTick('interval').catch(error => {
            lastError = error;
            console.warn(LOG, 'Supervisor tick failed.', error);
        }), SUPERVISOR_MS);
        queueMicrotask(() => supervisorTick('initial').catch(() => {}));
        return getState();
    }

    function stopSupervisor() {
        if (supervisorTimer) clearInterval(supervisorTimer);
        supervisorTimer = null;
        return getState();
    }

    async function setPersistentEnabled(value, reason = 'client-set') {
        if (!writeEnrollment(value === true)) {
            if (value) stopCoreRuntime('enrollment-write-failed');
            return { saved:false, state:getDeviceState() };
        }
        sessionOverride = null;
        await refreshRuntimeSettings(`launcher:${reason}`);
        await supervisorTick(reason);
        return getDeviceState();
    }

    const enableForDevice = options => setPersistentEnabled(true, options?.reason || 'client-enable');
    const disableForDevice = reason => setPersistentEnabled(false, reason || 'client-disable');
    const toggleForDevice = () => persistentEnabled() ? disableForDevice('client-toggle-off') : enableForDevice({ reason:'client-toggle-on' });

    async function clearEnrollment() {
        sessionOverride = null;
        const removed = clearEnrollmentDocument();
        await refreshRuntimeSettings('launcher:client-clear');
        await supervisorTick('client-clear');
        return { removed, state:getDeviceState() };
    }

    async function enableSession(options = {}) {
        sessionOverride = true;
        if (options.refreshSettings === true) await refreshRuntimeSettings('launcher:session-enable');
        await supervisorTick('session-enable');
        return getRuntimeHandles();
    }

    function disableSession(reason = 'session-disable') {
        sessionOverride = false;
        stopCoreRuntime(reason);
        return getState();
    }

    const toggleSession = () => effectiveEnabled() ? disableSession('session-toggle-off') : enableSession();
    const setSessionEnabled = value => value === false ? disableSession('session-set:false') : enableSession();

    async function startIfClientEnabled(options = {}) {
        if (!persistentEnabled()) return { started:false, reason:'client-not-enrolled', clientEnrollment:getDeviceState() };
        sessionOverride = null;
        if (options.refreshSettings === true) await refreshRuntimeSettings('launcher:gated-start');
        await supervisorTick('gated-start');
        return getRuntimeHandles();
    }

    function dispatchTestAction(action, source = 'custom') {
        if (!QoL.airNav?.dispatch) return { handled:false, reason:'controller-not-ready' };
        return QoL.airNav.dispatch({
            action:String(action || '').toUpperCase(), phase:'press', source,
            deviceId:`${source}:test`, raw:{ test:true }, timestamp:performance.now()
        });
    }

    function getDeviceState() {
        const enrollment = readEnrollment();
        return {
            storageKey: ENROLLMENT_KEY,
            schemaVersion: SCHEMA_VERSION,
            enabled: persistentEnabled(),
            configured: enrollment.configured,
            updatedAt: enrollment.updatedAt,
            storageAvailable: enrollment.storageAvailable,
            storageReason: enrollment.reason,
            sessionOverride,
            runtimeEnabledForSession: effectiveEnabled(),
            runtimeStarted: started,
            route: location.hash
        };
    }

    function getRuntimeHandles(adapters = null, deferred = null) {
        return {
            started, sessionOverride, effectiveEnabled:effectiveEnabled(),
            clientEnrollment:getDeviceState(), scanner:QoL.airScanner,
            focus:QoL.airFocus, geometry:QoL.airGeometry, scroll:QoL.airScroll,
            itemActions:QoL.airItemActions, modal:QoL.airModal,
            controller:QoL.airNav, controlBridge:QoL.airControlBridge,
            input:QoL.airNavInput, universalInput:QoL.airNavUniversalInput,
            profileRuntime:QoL.profileRuntime, recorder:QoL.recordInputRuntime,
            optionalHelper:clone(lastOptionalHelperResult),
            adapters, deferred, runtimeConfig:clone(getRuntimeConfig())
        };
    }

    function getState() {
        return {
            version:VERSION, legacyVersion:LEGACY_VERSION, started,
            starting:!!startingPromise, supervisorActive:!!supervisorTimer,
            sessionOverride, persistentEnabled:persistentEnabled(),
            effectiveEnabled:effectiveEnabled(), activeProfileId:activeProfileId(),
            runtimeSource:getRuntimeConfig()?.source || null,
            helperEnabled:helperEnabled(),
            helperRequired:false,
            optionalHelper:clone(lastOptionalHelperResult),
            lastStartReason, lastStopReason,
            lastError:lastError ? String(lastError?.message || lastError) : null,
            missingCoreModules:getMissingCoreModules(), route:location.hash,
            input:QoL.airNavInput?.getState?.() || null,
            controller:QoL.airNav?.getState?.() || null,
            controlBridge:QoL.airControlBridge?.getState?.() || null
        };
    }

    function compatibilityReport() {
        return {
            version:VERSION, legacyVersion:LEGACY_VERSION, ready:true,
            takeoverReady:true, clientLocalEnrollment:true,
            defaultClientEnabled:false, sessionOnlyToggle:true,
            runtimeSettingsOwnedHydration:true, profileRuntimeOwnedBindings:true,
            destroysProductionSubsystemsOnStop:false,
            validatesUniversalAdapterStartup:true,
            retriesFailedStartup:true,
            windowsHelperOptional:true,
            windowsHelperRequired:false,
            deferredNavigationCluster:['scanner','geometry','focus','scroll','page-form-navigation','item-actions','controller'],
            state:getState()
        };
    }

    const clientApi = Object.freeze({
        enable:enableForDevice, disable:disableForDevice, toggle:toggleForDevice,
        setEnabled:value => setPersistentEnabled(value === true, 'client-set'),
        getState:getDeviceState, clear:clearEnrollment
    });

    const api = Object.freeze({
        version:VERSION, VERSION, LEGACY_VERSION,
        startSupervisor, stopSupervisor, supervisorTick,
        start:startCoreRuntime, stop:stopCoreRuntime,
        applyRuntimeConfig, getMissingCoreModules,
        getState, getRuntimeHandles, getDeviceState,
        dispatchTestAction, compatibilityReport,
        destroy() { stopSupervisor(); stopCoreRuntime('launcher-destroy'); }
    });

    QoL.airNavLauncherRuntime = api;
    QoL.airNavClient = clientApi;
    QoL.enableAirNavForThisDevice = enableForDevice;
    QoL.disableAirNavForThisDevice = disableForDevice;
    QoL.toggleAirNavForThisDevice = toggleForDevice;
    QoL.setAirNavEnabledForThisDevice = value => setPersistentEnabled(value === true, 'client-alias-set');
    QoL.getAirNavDeviceState = getDeviceState;
    QoL.clearAirNavDeviceEnrollment = clearEnrollment;

    QoL.enableAirNav = enableSession;
    QoL.disableAirNav = disableSession;
    QoL.toggleAirNav = toggleSession;
    QoL.setAirNavEnabled = setSessionEnabled;
    QoL.startAirNavPhase7 = startIfClientEnabled;
    QoL.stopAirNavPhase7 = disableSession;
    QoL.startAirNavPhase6 = startIfClientEnabled;
    QoL.stopAirNavPhase6 = disableSession;
    QoL.syncAirNavRuntimeSettings = reason => applyRuntimeConfig(reason || 'compatibility-sync', true);
    QoL.getAirNavRuntimeState = getState;
    QoL.dispatchAirNavTestAction = dispatchTestAction;
    QoL.showAirNavToggleButton = () => false;
    QoL.airNavLauncherInfo = Object.freeze({
        version:VERSION, legacyVersion:LEGACY_VERSION, registeredAt:Date.now(),
        automaticStartup:true, loginSafeBootstrap:true,
        runtimeSettingsOwnedHydration:true, clientLocalEnrollment:true,
        defaultClientEnabled:false, clientStorageKey:ENROLLMENT_KEY,
        temporaryToggleButton:false,
        windowsHelperOptional:true,
        windowsHelperRequired:false
    });

    function begin() {
        startSupervisor();
        console.log(LOG, 'Production client-local launcher registered.', {
            version:VERSION, persistentEnabled:persistentEnabled(),
            sessionOverride, missing:getMissingCoreModules(),
            windowsHelperOptional:true
        });
    }

    if (QoL.clientReady) begin();
    else window.addEventListener('jellyfin-qol-client-ready', begin, { once:true });
})();
