(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.runtimeSettings?.version === '1.0.4') return;

    const VERSION = '1.0.4';
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
        { action:'BACK', label:'Back', input:'Escape', gesture:'single', allowRepeat:false },
        { action:'ENTER_ACTIONS', label:'Item actions', input:'KeyA', gesture:'single', allowRepeat:false },
        { action:'MENU', label:'Menu', input:'ContextMenu', gesture:'single', allowRepeat:false },
        { action:'HOME', label:'Home / Refresh', input:'BrowserHome', gesture:'single', allowRepeat:false },
        { action:'PLAY_PAUSE', label:'Play / Pause', input:'MediaPlayPause', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_CONTROL', label:'Player control mode', input:'F6', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_SEARCH_HANDOFF', label:'Search handoff toggle', input:'F7', gesture:'single', allowRepeat:false },
        { action:'TOGGLE_SESSION_NAV', label:'Navigation mode this session', input:'', gesture:'single', allowRepeat:false },
        { action:'EXIT_JELLYFIN', label:'Exit Jellyfin / HTPC', input:'BrowserBack', gesture:'long', allowRepeat:false }
    ];

    function makeBaseBindings() {
        return Object.fromEntries(ACTIONS.map(meta => [meta.action, {
            action: meta.action,
            label: meta.label,
            input: meta.input,
            gesture: meta.gesture,
            longPressMs: meta.gesture === 'long' ? 3000 : null,
            allowRepeat: meta.allowRepeat
        }]));
    }

    function makeKeyboardProfile(id = 'default', name = 'Default') {
        const bindings = makeBaseBindings();
        bindings.BACK = {
            ...bindings.BACK,
            id: 'bind:back:keyboard:keydown-escape-escape',
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger: {
                type: 'keydown',
                code: 'Escape',
                key: 'Escape',
                modifiers: { ctrl:false, alt:false, shift:false, meta:false }
            }
        };
        return { id, name, bindings };
    }

    function makeAirNavProfile(id = 'airnav', name = 'Airnav') {
        const bindings = makeBaseBindings();
        bindings.ACTIVATE = {
            ...bindings.ACTIVATE,
            id: 'bind:activate:keyboard:keydown-enter-enter',
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger: {
                type: 'keydown',
                code: 'Enter',
                key: 'Enter',
                modifiers: { ctrl:false, alt:false, shift:false, meta:false }
            }
        };
        bindings.BACK.input = 'BrowserBack';
        bindings.ENTER_ACTIONS = {
            ...bindings.ENTER_ACTIONS,
            input: 'ContextMenu',
            id: 'bind:enter_actions:keyboard:keydown-contextmenu-contextmenu',
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger: {
                type: 'keydown',
                code: 'ContextMenu',
                key: 'ContextMenu',
                modifiers: { ctrl:false, alt:false, shift:false, meta:false }
            }
        };
        bindings.MENU = {
            ...bindings.MENU,
            input: '',
            id: `runtime:${id}:menu`,
            adapter: null,
            deviceMatch: '*',
            trigger: null
        };
        bindings.PLAY_PAUSE = {
            ...bindings.PLAY_PAUSE,
            input: 'Enter',
            id: 'bind:play_pause:keyboard:keydown-enter-enter',
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger: {
                type: 'keydown',
                code: 'Enter',
                key: 'Enter',
                modifiers: { ctrl:false, alt:false, shift:false, meta:false }
            }
        };
        bindings.TOGGLE_CONTROL = {
            ...bindings.TOGGLE_CONTROL,
            input: 'ContextMenu',
            id: 'bind:toggle_control:keyboard:keydown-contextmenu-contextmenu',
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger: {
                type: 'keydown',
                code: 'ContextMenu',
                key: 'ContextMenu',
                modifiers: { ctrl:false, alt:false, shift:false, meta:false }
            }
        };
        return { id, name, bindings };
    }

    function makeDefaultProfile(id = 'default', name = id === 'airnav' ? 'Airnav' : 'Default') {
        return id === 'airnav'
            ? makeAirNavProfile(id, name)
            : makeKeyboardProfile(id, name);
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
        profiles: { switchMode: 'combination', syncAcrossUser: true, activeProfileId: 'default', items: { default: makeDefaultProfile(), airnav: makeDefaultProfile('airnav', 'Airnav') } },
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

        const enrollment = readJsonStorage(AIRNAV_ENROLLMENT_KEY);
        if (typeof enrollment?.enabled === 'boolean') next.airNavEnabled = enrollment.enabled;

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
            nextUserState.profiles.items = clone(USER_DEFAULTS.profiles.items);
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
    // Production profile runtime - Part 2: mutations + persistence.
    // Old QoL.airKeybinds remains authoritative until Part 3 takeover.
    // ---------------------------------------------------------------------

    const ALL_INPUT_CONTEXTS = Object.freeze(['page', 'modal', 'text', 'player', 'player-control']);
    const NAVIGATION_INPUT_CONTEXTS = Object.freeze(['page', 'modal', 'text', 'player-control']);
    const PROFILE_ACTION_META = Object.freeze({
        UP: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true, contexts:ALL_INPUT_CONTEXTS }),
        DOWN: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true, contexts:ALL_INPUT_CONTEXTS }),
        LEFT: Object.freeze({ critical:true, allowRepeat:true, contexts:ALL_INPUT_CONTEXTS }),
        RIGHT: Object.freeze({ critical:true, allowRepeat:true, contexts:ALL_INPUT_CONTEXTS }),
        ACTIVATE: Object.freeze({ critical:true, allowRepeat:false, contexts:NAVIGATION_INPUT_CONTEXTS }),
        BACK: Object.freeze({ critical:true, allowRepeat:false, contexts:ALL_INPUT_CONTEXTS }),
        ENTER_ACTIONS: Object.freeze({ critical:false, allowRepeat:false, contexts:Object.freeze(['page']) }),
        MENU: Object.freeze({ critical:false, allowRepeat:false, contexts:Object.freeze(['page', 'player', 'player-control']) }),
        HOME: Object.freeze({ critical:false, allowRepeat:false, global:true, contexts:ALL_INPUT_CONTEXTS }),
        PLAY_PAUSE: Object.freeze({ critical:false, allowRepeat:false, contexts:Object.freeze(['player']) }),
        TOGGLE_CONTROL: Object.freeze({ critical:false, allowRepeat:false, global:true, contexts:Object.freeze(['player', 'player-control', 'modal', 'text']) }),
        TOGGLE_SEARCH_HANDOFF: Object.freeze({ critical:false, allowRepeat:false, global:true, contexts:Object.freeze(['page', 'text']) }),
        TOGGLE_SESSION_NAV: Object.freeze({ critical:false, allowRepeat:false, global:true, contexts:ALL_INPUT_CONTEXTS }),
        EXIT_JELLYFIN: Object.freeze({ critical:false, allowRepeat:false, global:true, contexts:ALL_INPUT_CONTEXTS })
    });

    const profileMutationListeners = new Map();
    let profilePersistChain = Promise.resolve();
    let profileLastPersistAt = null;
    let profileLastPersistError = null;

    function profileConfig() {
        return runtimeConfig || QoL.runtimeConfig || null;
    }

    function profileItems() {
        return profileConfig()?.profiles?.items || {};
    }

    function profileGetActiveProfileId() {
        const config = profileConfig();
        return config?.activeProfileId || config?.profiles?.activeProfileId || clientState?.activeProfileId || 'default';
    }

    function profileGetProfile(profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        return clone(profileItems()?.[id] || null);
    }

    function profileGetActiveProfile() {
        return profileGetProfile(profileGetActiveProfileId());
    }

    function profileGetStoredProfile(profileId = null) {
        normalizeProfiles(userState, clientState);
        const id = String(profileId || profileGetActiveProfileId());
        return userState.profiles?.items?.[id] || null;
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

    function profileNormalizeModifiers(value) {
        return { ctrl:!!value?.ctrl, alt:!!value?.alt, shift:!!value?.shift, meta:!!value?.meta };
    }

    function profileNormalizeTrigger(value, adapter = '') {
        if (!value || typeof value !== 'object') return null;
        adapter = String(adapter || '').toLowerCase();
        const type = String(value.type || (adapter === 'keyboard' ? 'keydown' : '')).trim();
        if (!type) return null;
        const trigger = { type };

        if (adapter === 'keyboard' || type === 'keydown' || type === 'keyup') {
            trigger.code = value.code || null;
            trigger.key = value.key || null;
            trigger.modifiers = profileNormalizeModifiers(value.modifiers);
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
            if (!['up','down','left','right'].includes(direction)) return null;
            trigger.direction = direction;
            return trigger;
        }
        if (type === 'gamepad-button') {
            const button = Number(value.button);
            if (!Number.isInteger(button)) return null;
            trigger.button = button;
            trigger.threshold = Number.isFinite(Number(value.threshold)) ? Math.min(1, Math.max(0, Number(value.threshold))) : 0.5;
            return trigger;
        }
        if (type === 'gamepad-axis') {
            const axis = Number(value.axis);
            const direction = String(value.direction || '').toLowerCase();
            if (!Number.isInteger(axis) || !['positive','negative'].includes(direction)) return null;
            const threshold = Number.isFinite(Number(value.threshold)) ? Math.min(0.98, Math.max(0.2, Number(value.threshold))) : 0.65;
            const releaseThreshold = Number.isFinite(Number(value.releaseThreshold)) ? Math.min(threshold, Math.max(0.05, Number(value.releaseThreshold))) : Math.min(0.45, threshold);
            trigger.axis = axis;
            trigger.direction = direction;
            trigger.threshold = threshold;
            trigger.releaseThreshold = releaseThreshold;
            return trigger;
        }

        Object.entries(value).forEach(([key, item]) => {
            if (key === 'type' || item == null) return;
            if (['string','number','boolean'].includes(typeof item)) trigger[key] = item;
        });
        return trigger;
    }

    function profileSlugify(value) {
        return String(value || 'input').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'input';
    }

    function keyboardTriggerFromInput(input) {
        const value = String(input || '').trim();
        if (!value) return null;
        const keyOnly = /^(Browser|Media|AudioVolume|Launch|Zoom|PrintScreen|Pause)/.test(value);
        return profileNormalizeTrigger({ type:'keydown', code:keyOnly ? null : value, key:keyOnly ? value : null, modifiers:{} }, 'keyboard');
    }

    function profileNormalizeBinding(value, index = 0) {
        if (!value?.action || !value?.adapter || !value?.trigger) return null;
        const action = String(value.action).toUpperCase();
        const adapter = String(value.adapter).toLowerCase();
        const meta = PROFILE_ACTION_META[action] || {};
        const trigger = profileNormalizeTrigger(value.trigger, adapter);
        if (!trigger) return null;
        return {
            id:value.id || `bind:${action.toLowerCase()}:${adapter}:${index}`,
            action,
            adapter,
            deviceMatch:value.deviceMatch || '*',
            trigger,
            allowRepeat:typeof value.allowRepeat === 'boolean' ? value.allowRepeat : meta.allowRepeat !== false,
            gesture:String(value.gesture || (meta.allowRepeat ? 'repeat' : 'single')).toLowerCase(),
            longPressMs:value.longPressMs == null ? null : Number(value.longPressMs),
            profileId:value.profileId || null
        };
    }

    function profileBindingDescriptor(action, binding, profileId, index = 0) {
        if (!binding || typeof binding !== 'object') return null;
        const normalizedAction = String(binding.action || action || '').toUpperCase();
        if (!normalizedAction) return null;
        if (binding.adapter && binding.trigger) {
            return profileNormalizeBinding({ ...binding, action:normalizedAction, profileId:profileId || null }, index);
        }
        const trigger = keyboardTriggerFromInput(binding.input);
        if (!trigger) return null;
        return profileNormalizeBinding({
            id:binding.id || `runtime:${profileId || 'default'}:${normalizedAction.toLowerCase()}`,
            action:normalizedAction,
            adapter:'keyboard',
            deviceMatch:'*',
            trigger,
            allowRepeat:binding.allowRepeat,
            gesture:binding.gesture,
            longPressMs:binding.longPressMs,
            profileId:profileId || null
        }, index);
    }

    function profileGetBindings(profileId = null, adapter = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileItems()?.[id];
        if (!profile) return [];
        const source = profile.bindings || {};
        const entries = Array.isArray(source) ? source.map(binding => [String(binding?.action || ''), binding]) : Object.entries(source);
        const bindings = entries.map(([action, binding], index) => profileBindingDescriptor(action, binding, id, index)).filter(Boolean);
        return adapter ? bindings.filter(binding => binding.adapter === String(adapter).toLowerCase()) : bindings;
    }

    function profileGetBinding(action, profileId = null) {
        const normalized = String(action || '').toUpperCase();
        return profileGetBindings(profileId).find(binding => binding.action === normalized) || null;
    }

    function profileGetDefaultBindings() {
        const profile = makeDefaultProfile('default', 'Default');
        return Object.entries(profile.bindings || {}).map(([action, binding], index) => profileBindingDescriptor(action, binding, 'default', index)).filter(Boolean);
    }

    function profileMakeKeyboardBinding(action, code, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const identity = String(code || options.key || '').trim();
        if (!normalizedAction || !identity) return null;
        const meta = PROFILE_ACTION_META[normalizedAction] || {};
        const keyOnly = /^(Browser|Media|AudioVolume|Launch|Zoom|PrintScreen|Pause)/.test(identity);
        return profileNormalizeBinding({
            id:options.id || `bind:${normalizedAction.toLowerCase()}:keyboard:${profileSlugify(identity)}`,
            action:normalizedAction,
            adapter:'keyboard',
            deviceMatch:options.deviceMatch || '*',
            trigger:{ type:'keydown', code:keyOnly ? null : identity, key:options.key || (keyOnly ? identity : null), modifiers:profileNormalizeModifiers(options.modifiers) },
            allowRepeat:typeof options.allowRepeat === 'boolean' ? options.allowRepeat : meta.allowRepeat !== false,
            gesture:options.gesture || (meta.allowRepeat ? 'repeat' : 'single'),
            longPressMs:options.longPressMs ?? null
        });
    }

    function profileMakeCapturedBinding(action, capture, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const adapter = String(capture?.adapter || '').toLowerCase();
        const trigger = profileNormalizeTrigger(capture?.trigger, adapter);
        if (!normalizedAction || !adapter || !trigger) return null;
        const meta = PROFILE_ACTION_META[normalizedAction] || {};
        const triggerIdentity = [trigger.type, trigger.code, trigger.key, trigger.button, trigger.axis, trigger.direction].filter(value => value !== null && value !== undefined && value !== '').join('-');
        return profileNormalizeBinding({
            id:options.id || `bind:${normalizedAction.toLowerCase()}:${adapter}:${profileSlugify(triggerIdentity || 'input')}`,
            action:normalizedAction,
            adapter,
            deviceMatch:options.deviceMatch || capture.deviceMatch || '*',
            trigger,
            allowRepeat:typeof options.allowRepeat === 'boolean' ? options.allowRepeat : meta.allowRepeat !== false,
            gesture:options.gesture || profileGetBinding(normalizedAction)?.gesture || (meta.allowRepeat ? 'repeat' : 'single'),
            longPressMs:options.longPressMs ?? profileGetBinding(normalizedAction)?.longPressMs ?? null
        });
    }

    function profileDeviceScopesOverlap(a, b) {
        const left = a || '*';
        const right = b || '*';
        return left === '*' || right === '*' || left === right;
    }

    function profileSamePhysicalTrigger(a, b) {
        if (!a || !b || a.adapter !== b.adapter || !profileDeviceScopesOverlap(a.deviceMatch, b.deviceMatch)) return false;
        const at = a.trigger || {};
        const bt = b.trigger || {};
        const typeA = at.type || (a.adapter === 'keyboard' ? 'keydown' : '');
        const typeB = bt.type || (b.adapter === 'keyboard' ? 'keydown' : '');
        if (typeA !== typeB) return false;
        if (a.adapter === 'keyboard' || typeA === 'keydown' || typeA === 'keyup') {
            const am = profileNormalizeModifiers(at.modifiers);
            const bm = profileNormalizeModifiers(bt.modifiers);
            if (am.ctrl !== bm.ctrl || am.alt !== bm.alt || am.shift !== bm.shift || am.meta !== bm.meta) return false;
            if (at.code && bt.code) return at.code === bt.code;
            return !!(at.key && bt.key && at.key === bt.key);
        }
        if (typeA === 'pointer-button' || typeA === 'mouse-button') return Number(at.button) === Number(bt.button) && (!at.pointerType || !bt.pointerType || at.pointerType === bt.pointerType);
        if (typeA === 'wheel') return String(at.direction) === String(bt.direction);
        if (typeA === 'gamepad-button') return Number(at.button) === Number(bt.button);
        if (typeA === 'gamepad-axis') return Number(at.axis) === Number(bt.axis) && String(at.direction) === String(bt.direction);
        try { return JSON.stringify(at) === JSON.stringify(bt); } catch (_) { return false; }
    }

    function profileGesture(binding) {
        return String(binding?.gesture || (profileGetActionMeta(binding?.action).allowRepeat ? 'repeat' : 'single')).toLowerCase();
    }

    function profileActionContexts(action) {
        const contexts = PROFILE_ACTION_META[String(action || '').toUpperCase()]?.contexts;
        return new Set(Array.isArray(contexts) && contexts.length ? contexts : ALL_INPUT_CONTEXTS);
    }

    function profileActionContextsOverlap(leftAction, rightAction) {
        const left = profileActionContexts(leftAction);
        const right = profileActionContexts(rightAction);
        return [...left].some(context => right.has(context));
    }

    function profileAnalyzeConflicts(binding, profileId = null) {
        const normalized = profileNormalizeBinding(binding, 0);
        if (!normalized) return [];
        return profileGetBindings(profileId)
            .filter(item => item.id !== normalized.id)
            .filter(item => profileSamePhysicalTrigger(item, normalized))
            .filter(item => profileGesture(item) === profileGesture(normalized))
            .filter(item => profileActionContextsOverlap(item.action, normalized.action))
            .map(item => ({ binding:clone(item), sameAction:item.action === normalized.action, sameGesture:true, contextOverlap:true, criticalAction:profileGetActionMeta(item.action).critical === true, safeToKeepBoth:false }));
    }

    function profileGetCriticalActionsWithoutBindings(profileId = null, bindingsOverride = null) {
        const bindings = Array.isArray(bindingsOverride) ? bindingsOverride : profileGetBindings(profileId);
        return Object.entries(PROFILE_ACTION_META).filter(([, meta]) => meta.critical === true).map(([action]) => action).filter(action => !bindings.some(binding => binding.action === action));
    }

    function profileOn(event, callback) {
        if (typeof callback !== 'function') return () => {};
        if (!profileMutationListeners.has(event)) profileMutationListeners.set(event, new Set());
        profileMutationListeners.get(event).add(callback);
        return () => profileOff(event, callback);
    }

    function profileOff(event, callback) {
        const set = profileMutationListeners.get(event);
        if (!set) return;
        set.delete(callback);
        if (!set.size) profileMutationListeners.delete(event);
    }

    function profileEmit(event, payload) {
        const set = profileMutationListeners.get(event);
        if (set) [...set].forEach(callback => {
            try { callback(clone(payload)); }
            catch (error) { console.error('[JellyfinQoL.ProfileRuntime]', `Listener failed for ${event}.`, error); }
        });
        try { window.dispatchEvent(new CustomEvent(`jellyfin-qol-profile-${event}`, { detail:clone(payload) })); } catch (_) {}
    }

    function profileSaveClientState() {
        try {
            clientState.schemaVersion = CLIENT_SCHEMA_VERSION;
            localStorage.setItem(CLIENT_STORAGE_KEY, JSON.stringify(clientState));
            lastClientFingerprint = getClientFingerprint();
            return true;
        } catch (error) {
            console.error('[JellyfinQoL.ProfileRuntime] Could not save client-local profile activation.', error);
            return false;
        }
    }

    function profileQueueServerPersist(reason = 'profile-edit') {
        const token = getAccessToken();
        if (!token) return Promise.resolve({ saved:false, reason:'anonymous-session' });
        const snapshot = clone(userState);
        profilePersistChain = profilePersistChain.catch(() => null).then(async () => {
            try {
                await apiRequest('JellyfinQoL/UserSettings', { method:'PUT', body:JSON.stringify({ schemaVersion:USER_SCHEMA_VERSION, data:snapshot }) });
                profileLastPersistAt = Date.now();
                profileLastPersistError = null;
                lastServerRefreshAt = profileLastPersistAt;
                const result = { saved:true, reason, savedAt:profileLastPersistAt };
                profileEmit('persisted', result);
                return result;
            } catch (error) {
                profileLastPersistError = error;
                const result = { saved:false, reason:'server-save-failed', operation:reason, error:String(error?.message || error) };
                console.error('[JellyfinQoL.ProfileRuntime] Server profile persistence failed.', error);
                profileEmit('error', result);
                return result;
            }
        });
        return profilePersistChain;
    }

    function profileFlushPersistence() {
        return profilePersistChain;
    }

    function profilePublishMutation(reason) {
        const config = publish('runtime-profile-edit+client-local', !!getAccessToken(), `profile-runtime:${reason}`);
        const payload = { reason, activeProfileId:profileGetActiveProfileId(), config };
        profileEmit('changed', payload);
        return payload;
    }

    function profileActionLabel(action) {
        return ACTIONS.find(item => item.action === action)?.label || action;
    }

    function profileDescribeTrigger(binding) {
        const trigger = binding?.trigger || {};
        const type = String(trigger.type || '');
        if (binding?.adapter === 'keyboard' || type === 'keydown' || type === 'keyup') return trigger.code || trigger.key || '';
        if (type === 'pointer-button' || type === 'mouse-button') return `Pointer button ${trigger.button}`;
        if (type === 'wheel') return `Wheel ${trigger.direction || ''}`.trim();
        if (type === 'gamepad-button') return `Gamepad button ${trigger.button}`;
        if (type === 'gamepad-axis') return `Gamepad axis ${trigger.axis} ${trigger.direction || ''}`.trim();
        return [binding?.adapter || 'input', type || 'trigger'].join(':');
    }

    function profileStoredBindingFromDescriptor(descriptor, existing = null) {
        const normalized = profileNormalizeBinding(descriptor, 0);
        if (!normalized) return null;
        const meta = PROFILE_ACTION_META[normalized.action] || {};
        const gesture = normalized.gesture || existing?.gesture || (meta.allowRepeat ? 'repeat' : 'single');
        return {
            ...(isObject(existing) ? clone(existing) : {}),
            id:normalized.id,
            action:normalized.action,
            label:existing?.label || profileActionLabel(normalized.action),
            input:profileDescribeTrigger(normalized),
            adapter:normalized.adapter,
            deviceMatch:normalized.deviceMatch || '*',
            trigger:clone(normalized.trigger),
            gesture,
            longPressMs:gesture === 'long' ? (normalized.longPressMs || existing?.longPressMs || userState?.gestures?.longPressMs || 3000) : null,
            allowRepeat:typeof normalized.allowRepeat === 'boolean' ? normalized.allowRepeat : meta.allowRepeat !== false
        };
    }

    function profileEmptyStoredBinding(action, existing = null) {
        const normalizedAction = String(action || '').toUpperCase();
        const meta = PROFILE_ACTION_META[normalizedAction] || {};
        const gesture = existing?.gesture || (meta.allowRepeat ? 'repeat' : 'single');
        return {
            ...(isObject(existing) ? clone(existing) : {}),
            id:existing?.id || `runtime:${profileGetActiveProfileId()}:${normalizedAction.toLowerCase()}`,
            action:normalizedAction,
            label:existing?.label || profileActionLabel(normalizedAction),
            input:'',
            adapter:null,
            deviceMatch:'*',
            trigger:null,
            gesture,
            longPressMs:gesture === 'long' ? (existing?.longPressMs || userState?.gestures?.longPressMs || 3000) : null,
            allowRepeat:typeof existing?.allowRepeat === 'boolean' ? existing.allowRepeat : meta.allowRepeat !== false
        };
    }

    function profilePersist(reason = 'manual-profile-persist') {
        profileQueueServerPersist(reason);
        return true;
    }

    function profileSetActiveProfile(profileId) {
        const id = String(profileId || '');
        if (!profileGetStoredProfile(id)) return { changed:false, reason:'profile-not-found', profileId:id };
        const previous = profileGetActiveProfileId();
        if (previous === id) return { changed:false, reason:'profile-already-active', profileId:id };
        clientState.activeProfileId = id;
        if (!profileSaveClientState()) {
            clientState.activeProfileId = previous;
            return { changed:false, reason:'client-save-failed', profileId:id };
        }
        profilePublishMutation('profile-changed');
        const result = { changed:true, previous, profileId:id };
        profileEmit('profileChanged', { ...result, profile:profileGetProfile(id) });
        return result;
    }

    function profileCreateProfile(name, options = {}) {
        normalizeProfiles(userState, clientState);
        const items = userState.profiles.items;
        const base = options.baseProfileId ? items[options.baseProfileId] : items[profileGetActiveProfileId()];
        const idBase = profileSlugify(options.id || name || 'profile');
        let id = idBase;
        let suffix = 2;
        while (items[id]) id = `${idBase}-${suffix++}`;
        const profile = base ? clone(base) : makeDefaultProfile(id, name || id);
        profile.id = id;
        profile.name = String(name || id);
        items[id] = profile;
        profilePublishMutation('profile-created');
        profileQueueServerPersist('profile-created');
        profileEmit('profileCreated', { profile:profileGetProfile(id) });
        return profileGetProfile(id);
    }

    function profileDeleteProfile(profileId) {
        normalizeProfiles(userState, clientState);
        const id = String(profileId || '');
        const items = userState.profiles.items;
        if (!items[id]) return { changed:false, reason:'profile-not-found', profileId:id };
        if (Object.keys(items).length <= 1) return { changed:false, reason:'cannot-delete-last-profile', profileId:id };
        delete items[id];
        const fallbackId = Object.keys(items)[0];
        if (userState.profiles.activeProfileId === id) userState.profiles.activeProfileId = fallbackId;
        if (clientState.activeProfileId === id) {
            clientState.activeProfileId = fallbackId;
            if (!profileSaveClientState()) console.warn('[JellyfinQoL.ProfileRuntime] Deleted active profile but could not persist fallback activation.');
        }
        profilePublishMutation('profile-deleted');
        profileQueueServerPersist('profile-deleted');
        const result = { changed:true, profileId:id, activeProfileId:profileGetActiveProfileId() };
        profileEmit('profileDeleted', result);
        return result;
    }

    function profileResetProfile(profileId = null) {
        normalizeProfiles(userState, clientState);
        const id = String(profileId || profileGetActiveProfileId());
        const items = userState.profiles.items;
        if (!items[id]) return { changed:false, reason:'profile-not-found', profileId:id };
        const name = items[id]?.name || id;
        items[id] = makeDefaultProfile(id, name);
        profilePublishMutation('profile-reset');
        profileQueueServerPersist('profile-reset');
        const result = { changed:true, profileId:id };
        profileEmit('profileReset', { ...result, profile:profileGetProfile(id) });
        return result;
    }

    function profileReplaceBindingsForAction(action, bindings, profileId = null, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(id);
        if (!profile) return { changed:false, reason:'profile-not-found', profileId:id };
        const incoming = Array.isArray(bindings) ? bindings : [];
        if (incoming.length > 1) return { changed:false, reason:'multiple-bindings-not-supported-by-production-profile-schema', profileId:id, action:normalizedAction };
        if (PROFILE_ACTION_META[normalizedAction]?.critical === true && incoming.length === 0 && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-action', profileId:id, action:normalizedAction };
        }
        profile.bindings = isObject(profile.bindings) ? profile.bindings : {};
        if (!incoming.length) {
            profile.bindings[normalizedAction] = profileEmptyStoredBinding(normalizedAction, profile.bindings[normalizedAction]);
        } else {
            const normalized = profileNormalizeBinding({ ...incoming[0], action:normalizedAction, profileId:id }, 0);
            if (!normalized) return { changed:false, reason:'invalid-binding', profileId:id, action:normalizedAction };
            profile.bindings[normalizedAction] = profileStoredBindingFromDescriptor(normalized, profile.bindings[normalizedAction]);
        }
        profilePublishMutation('bindings-replaced');
        profileQueueServerPersist('bindings-replaced');
        const result = { changed:true, profileId:id, action:normalizedAction, bindings:profileGetBindings(id).filter(item => item.action === normalizedAction) };
        profileEmit('bindingsChanged', result);
        return result;
    }

    function profileClearBindingsForAction(action, profileId = null, options = {}) {
        return profileReplaceBindingsForAction(action, [], profileId, options);
    }

    function profileCommitBinding(binding, options = {}) {
        const profileId = String(options.profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(profileId);
        if (!profile) return { changed:false, reason:'profile-not-found', profileId };
        const normalized = profileNormalizeBinding({ ...binding, profileId }, 0);
        if (!normalized) return { changed:false, reason:'invalid-binding', profileId };
        const mode = options.mode || 'replace-action';
        if (!['replace-action','add'].includes(mode)) return { changed:false, reason:'unsupported-commit-mode', mode, profileId };
        if (mode === 'add' && profileGetBinding(normalized.action, profileId)) {
            return { changed:false, reason:'multiple-bindings-not-supported-by-production-profile-schema', profileId, action:normalized.action };
        }
        const conflictResolution = options.conflictResolution || 'cancel';
        const conflicts = profileAnalyzeConflicts(normalized, profileId);
        if (conflicts.length && conflictResolution === 'cancel') {
            return { changed:false, reason:'conflict-resolution-required', profileId, binding:clone(normalized), conflicts };
        }
        if (conflicts.length && conflictResolution === 'keep-both' && conflicts.some(item => !item.sameAction)) {
            return { changed:false, reason:'keep-both-unsafe', profileId, binding:clone(normalized), conflicts };
        }
        let simulated = profileGetBindings(profileId).filter(item => item.action !== normalized.action);
        if (conflictResolution === 'replace') {
            const conflictingIds = new Set(conflicts.map(item => item.binding?.id).filter(Boolean));
            simulated = simulated.filter(item => !conflictingIds.has(item.id));
        }
        simulated.push(normalized);
        const criticalMissing = profileGetCriticalActionsWithoutBindings(profileId, simulated);
        if (criticalMissing.length && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-actions', profileId, binding:clone(normalized), conflicts, actions:criticalMissing };
        }
        profile.bindings = isObject(profile.bindings) ? profile.bindings : {};
        if (conflictResolution === 'replace') {
            conflicts.forEach(item => {
                const conflictAction = item.binding?.action;
                if (!conflictAction || conflictAction === normalized.action) return;
                profile.bindings[conflictAction] = profileEmptyStoredBinding(conflictAction, profile.bindings[conflictAction]);
            });
        }
        profile.bindings[normalized.action] = profileStoredBindingFromDescriptor(normalized, profile.bindings[normalized.action]);
        profilePublishMutation('binding-committed');
        profileQueueServerPersist('binding-committed');
        const result = { changed:true, reason:'binding-committed', profileId, mode, conflictResolution, binding:profileGetBinding(normalized.action, profileId), conflicts };
        profileEmit('bindingCommitted', result);
        return result;
    }

    function profileRemoveBinding(bindingId, options = {}) {
        const profileId = String(options.profileId || profileGetActiveProfileId());
        const target = profileGetBindings(profileId).find(item => item.id === bindingId);
        if (!target) return { changed:false, reason:'binding-not-found', profileId, bindingId };
        if (PROFILE_ACTION_META[target.action]?.critical === true && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-action', profileId, bindingId, action:target.action };
        }
        const cleared = profileClearBindingsForAction(target.action, profileId, { allowCriticalUnbound:true });
        if (!cleared.changed) return cleared;
        const result = { changed:true, reason:'binding-removed', profileId, binding:clone(target) };
        profileEmit('bindingRemoved', result);
        return result;
    }

    function profileSetProfileBehavior(patch, profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(id);
        if (!profile) return { changed:false, reason:'profile-not-found', profileId:id };
        profile.behavior = { ...(isObject(profile.behavior) ? profile.behavior : {}), ...(isObject(patch) ? clone(patch) : {}) };
        profilePublishMutation('profile-behavior');
        profileQueueServerPersist('profile-behavior');
        const result = { changed:true, profileId:id, behavior:clone(profile.behavior) };
        profileEmit('behaviorChanged', result);
        return result;
    }

    function profileCompatibilityReport() {
        const legacy = QoL.airKeybinds || null;
        const required = [
            'getActiveProfileId','getProfile','getActiveProfile','getBindings','getDefaultBindings','getActionMeta',
            'isGlobalAction','isTextHandoffAction','normalizeTrigger','makeKeyboardBinding','makeCapturedBinding',
            'analyzeConflicts','getCriticalActionsWithoutBindings','persist','setActiveProfile','createProfile','deleteProfile',
            'resetProfile','replaceBindingsForAction','clearBindingsForAction','commitBinding','removeBinding','setProfileBehavior',
            'flushPersistence','on','off'
        ];
        const missing = required.filter(name => typeof QoL.profileRuntime?.[name] !== 'function');
        let legacyBindings = [];
        try { legacyBindings = legacy?.getBindings?.() || []; } catch (_) {}
        return {
            version:'1.2.4-default-profiles',
            ready:missing.length === 0,
            mutationReady:missing.length === 0,
            readOnly:false,
            takeoverActive:false,
            missingMethods:missing,
            legacyPresent:!!legacy,
            legacyVersion:legacy?.VERSION || legacy?.version || null,
            activeProfileId:profileGetActiveProfileId(),
            productionBindingCount:profileGetBindings().length,
            legacyBindingCount:Array.isArray(legacyBindings) ? legacyBindings.length : null,
            conflictRule:'same-physical-trigger+same-gesture+overlapping-input-context',
            gestureResolutionActive:false,
            serverPersistence:{
                lastPersistAt:profileLastPersistAt,
                lastError:profileLastPersistError ? String(profileLastPersistError?.message || profileLastPersistError) : null
            }
        };
    }

    function profileGetState() {
        const config = profileConfig();
        const activeProfileId = profileGetActiveProfileId();
        const profiles = profileItems();
        return {
            version:'1.2.4-default-profiles',
            source:config?.source || null,
            authenticated:config?.authenticated === true,
            activeProfileId,
            profileIds:Object.keys(profiles),
            activeProfile:profileGetProfile(activeProfileId),
            bindings:profileGetBindings(activeProfileId),
            bindingCount:profileGetBindings(activeProfileId).length,
            readOnly:false,
            persistenceReady:true,
            takeoverActive:false,
            compatibilityReady:true,
            conflictRule:'same-physical-trigger+same-gesture+overlapping-input-context',
            gestureResolutionActive:false,
            lastPersistAt:profileLastPersistAt,
            lastPersistError:profileLastPersistError ? String(profileLastPersistError?.message || profileLastPersistError) : null
        };
    }

    QoL.profileRuntime = Object.freeze({
        version:'1.2.4-default-profiles',
        ACTION_META:PROFILE_ACTION_META,
        getState:profileGetState,
        getActiveProfileId:profileGetActiveProfileId,
        getProfile:profileGetProfile,
        getActiveProfile:profileGetActiveProfile,
        getBindings:profileGetBindings,
        getBinding:profileGetBinding,
        getDefaultBindings:profileGetDefaultBindings,
        getActionMeta:profileGetActionMeta,
        isGlobalAction:profileIsGlobalAction,
        isTextHandoffAction:profileIsTextHandoffAction,
        normalizeTrigger:profileNormalizeTrigger,
        makeKeyboardBinding:profileMakeKeyboardBinding,
        makeCapturedBinding:profileMakeCapturedBinding,
        analyzeConflicts:profileAnalyzeConflicts,
        getCriticalActionsWithoutBindings:profileGetCriticalActionsWithoutBindings,
        persist:profilePersist,
        flushPersistence:profileFlushPersistence,
        setActiveProfile:profileSetActiveProfile,
        createProfile:profileCreateProfile,
        deleteProfile:profileDeleteProfile,
        resetProfile:profileResetProfile,
        replaceBindingsForAction:profileReplaceBindingsForAction,
        clearBindingsForAction:profileClearBindingsForAction,
        commitBinding:profileCommitBinding,
        removeBinding:profileRemoveBinding,
        setProfileBehavior:profileSetProfileBehavior,
        on:profileOn,
        off:profileOff,
        compatibilityReport:profileCompatibilityReport
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
