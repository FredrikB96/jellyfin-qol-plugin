(function () {
    'use strict';

    const LOG = '[JellyfinQoL.UserSettings]';
    const STUB = '[JellyfinQoL.UserSettings][STUB]';
    const USER_SCHEMA_VERSION = 1;
    const CLIENT_SCHEMA_VERSION = 1;
    const CLIENT_STORAGE_KEY = 'jellyfin-qol-user-client-v1';

    const ACTIONS = [
        { action:'UP', label:'Up', input:'ArrowUp', gesture:'repeat', gestureCapable:false, allowRepeat:true },
        { action:'DOWN', label:'Down', input:'ArrowDown', gesture:'repeat', gestureCapable:false, allowRepeat:true },
        { action:'LEFT', label:'Left', input:'ArrowLeft', gesture:'repeat', gestureCapable:false, allowRepeat:true },
        { action:'RIGHT', label:'Right', input:'ArrowRight', gesture:'repeat', gestureCapable:false, allowRepeat:true },
        { action:'ACTIVATE', label:'Activate / OK', input:'Enter', gesture:'single', gestureCapable:false, allowRepeat:false },
        { action:'BACK', label:'Back', input:'BrowserBack', gesture:'single', gestureCapable:true, allowRepeat:false },
        { action:'ENTER_ACTIONS', label:'Item actions', input:'KeyA', gesture:'single', gestureCapable:false, allowRepeat:false },
        { action:'MENU', label:'Menu', input:'ContextMenu', gesture:'single', gestureCapable:true, allowRepeat:false },
        { action:'HOME', label:'Home / Refresh', input:'BrowserHome', gesture:'single', gestureCapable:true, allowRepeat:false },
        { action:'PLAY_PAUSE', label:'Play / Pause', input:'MediaPlayPause', gesture:'single', gestureCapable:false, allowRepeat:false },
        { action:'TOGGLE_CONTROL', label:'Player control mode', input:'F6', gesture:'single', gestureCapable:false, allowRepeat:false },
        { action:'TOGGLE_SEARCH_HANDOFF', label:'Search handoff toggle', input:'F7', gesture:'single', gestureCapable:false, allowRepeat:false },
        { action:'TOGGLE_SESSION_NAV', label:'Navigation mode this session', input:'', gesture:'single', gestureCapable:true, allowRepeat:false },
        { action:'EXIT_JELLYFIN', label:'Exit Jellyfin / HTPC', input:'BrowserBack', gesture:'long', gestureCapable:true, allowRepeat:false }
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

    const USER_DEFAULTS = {
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
    };

    const CLIENT_DEFAULTS = {
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
    };

    let root = null;
    let form = null;
    let userState = clone(USER_DEFAULTS);
    let savedUserState = clone(USER_DEFAULTS);
    let clientState = clone(CLIENT_DEFAULTS);
    let savedClientState = clone(CLIENT_DEFAULTS);
    let globalDefaults = {};
    let initialized = false;

    function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
    function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
    function merge(base, incoming) {
        if (!isObject(base)) return incoming === undefined ? clone(base) : clone(incoming);
        const out = clone(base);
        if (!isObject(incoming)) return out;
        Object.keys(incoming).forEach(key => {
            out[key] = isObject(out[key]) && isObject(incoming[key]) ? merge(out[key], incoming[key]) : clone(incoming[key]);
        });
        return out;
    }
    function getPath(object, path) { return path.split('.').reduce((value, key) => value == null ? undefined : value[key], object); }
    function setPath(object, path, value) {
        const parts = path.split('.');
        let target = object;
        parts.slice(0, -1).forEach(part => { if (!isObject(target[part])) target[part] = {}; target = target[part]; });
        target[parts[parts.length - 1]] = value;
    }
    function scopeObject(scope) { return scope === 'client' ? clientState : userState; }
    function inputValue(element) {
        if (element.type === 'checkbox') return !!element.checked;
        if (element.type === 'number') return element.value === '' ? null : Number(element.value);
        return element.value;
    }
    function setInputValue(element, value) {
        if (element.type === 'checkbox') element.checked = !!value;
        else element.value = value == null ? '' : value;
    }
    function logStub(name, payload) { console.log(STUB, name, payload || ''); }
    function notify(message) {
        try { Dashboard.alert(message); } catch (_) { console.log(LOG, message); }
    }
    function setStatus(id, message) {
        const element = root?.querySelector('#' + id);
        if (element) element.textContent = message;
    }

    function getToken() {
        try {
            if (typeof ApiClient?.accessToken === 'function') return ApiClient.accessToken() || null;
            if (typeof ApiClient?.accessToken === 'string') return ApiClient.accessToken || null;
        } catch (_) {}
        return null;
    }

    async function apiRequest(path, options = {}) {
        const headers = { Accept:'application/json', ...(options.headers || {}) };
        const token = getToken();
        if (token && !headers.Authorization) headers.Authorization = `MediaBrowser Token="${token}"`;
        if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const response = await fetch(ApiClient.getUrl(path), { ...options, headers, credentials:'same-origin' });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        if (!text) return null;
        try { return JSON.parse(text); } catch (_) { return text; }
    }

    function loadClientState() {
        try {
            const raw = localStorage.getItem(CLIENT_STORAGE_KEY);
            clientState = raw ? merge(CLIENT_DEFAULTS, JSON.parse(raw)) : clone(CLIENT_DEFAULTS);
        } catch (error) {
            console.warn(LOG, 'Could not read client-local QoL settings.', error);
            clientState = clone(CLIENT_DEFAULTS);
        }

        try {
            const runtimeState = window.JellyfinQoL?.airNavClient?.getState?.();
            if (runtimeState && typeof runtimeState.enabled === 'boolean') clientState.airNavEnabled = runtimeState.enabled;
        } catch (_) {}

        savedClientState = clone(clientState);
    }

    function saveClientState() {
        try {
            clientState.schemaVersion = CLIENT_SCHEMA_VERSION;
            localStorage.setItem(CLIENT_STORAGE_KEY, JSON.stringify(clientState));
            savedClientState = clone(clientState);
        } catch (error) {
            console.error(LOG, 'Could not persist client-local QoL settings.', error);
        }
    }

    function defaultsFromGlobal(globalDocument) {
        const source = globalDocument?.global || globalDocument || {};
        const next = clone(USER_DEFAULTS);
        for (const key of ['behavior','failure','search','notifications','navigation','focus','scroll','gestures','player']) {
            if (source[key]) next[key] = merge(next[key], source[key]);
        }
        const defaultProfileId = String(source.defaultProfileId || 'default');
        next.profiles.activeProfileId = defaultProfileId;
        if (!next.profiles.items[defaultProfileId]) next.profiles.items[defaultProfileId] = makeDefaultProfile(defaultProfileId, defaultProfileId === 'default' ? 'Default' : defaultProfileId);
        return next;
    }

    async function loadUserState() {
        const payload = await apiRequest('JellyfinQoL/UserSettings');
        globalDefaults = payload?.global || {};
        const baseline = defaultsFromGlobal(globalDefaults);
        const stored = payload?.user?.data || {};
        userState = merge(baseline, stored);
        normalizeProfiles();
        savedUserState = clone(userState);
        console.log(LOG, 'User settings loaded.', { user: userState, globalDefaults, client: clientState });
    }

    function normalizeProfiles() {
        userState.profiles = merge(USER_DEFAULTS.profiles, userState.profiles || {});
        if (!isObject(userState.profiles.items) || !Object.keys(userState.profiles.items).length) {
            userState.profiles.items = { default: makeDefaultProfile() };
        }
        Object.entries(userState.profiles.items).forEach(([id, profile]) => {
            const base = makeDefaultProfile(id, profile?.name || id);
            userState.profiles.items[id] = merge(base, profile || {});
            userState.profiles.items[id].id = id;
        });
        if (!userState.profiles.items[userState.profiles.activeProfileId]) userState.profiles.activeProfileId = Object.keys(userState.profiles.items)[0];
        if (!userState.profiles.items[clientState.activeProfileId]) clientState.activeProfileId = userState.profiles.activeProfileId;
    }

    function selectedProfile() {
        normalizeProfiles();
        return userState.profiles.items[userState.profiles.activeProfileId];
    }


    function decorateNativeControls() {
        if (!root) return;

        // Jellyfin's own preference pages render a separate arrow container
        // beside each select. Embedded plugin HTML does not always receive
        // that decoration automatically, so add the same DOM shape here.
        root.querySelectorAll('.selectContainer').forEach(container => {
            if (container.querySelector('.selectArrowContainer')) return;
            const select = container.querySelector('select');
            if (!select) return;
            const arrow = document.createElement('div');
            arrow.className = 'selectArrowContainer';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.innerHTML = '<div style="visibility:hidden;display:none;">0</div><span class="selectArrow material-icons keyboard_arrow_down"></span>';
            container.appendChild(arrow);
        });

        root.querySelectorAll('input[is="emby-input"]').forEach(input => input.classList.add('emby-input'));
        root.querySelectorAll('select[is="emby-select"]').forEach(select => select.classList.add('emby-select', 'emby-select-withcolor'));
        root.querySelectorAll('input[is="emby-checkbox"]').forEach(input => input.classList.add('emby-checkbox'));
        root.querySelectorAll('button[is="emby-button"]').forEach(button => button.classList.add('emby-button'));
        root.querySelectorAll('.inputLabel').forEach(label => label.classList.add('inputLabelUnfocused'));
    }

    function renderFields() {
        root.querySelectorAll('[data-scope][data-path]').forEach(element => {
            setInputValue(element, getPath(scopeObject(element.dataset.scope), element.dataset.path));
        });
    }

    function renderProfiles() {
        normalizeProfiles();
        const items = userState.profiles.items;
        const profileSelector = root.querySelector('#qolUserProfileSelector');
        const activeSelector = root.querySelector('#qolUserActiveProfile');
        const options = Object.values(items).map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('');
        profileSelector.innerHTML = options;
        activeSelector.innerHTML = options;
        profileSelector.value = userState.profiles.activeProfileId;
        activeSelector.value = clientState.activeProfileId;
        renderBindings();
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
    }

    function renderBindings() {
        const profile = selectedProfile();
        const host = root.querySelector('#qolUserBindings');
        host.innerHTML = ACTIONS.map(meta => {
            const binding = merge({ action:meta.action, label:meta.label, input:meta.input, gesture:meta.gesture, longPressMs:meta.gesture === 'long' ? userState.gestures.longPressMs : null, allowRepeat:meta.allowRepeat }, profile.bindings?.[meta.action] || {});
            profile.bindings = profile.bindings || {};
            profile.bindings[meta.action] = binding;
            const gestureDisabled = meta.gestureCapable ? '' : 'disabled';
            const longDisabled = binding.gesture === 'long' ? '' : 'disabled';
            const repeatDisabled = ['UP','DOWN','LEFT','RIGHT'].includes(meta.action) ? '' : 'disabled';
            return `<tr data-binding-action="${meta.action}">
                <td><strong>${escapeHtml(meta.label)}</strong></td>
                <td><input is="emby-input" type="text" data-binding-field="input" value="${escapeHtml(binding.input || '')}" readonly /></td>
                <td><select is="emby-select" class="emby-select-withcolor emby-select" data-binding-field="gesture" ${gestureDisabled}>
                    <option value="single" ${binding.gesture === 'single' ? 'selected' : ''}>Single</option>
                    <option value="double" ${binding.gesture === 'double' ? 'selected' : ''}>Double</option>
                    <option value="long" ${binding.gesture === 'long' ? 'selected' : ''}>Long</option>
                    <option value="repeat" ${binding.gesture === 'repeat' ? 'selected' : ''}>Hold / repeat</option>
                </select></td>
                <td><input is="emby-input" type="number" min="300" max="10000" step="100" data-binding-field="longPressMs" value="${binding.longPressMs || userState.gestures.longPressMs}" ${longDisabled} /></td>
                <td><input is="emby-checkbox" type="checkbox" data-binding-field="allowRepeat" ${binding.allowRepeat ? 'checked' : ''} ${repeatDisabled} /></td>
                <td><button is="emby-button" type="button" class="raised emby-button" data-qol-command="binding-record" data-action="${meta.action}">Record</button>
                    <button is="emby-button" type="button" class="raised emby-button" data-qol-command="binding-clear" data-action="${meta.action}">Clear</button></td>
            </tr>`;
        }).join('');
    }

    function renderProtectedInputs() {
        const host = root.querySelector('#qolUserProtectedInputs');
        host.innerHTML = (clientState.protectedInputs || []).map((item, index) => `<div class="qol-protected-grid" data-protected-index="${index}">
            <input is="emby-checkbox" type="checkbox" data-protected-field="enabled" ${item.enabled !== false ? 'checked' : ''} title="Enabled" />
            <input is="emby-input" type="text" data-protected-field="id" value="${escapeHtml(item.id || '')}" placeholder="id" />
            <input is="emby-input" type="number" min="0" max="255" data-protected-field="vkCode" value="${Number(item.vkCode || 0)}" />
            <input is="emby-input" type="text" data-protected-field="vkName" value="${escapeHtml(item.vkName || '')}" placeholder="VK name" />
            <input is="emby-input" type="text" data-protected-field="key" value="${escapeHtml(item.key || '')}" placeholder="Synthetic key" />
            <button is="emby-button" type="button" class="raised emby-button" data-qol-command="helper-remove" data-index="${index}">Remove</button>
        </div>`).join('');
    }

    function renderAll() {
        renderFields();
        renderProfiles();
        renderProtectedInputs();
        decorateNativeControls();
    }

    function markDirty(reason) {
        setStatus('qolUserSaveStatus', 'Unsaved changes. ' + (reason || ''));
    }

    async function save() {
        Dashboard.showLoadingMsg?.();
        try {
            await apiRequest('JellyfinQoL/UserSettings', {
                method:'PUT',
                body:JSON.stringify({ schemaVersion: USER_SCHEMA_VERSION, data:userState })
            });
            saveClientState();
            savedUserState = clone(userState);
            setStatus('qolUserSaveStatus', 'Saved.');
            console.log(LOG, 'User + client settings saved.', { user:userState, client:clientState });
            await applyLive('save');
        } finally {
            Dashboard.hideLoadingMsg?.();
        }
    }

    async function applyLive(reason) {
        const QoL = window.JellyfinQoL || {};
        console.log(LOG, 'Applying settings to available prototype/final runtime.', { reason, user:userState, client:clientState });

        if (QoL.airNavClient?.setEnabled) {
            try { await QoL.airNavClient.setEnabled(clientState.airNavEnabled === true); }
            catch (error) { console.warn(LOG, 'airNavClient.setEnabled failed', error); }
        } else {
            logStub('Apply client AirNav enrollment', clientState.airNavEnabled);
        }

        if (QoL.airGuard) {
            try {
                if (clientState.helperEnabled) QoL.airGuard.enable?.('user-settings');
                else QoL.airGuard.disable?.('user-settings');
            } catch (error) { console.warn(LOG, 'GuardManager apply failed', error); }
        } else if (clientState.helperEnabled) {
            logStub('Enable optional GuardManager companion', clientState.helperBaseUrl);
        }

        logStub('Hydrate final keybind/gesture resolver from saved profile', { activeProfileId:clientState.activeProfileId, profile:selectedProfile() });
        logStub('Apply final navigation/focus/scroll/player settings to migrated runtime', userState);
        logStub('Apply HTPC exit runtime bridge', clientState.htpcExit);
    }

    async function helperRequest(path, options = {}) {
        const base = String(clientState.helperBaseUrl || '').replace(/\/+$/, '');
        if (!base) throw new Error('Helper URL is empty.');
        const response = await fetch(base + path, { ...options, headers:{ Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
        if (!text) return null;
        try { return JSON.parse(text); } catch (_) { return text; }
    }

    function bindingRowChange(element) {
        const row = element.closest('tr[data-binding-action]');
        if (!row) return false;
        const action = row.dataset.bindingAction;
        const binding = selectedProfile().bindings[action];
        const field = element.dataset.bindingField;
        if (!binding || !field) return false;
        binding[field] = element.type === 'checkbox' ? !!element.checked : element.type === 'number' ? Number(element.value) : element.value;
        if (field === 'gesture') {
            if (binding.gesture === 'long' && !binding.longPressMs) binding.longPressMs = userState.gestures.longPressMs;
            renderBindings();
        }
        console.log(LOG, 'Binding changed', { action, binding:clone(binding) });
        markDirty('Binding changed.');
        return true;
    }

    function protectedInputChange(element) {
        const row = element.closest('[data-protected-index]');
        if (!row) return false;
        const item = clientState.protectedInputs?.[Number(row.dataset.protectedIndex)];
        if (!item) return false;
        const field = element.dataset.protectedField;
        if (!field) return false;
        item[field] = element.type === 'checkbox' ? !!element.checked : element.type === 'number' ? Number(element.value) : element.value;
        console.log(LOG, 'Protected input changed', clone(item));
        markDirty('Device helper configuration changed.');
        return true;
    }

    async function handleCommand(command, button) {
        switch (command) {
            case 'close':
                window.JellyfinQoL?.closeQoLUserSettings?.();
                return;
            case 'session-off':
                if (typeof window.JellyfinQoL?.disableAirNav === 'function') {
                    window.JellyfinQoL.disableAirNav();
                    notify('Navigation mode turned off for this session');
                } else logStub('Session-only AirNav disable');
                return;
            case 'apply-live':
                await applyLive('manual');
                return;
            case 'profile-create': {
                const name = prompt('Profile name');
                if (!name?.trim()) return;
                const idBase = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
                let id = idBase;
                let suffix = 2;
                while (userState.profiles.items[id]) id = idBase + '-' + suffix++;
                userState.profiles.items[id] = makeDefaultProfile(id, name.trim());
                userState.profiles.activeProfileId = id;
                clientState.activeProfileId = id;
                renderAll(); markDirty('Profile created.');
                console.log(LOG, 'Profile created', id);
                return;
            }
            case 'profile-delete': {
                const ids = Object.keys(userState.profiles.items);
                if (ids.length <= 1) { notify('At least one profile must remain.'); return; }
                const profile = selectedProfile();
                if (!confirm(`Delete profile "${profile.name}"?`)) return;
                delete userState.profiles.items[profile.id];
                userState.profiles.activeProfileId = Object.keys(userState.profiles.items)[0];
                clientState.activeProfileId = userState.profiles.activeProfileId;
                renderAll(); markDirty('Profile deleted.');
                return;
            }
            case 'profile-reset': {
                const profile = selectedProfile();
                if (!confirm(`Reset profile "${profile.name}" to defaults?`)) return;
                userState.profiles.items[profile.id] = makeDefaultProfile(profile.id, profile.name);
                renderBindings(); markDirty('Profile reset.');
                return;
            }
            case 'profile-export':
                root.querySelector('#qolUserProfileJson').value = JSON.stringify(selectedProfile(), null, 2);
                return;
            case 'profile-import':
                try {
                    const value = JSON.parse(root.querySelector('#qolUserProfileJson').value);
                    if (!value.id || !value.name) throw new Error('Profile requires id and name.');
                    userState.profiles.items[value.id] = merge(makeDefaultProfile(value.id, value.name), value);
                    userState.profiles.activeProfileId = value.id;
                    clientState.activeProfileId = value.id;
                    renderAll(); markDirty('Profile imported.');
                } catch (error) { notify('Invalid profile JSON: ' + error.message); }
                return;
            case 'binding-record':
                logStub('Record physical input for binding', { action:button.dataset.action, profileId:selectedProfile().id });
                return;
            case 'binding-clear': {
                const action = button.dataset.action;
                if (selectedProfile().bindings[action]) selectedProfile().bindings[action].input = '';
                renderBindings(); markDirty('Binding cleared.');
                return;
            }
            case 'helper-status':
                try { const result = await helperRequest('/status'); setStatus('qolUserHelperStatus', JSON.stringify(result, null, 2)); console.log(LOG, 'Helper status', result); }
                catch (error) { setStatus('qolUserHelperStatus', 'Helper unavailable: ' + error.message); }
                return;
            case 'helper-load':
                try {
                    const result = await helperRequest('/inputs');
                    const items = Array.isArray(result) ? result : (result?.inputs || []);
                    if (items.length) clientState.protectedInputs = items.map(item => ({ enabled:item.enabled !== false, id:item.id, vkCode:item.vkCode, vkName:item.vkName || '', key:item.key || '', code:item.code || '' }));
                    renderProtectedInputs(); markDirty('Loaded helper registry into this device settings.');
                } catch (error) { setStatus('qolUserHelperStatus', 'Could not load helper inputs: ' + error.message); }
                return;
            case 'helper-save':
                try {
                    const result = await helperRequest('/inputs', { method:'PUT', body:JSON.stringify({ schemaVersion:2, inputs:clientState.protectedInputs }) });
                    setStatus('qolUserHelperStatus', 'Protected inputs saved to helper.\n' + JSON.stringify(result || {}, null, 2));
                } catch (error) { setStatus('qolUserHelperStatus', 'Helper registry write unavailable: ' + error.message); logStub('Protected input helper write', clientState.protectedInputs); }
                return;
            case 'helper-add':
                clientState.protectedInputs.push({ enabled:true, id:'custom-' + Date.now(), vkCode:0, vkName:'', key:'', code:'' });
                renderProtectedInputs(); markDirty('Protected input added.');
                return;
            case 'helper-remove':
                clientState.protectedInputs.splice(Number(button.dataset.index), 1);
                renderProtectedInputs(); markDirty('Protected input removed.');
                return;
            case 'helper-record':
                logStub('Record physical Windows VK for protected input');
                return;
            case 'htpc-test-exit':
                logStub('HTPC exit pipeline called', clientState.htpcExit);
                return;
            case 'diag-runtime':
                console.log(LOG, 'Runtime diagnostics', { QoL:window.JellyfinQoL, user:userState, client:clientState, globalDefaults });
                return;
            case 'diag-scanner':
                if (window.JellyfinQoL?.airScanner?.scan) console.log(LOG, 'Scanner rescan result', window.JellyfinQoL.airScanner.scan('user-settings-diagnostic'));
                else logStub('Scanner rescan diagnostic');
                return;
            case 'diag-geometry':
                if (window.JellyfinQoL?.airGeometry?.getDebugSnapshot) console.log(LOG, 'Geometry snapshot', window.JellyfinQoL.airGeometry.getDebugSnapshot());
                else logStub('Geometry diagnostic snapshot');
                return;
            case 'diag-focus':
                if (window.JellyfinQoL?.airFocus?.getState) console.log(LOG, 'Focus snapshot', window.JellyfinQoL.airFocus.getState());
                else logStub('Focus diagnostic snapshot');
                return;
            case 'reset-user':
                if (!confirm('Reset your Jellyfin QoL settings to server defaults?')) return;
                await apiRequest('JellyfinQoL/UserSettings', { method:'DELETE' });
                userState = defaultsFromGlobal(globalDefaults);
                normalizeProfiles(); savedUserState = clone(userState); renderAll(); markDirty('Server user settings reset. Save if you make further changes.');
                return;
            case 'reset-client':
                if (!confirm('Reset QoL settings stored only on this browser/WebView?')) return;
                clientState = clone(CLIENT_DEFAULTS); renderAll(); markDirty('This device settings reset.');
                return;
            case 'export-user':
                root.querySelector('#qolUserSettingsJson').value = JSON.stringify({ schemaVersion:USER_SCHEMA_VERSION, data:userState }, null, 2);
                return;
            case 'import-user':
                try {
                    const parsed = JSON.parse(root.querySelector('#qolUserSettingsJson').value);
                    const incoming = parsed?.data || parsed;
                    userState = merge(defaultsFromGlobal(globalDefaults), incoming);
                    normalizeProfiles(); renderAll(); markDirty('User settings imported.');
                } catch (error) { notify('Invalid settings JSON: ' + error.message); }
                return;
            case 'revert':
                userState = clone(savedUserState);
                clientState = clone(savedClientState);
                renderAll(); setStatus('qolUserSaveStatus', 'Reverted unsaved changes.');
                return;
        }
    }

    async function initialize(nextRoot) {
        if (initialized) destroy();
        root = nextRoot || document.querySelector('#JellyfinQoLUserSettingsPage');
        if (!root) throw new Error('QoL user settings root not found.');
        form = root.querySelector('#JellyfinQoLUserSettingsForm');
        loadClientState();
        Dashboard.showLoadingMsg?.();
        try {
            await loadUserState();
            renderAll();
            setStatus('qolUserSaveStatus', 'No unsaved changes.');
        } catch (error) {
            console.error(LOG, 'Failed to load user settings.', error);
            setStatus('qolUserSaveStatus', 'Could not load user settings: ' + error.message);
        } finally {
            Dashboard.hideLoadingMsg?.();
        }

        root.addEventListener('change', onChange);
        root.addEventListener('click', onClick);
        form.addEventListener('submit', onSubmit);
        root.querySelector('#qolUserProfileSelector').addEventListener('change', onProfileSelectorChange);
        initialized = true;
        console.log(LOG, 'User settings page initialized.');
    }

    function onChange(event) {
        const element = event.target;
        if (bindingRowChange(element) || protectedInputChange(element)) return;
        if (!element.matches?.('[data-scope][data-path]')) return;
        setPath(scopeObject(element.dataset.scope), element.dataset.path, inputValue(element));
        if (element.dataset.scope === 'client' && element.dataset.path === 'activeProfileId') clientState.activeProfileId = element.value;
        console.log(LOG, 'Setting changed', { scope:element.dataset.scope, path:element.dataset.path, value:getPath(scopeObject(element.dataset.scope), element.dataset.path) });
        markDirty();
    }

    function onClick(event) {
        const button = event.target.closest?.('[data-qol-command]');
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        handleCommand(button.dataset.qolCommand, button).catch(error => console.error(LOG, 'Command failed', button.dataset.qolCommand, error));
    }

    function onSubmit(event) {
        event.preventDefault();
        save().catch(error => { console.error(LOG, 'Save failed', error); setStatus('qolUserSaveStatus', 'Save failed: ' + error.message); });
    }

    function onProfileSelectorChange(event) {
        userState.profiles.activeProfileId = event.target.value;
        renderBindings();
        markDirty('Selected profile changed.');
    }

    function destroy() {
        if (!root) return;
        try { root.removeEventListener('change', onChange); } catch (_) {}
        try { root.removeEventListener('click', onClick); } catch (_) {}
        try { form?.removeEventListener('submit', onSubmit); } catch (_) {}
        initialized = false;
        root = null;
        form = null;
    }

    window.JellyfinQoLUserSettingsPage = Object.freeze({ initialize, destroy });
})();
