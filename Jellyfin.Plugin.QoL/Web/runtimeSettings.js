(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.runtimeSettings?.version === '1.0.0') return;

    const VERSION = '1.0.0';
    const LOG = '[JellyfinQoL.RuntimeSettings]';
    const USER_SCHEMA_VERSION = 1;
    const CLIENT_SCHEMA_VERSION = 1;
    const CLIENT_STORAGE_KEY = 'jellyfin-qol-user-client-v1';
    const AIRNAV_ENROLLMENT_KEY = 'jellyfin-qol-airnav-client-v1';
    const SUPERVISOR_INTERVAL_MS = 1000;
    const RETRY_INTERVAL_MS = 5000;
    const SERVER_REFRESH_INTERVAL_MS = 30000;

    const ACTIONS = [
        { action:'UP', label:'Up', input:'ArrowUp', gesture:'repeat', allowRepeat:true },
        { action:'DOWN', label:'Down', input:'ArrowDown', gesture:'repeat', allowRepeat:true },
        { action:'LEFT', label:'Left', input:'ArrowLeft', gesture:'repeat', allowRepeat:true },
        { action:'RIGHT', label:'Right', input:'ArrowRight', gesture:'repeat', allowRepeat:true },
        { action:'ACTIVATE', label:'Activate / OK', input:'Enter', gesture:'single', allowRepeat:false },
        { action:'BACK', label:'Back', input:'BrowserBack', gesture:'single', allowRepeat:false },
        { action:'ENTER_ACTIONS', label:'Item actions', input:'KeyA', gesture:'single', allowRepeat:false },
        { action:'MENU', label:'Menu', input:'ContextMenu', gesture:'single', allowRepeat:false },
        { action:'HOME', label:'Home / Refresh', input:'BrowserHome', gesture:'single', allowRepeat:false },
        { action:'PLAY_PAUSE', label:'Play / Pause', input:'MediaPlayPause', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_CONTROL', label:'Player control mode', input:'F6', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_SEARCH_HANDOFF', label:'Search handoff toggle', input:'F7', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_SESSION_NAV', label:'Navigation mode this session', input:'', gesture:'single', allowRepeat:false },
        { action:'EXIT_JELLYFIN', label:'Exit Jellyfin / HTPC', input:'BrowserBack', gesture:'long', allowRepeat:false }
    ];

    function makeDefaultProfile(id = 'default', name = 'Default') {
        return {
            id,
            name,
            bindings: Object.fromEntries(ACTIONS.map(meta => [meta.action, {
                action: meta.action,
                label: meta.label,
                input: meta.input,
                gesture: meta.gesture,
                longPressMs: meta.gesture === 'long' ? 3000 : null,
                allowRepeat: meta.allowRepeat
            }]))
        };
    }

    const USER_DEFAULTS = Object.freeze({
        behavior: { cardActivate: 'openDetails' },
        failure: { unknownPage: 'generic' },
        search: { handoffEnabled: true, globalActionsWhileTyping: true, directionExit: 'nearest' },
        notifications: { airNavToggle: true, profileChanged: true },
        navigation: { clampAtEdges: true, preservePreferredX: true, returnByGeometry: true },
        focus: { scale: 1.045, applyScale: true, outlineWidthPx: 3, outlineOffsetPx: 3, borderRadiusPx: 12, transitionMs: 120 },
        scroll: { behavior: 'smooth', horizontalOnlyWhenNeeded: true, verticalCenter: true, headerSelectionScrollTop: true, horizontalTriggerInsetPx: 42, horizontalRestInsetPx: 88 },
        gestures: { doublePressMs: 250, longPressMs: 3000, repeatDelayMs: 360, repeatIntervalMs: 115, accelerationEnabled: true, minRepeatIntervalMs: 55 },
        profiles: { switchMode: 'combination', syncAcrossUser: true, activeProfileId: 'default', items: { default: makeDefaultProfile() } },
        quickActions: { entry: 'menu', defaultAction: 'play' },
        menu: { onCard: 'quickActions', inPlayer: 'toggleControl' },
        back: { page: 'homeFallback', modal: 'close', player: 'closeContextThenExit' },
        home: { action: 'navigateRescan' },
        player: { ownership: 'dedicated', allowOsdTimeout: true, volumeStep: 5, seekSeconds: 10, playPauseOutside: 'disabled' },
        forms: { dropdownBack: 'restore', numericBack: 'saveExit' }
    });

    const CLIENT_DEFAULTS = Object.freeze({
        schemaVersion: CLIENT_SCHEMA_VERSION,
        airNavEnabled: false,
        activeProfileId: 'default',
        mouseClickClearsFocus: true,
        helperEnabled: false,
        helperBaseUrl: 'http://127.0.0.1:8765',
        helperPersistentWarning: true,
        htpcExit: { enabled: false, gesture: 'long', longPressMs: 3000, confirmation: true, loadingThresholdMs: 5000, frontendName: 'Flex Launcher' },
        protectedInputs: [
            { enabled:true, id:'browseHome', vkCode:172, vkName:'VK_BROWSER_HOME', key:'BrowserHome', code:'' },
            { enabled:true, id:'browseBack', vkCode:166, vkName:'VK_BROWSER_BACK', key:'BrowserBack', code:'' },
            { enabled:false, id:'contextMenu', vkCode:93, vkName:'VK_APPS', key:'ContextMenu', code:'ContextMenu' }
        ]
    });

    const listeners = new Map();
    let started = false;
    let supervisorTimer = null;
    let observedToken = null;
    let hydratedToken = null;
    let lastHydrationAttemptAt = 0;
    let lastServerRefreshAt = 0;
    let lastClientFingerprint = null;
    let lastError = null;
    let status = 'idle';
    let globalDocument = {};
    let userState = clone(USER_DEFAULTS);
    let clientState = clone(CLIENT_DEFAULTS);
    let runtimeConfig = null;
    let refreshPromise = null;

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function isObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function merge(base, incoming) {
        if (!isObject(base)) return incoming === undefined ? clone(base) : clone(incoming);
        const out = clone(base);
        if (!isObject(incoming)) return out;
        Object.keys(incoming).forEach(key => {
            out[key] = isObject(out[key]) && isObject(incoming[key])
                ? merge(out[key], incoming[key])
                : clone(incoming[key]);
        });
        return out;
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
                try { callback(payload); }
                catch (error) { console.error(LOG, `Listener failed for ${event}.`, error); }
            });
        }

        try {
            window.dispatchEvent(new CustomEvent(`jellyfin-qol-runtime-${event}`, {
                detail: clone(payload)
            }));
        } catch (_) {}
    }

    function getAccessToken() {
        const client = window.ApiClient;
        if (!client) return null;
        try {
            if (typeof client.accessToken === 'function') return client.accessToken() || null;
            if (typeof client.accessToken === 'string') return client.accessToken || null;
        } catch (_) {}
        return null;
    }

    function getToken() {
        return getAccessToken();
    }

    async function apiRequest(path, options = {}) {
        if (!window.ApiClient?.getUrl) throw new Error('ApiClient is not ready.');
        const headers = { Accept:'application/json', ...(options.headers || {}) };
        const token = getToken();
        if (token && !headers.Authorization) headers.Authorization = `MediaBrowser Token="${token}"`;
        if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

        const response = await fetch(ApiClient.getUrl(path), {
            ...options,
            headers,
            credentials:'same-origin'
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        if (!text) return null;
        try { return JSON.parse(text); } catch (_) { return text; }
    }

    function readJsonStorage(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (error) {
            console.warn(LOG, `Could not read ${key}.`, error);
            return null;
        }
    }

    function getClientFingerprint() {
        try {
            return JSON.stringify({
                client: localStorage.getItem(CLIENT_STORAGE_KEY),
                enrollment: localStorage.getItem(AIRNAV_ENROLLMENT_KEY)
            });
        } catch (_) {
            return null;
        }
    }

    function loadClientState() {
        const stored = readJsonStorage(CLIENT_STORAGE_KEY);
        const next = merge(CLIENT_DEFAULTS, stored || {});

        // Preserve the Phase 13.1 client-local enrollment boundary during the
        // migration. This flag is intentionally not synced through the user API.
        const enrollment = readJsonStorage(AIRNAV_ENROLLMENT_KEY);
        if (typeof enrollment?.enabled === 'boolean') next.airNavEnabled = enrollment.enabled;

        // While the prototype launcher is still active it remains authoritative
        // for the live enrollment flag. This compatibility read disappears once
        // the launcher itself is migrated into the production bootstrap.
        try {
            const liveEnrollment = QoL.airNavClient?.getState?.();
            if (typeof liveEnrollment?.enabled === 'boolean') next.airNavEnabled = liveEnrollment.enabled;
        } catch (_) {}

        next.schemaVersion = CLIENT_SCHEMA_VERSION;
        clientState = next;
        lastClientFingerprint = getClientFingerprint();
        return clone(clientState);
    }

    function defaultsFromGlobal(document) {
        const source = document?.global || document || {};
        const next = clone(USER_DEFAULTS);

        for (const key of [
            'behavior', 'failure', 'search', 'notifications', 'navigation',
            'focus', 'scroll', 'gestures', 'player'
        ]) {
            if (source[key]) next[key] = merge(next[key], source[key]);
        }

        const defaultProfileId = String(source.defaultProfileId || 'default');
        next.profiles.activeProfileId = defaultProfileId;
        if (!next.profiles.items[defaultProfileId]) {
            next.profiles.items[defaultProfileId] = makeDefaultProfile(
                defaultProfileId,
                defaultProfileId === 'default' ? 'Default' : defaultProfileId
            );
        }

        return next;
    }

    function normalizeProfiles(nextUserState, nextClientState) {
        nextUserState.profiles = merge(USER_DEFAULTS.profiles, nextUserState.profiles || {});
        if (!isObject(nextUserState.profiles.items) || !Object.keys(nextUserState.profiles.items).length) {
            nextUserState.profiles.items = { default: makeDefaultProfile() };
        }

        Object.entries(nextUserState.profiles.items).forEach(([id, profile]) => {
            const base = makeDefaultProfile(id, profile?.name || id);
            nextUserState.profiles.items[id] = merge(base, profile || {});
            nextUserState.profiles.items[id].id = id;
        });

        if (!nextUserState.profiles.items[nextUserState.profiles.activeProfileId]) {
            nextUserState.profiles.activeProfileId = Object.keys(nextUserState.profiles.items)[0];
        }

        if (!nextUserState.profiles.items[nextClientState.activeProfileId]) {
            nextClientState.activeProfileId = nextUserState.profiles.activeProfileId;
        }
    }

    function createRuntimeConfig(source, authenticated) {
        normalizeProfiles(userState, clientState);
        const activeProfileId = clientState.activeProfileId || userState.profiles.activeProfileId;
        const activeProfile = userState.profiles.items[activeProfileId] || null;

        return {
            schemaVersion: 1,
            runtimeVersion: VERSION,
            generatedAt: new Date().toISOString(),
            source,
            authenticated: authenticated === true,
            airNavEnabled: clientState.airNavEnabled === true,
            activeProfileId,
            activeProfile: clone(activeProfile),
            behavior: clone(userState.behavior),
            failure: clone(userState.failure),
            search: clone(userState.search),
            notifications: clone(userState.notifications),
            navigation: clone(userState.navigation),
            focus: clone(userState.focus),
            scroll: clone(userState.scroll),
            gestures: clone(userState.gestures),
            profiles: clone(userState.profiles),
            quickActions: clone(userState.quickActions),
            menu: clone(userState.menu),
            back: clone(userState.back),
            home: clone(userState.home),
            player: clone(userState.player),
            forms: clone(userState.forms),
            client: clone(clientState),
            user: clone(userState),
            global: clone(globalDocument)
        };
    }

    function applyKnownCompatibilitySettings(config, reason) {
        const results = {};

        // Only call prototype APIs whose contract is already established. Input,
        // profiles and gestures are deliberately not migrated in this pass.
        if (QoL.airScroll?.setBehavior && config.scroll?.behavior) {
            try {
                QoL.airScroll.setBehavior(config.scroll.behavior);
                results.scrollBehavior = 'applied';
            } catch (error) {
                results.scrollBehavior = 'failed';
                console.warn(LOG, 'Prototype scroll behavior apply failed.', error);
            }
        }

        console.log(LOG, 'Runtime config published.', {
            reason,
            source: config.source,
            authenticated: config.authenticated,
            airNavEnabled: config.airNavEnabled,
            activeProfileId: config.activeProfileId,
            compatibility: results
        });

        return results;
    }

    function publish(source, authenticated, reason) {
        runtimeConfig = createRuntimeConfig(source, authenticated);
        QoL.runtimeConfig = runtimeConfig;
        const compatibility = applyKnownCompatibilitySettings(runtimeConfig, reason);
        const snapshot = getState();
        emit('settings-changed', { reason, config:runtimeConfig, compatibility, state:snapshot });
        return clone(runtimeConfig);
    }

    function activateAnonymous(reason) {
        globalDocument = {};
        userState = defaultsFromGlobal({});
        loadClientState();
        normalizeProfiles(userState, clientState);
        hydratedToken = null;
        lastServerRefreshAt = 0;
        lastError = null;
        status = 'anonymous';
        return publish('bootstrap+client-local', false, reason);
    }

    async function hydrateAuthenticated(reason, forceServer) {
        const requestToken = getAccessToken();
        if (!requestToken) return activateAnonymous(`${reason}:no-token`);

        if (!forceServer && hydratedToken === requestToken && runtimeConfig?.authenticated) {
            loadClientState();
            status = 'ready';
            return publish('cached-server+client-local', true, reason);
        }

        lastHydrationAttemptAt = Date.now();
        status = 'loading';

        const payload = await apiRequest('JellyfinQoL/UserSettings');

        // A logout or user switch during the request must never publish the old
        // user's settings into the new session.
        if (getAccessToken() !== requestToken) {
            console.log(LOG, 'Discarded stale authenticated settings response.');
            return refresh(`${reason}:stale-auth`, { forceServer:true });
        }

        globalDocument = payload?.global || {};
        const baseline = defaultsFromGlobal(globalDocument);
        userState = merge(baseline, payload?.user?.data || {});
        loadClientState();
        normalizeProfiles(userState, clientState);

        hydratedToken = requestToken;
        observedToken = requestToken;
        lastServerRefreshAt = Date.now();
        lastError = null;
        status = 'ready';

        return publish(
            payload?.user?.data ? 'server-user+global+client-local' : 'server-global+client-local',
            true,
            reason
        );
    }

    async function refresh(reason = 'manual', options = {}) {
        if (refreshPromise && !options.forceServer) return refreshPromise;

        const forceServer = options.forceServer === true;
        refreshPromise = (async () => {
            loadClientState();
            const token = getAccessToken();
            observedToken = token;

            if (!token) return activateAnonymous(reason);

            try {
                return await hydrateAuthenticated(reason, forceServer);
            } catch (error) {
                lastError = error;
                status = 'degraded';
                console.warn(LOG, 'Authenticated settings hydration failed; keeping safe bootstrap settings.', error);

                // Never keep a previous authenticated user's document after a
                // failed user switch. If this token has never hydrated, publish
                // bootstrap defaults plus this device's local state.
                if (hydratedToken !== token) {
                    globalDocument = {};
                    userState = defaultsFromGlobal({});
                    normalizeProfiles(userState, clientState);
                    runtimeConfig = createRuntimeConfig('bootstrap-fallback+client-local', true);
                    QoL.runtimeConfig = runtimeConfig;
                    emit('settings-changed', { reason, config:runtimeConfig, compatibility:{}, state:getState() });
                }

                emit('error', { reason, error:String(error?.message || error), state:getState() });
                return clone(runtimeConfig);
            } finally {
                refreshPromise = null;
            }
        })();

        return refreshPromise;
    }

    async function supervisorTick(reason = 'poll') {
        const token = getAccessToken();
        const tokenChanged = token !== observedToken;
        const clientChanged = getClientFingerprint() !== lastClientFingerprint;
        const now = Date.now();

        if (tokenChanged) {
            observedToken = token;
            hydratedToken = null;
            if (!token) {
                activateAnonymous('logout-detected');
                return;
            }
            await refresh('authentication-changed', { forceServer:true });
            return;
        }

        if (clientChanged) {
            await refresh('client-local-changed');
            return;
        }

        if (token && lastError && now - lastHydrationAttemptAt >= RETRY_INTERVAL_MS) {
            await refresh('retry-after-error', { forceServer:true });
            return;
        }

        if (token && now - lastServerRefreshAt >= SERVER_REFRESH_INTERVAL_MS) {
            await refresh('periodic-server-refresh', { forceServer:true });
            return;
        }

        if (!token && status !== 'anonymous') activateAnonymous('anonymous-supervisor');
    }

    function start() {
        if (started) return getState();
        started = true;
        observedToken = getAccessToken();
        loadClientState();

        refresh('startup', { forceServer:!!observedToken }).catch(error => {
            console.warn(LOG, 'Initial refresh failed.', error);
        });

        supervisorTimer = setInterval(() => {
            supervisorTick().catch(error => console.warn(LOG, 'Supervisor tick failed.', error));
        }, SUPERVISOR_INTERVAL_MS);

        window.addEventListener('focus', handleFocus);
        window.addEventListener('storage', handleStorage);
        window.addEventListener('jellyfin-qol-runtime-refresh', handleExternalRefresh);

        console.log(LOG, 'Started.', {
            authenticated: !!observedToken,
            clientStorageKey: CLIENT_STORAGE_KEY,
            enrollmentStorageKey: AIRNAV_ENROLLMENT_KEY
        });

        return getState();
    }

    function stop() {
        if (!started) return getState();
        started = false;
        if (supervisorTimer) clearInterval(supervisorTimer);
        supervisorTimer = null;
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener('jellyfin-qol-runtime-refresh', handleExternalRefresh);
        status = 'stopped';
        console.log(LOG, 'Stopped.');
        return getState();
    }

    function handleFocus() {
        refresh('window-focus', { forceServer:!!getAccessToken() }).catch(() => {});
    }

    function handleStorage(event) {
        if (![CLIENT_STORAGE_KEY, AIRNAV_ENROLLMENT_KEY].includes(event.key)) return;
        refresh('storage-event').catch(() => {});
    }

    function handleExternalRefresh(event) {
        refresh(event?.detail?.reason || 'external-event', {
            forceServer: event?.detail?.forceServer !== false
        }).catch(() => {});
    }

    function getConfig() {
        return clone(runtimeConfig);
    }

    function getState() {
        return {
            version: VERSION,
            started,
            status,
            authenticated: !!observedToken,
            hydrated: !!hydratedToken,
            source: runtimeConfig?.source || null,
            airNavEnabled: runtimeConfig?.airNavEnabled ?? clientState.airNavEnabled === true,
            activeProfileId: runtimeConfig?.activeProfileId || clientState.activeProfileId || null,
            lastServerRefreshAt: lastServerRefreshAt || null,
            lastError: lastError ? String(lastError?.message || lastError) : null
        };
    }

    // ---------------------------------------------------------------------
    // Production profile projection.
    //
    // This is intentionally READ-ONLY in this migration step. The
    // authoritative data remains runtimeConfig, which is resolved from
    // server-global + user + client-local settings above.
    //
    // Existing prototype airKeybinds remains active until this projection has
    // been verified. Input/recording/gesture ownership is migrated later.
    // ---------------------------------------------------------------------

    const PROFILE_ACTION_META = Object.freeze({
        UP: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true }),
        DOWN: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true }),
        LEFT: Object.freeze({ critical:true, allowRepeat:true }),
        RIGHT: Object.freeze({ critical:true, allowRepeat:true }),
        ACTIVATE: Object.freeze({ critical:true, allowRepeat:false }),
        BACK: Object.freeze({ critical:true, allowRepeat:false }),
        ENTER_ACTIONS: Object.freeze({ critical:false, allowRepeat:false }),
        MENU: Object.freeze({ critical:false, allowRepeat:false }),
        HOME: Object.freeze({ critical:false, allowRepeat:false }),
        PLAY_PAUSE: Object.freeze({ critical:false, allowRepeat:false }),
        TOGGLE_CONTROL: Object.freeze({ critical:false, allowRepeat:false, global:true }),
        TOGGLE_SEARCH_HANDOFF: Object.freeze({ critical:false, allowRepeat:false, global:true }),
        TOGGLE_SESSION_NAV: Object.freeze({ critical:false, allowRepeat:false, global:true }),
        EXIT_JELLYFIN: Object.freeze({ critical:false, allowRepeat:false, global:true })
    });

    function profileConfig() {
        return runtimeConfig || QoL.runtimeConfig || null;
    }

    function profileItems() {
        return profileConfig()?.profiles?.items || {};
    }

    function profileGetActiveProfileId() {
        const config = profileConfig();
        return config?.activeProfileId ||
            config?.profiles?.activeProfileId ||
            clientState?.activeProfileId ||
            'default';
    }

    function profileGetProfile(profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileItems()?.[id] || null;
        return clone(profile);
    }

    function profileGetActiveProfile() {
        return profileGetProfile(profileGetActiveProfileId());
    }

    function profileGetActionMeta(action) {
        return clone(PROFILE_ACTION_META[String(action || '').toUpperCase()] || {});
    }

    function profileIsGlobalAction(action) {
        return profileGetActionMeta(action).global === true;
    }

    function profileIsTextHandoffAction(action) {
        return profileGetActionMeta(action).textHandoff === true;
    }

    function keyboardTriggerFromInput(input) {
        const value = String(input || '').trim();
        if (!value) return null;

        // Browser/consumer keys do not reliably populate KeyboardEvent.code.
        // Keep them key-based so synthetic GuardManager relays match too.
        const keyOnly =
            /^(Browser|Media|AudioVolume|Launch|Zoom|PrintScreen|Pause)/.test(value);

        return {
            type: 'keydown',
            code: keyOnly ? null : value,
            key: keyOnly ? value : null,
            modifiers: {
                ctrl: false,
                alt: false,
                shift: false,
                meta: false
            }
        };
    }

    function profileBindingDescriptor(action, binding, profileId) {
        if (!binding || typeof binding !== 'object') return null;

        // Future profile schemas may already carry a neutral descriptor.
        if (binding.adapter && binding.trigger) {
            return {
                ...clone(binding),
                action: String(binding.action || action || '').toUpperCase(),
                profileId: profileId || null,
                gesture: binding.gesture || 'single'
            };
        }

        const normalizedAction = String(binding.action || action || '').toUpperCase();
        const trigger = keyboardTriggerFromInput(binding.input);

        if (!normalizedAction || !trigger) return null;

        const meta = PROFILE_ACTION_META[normalizedAction] || {};

        return {
            id: binding.id || `runtime:${profileId || 'default'}:${normalizedAction.toLowerCase()}`,
            action: normalizedAction,
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger,
            allowRepeat:
                typeof binding.allowRepeat === 'boolean'
                    ? binding.allowRepeat
                    : meta.allowRepeat !== false,

            // Gesture metadata is retained here but deliberately NOT resolved
            // in this step. The later Gesture Resolver will own timing/phase.
            gesture: binding.gesture || (meta.allowRepeat ? 'repeat' : 'single'),
            longPressMs:
                binding.longPressMs == null
                    ? null
                    : Number(binding.longPressMs),
            profileId: profileId || null
        };
    }

    function profileGetBindings(profileId = null, adapter = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileItems()?.[id];

        if (!profile) return [];

        const source = profile.bindings || {};
        let entries;

        if (Array.isArray(source)) {
            entries = source.map(binding => [
                String(binding?.action || ''),
                binding
            ]);
        } else {
            entries = Object.entries(source);
        }

        return entries
            .map(([action, binding]) =>
                profileBindingDescriptor(action, binding, id)
            )
            .filter(Boolean)
            .filter(binding =>
                adapter ? binding.adapter === adapter : true
            );
    }

    function profileGetBinding(action, profileId = null) {
        const normalized = String(action || '').toUpperCase();
        return profileGetBindings(profileId)
            .find(binding => binding.action === normalized) || null;
    }

    function profileGetState() {
        const config = profileConfig();
        const activeProfileId = profileGetActiveProfileId();
        const profiles = profileItems();

        return {
            version: '1.0.0',
            source: config?.source || null,
            authenticated: config?.authenticated === true,
            activeProfileId,
            profileIds: Object.keys(profiles),
            activeProfile: profileGetProfile(activeProfileId),
            bindings: profileGetBindings(activeProfileId),
            bindingCount: profileGetBindings(activeProfileId).length,
            readOnly: true,
            gestureResolutionActive: false
        };
    }

    QoL.profileRuntime = Object.freeze({
        version: '1.0.0',
        ACTION_META: PROFILE_ACTION_META,
        getState: profileGetState,
        getActiveProfileId: profileGetActiveProfileId,
        getProfile: profileGetProfile,
        getActiveProfile: profileGetActiveProfile,
        getBindings: profileGetBindings,
        getBinding: profileGetBinding,
        getActionMeta: profileGetActionMeta,
        isGlobalAction: profileIsGlobalAction,
        isTextHandoffAction: profileIsTextHandoffAction
    });
    QoL.runtimeSettings = Object.freeze({
        version: VERSION,
        start,
        stop,
        refresh,
        getConfig,
        getState,
        on,
        off,
        defaults: Object.freeze({
            user: clone(USER_DEFAULTS),
            client: clone(CLIENT_DEFAULTS),
            userSchemaVersion: USER_SCHEMA_VERSION,
            clientSchemaVersion: CLIENT_SCHEMA_VERSION,
            clientStorageKey: CLIENT_STORAGE_KEY,
            enrollmentStorageKey: AIRNAV_ENROLLMENT_KEY
        })
    });
})();
