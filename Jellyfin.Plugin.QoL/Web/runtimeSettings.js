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
        profileMirrorLegacySettings(runtimeConfig);
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
            lastError: lastError ? String(lastError    // ---------------------------------------------------------------------
    // Production Profile Runtime / Phase-12 compatibility boundary.
    //
    // Authoritative state:
    //   runtimeSettings.userState + clientState
    //
    // Public modern API:
    //   JellyfinQoL.profileRuntime
    //
    // Transitional compatibility API:
    //   JellyfinQoL.profileCompatibility
    //
    // If the old injected QoL.airKeybinds module is NOT present, the
    // compatibility API automatically occupies JellyfinQoL.airKeybinds.
    // If the prototype is still loaded, it is left untouched so both can be
    // compared safely before takeover.
    //
    // IMPORTANT:
    // Gesture classification is NOT performed here. This module stores and
    // compares gesture metadata, but the later Gesture Resolver owns timing
    // and single/double/long decisions.
    // ---------------------------------------------------------------------

    const PROFILE_COMPAT_STORAGE_KEY = 'jellyfin-qol-airnav-keybinds-v1';
    const PROFILE_SCHEMA_VERSION = 1;

    const PROFILE_ACTION_META = Object.freeze({
        UP: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true, defaultGesture:'repeat' }),
        DOWN: Object.freeze({ critical:true, allowRepeat:true, textHandoff:true, defaultGesture:'repeat' }),
        LEFT: Object.freeze({ critical:true, allowRepeat:true, defaultGesture:'repeat' }),
        RIGHT: Object.freeze({ critical:true, allowRepeat:true, defaultGesture:'repeat' }),
        ACTIVATE: Object.freeze({ critical:true, allowRepeat:false, defaultGesture:'single' }),
        BACK: Object.freeze({ critical:true, allowRepeat:false, defaultGesture:'single' }),
        ENTER_ACTIONS: Object.freeze({ critical:false, allowRepeat:false, defaultGesture:'single' }),
        MENU: Object.freeze({ critical:false, allowRepeat:false, defaultGesture:'single' }),
        HOME: Object.freeze({ critical:false, allowRepeat:false, defaultGesture:'single' }),
        PLAY_PAUSE: Object.freeze({ critical:false, allowRepeat:false, defaultGesture:'single' }),
        TOGGLE_CONTROL: Object.freeze({ critical:false, allowRepeat:false, global:true, defaultGesture:'single' }),
        TOGGLE_SEARCH_HANDOFF: Object.freeze({ critical:false, allowRepeat:false, global:true, defaultGesture:'single' }),
        TOGGLE_SESSION_NAV: Object.freeze({ critical:false, allowRepeat:false, global:true, defaultGesture:'single' }),
        EXIT_JELLYFIN: Object.freeze({ critical:false, allowRepeat:false, global:true, defaultGesture:'long' })
    });

    const PROFILE_ACTION_LABELS = Object.freeze({
        UP: 'Up',
        DOWN: 'Down',
        LEFT: 'Left',
        RIGHT: 'Right',
        ACTIVATE: 'Activate / OK',
        BACK: 'Back',
        ENTER_ACTIONS: 'Item actions',
        MENU: 'Menu',
        HOME: 'Home / Refresh',
        PLAY_PAUSE: 'Play / Pause',
        TOGGLE_CONTROL: 'Player control mode',
        TOGGLE_SEARCH_HANDOFF: 'Search handoff toggle',
        TOGGLE_SESSION_NAV: 'Navigation mode this session',
        EXIT_JELLYFIN: 'Exit Jellyfin / HTPC'
    });

    const profileListeners = new Map();
    let profilePersistChain = Promise.resolve();
    let profileLastPersistAt = null;
    let profileLastPersistError = null;
    let profileRuntimeApi = null;
    let profileCompatibilityApi = null;

    function profileOn(event, callback) {
        if (typeof callback !== 'function') return () => {};
        if (!profileListeners.has(event)) profileListeners.set(event, new Set());
        profileListeners.get(event).add(callback);
        return () => profileOff(event, callback);
    }

    function profileOff(event, callback) {
        const set = profileListeners.get(event);
        if (!set) return;
        set.delete(callback);
        if (!set.size) profileListeners.delete(event);
    }

    function profileEmit(event, payload) {
        const set = profileListeners.get(event);
        if (set) {
            [...set].forEach(callback => {
                try { callback(clone(payload)); }
                catch (error) { console.error('[JellyfinQoL.ProfileRuntime]', `Listener failed for ${event}.`, error); }
            });
        }

        try {
            window.dispatchEvent(new CustomEvent(`jellyfin-qol-profile-${event}`, {
                detail: clone(payload)
            }));
        } catch (_) {}
    }

    function profileSlugify(value) {
        return String(value || 'profile')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'profile';
    }

    function profileNormalizeModifiers(value) {
        return {
            ctrl: !!value?.ctrl,
            alt: !!value?.alt,
            shift: !!value?.shift,
            meta: !!value?.meta
        };
    }

    function profileNormalizeTrigger(value, adapter = '') {
        if (!value || typeof value !== 'object') return null;

        adapter = String(adapter || '').toLowerCase();

        const type = String(
            value.type ||
            (adapter === 'keyboard' ? 'keydown' : '')
        ).trim();

        if (!type) return null;

        const trigger = { type };

        if (adapter === 'keyboard' || type === 'keydown' || type === 'keyup') {
            trigger.code = value.code || null;
            trigger.key = value.key || null;
            trigger.modifiers = profileNormalizeModifiers(value.modifiers);

            if (!trigger.code && !trigger.key) return null;
            return trigger;
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
            trigger.threshold = Number.isFinite(Number(value.threshold))
                ? Math.min(1, Math.max(0, Number(value.threshold)))
                : 0.5;
            return trigger;
        }

        if (type === 'gamepad-axis') {
            const axis = Number(value.axis);
            const direction = String(value.direction || '').toLowerCase();

            if (!Number.isInteger(axis) || !['positive','negative'].includes(direction)) {
                return null;
            }

            const threshold = Number.isFinite(Number(value.threshold))
                ? Math.min(0.98, Math.max(0.2, Number(value.threshold)))
                : 0.65;

            const releaseThreshold = Number.isFinite(Number(value.releaseThreshold))
                ? Math.min(threshold, Math.max(0.05, Number(value.releaseThreshold)))
                : Math.min(0.45, threshold);

            trigger.axis = axis;
            trigger.direction = direction;
            trigger.threshold = threshold;
            trigger.releaseThreshold = releaseThreshold;
            return trigger;
        }

        // Forward-compatible neutral browser trigger.
        Object.entries(value).forEach(([key, item]) => {
            if (key === 'type' || item == null) return;
            if (['string','number','boolean'].includes(typeof item)) {
                trigger[key] = item;
            }
        });

        return trigger;
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

    function profileConfig() {
        return runtimeConfig || QoL.runtimeConfig || null;
    }

    function profileItems() {
        normalizeProfiles(userState, clientState);
        return userState.profiles?.items || {};
    }

    function profileGetActiveProfileId() {
        const config = profileConfig();
        const items = profileItems();

        const candidates = [
            clientState?.activeProfileId,
            config?.activeProfileId,
            userState?.profiles?.activeProfileId,
            'default'
        ];

        return candidates.find(id => id && items[id]) || Object.keys(items)[0] || 'default';
    }

    function profileGetStoredProfile(profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        return profileItems()?.[id] || null;
    }

    function profileGetProfile(profileId = null) {
        return clone(profileGetStoredProfile(profileId));
    }

    function profileGetActiveProfile() {
        return profileGetProfile(profileGetActiveProfileId());
    }

    function profileKeyboardTriggerFromInput(input) {
        const value = String(input || '').trim();
        if (!value) return null;

        // Consumer/browser keys often have no useful KeyboardEvent.code,
        // especially synthetic GuardManager relay events.
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

    function profileNormalizeDescriptor(value, index = 0) {
        if (!value?.action || !value?.adapter || !value?.trigger) return null;

        const action = String(value.action).toUpperCase();
        const adapter = String(value.adapter).toLowerCase();
        const meta = PROFILE_ACTION_META[action] || {};
        const trigger = profileNormalizeTrigger(value.trigger, adapter);

        if (!trigger) return null;

        return {
            id: value.id || `bind:${action.toLowerCase()}:${adapter}:${index}`,
            action,
            adapter,
            deviceMatch: value.deviceMatch || '*',
            trigger,
            allowRepeat:
                typeof value.allowRepeat === 'boolean'
                    ? value.allowRepeat
                    : meta.allowRepeat !== false,
            gesture:
                String(value.gesture || meta.defaultGesture || 'single').toLowerCase(),
            longPressMs:
                value.longPressMs == null
                    ? null
                    : Math.max(1, Number(value.longPressMs) || 0),
            profileId: value.profileId || null
        };
    }

    function profileBindingDescriptor(action, binding, profileId, index = 0) {
        if (!binding || typeof binding !== 'object') return null;

        const normalizedAction = String(binding.action || action || '').toUpperCase();
        if (!normalizedAction) return null;

        // New/future saved bindings can carry their neutral trigger directly.
        if (binding.adapter && binding.trigger) {
            return profileNormalizeDescriptor({
                ...binding,
                action: normalizedAction,
                profileId: profileId || null
            }, index);
        }

        // Current settings schema stores a compact human-readable input field.
        const trigger = profileKeyboardTriggerFromInput(binding.input);
        if (!trigger) return null;

        return profileNormalizeDescriptor({
            id: binding.id || `runtime:${profileId || 'default'}:${normalizedAction.toLowerCase()}`,
            action: normalizedAction,
            adapter: 'keyboard',
            deviceMatch: '*',
            trigger,
            allowRepeat: binding.allowRepeat,
            gesture: binding.gesture,
            longPressMs: binding.longPressMs,
            profileId: profileId || null
        }, index);
    }

    function profileGetBindings(profileId = null, adapter = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(id);
        if (!profile) return [];

        const source = profile.bindings || {};
        const entries = Array.isArray(source)
            ? source.map(binding => [String(binding?.action || ''), binding])
            : Object.entries(source);

        const bindings = entries
            .map(([action, binding], index) =>
                profileBindingDescriptor(action, binding, id, index)
            )
            .filter(Boolean);

        return adapter
            ? bindings.filter(item => item.adapter === String(adapter).toLowerCase())
            : bindings;
    }

    function profileGetBinding(action, profileId = null) {
        const normalized = String(action || '').toUpperCase();
        return profileGetBindings(profileId)
            .find(binding => binding.action === normalized) || null;
    }

    function profileBehaviorSnapshot(profile) {
        return {
            cardActivate:
                profile?.behavior?.cardActivate ||
                userState?.behavior?.cardActivate ||
                'openDetails',
            scrollBehavior:
                profile?.behavior?.scrollBehavior ||
                userState?.scroll?.behavior ||
                'smooth',
            searchHandoffEnabled:
                typeof profile?.behavior?.searchHandoffEnabled === 'boolean'
                    ? profile.behavior.searchHandoffEnabled
                    : userState?.search?.handoffEnabled !== false
        };
    }

    function profileGetCompatibilityState() {
        const profiles = {};

        Object.entries(profileItems()).forEach(([id, profile]) => {
            profiles[id] = {
                id,
                name: String(profile?.name || id),
                bindings: profileGetBindings(id),
                behavior: profileBehaviorSnapshot(profile)
            };
        });

        return {
            version: PROFILE_SCHEMA_VERSION,
            activeProfileId: profileGetActiveProfileId(),
            profiles
        };
    }

    function profileGetDefaultBindings() {
        const profile = makeDefaultProfile('default', 'Default');
        const source = profile.bindings || {};

        return Object.entries(source)
            .map(([action, binding], index) =>
                profileBindingDescriptor(action, binding, 'default', index)
            )
            .filter(Boolean);
    }

    function profileCreateDefaultState() {
        const profile = makeDefaultProfile('default', 'Default');

        return {
            version: PROFILE_SCHEMA_VERSION,
            activeProfileId: 'default',
            profiles: {
                default: {
                    id: 'default',
                    name: 'Default',
                    bindings: Object.entries(profile.bindings || {})
                        .map(([action, binding], index) =>
                            profileBindingDescriptor(action, binding, 'default', index)
                        )
                        .filter(Boolean),
                    behavior: profileBehaviorSnapshot(profile)
                }
            }
        };
    }

    function profileDescribeTrigger(binding) {
        const trigger = binding?.trigger || {};
        const type = String(trigger.type || '');

        if (binding?.adapter === 'keyboard' || type === 'keydown' || type === 'keyup') {
            return trigger.code || trigger.key || '';
        }

        if (type === 'pointer-button' || type === 'mouse-button') {
            return `Pointer button ${trigger.button}`;
        }

        if (type === 'wheel') {
            return `Wheel ${trigger.direction || ''}`.trim();
        }

        if (type === 'gamepad-button') {
            return `Gamepad button ${trigger.button}`;
        }

        if (type === 'gamepad-axis') {
            return `Gamepad axis ${trigger.axis} ${trigger.direction || ''}`.trim();
        }

        return [
            binding?.adapter || 'input',
            type || 'trigger'
        ].join(':');
    }

    function profileStoredBindingFromDescriptor(descriptor, existing = null) {
        const normalized = profileNormalizeDescriptor(descriptor, 0);
        if (!normalized) return null;

        const meta = PROFILE_ACTION_META[normalized.action] || {};
        const gesture =
            normalized.gesture ||
            existing?.gesture ||
            meta.defaultGesture ||
            'single';

        return {
            ...(isObject(existing) ? clone(existing) : {}),
            id: normalized.id,
            action: normalized.action,
            label:
                existing?.label ||
                PROFILE_ACTION_LABELS[normalized.action] ||
                normalized.action,
            input: profileDescribeTrigger(normalized),
            adapter: normalized.adapter,
            deviceMatch: normalized.deviceMatch || '*',
            trigger: clone(normalized.trigger),
            gesture,
            longPressMs:
                gesture === 'long'
                    ? (
                        normalized.longPressMs ||
                        existing?.longPressMs ||
                        userState?.gestures?.longPressMs ||
                        3000
                    )
                    : null,
            allowRepeat:
                typeof normalized.allowRepeat === 'boolean'
                    ? normalized.allowRepeat
                    : meta.allowRepeat !== false
        };
    }

    function profileEmptyStoredBinding(action, existing = null) {
        const normalizedAction = String(action || '').toUpperCase();
        const meta = PROFILE_ACTION_META[normalizedAction] || {};

        return {
            ...(isObject(existing) ? clone(existing) : {}),
            action: normalizedAction,
            label:
                existing?.label ||
                PROFILE_ACTION_LABELS[normalizedAction] ||
                normalizedAction,
            input: '',
            gesture:
                existing?.gesture ||
                meta.defaultGesture ||
                'single',
            longPressMs:
                (existing?.gesture || meta.defaultGesture) === 'long'
                    ? (
                        existing?.longPressMs ||
                        userState?.gestures?.longPressMs ||
                        3000
                    )
                    : null,
            allowRepeat:
                typeof existing?.allowRepeat === 'boolean'
                    ? existing.allowRepeat
                    : meta.allowRepeat !== false
        };
    }

    function profileDeviceScopesOverlap(a, b) {
        const left = a || '*';
        const right = b || '*';
        return left === '*' || right === '*' || left === right;
    }

    function profileSamePhysicalTrigger(a, b) {
        if (!a || !b) return false;
        if (a.adapter !== b.adapter) return false;

        if (!profileDeviceScopesOverlap(a.deviceMatch, b.deviceMatch)) {
            return false;
        }

        const at = a.trigger || {};
        const bt = b.trigger || {};
        const typeA = at.type || (a.adapter === 'keyboard' ? 'keydown' : '');
        const typeB = bt.type || (b.adapter === 'keyboard' ? 'keydown' : '');

        if (typeA !== typeB) return false;

        if (a.adapter === 'keyboard' || typeA === 'keydown' || typeA === 'keyup') {
            const am = profileNormalizeModifiers(at.modifiers);
            const bm = profileNormalizeModifiers(bt.modifiers);

            if (
                am.ctrl !== bm.ctrl ||
                am.alt !== bm.alt ||
                am.shift !== bm.shift ||
                am.meta !== bm.meta
            ) {
                return false;
            }

            if (at.code && bt.code) return at.code === bt.code;

            if (at.key || bt.key) {
                return !!at.key && !!bt.key && at.key === bt.key;
            }

            return false;
        }

        if (typeA === 'pointer-button' || typeA === 'mouse-button') {
            return (
                Number(at.button) === Number(bt.button) &&
                (!at.pointerType || !bt.pointerType || at.pointerType === bt.pointerType)
            );
        }

        if (typeA === 'wheel') {
            return String(at.direction) === String(bt.direction);
        }

        if (typeA === 'gamepad-button') {
            return Number(at.button) === Number(bt.button);
        }

        if (typeA === 'gamepad-axis') {
            return (
                Number(at.axis) === Number(bt.axis) &&
                String(at.direction) === String(bt.direction)
            );
        }

        try {
            return JSON.stringify(at) === JSON.stringify(bt);
        } catch (_) {
            return false;
        }
    }

    function profileGestureOf(binding) {
        const action = String(binding?.action || '').toUpperCase();
        return String(
            binding?.gesture ||
            PROFILE_ACTION_META[action]?.defaultGesture ||
            'single'
        ).toLowerCase();
    }

    function profileSameConflictIdentity(a, b) {
        // Final UX rule: same physical trigger is only a conflict when the
        // gesture is also the same. BrowserBack single and BrowserBack long
        // are therefore intentionally allowed together.
        return (
            profileSamePhysicalTrigger(a, b) &&
            profileGestureOf(a) === profileGestureOf(b)
        );
    }

    function profileAnalyzeConflicts(binding, profileId = null) {
        const normalized = profileNormalizeDescriptor(binding, 0);
        if (!normalized) return [];

        return profileGetBindings(profileId)
            .filter(item => item.id !== normalized.id)
            .filter(item => profileSameConflictIdentity(item, normalized))
            .map(item => ({
                binding: clone(item),
                sameAction: item.action === normalized.action,
                sameGesture: profileGestureOf(item) === profileGestureOf(normalized),
                criticalAction: profileGetActionMeta(item.action).critical === true,
                safeToKeepBoth: false
            }));
    }

    function profileGetCriticalActionsWithoutBindings(profileId = null, bindingsOverride = null) {
        const bindings = Array.isArray(bindingsOverride)
            ? bindingsOverride
            : profileGetBindings(profileId);

        return Object.entries(PROFILE_ACTION_META)
            .filter(([, meta]) => meta.critical === true)
            .map(([action]) => action)
            .filter(action => !bindings.some(binding => binding.action === action));
    }

    function profileMakeKeyboardBinding(action, code, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const meta = PROFILE_ACTION_META[normalizedAction] || {};
        const identity = String(code || options.key || '').trim();

        if (!identity) return null;

        const keyOnly =
            /^(Browser|Media|AudioVolume|Launch|Zoom|PrintScreen|Pause)/.test(identity);

        return profileNormalizeDescriptor({
            id:
                options.id ||
                `bind:${normalizedAction.toLowerCase()}:keyboard:${profileSlugify(identity)}`,
            action: normalizedAction,
            adapter: 'keyboard',
            deviceMatch: options.deviceMatch || '*',
            trigger: {
                type: 'keydown',
                code: keyOnly ? null : identity,
                key: options.key || (keyOnly ? identity : null),
                modifiers: profileNormalizeModifiers(options.modifiers)
            },
            allowRepeat:
                typeof options.allowRepeat === 'boolean'
                    ? options.allowRepeat
                    : meta.allowRepeat !== false,
            gesture:
                options.gesture ||
                meta.defaultGesture ||
                'single',
            longPressMs: options.longPressMs ?? null
        }, 0);
    }

    function profileMakeCapturedBinding(action, capture, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const meta = PROFILE_ACTION_META[normalizedAction] || {};
        const adapter = String(capture?.adapter || '').toLowerCase();
        const trigger = profileNormalizeTrigger(capture?.trigger, adapter);

        if (!adapter || !trigger) return null;

        const triggerIdentity = [
            trigger.type,
            trigger.code,
            trigger.key,
            trigger.button,
            trigger.axis,
            trigger.direction
        ]
            .filter(value => value !== null && value !== undefined && value !== '')
            .join('-');

        const existing = profileGetBinding(normalizedAction, options.profileId);

        return profileNormalizeDescriptor({
            id:
                options.id ||
                `bind:${normalizedAction.toLowerCase()}:${adapter}:${profileSlugify(triggerIdentity || 'input')}`,
            action: normalizedAction,
            adapter,
            deviceMatch: options.deviceMatch || capture.deviceMatch || '*',
            trigger,
            allowRepeat:
                typeof options.allowRepeat === 'boolean'
                    ? options.allowRepeat
                    : meta.allowRepeat !== false,
            gesture:
                options.gesture ||
                existing?.gesture ||
                meta.defaultGesture ||
                'single',
            longPressMs:
                options.longPressMs ??
                existing?.longPressMs ??
                null
        }, 0);
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

        if (!token) {
            return Promise.resolve({
                saved: false,
                reason: 'anonymous-session'
            });
        }

        const snapshot = clone(userState);

        profilePersistChain = profilePersistChain
            .catch(() => null)
            .then(async () => {
                try {
                    await apiRequest('JellyfinQoL/UserSettings', {
                        method: 'PUT',
                        body: JSON.stringify({
                            schemaVersion: USER_SCHEMA_VERSION,
                            data: snapshot
                        })
                    });

                    profileLastPersistAt = Date.now();
                    profileLastPersistError = null;

                    const result = {
                        saved: true,
                        reason,
                        savedAt: profileLastPersistAt
                    };

                    profileEmit('persisted', result);
                    return result;
                } catch (error) {
                    profileLastPersistError = error;
                    console.error('[JellyfinQoL.ProfileRuntime] Server profile persistence failed.', error);

                    const result = {
                        saved: false,
                        reason: 'server-save-failed',
                        operation: reason,
                        error: String(error?.message || error)
                    };

                    profileEmit('error', result);
                    return result;
                }
            });

        return profilePersistChain;
    }

    function profileFlushPersist() {
        return profilePersistChain;
    }

    function profileMirrorLegacySettings(config = profileConfig()) {
        if (!config) return;

        QoL.settings = QoL.settings || {};
        QoL.settings.airNav = QoL.settings.airNav || {};
        QoL.settings.airNav.input = QoL.settings.airNav.input || {};
        QoL.settings.airNav.behavior = QoL.settings.airNav.behavior || {};
        QoL.settings.airNav.scroll = QoL.settings.airNav.scroll || {};
        QoL.settings.airNav.searchHandoff = QoL.settings.airNav.searchHandoff || {};

        const state = profileGetCompatibilityState();

        QoL.settings.airNav.input.activeProfileId = state.activeProfileId;
        QoL.settings.airNav.input.profiles = clone(state.profiles);

        if (config.behavior?.cardActivate) {
            QoL.settings.airNav.behavior.cardActivate = config.behavior.cardActivate;
        }

        if (config.scroll?.behavior) {
            QoL.settings.airNav.scroll.behavior = config.scroll.behavior;
        }

        if (typeof config.search?.handoffEnabled === 'boolean') {
            QoL.settings.airNav.searchHandoff.enabled = config.search.handoffEnabled;
        }
    }

    function profilePublishMutation(reason, options = {}) {
        normalizeProfiles(userState, clientState);

        const config = publish(
            'runtime-profile-edit+client-local',
            !!getAccessToken(),
            `profile-runtime:${reason}`
        );

        let reload = null;

        if (options.reload !== false && QoL.airNavInput?.reloadBindings) {
            try {
                reload = QoL.airNavInput.reloadBindings(profileGetActiveProfileId());
            } catch (error) {
                console.warn('[JellyfinQoL.ProfileRuntime] Input binding reload failed.', error);
            }
        }

        const payload = {
            reason,
            activeProfileId: profileGetActiveProfileId(),
            reload,
            config
        };

        profileEmit('changed', payload);
        return payload;
    }

    function profilePersist(options = {}) {
        profileMirrorLegacySettings();

        if (options.emitEvent !== false) {
            profileEmit('persistRequested', {
                activeProfileId: profileGetActiveProfileId()
            });
        }

        profileQueueServerPersist('compat-persist');
        return true;
    }

    function profileSetActiveProfile(profileId) {
        const id = String(profileId || '');
        const items = profileItems();

        if (!items[id]) {
            return { changed:false, reason:'profile-not-found', profileId:id };
        }

        const previous = profileGetActiveProfileId();

        if (previous === id) {
            return { changed:false, reason:'profile-already-active', profileId:id };
        }

        clientState.activeProfileId = id;
        profileSaveClientState();

        const mutation = profilePublishMutation('profile-changed');

        const result = {
            changed: true,
            previous,
            profileId: id,
            reload: mutation.reload
        };

        profileEmit('profileChanged', {
            ...result,
            profile: profileGetProfile(id)
        });

        return result;
    }

    function profileCreateProfile(name, options = {}) {
        const items = profileItems();

        const base =
            (options.baseProfileId && items[options.baseProfileId]) ||
            items[profileGetActiveProfileId()] ||
            null;

        const idBase = profileSlugify(options.id || name || 'profile');
        let id = idBase;
        let suffix = 2;

        while (items[id]) id = `${idBase}-${suffix++}`;

        const profile = base
            ? clone(base)
            : makeDefaultProfile(id, name || id);

        profile.id = id;
        profile.name = String(name || id);
        items[id] = profile;

        userState.profiles.activeProfileId = id;
        clientState.activeProfileId = id;
        profileSaveClientState();

        profilePublishMutation('profile-created');
        profileQueueServerPersist('profile-created');

        profileEmit('profileCreated', {
            profile: profileGetProfile(id)
        });

        return profileGetProfile(id);
    }

    function profileDeleteProfile(profileId) {
        const id = String(profileId || '');
        const items = profileItems();

        if (!items[id]) {
            return { changed:false, reason:'profile-not-found', profileId:id };
        }

        if (Object.keys(items).length <= 1) {
            return { changed:false, reason:'cannot-delete-last-profile', profileId:id };
        }

        delete items[id];

        const fallbackId = Object.keys(items)[0];

        if (userState.profiles.activeProfileId === id) {
            userState.profiles.activeProfileId = fallbackId;
        }

        if (clientState.activeProfileId === id) {
            clientState.activeProfileId = fallbackId;
            profileSaveClientState();
        }

        const mutation = profilePublishMutation('profile-deleted');
        profileQueueServerPersist('profile-deleted');

        const result = {
            changed: true,
            profileId: id,
            activeProfileId: profileGetActiveProfileId(),
            reload: mutation.reload
        };

        profileEmit('profileDeleted', result);
        return result;
    }

    function profileResetProfile(profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const items = profileItems();

        if (!items[id]) {
            return { changed:false, reason:'profile-not-found', profileId:id };
        }

        const name = items[id]?.name || id;
        items[id] = makeDefaultProfile(id, name);

        const mutation = profilePublishMutation('profile-reset');
        profileQueueServerPersist('profile-reset');

        const result = {
            changed: true,
            profileId: id,
            reload: mutation.reload
        };

        profileEmit('profileReset', {
            ...result,
            profile: profileGetProfile(id)
        });

        return result;
    }

    function profileReplaceBindingsForAction(action, bindings, profileId = null, options = {}) {
        const normalizedAction = String(action || '').toUpperCase();
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(id);

        if (!profile) {
            return { changed:false, reason:'profile-not-found', profileId:id };
        }

        const incoming = Array.isArray(bindings) ? bindings : [];

        if (incoming.length > 1) {
            return {
                changed: false,
                reason: 'multiple-bindings-not-supported-by-production-profile-schema',
                profileId: id,
                action: normalizedAction
            };
        }

        const meta = PROFILE_ACTION_META[normalizedAction] || {};

        if (
            meta.critical === true &&
            incoming.length === 0 &&
            options.allowCriticalUnbound !== true
        ) {
            return {
                changed:false,
                reason:'would-unbind-critical-action',
                profileId:id,
                action:normalizedAction
            };
        }

        profile.bindings = isObject(profile.bindings) ? profile.bindings : {};

        if (!incoming.length) {
            profile.bindings[normalizedAction] =
                profileEmptyStoredBinding(
                    normalizedAction,
                    profile.bindings[normalizedAction]
                );
        } else {
            const normalized = profileNormalizeDescriptor({
                ...incoming[0],
                action: normalizedAction,
                profileId: id
            }, 0);

            if (!normalized) {
                return {
                    changed:false,
                    reason:'invalid-binding',
                    profileId:id,
                    action:normalizedAction
                };
            }

            profile.bindings[normalizedAction] =
                profileStoredBindingFromDescriptor(
                    normalized,
                    profile.bindings[normalizedAction]
                );
        }

        const mutation = profilePublishMutation('bindings-replaced');
        profileQueueServerPersist('bindings-replaced');

        const result = {
            changed: true,
            profileId: id,
            action: normalizedAction,
            bindings: profileGetBindings(id).filter(item => item.action === normalizedAction),
            reload: mutation.reload
        };

        profileEmit('bindingsChanged', result);
        return result;
    }

    function profileClearBindingsForAction(action, profileId = null, options = {}) {
        return profileReplaceBindingsForAction(action, [], profileId, options);
    }

    function profileCommitBinding(binding, options = {}) {
        const profileId = String(options.profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(profileId);

        if (!profile) {
            return { changed:false, reason:'profile-not-found', profileId };
        }

        const normalized = profileNormalizeDescriptor(binding, 0);

        if (!normalized) {
            return { changed:false, reason:'invalid-binding', profileId };
        }

        const mode = options.mode || 'replace-action';
        const conflictResolution = options.conflictResolution || 'cancel';

        if (!['replace-action','add'].includes(mode)) {
            return {
                changed:false,
                reason:'unsupported-commit-mode',
                mode,
                profileId
            };
        }

        // Production profiles intentionally keep one active binding per action.
        // "add" is accepted for recorder compatibility and behaves as replacing
        // that action's current physical binding.
        const conflicts = profileAnalyzeConflicts(normalized, profileId);

        if (conflicts.length && conflictResolution === 'cancel') {
            return {
                changed:false,
                reason:'conflict-resolution-required',
                profileId,
                binding:clone(normalized),
                conflicts
            };
        }

        if (
            conflicts.length &&
            conflictResolution === 'keep-both' &&
            conflicts.some(item => !item.sameAction)
        ) {
            return {
                changed:false,
                reason:'keep-both-unsafe',
                profileId,
                binding:clone(normalized),
                conflicts
            };
        }

        const currentBindings = profileGetBindings(profileId);
        let simulated = currentBindings.filter(item => item.action !== normalized.action);

        if (conflictResolution === 'replace') {
            const conflictIds = new Set(
                conflicts.map(item => item.binding?.id).filter(Boolean)
            );

            simulated = simulated.filter(item => !conflictIds.has(item.id));
        }

        simulated.push(normalized);

        const criticalMissing =
            profileGetCriticalActionsWithoutBindings(profileId, simulated);

        if (
            criticalMissing.length &&
            options.allowCriticalUnbound !== true
        ) {
            return {
                changed:false,
                reason:'would-unbind-critical-actions',
                profileId,
                binding:clone(normalized),
                conflicts,
                actions:criticalMissing
            };
        }

        profile.bindings = isObject(profile.bindings) ? profile.bindings : {};

        if (conflictResolution === 'replace') {
            conflicts.forEach(item => {
                const conflictAction = item.binding?.action;
                if (!conflictAction || conflictAction === normalized.action) return;

                profile.bindings[conflictAction] =
                    profileEmptyStoredBinding(
                        conflictAction,
                        profile.bindings[conflictAction]
                    );
            });
        }

        profile.bindings[normalized.action] =
            profileStoredBindingFromDescriptor(
                normalized,
                profile.bindings[normalized.action]
            );

        const mutation = profilePublishMutation('binding-committed');
        profileQueueServerPersist('binding-committed');

        const result = {
            changed:true,
            reason:'binding-committed',
            profileId,
            mode,
            conflictResolution,
            binding:profileGetBinding(normalized.action, profileId),
            conflicts,
            reload:mutation.reload
        };

        profileEmit('bindingCommitted', result);
        return result;
    }

    function profileRemoveBinding(bindingId, options = {}) {
        const profileId = String(options.profileId || profileGetActiveProfileId());
        const target = profileGetBindings(profileId)
            .find(item => item.id === bindingId);

        if (!target) {
            return {
                changed:false,
                reason:'binding-not-found',
                profileId,
                bindingId
            };
        }

        const meta = PROFILE_ACTION_META[target.action] || {};

        if (
            meta.critical === true &&
            options.allowCriticalUnbound !== true
        ) {
            return {
                changed:false,
                reason:'would-unbind-critical-action',
                profileId,
                bindingId,
                action:target.action
            };
        }

        const result = profileClearBindingsForAction(
            target.action,
            profileId,
            { allowCriticalUnbound:true }
        );

        if (!result.changed) return result;

        const finalResult = {
            changed:true,
            reason:'binding-removed',
            profileId,
            binding:clone(target),
            reload:result.reload
        };

        profileEmit('bindingRemoved', finalResult);
        return finalResult;
    }

    function profileSetProfileBehavior(patch, profileId = null) {
        const id = String(profileId || profileGetActiveProfileId());
        const profile = profileGetStoredProfile(id);

        if (!profile) {
            return { changed:false, reason:'profile-not-found', profileId:id };
        }

        profile.behavior = {
            ...(profile.behavior || {}),
            ...(patch || {})
        };

        if (id === profileGetActiveProfileId()) {
            if (patch?.cardActivate) {
                userState.behavior.cardActivate = patch.cardActivate;
            }

            if (patch?.scrollBehavior) {
                userState.scroll.behavior = patch.scrollBehavior;
            }

            if (typeof patch?.searchHandoffEnabled === 'boolean') {
                userState.search.handoffEnabled = patch.searchHandoffEnabled;
            }
        }

        profilePublishMutation('profile-behavior');
        profileQueueServerPersist('profile-behavior');

        const result = {
            changed:true,
            profileId:id,
            behavior:profileBehaviorSnapshot(profile)
        };

        profileEmit('behaviorChanged', result);
        return result;
    }

    function profileImportCompatibilityState(nextState) {
        const source = nextState || profileCreateDefaultState();
        const incomingProfiles = source?.profiles || {};
        const nextItems = {};

        Object.entries(incomingProfiles).forEach(([id, legacyProfile]) => {
            const profileId = String(legacyProfile?.id || id || 'default');
            const base = makeDefaultProfile(
                profileId,
                legacyProfile?.name || profileId
            );

            // Missing old bindings must remain missing rather than silently
            // reappearing from modern defaults after normalizeProfiles().
            Object.keys(base.bindings || {}).forEach(action => {
                base.bindings[action] =
                    profileEmptyStoredBinding(
                        action,
                        base.bindings[action]
                    );
            });

            const incomingBindings = Array.isArray(legacyProfile?.bindings)
                ? legacyProfile.bindings
                : [];

            incomingBindings.forEach((binding, index) => {
                const normalized = profileNormalizeDescriptor(binding, index);
                if (!normalized) return;

                // Final production schema is one active binding per action.
                if (
                    base.bindings[normalized.action]?.input ||
                    base.bindings[normalized.action]?.trigger
                ) {
                    return;
                }

                base.bindings[normalized.action] =
                    profileStoredBindingFromDescriptor(
                        normalized,
                        base.bindings[normalized.action]
                    );
            });

            if (legacyProfile?.behavior) {
                base.behavior = clone(legacyProfile.behavior);
            }

            nextItems[profileId] = base;
        });

        if (!Object.keys(nextItems).length) {
            nextItems.default = makeDefaultProfile();
        }

        const requestedActive = String(source?.activeProfileId || 'default');
        const activeId =
            nextItems[requestedActive]
                ? requestedActive
                : Object.keys(nextItems)[0];

        userState.profiles.items = nextItems;
        userState.profiles.activeProfileId = activeId;

        if (!nextItems[clientState.activeProfileId]) {
            clientState.activeProfileId = activeId;
            profileSaveClientState();
        }

        const activeBehavior = profileBehaviorSnapshot(nextItems[activeId]);

        userState.behavior.cardActivate = activeBehavior.cardActivate;
        userState.scroll.behavior = activeBehavior.scrollBehavior;
        userState.search.handoffEnabled = activeBehavior.searchHandoffEnabled;

        return activeId;
    }

    function profileReplaceState(nextState, options = {}) {
        const activeId = profileImportCompatibilityState(nextState);

        const mutation = profilePublishMutation(
            `state-replaced:${options.source || 'external'}`
        );

        if (options.persist === true) {
            profileQueueServerPersist(
                `state-replaced:${options.source || 'external'}`
            );
        }

        const result = profileGetCompatibilityState();

        profileEmit('stateReplaced', {
            source: options.source || 'external',
            state: result,
            reload: mutation.reload
        });

        console.log('[JellyfinQoL.ProfileRuntime] Compatibility state replaced.', {
            source: options.source || 'external',
            activeProfileId: activeId,
            profiles: Object.keys(result.profiles)
        });

        return result;
    }

    function profileGetMigrationCandidate() {
        // The production UserSettings API has already replaced the old
        // browser-local profile authority. No automatic legacy cache migration
        // is performed from this compatibility facade.
        return null;
    }

    function profileClearLocalCache() {
        try {
            localStorage.removeItem(PROFILE_COMPAT_STORAGE_KEY);
        } catch (_) {}
        return true;
    }

    function profileClearPersistedForTesting() {
        const reset = profileCreateDefaultState();
        profileImportCompatibilityState(reset);
        profileSaveClientState();
        profilePublishMutation('testing-reset');
        profileQueueServerPersist('testing-reset');
        profileEmit('resetAll', profileGetCompatibilityState());
        return profileGetCompatibilityState();
    }

    function profileInitialize() {
        profileMirrorLegacySettings();
        return profileGetCompatibilityState();
    }

    function profileCompatibilityReport() {
        const legacy =
            QoL.airKeybinds &&
            QoL.airKeybinds !== profileCompatibilityApi
                ? QoL.airKeybinds
                : null;

        const required = [
            'initialize',
            'persist',
            'getState',
            'getActiveProfileId',
            'getProfile',
            'getActiveProfile',
            'getBindings',
            'getDefaultBindings',
            'getActionMeta',
            'isGlobalAction',
            'isTextHandoffAction',
            'setActiveProfile',
            'createProfile',
            'deleteProfile',
            'resetProfile',
            'replaceBindingsForAction',
            'clearBindingsForAction',
            'makeKeyboardBinding',
            'makeCapturedBinding',
            'normalizeTrigger',
            'analyzeConflicts',
            'commitBinding',
            'removeBinding',
            'getCriticalActionsWithoutBindings',
            'setProfileBehavior',
            'createDefaultState',
            'getMigrationCandidate',
            'replaceState',
            'clearLocalCache',
            'clearPersistedForTesting',
            'on',
            'off'
        ];

        const missing = required.filter(
            name => typeof profileCompatibilityApi?.[name] !== 'function'
        );

        let legacyState = null;
        try {
            legacyState = legacy?.getState?.() || null;
        } catch (_) {}

        const productionState = profileGetCompatibilityState();

        const actionComparison = {};
        Object.keys(PROFILE_ACTION_META).forEach(action => {
            let legacyBinding = null;

            try {
                legacyBinding =
                    legacy?.getBindings?.()
                        ?.find(item => item.action === action) ||
                    null;
            } catch (_) {}

            const productionBinding =
                profileGetBinding(action) || null;

            actionComparison[action] = {
                production: productionBinding
                    ? {
                        adapter: productionBinding.adapter,
                        trigger: clone(productionBinding.trigger),
                        gesture: productionBinding.gesture,
                        allowRepeat: productionBinding.allowRepeat
                    }
                    : null,
                legacy: legacyBinding
                    ? {
                        adapter: legacyBinding.adapter,
                        trigger: clone(legacyBinding.trigger),
                        gesture: legacyBinding.gesture || null,
                        allowRepeat: legacyBinding.allowRepeat
                    }
                    : null
            };
        });

        return {
            version: '1.1.0',
            productionReady: missing.length === 0,
            missingMethods: missing,
            passiveComparisonMode:
                !!legacy &&
                QoL.airKeybinds !== profileCompatibilityApi,
            compatibilityFacadeInstalled:
                QoL.airKeybinds === profileCompatibilityApi,
            activeProfileId: productionState.activeProfileId,
            profileIds: Object.keys(productionState.profiles),
            productionBindingCount:
                profileGetBindings().length,
            legacyPresent: !!legacy,
            legacyVersion:
                legacy?.VERSION ||
                legacy?.version ||
                null,
            legacyActiveProfileId:
                legacyState?.activeProfileId ||
                null,
            legacyBindingCount:
                Array.isArray(
                    legacyState?.profiles?.[
                        legacyState?.activeProfileId
                    ]?.bindings
                )
                    ? legacyState.profiles[
                        legacyState.activeProfileId
                    ].bindings.length
                    : null,
            conflictRule:
                'same-physical-trigger+same-gesture',
            serverPersistence: {
                lastPersistAt: profileLastPersistAt,
                lastError:
                    profileLastPersistError
                        ? String(profileLastPersistError?.message || profileLastPersistError)
                        : null
            },
            actionComparison
        };
    }

    function profileGetRuntimeState() {
        const config = profileConfig();

        return {
            version: '1.1.0',
            source: config?.source || null,
            authenticated: config?.authenticated === true,
            activeProfileId: profileGetActiveProfileId(),
            profileIds: Object.keys(profileItems()),
            activeProfile: profileGetProfile(),
            bindings: profileGetBindings(),
            bindingCount: profileGetBindings().length,
            readOnly: false,
            compatibilityReady: true,
            compatibilityFacadeInstalled:
                QoL.airKeybinds === profileCompatibilityApi,
            gestureResolutionActive: false,
            conflictRule: 'same-physical-trigger+same-gesture',
            lastPersistAt: profileLastPersistAt,
            lastPersistError:
                profileLastPersistError
                    ? String(profileLastPersistError?.message || profileLastPersistError)
                    : null
        };
    }

    profileCompatibilityApi = Object.freeze({
        VERSION: 'production-compat-1.1.0',
        version: '1.1.0',
        STORAGE_KEY: PROFILE_COMPAT_STORAGE_KEY,
        SCHEMA_VERSION: PROFILE_SCHEMA_VERSION,
        ACTION_META: PROFILE_ACTION_META,

        initialize: profileInitialize,
        persist: profilePersist,

        getState: profileGetCompatibilityState,
        getActiveProfileId: profileGetActiveProfileId,
        getProfile: profileGetProfile,
        getActiveProfile: profileGetActiveProfile,
        getBindings: profileGetBindings,
        getDefaultBindings: profileGetDefaultBindings,
        getActionMeta: profileGetActionMeta,
        isGlobalAction: profileIsGlobalAction,
        isTextHandoffAction: profileIsTextHandoffAction,

        setActiveProfile: profileSetActiveProfile,
        createProfile: profileCreateProfile,
        deleteProfile: profileDeleteProfile,
        resetProfile: profileResetProfile,

        replaceBindingsForAction: profileReplaceBindingsForAction,
        clearBindingsForAction: profileClearBindingsForAction,
        makeKeyboardBinding: profileMakeKeyboardBinding,
        makeCapturedBinding: profileMakeCapturedBinding,
        normalizeTrigger: profileNormalizeTrigger,
        analyzeConflicts: profileAnalyzeConflicts,
        commitBinding: profileCommitBinding,
        removeBinding: profileRemoveBinding,
        getCriticalActionsWithoutBindings: profileGetCriticalActionsWithoutBindings,

        setProfileBehavior: profileSetProfileBehavior,
        createDefaultState: profileCreateDefaultState,
        getMigrationCandidate: profileGetMigrationCandidate,
        replaceState: profileReplaceState,
        clearLocalCache: profileClearLocalCache,
        clearPersistedForTesting: profileClearPersistedForTesting,

        on: profileOn,
        off: profileOff
    });

    profileRuntimeApi = Object.freeze({
        version: '1.1.0',
        ACTION_META: PROFILE_ACTION_META,

        getState: profileGetRuntimeState,
        getCompatibilityState: profileGetCompatibilityState,
        getActiveProfileId: profileGetActiveProfileId,
        getProfile: profileGetProfile,
        getActiveProfile: profileGetActiveProfile,
        getBindings: profileGetBindings,
        getBinding: profileGetBinding,
        getDefaultBindings: profileGetDefaultBindings,
        getActionMeta: profileGetActionMeta,
        isGlobalAction: profileIsGlobalAction,
        isTextHandoffAction: profileIsTextHandoffAction,

        normalizeTrigger: profileNormalizeTrigger,
        makeKeyboardBinding: profileMakeKeyboardBinding,
        makeCapturedBinding: profileMakeCapturedBinding,
        analyzeConflicts: profileAnalyzeConflicts,
        getCriticalActionsWithoutBindings: profileGetCriticalActionsWithoutBindings,

        setActiveProfile: profileSetActiveProfile,
        createProfile: profileCreateProfile,
        deleteProfile: profileDeleteProfile,
        resetProfile: profileResetProfile,
        replaceBindingsForAction: profileReplaceBindingsForAction,
        clearBindingsForAction: profileClearBindingsForAction,
        commitBinding: profileCommitBinding,
        removeBinding: profileRemoveBinding,
        setProfileBehavior: profileSetProfileBehavior,
        replaceCompatibilityState: profileReplaceState,

        flushPersistence: profileFlushPersist,
        compatibilityReport: profileCompatibilityReport,

        on: profileOn,
        off: profileOff
    });

    QoL.profileRuntime = profileRuntimeApi;
    QoL.profileCompatibility = profileCompatibilityApi;

    // Automatic takeover only when the old injected profile core is absent.
    // During side-by-side validation the existing prototype remains untouched.
    if (!QoL.airKeybinds) {
        QoL.airKeybinds = profileCompatibilityApi;

        console.log(
            '[JellyfinQoL.ProfileRuntime] Production profile compatibility facade installed as JellyfinQoL.airKeybinds.'
        );
    } else if (QoL.airKeybinds !== profileCompatibilityApi) {
        console.log(
            '[JellyfinQoL.ProfileRuntime] Prototype airKeybinds detected; production profile runtime is in passive comparison mode.'
        );
    }

extHandoffAction: profileIsTextHandoffAction
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
