(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.clientBootstrap?.version === '1.1.1') {
        QoL.clientBootstrap.start?.();
        return;
    }

    const VERSION = '1.1.1';
    const LOG = '[JellyfinQoL.ClientBootstrap]';
    const RESOURCE_BASE = 'JellyfinQoL/Client/';
    const PROFILE_COMPAT_VERSION = '1.0.1';
    const PROFILE_COMPAT_STORAGE_KEY = 'jellyfin-qol-airnav-keybinds-v1';
    const loadedResources = new Map();
    const profileCompatListeners = new Map();
    let started = false;
    let startingPromise = null;
    let lastError = null;
    let startedAt = null;
    let profileCompatibility = null;
    let profileOverrideState = null;
    let profileOverrideSource = null;

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

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

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

    function profileRuntime() {
        return QoL.profileRuntime || null;
    }

    function profileCompatOn(event, callback) {
        if (typeof callback !== 'function') return () => {};
        if (!profileCompatListeners.has(event)) profileCompatListeners.set(event, new Set());
        profileCompatListeners.get(event).add(callback);
        return () => profileCompatOff(event, callback);
    }

    function profileCompatOff(event, callback) {
        const set = profileCompatListeners.get(event);
        if (!set) return;
        set.delete(callback);
        if (!set.size) profileCompatListeners.delete(event);
    }

    function profileCompatEmit(event, payload) {
        const set = profileCompatListeners.get(event);
        if (!set) return;
        [...set].forEach(callback => {
            try { callback(clone(payload)); }
            catch (error) { console.error(LOG, `Profile compatibility listener failed for ${event}.`, error); }
        });
    }

    function profileCompatBehavior(profile = null) {
        const config = QoL.runtimeConfig || {};
        return {
            cardActivate: profile?.behavior?.cardActivate || config.behavior?.cardActivate || 'openDetails',
            scrollBehavior: profile?.behavior?.scrollBehavior || config.scroll?.behavior || 'smooth',
            searchHandoffEnabled:
                typeof profile?.behavior?.searchHandoffEnabled === 'boolean'
                    ? profile.behavior.searchHandoffEnabled
                    : config.search?.handoffEnabled !== false
        };
    }

    function profileCompatNormalizeBinding(binding, index = 0) {
        if (!binding?.action || !binding?.adapter || !binding?.trigger) return null;
        const runtime = profileRuntime();
        const action = String(binding.action).toUpperCase();
        const adapter = String(binding.adapter).toLowerCase();
        const trigger = runtime?.normalizeTrigger?.(binding.trigger, adapter) || clone(binding.trigger);
        if (!trigger) return null;
        const meta = runtime?.getActionMeta?.(action) || {};
        return {
            id: binding.id || `bind:${action.toLowerCase()}:${adapter}:${index}`,
            action,
            adapter,
            deviceMatch: binding.deviceMatch || '*',
            trigger,
            allowRepeat: typeof binding.allowRepeat === 'boolean' ? binding.allowRepeat : meta.allowRepeat !== false,
            gesture: String(binding.gesture || (meta.allowRepeat ? 'repeat' : 'single')).toLowerCase(),
            longPressMs: binding.longPressMs == null ? null : Number(binding.longPressMs)
        };
    }

    function profileCompatNormalizeState(value) {
        const source = value && typeof value === 'object' ? value : {};
        const profiles = {};

        Object.entries(source.profiles || {}).forEach(([id, profile]) => {
            const profileId = String(profile?.id || id || 'default');
            profiles[profileId] = {
                id: profileId,
                name: String(profile?.name || profileId),
                bindings: (Array.isArray(profile?.bindings) ? profile.bindings : [])
                    .map((binding, index) => profileCompatNormalizeBinding(binding, index))
                    .filter(Boolean),
                behavior: profileCompatBehavior(profile)
            };
        });

        if (!Object.keys(profiles).length) {
            const defaults = profileRuntime()?.getDefaultBindings?.() || [];
            profiles.default = {
                id: 'default',
                name: 'Default',
                bindings: defaults.map((binding, index) => profileCompatNormalizeBinding(binding, index)).filter(Boolean),
                behavior: profileCompatBehavior()
            };
        }

        let activeProfileId = String(source.activeProfileId || 'default');
        if (!profiles[activeProfileId]) activeProfileId = Object.keys(profiles)[0];

        return {
            version: 1,
            activeProfileId,
            profiles
        };
    }

    function profileCompatFromProduction() {
        const runtime = profileRuntime();
        const runtimeState = runtime?.getState?.() || {};
        const profiles = {};

        (runtimeState.profileIds || []).forEach(id => {
            const profile = runtime.getProfile?.(id) || { id, name:id };
            profiles[id] = {
                id,
                name: String(profile?.name || id),
                bindings: (runtime.getBindings?.(id) || []).map((binding, index) => profileCompatNormalizeBinding(binding, index)).filter(Boolean),
                behavior: profileCompatBehavior(profile)
            };
        });

        return profileCompatNormalizeState({
            version: 1,
            activeProfileId: runtimeState.activeProfileId || 'default',
            profiles
        });
    }

    function profileCompatCurrentState() {
        return clone(profileOverrideState || profileCompatFromProduction());
    }

    function profileCompatGetProfile(profileId = null) {
        const state = profileCompatCurrentState();
        const id = String(profileId || state.activeProfileId);
        return clone(state.profiles[id] || null);
    }

    function profileCompatGetBindings(profileId = null, adapter = null) {
        const profile = profileCompatGetProfile(profileId);
        const bindings = Array.isArray(profile?.bindings) ? profile.bindings : [];
        return adapter
            ? bindings.filter(binding => binding.adapter === String(adapter).toLowerCase())
            : bindings;
    }

    function profileCompatModifiers(value) {
        return {
            ctrl: !!value?.ctrl,
            alt: !!value?.alt,
            shift: !!value?.shift,
            meta: !!value?.meta
        };
    }

    function profileCompatDeviceScopesOverlap(a, b) {
        const left = a || '*';
        const right = b || '*';
        return left === '*' || right === '*' || left === right;
    }

    function profileCompatSamePhysicalTrigger(a, b) {
        if (!a || !b || a.adapter !== b.adapter || !profileCompatDeviceScopesOverlap(a.deviceMatch, b.deviceMatch)) return false;
        const at = a.trigger || {};
        const bt = b.trigger || {};
        const typeA = at.type || (a.adapter === 'keyboard' ? 'keydown' : '');
        const typeB = bt.type || (b.adapter === 'keyboard' ? 'keydown' : '');
        if (typeA !== typeB) return false;

        if (a.adapter === 'keyboard' || typeA === 'keydown' || typeA === 'keyup') {
            const am = profileCompatModifiers(at.modifiers);
            const bm = profileCompatModifiers(bt.modifiers);
            if (am.ctrl !== bm.ctrl || am.alt !== bm.alt || am.shift !== bm.shift || am.meta !== bm.meta) return false;
            if (at.code && bt.code) return at.code === bt.code;
            return !!(at.key && bt.key && at.key === bt.key);
        }

        if (typeA === 'pointer-button' || typeA === 'mouse-button') {
            return Number(at.button) === Number(bt.button) && (!at.pointerType || !bt.pointerType || at.pointerType === bt.pointerType);
        }
        if (typeA === 'wheel') return String(at.direction) === String(bt.direction);
        if (typeA === 'gamepad-button') return Number(at.button) === Number(bt.button);
        if (typeA === 'gamepad-axis') return Number(at.axis) === Number(bt.axis) && String(at.direction) === String(bt.direction);

        try { return JSON.stringify(at) === JSON.stringify(bt); }
        catch (_) { return false; }
    }

    function profileCompatGesture(binding) {
        const meta = profileRuntime()?.getActionMeta?.(binding?.action) || {};
        return String(binding?.gesture || (meta.allowRepeat ? 'repeat' : 'single')).toLowerCase();
    }

    function profileCompatActionContexts(action) {
        const contexts = profileRuntime()?.getActionMeta?.(action)?.contexts;
        return new Set(
            Array.isArray(contexts) && contexts.length
                ? contexts.map(context => String(context || '').toLowerCase()).filter(Boolean)
                : ['page', 'modal', 'text', 'player']
        );
    }

    function profileCompatActionContextsOverlap(leftAction, rightAction) {
        const left = profileCompatActionContexts(leftAction);
        const right = profileCompatActionContexts(rightAction);
        return [...left].some(context => right.has(context));
    }

    function profileCompatAnalyzeConflicts(binding, profileId = null) {
        const normalized = profileCompatNormalizeBinding(binding, 0);
        if (!normalized) return [];
        return profileCompatGetBindings(profileId)
            .filter(item => item.id !== normalized.id)
            .filter(item => profileCompatSamePhysicalTrigger(item, normalized))
            .filter(item => profileCompatGesture(item) === profileCompatGesture(normalized))
            .filter(item => profileCompatActionContextsOverlap(item.action, normalized.action))
            .map(item => ({
                binding: clone(item),
                sameAction: item.action === normalized.action,
                sameGesture: true,
                contextOverlap: true,
                criticalAction: profileRuntime()?.getActionMeta?.(item.action)?.critical === true,
                safeToKeepBoth: false
            }));
    }

    function profileCompatGetCriticalActionsWithoutBindings(profileId = null, bindingsOverride = null) {
        const bindings = Array.isArray(bindingsOverride) ? bindingsOverride : profileCompatGetBindings(profileId);
        const actionMeta = profileRuntime()?.ACTION_META || {};
        return Object.entries(actionMeta)
            .filter(([, meta]) => meta?.critical === true)
            .map(([action]) => action)
            .filter(action => !bindings.some(binding => binding.action === action));
    }

    function profileCompatReload(profileId) {
        try { return QoL.airNavInput?.reloadBindings?.(profileId) || null; }
        catch (error) {
            console.warn(LOG, 'Compatibility binding reload failed.', error);
            return null;
        }
    }

    function profileCompatReplaceState(nextState, options = {}) {
        profileOverrideState = profileCompatNormalizeState(nextState);
        profileOverrideSource = options.source || 'external';
        const reload = profileCompatReload(profileOverrideState.activeProfileId);
        const payload = {
            source: profileOverrideSource,
            transient: true,
            state: profileCompatCurrentState(),
            reload
        };
        profileCompatEmit('stateReplaced', payload);
        console.log(LOG, 'Transient profile compatibility state replaced.', {
            source: profileOverrideSource,
            activeProfileId: profileOverrideState.activeProfileId,
            profiles: Object.keys(profileOverrideState.profiles)
        });
        return payload.state;
    }

    function profileCompatEnsureOverride() {
        if (!profileOverrideState) {
            profileOverrideState = profileCompatFromProduction();
            profileOverrideSource = 'compatibility-mutation';
        }
        return profileOverrideState;
    }

    function profileCompatSetActiveProfile(profileId) {
        const state = profileCompatEnsureOverride();
        const id = String(profileId || '');
        if (!state.profiles[id]) return { changed:false, reason:'profile-not-found', profileId:id };
        const previous = state.activeProfileId;
        if (previous === id) return { changed:false, reason:'profile-already-active', profileId:id };
        state.activeProfileId = id;
        const reload = profileCompatReload(id);
        const result = { changed:true, previous, profileId:id, reload };
        profileCompatEmit('profileChanged', { ...result, profile:profileCompatGetProfile(id) });
        return result;
    }

    function profileCompatCreateProfile(name, options = {}) {
        const state = profileCompatEnsureOverride();
        const base = options.baseProfileId ? state.profiles[options.baseProfileId] : state.profiles[state.activeProfileId];
        const slug = String(options.id || name || 'profile').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
        let id = slug;
        let suffix = 2;
        while (state.profiles[id]) id = `${slug}-${suffix++}`;
        const profile = base ? clone(base) : profileCompatNormalizeState({ profiles:{} }).profiles.default;
        profile.id = id;
        profile.name = String(name || id);
        state.profiles[id] = profile;
        profileCompatEmit('profileCreated', { profile:clone(profile) });
        return clone(profile);
    }

    function profileCompatDeleteProfile(profileId) {
        const state = profileCompatEnsureOverride();
        const id = String(profileId || '');
        if (!state.profiles[id]) return { changed:false, reason:'profile-not-found', profileId:id };
        if (Object.keys(state.profiles).length <= 1) return { changed:false, reason:'cannot-delete-last-profile', profileId:id };
        delete state.profiles[id];
        if (state.activeProfileId === id) state.activeProfileId = Object.keys(state.profiles)[0];
        const reload = profileCompatReload(state.activeProfileId);
        const result = { changed:true, profileId:id, activeProfileId:state.activeProfileId, reload };
        profileCompatEmit('profileDeleted', result);
        return result;
    }

    function profileCompatResetProfile(profileId = null) {
        const state = profileCompatEnsureOverride();
        const id = String(profileId || state.activeProfileId);
        const existing = state.profiles[id];
        if (!existing) return { changed:false, reason:'profile-not-found', profileId:id };
        const defaults = profileCompatNormalizeState({ profiles:{} }).profiles.default;
        state.profiles[id] = { ...defaults, id, name:existing.name || id };
        const reload = id === state.activeProfileId ? profileCompatReload(id) : null;
        const result = { changed:true, profileId:id, reload };
        profileCompatEmit('profileReset', { ...result, profile:profileCompatGetProfile(id) });
        return result;
    }

    function profileCompatReplaceBindingsForAction(action, bindings, profileId = null, options = {}) {
        const state = profileCompatEnsureOverride();
        const id = String(profileId || state.activeProfileId);
        const profile = state.profiles[id];
        if (!profile) return { changed:false, reason:'profile-not-found', profileId:id };
        const normalizedAction = String(action || '').toUpperCase();
        const incoming = Array.isArray(bindings) ? bindings : [];
        if (profileRuntime()?.getActionMeta?.(normalizedAction)?.critical === true && !incoming.length && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-action', profileId:id, action:normalizedAction };
        }
        const normalized = incoming.map((binding, index) => profileCompatNormalizeBinding({ ...binding, action:normalizedAction }, index)).filter(Boolean);
        profile.bindings = (profile.bindings || []).filter(binding => binding.action !== normalizedAction).concat(normalized);
        const reload = id === state.activeProfileId ? profileCompatReload(id) : null;
        const result = { changed:true, profileId:id, action:normalizedAction, bindings:profileCompatGetBindings(id).filter(binding => binding.action === normalizedAction), reload };
        profileCompatEmit('bindingsChanged', result);
        return result;
    }

    function profileCompatCommitBinding(binding, options = {}) {
        const state = profileCompatEnsureOverride();
        const profileId = String(options.profileId || state.activeProfileId);
        const profile = state.profiles[profileId];
        if (!profile) return { changed:false, reason:'profile-not-found', profileId };
        const normalized = profileCompatNormalizeBinding(binding, 0);
        if (!normalized) return { changed:false, reason:'invalid-binding', profileId };
        const conflicts = profileCompatAnalyzeConflicts(normalized, profileId);
        const resolution = options.conflictResolution || 'cancel';
        if (conflicts.length && resolution === 'cancel') {
            return { changed:false, reason:'conflict-resolution-required', profileId, binding:clone(normalized), conflicts };
        }
        if (conflicts.length && resolution === 'keep-both' && conflicts.some(item => !item.sameAction)) {
            return { changed:false, reason:'keep-both-unsafe', profileId, binding:clone(normalized), conflicts };
        }
        let nextBindings = (profile.bindings || []).filter(item => item.action !== normalized.action);
        if (resolution === 'replace') {
            const conflictIds = new Set(conflicts.map(item => item.binding?.id).filter(Boolean));
            nextBindings = nextBindings.filter(item => !conflictIds.has(item.id));
        }
        nextBindings.push(normalized);
        const criticalMissing = profileCompatGetCriticalActionsWithoutBindings(profileId, nextBindings);
        if (criticalMissing.length && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-actions', profileId, binding:clone(normalized), conflicts, actions:criticalMissing };
        }
        profile.bindings = nextBindings;
        const reload = profileId === state.activeProfileId ? profileCompatReload(profileId) : null;
        const result = { changed:true, reason:'binding-committed', profileId, binding:clone(normalized), conflicts, reload };
        profileCompatEmit('bindingCommitted', result);
        return result;
    }

    function profileCompatRemoveBinding(bindingId, options = {}) {
        const state = profileCompatEnsureOverride();
        const profileId = String(options.profileId || state.activeProfileId);
        const profile = state.profiles[profileId];
        if (!profile) return { changed:false, reason:'profile-not-found', profileId };
        const target = (profile.bindings || []).find(binding => binding.id === bindingId);
        if (!target) return { changed:false, reason:'binding-not-found', profileId, bindingId };
        if (profileRuntime()?.getActionMeta?.(target.action)?.critical === true && options.allowCriticalUnbound !== true) {
            return { changed:false, reason:'would-unbind-critical-action', profileId, bindingId, action:target.action };
        }
        profile.bindings = profile.bindings.filter(binding => binding.id !== bindingId);
        const reload = profileId === state.activeProfileId ? profileCompatReload(profileId) : null;
        const result = { changed:true, reason:'binding-removed', profileId, binding:clone(target), reload };
        profileCompatEmit('bindingRemoved', result);
        return result;
    }

    function profileCompatSetBehavior(patch, profileId = null) {
        const state = profileCompatEnsureOverride();
        const id = String(profileId || state.activeProfileId);
        const profile = state.profiles[id];
        if (!profile) return { changed:false, reason:'profile-not-found', profileId:id };
        profile.behavior = { ...profileCompatBehavior(profile), ...(patch && typeof patch === 'object' ? clone(patch) : {}) };
        const result = { changed:true, profileId:id, behavior:clone(profile.behavior) };
        profileCompatEmit('behaviorChanged', result);
        return result;
    }

    function profileCompatInstall() {
        const runtime = profileRuntime();
        if (!runtime) throw new Error('profileRuntime is not ready.');
        if (profileCompatibility) return profileCompatibility;

        profileCompatibility = Object.freeze({
            VERSION: `production-compat-${PROFILE_COMPAT_VERSION}`,
            version: PROFILE_COMPAT_VERSION,
            STORAGE_KEY: PROFILE_COMPAT_STORAGE_KEY,
            SCHEMA_VERSION: 1,
            ACTION_META: runtime.ACTION_META,
            initialize: options => options?.state ? profileCompatReplaceState(options.state, { source:'initialize', cache:false }) : profileCompatCurrentState(),
            persist: () => true,
            getState: profileCompatCurrentState,
            getActiveProfileId: () => profileCompatCurrentState().activeProfileId,
            getProfile: profileCompatGetProfile,
            getActiveProfile: () => profileCompatGetProfile(),
            getBindings: profileCompatGetBindings,
            getDefaultBindings: () => clone(runtime.getDefaultBindings?.() || []),
            getActionMeta: action => runtime.getActionMeta?.(action) || {},
            isGlobalAction: action => runtime.isGlobalAction?.(action) === true,
            isTextHandoffAction: action => runtime.isTextHandoffAction?.(action) === true,
            setActiveProfile: profileCompatSetActiveProfile,
            createProfile: profileCompatCreateProfile,
            deleteProfile: profileCompatDeleteProfile,
            resetProfile: profileCompatResetProfile,
            replaceBindingsForAction: profileCompatReplaceBindingsForAction,
            clearBindingsForAction: (action, profileId = null, options = {}) => profileCompatReplaceBindingsForAction(action, [], profileId, options),
            makeKeyboardBinding: (...args) => runtime.makeKeyboardBinding?.(...args) || null,
            makeCapturedBinding: (...args) => runtime.makeCapturedBinding?.(...args) || null,
            normalizeTrigger: (...args) => runtime.normalizeTrigger?.(...args) || null,
            analyzeConflicts: profileCompatAnalyzeConflicts,
            commitBinding: profileCompatCommitBinding,
            removeBinding: profileCompatRemoveBinding,
            getCriticalActionsWithoutBindings: profileCompatGetCriticalActionsWithoutBindings,
            setProfileBehavior: profileCompatSetBehavior,
            createDefaultState: () => profileCompatNormalizeState({ profiles:{} }),
            getMigrationCandidate: () => null,
            replaceState: profileCompatReplaceState,
            clearLocalCache: () => {
                try { localStorage.removeItem(PROFILE_COMPAT_STORAGE_KEY); } catch (_) {}
                return true;
            },
            clearPersistedForTesting: () => {
                profileOverrideState = profileCompatNormalizeState({ profiles:{} });
                profileOverrideSource = 'testing-reset';
                profileCompatReload(profileOverrideState.activeProfileId);
                profileCompatEmit('resetAll', profileCompatCurrentState());
                return profileCompatCurrentState();
            },
            on: profileCompatOn,
            off: profileCompatOff
        });

        QoL.profileCompatibility = profileCompatibility;

        if (!QoL.airKeybinds) {
            QoL.airKeybinds = profileCompatibility;
            console.log(LOG, 'Production profile compatibility facade installed as JellyfinQoL.airKeybinds.');
        } else if (QoL.airKeybinds !== profileCompatibility) {
            console.log(LOG, 'Prototype airKeybinds detected; compatibility facade is passive until the old profile script is disabled.');
        }

        return profileCompatibility;
    }

    function profileCompatReport() {
        const facade = profileCompatibility || QoL.profileCompatibility || null;
        const active = QoL.airKeybinds === facade;
        const legacy = QoL.airKeybinds && !active ? QoL.airKeybinds : null;
        const required = [
            'initialize','replaceState','getState','getActiveProfileId','getProfile','getActiveProfile','getBindings',
            'getActionMeta','isGlobalAction','isTextHandoffAction','makeCapturedBinding','analyzeConflicts','commitBinding','on','off'
        ];
        return {
            version: PROFILE_COMPAT_VERSION,
            ready: !!facade && required.every(name => typeof facade?.[name] === 'function'),
            takeoverActive: active,
            passiveComparisonMode: !!legacy,
            legacyPresent: !!legacy,
            legacyVersion: legacy?.VERSION || legacy?.version || null,
            overrideActive: !!profileOverrideState,
            overrideSource: profileOverrideSource,
            activeProfileId: facade?.getActiveProfileId?.() || null,
            bindingCount: facade?.getBindings?.().length ?? null,
            serverAuthority: 'JellyfinQoL.profileRuntime',
            replaceStatePersistence: 'transient-only'
        };
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

            profileCompatInstall();

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
            runtimeSettings: QoL.runtimeSettings?.getState?.() || null,
            profileCompatibility: profileCompatReport()
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
        refreshSettings,
        profileCompatibilityReport: profileCompatReport
    });

    start().catch(() => {});
})();
