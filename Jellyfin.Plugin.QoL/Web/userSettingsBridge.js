(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.userSettingsBridge?.version === '1.2.5') return;

    const VERSION = '1.2.5';
    const LOG = '[JellyfinQoL.UserSettingsBridge]';
    const ENTRY_ID = 'jellyfinQoLUserSettingsLink';
    const HOST_ID = 'jellyfinQoLUserSettingsHost';
    const STYLE_ID = 'jellyfinQoLUserSettingsNativeControlStyles';
    const PAGE_RESOURCE = 'JellyfinQoLUserSettingsPage';
    const SCRIPT_RESOURCE = 'JellyfinQoLUserSettingsPage.js';
    const KEYBIND_RESOURCE = 'userSettingsKeybindIntegration.js';

    let observer = null;
    let scheduled = false;
    let opening = null;
    let hiddenSourcePage = null;
    let headerTitleSnapshot = null;
    let keybindLoading = null;
    let scannerFormOverride = null;
    let openGeneration = 0;

    function setNativeHeaderTitle(title) {
        const element = document.querySelector('.skinHeader .pageTitle, .pageTitle');
        if (!element) return false;
        if (!headerTitleSnapshot) headerTitleSnapshot = { element, html:element.innerHTML };
        element.textContent = String(title || 'QoL Settings');
        return true;
    }

    function restoreNativeHeaderTitle() {
        const snapshot = headerTitleSnapshot;
        headerTitleSnapshot = null;
        if (!snapshot?.element?.isConnected) return false;
        snapshot.element.innerHTML = snapshot.html;
        return true;
    }

    function handleHeaderBack(event) {
        const host = document.getElementById(HOST_ID);
        if (!host || !isPreferencesMenuRoute()) return;

        const button = event.target?.closest?.('.headerBackButton');
        if (!button?.isConnected) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        closeUserSettings({ reason:'header-back' });
    }

    function configurationResourceUrl(name) {
        return ApiClient.getUrl(`web/ConfigurationPage?name=${encodeURIComponent(name)}`);
    }

    function clientResourceUrl(name) {
        return ApiClient.getUrl(`JellyfinQoL/Client/${name}`);
    }

    function isPreferencesMenuRoute() {
        return /^#\/mypreferencesmenu\b/i.test(location.hash || '');
    }

    function isOpenAttemptCurrent(token, host = null) {
        return !!(
            token === openGeneration &&
            isPreferencesMenuRoute() &&
            (!host || host.isConnected)
        );
    }

    // Compatibility names retained because older settings/keybind code may call
    // them. Production QoL Settings must stay AirNav-navigable: the settings
    // page itself is a normal AirNav form surface. Only recorder capture is
    // allowed to take exclusive input ownership temporarily.
    function suspendNavigationForSettings() {
        return ensureNavigationSuspended();
    }

    function ensureNavigationSuspended() {
        const input = QoL.airNavInput;
        if (!input?.getState) return false;

        const state = input.getState() || {};
        if (state.suspended && state.suspendReason === 'qol-user-settings') {
            try {
                input.resume?.();
                console.log(LOG, 'Cleared legacy QoL Settings AirNav suspension.');
            } catch (error) {
                console.warn(LOG, 'Could not clear legacy QoL Settings suspension.', error);
                return false;
            }
        }

        const next = input.getState?.() || {};
        return next.suspended !== true;
    }

    function restoreNavigationSuspension() {
        const input = QoL.airNavInput;
        const state = input?.getState?.() || {};
        if (state.suspended && state.suspendReason === 'qol-user-settings') {
            try { input.resume?.(); }
            catch (error) {
                console.warn(LOG, 'Could not clear QoL Settings suspension on close.', error);
                return false;
            }
        }
        return true;
    }

    function enableQoLScannerFormSurface(reason = 'open') {
        const scannerApi = QoL.airScanner;
        if (!scannerApi?.create) return false;

        let scanner = null;
        try {
            scanner = scannerApi.create();
        } catch (error) {
            console.warn(LOG, 'Could not access AirNav Scanner for QoL form integration.', error);
            return false;
        }

        if (!scanner?.cfg) return false;

        if (!scannerFormOverride) {
            scannerFormOverride = {
                instance: scanner,
                pageFormRoutePattern: scanner.cfg.pageFormRoutePattern
            };
        }

        // QoL Settings is mounted over #/mypreferencesmenu without changing the
        // Jellyfin route. Scanner normally excludes that menu route from form
        // discovery. While this DLL-hosted page is visible, treat the same route
        // as a form surface so select/checkbox/range/number controls become
        // NavigationItems alongside action buttons.
        scanner.cfg.pageFormRoutePattern = /^#\/mypreferences/i;

        try {
            scannerApi.scan?.(`qol-settings-form:${reason}`);
        } catch (error) {
            console.warn(LOG, 'Could not rescan QoL Settings as an AirNav form.', error);
        }

        try {
            QoL.airFocus?.refresh?.(`qol-settings-form:${reason}`);
        } catch (_) {}

        return true;
    }

    function restoreQoLScannerFormSurface(reason = 'close') {
        const saved = scannerFormOverride;
        scannerFormOverride = null;

        if (!saved?.instance?.cfg) return false;

        saved.instance.cfg.pageFormRoutePattern = saved.pageFormRoutePattern;

        try {
            QoL.airScanner?.scan?.(`qol-settings-form-restore:${reason}`);
        } catch (error) {
            console.warn(LOG, 'Could not restore Scanner after QoL Settings closed.', error);
        }

        try {
            QoL.airFocus?.refresh?.(`qol-settings-form-restore:${reason}`);
        } catch (_) {}

        return true;
    }

    function reconcileLifecycle(reason = 'manual') {
        const host = document.getElementById(HOST_ID);
        const onPreferencesMenu = isPreferencesMenuRoute();

        // Jellyfin's SPA can update location.hash through a navigation path that
        // does not emit hashchange. The settings host is deliberately mounted on
        // top of #/mypreferencesmenu, so route ownership must be reconciled from
        // DOM mutations/popstate as well. Never let a stale settings host leak
        // into Home, playback, or another Jellyfin surface.
        if (host && !onPreferencesMenu) {
            closeUserSettings({
                restoreSource:false,
                reason:`route-left:${reason}`
            });
            return false;
        }

        if (onPreferencesMenu) {
            ensureEntry();
        }

        return true;
    }

    function scheduleLifecycleReconcile(reason = 'scheduled') {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            reconcileLifecycle(reason);
        });
    }

    // Compatibility helper retained for callers/tests that still use the old
    // entry-only scheduler name.
    function scheduleEnsureEntry() {
        scheduleLifecycleReconcile('ensure-entry');
    }

    function ensureEntry() {
        if (!isPreferencesMenuRoute()) return false;
        if (document.getElementById(ENTRY_ID)) return true;

        const page = document.querySelector('#myPreferencesMenuPage.page:not(.hide), #myPreferencesMenuPage');
        if (!page) return false;
        const section = page.querySelector('.verticalSection');
        if (!section) return false;

        const entry = document.createElement('a');
        entry.id = ENTRY_ID;
        entry.setAttribute('is', 'emby-linkbutton');
        entry.setAttribute('data-ripple', 'false');
        entry.href = '#';
        entry.className = 'listItem-border emby-button';
        entry.style.display = 'block';
        entry.style.padding = '0';
        entry.style.margin = '0';
        entry.innerHTML = `
            <div class="listItem">
                <span class="material-icons listItemIcon listItemIcon-transparent tune" aria-hidden="true"></span>
                <div class="listItemBody"><div class="listItemBodyText">QoL Settings</div></div>
            </div>`;

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openUserSettings().catch(error => console.error(LOG, 'Could not open QoL Settings.', error));
        });

        const enhanced = section.querySelector('#jellyfinEnhancedUserPrefsLink');
        if (enhanced?.nextSibling) enhanced.parentNode.insertBefore(entry, enhanced.nextSibling);
        else section.appendChild(entry);
        return true;
    }

    function loadScript() {
        if (window.JellyfinQoLUserSettingsPage?.initialize) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-jellyfin-qol-user-settings-page]');
            if (existing) {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (window.JellyfinQoLUserSettingsPage?.initialize) {
                        clearInterval(timer);
                        resolve();
                    } else if (Date.now() - started > 5000) {
                        clearInterval(timer);
                        reject(new Error('Timed out waiting for user settings page script.'));
                    }
                }, 50);
                return;
            }

            const script = document.createElement('script');
            script.src = configurationResourceUrl(SCRIPT_RESOURCE);
            script.async = true;
            script.dataset.jellyfinQolUserSettingsPage = 'true';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load embedded QoL user settings script.'));
            document.head.appendChild(script);
        });
    }

    function ensureNativeControlStyles() {
        if (document.getElementById(STYLE_ID)) return true;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #JellyfinQoLUserSettingsPage .checkboxContainer {
                display:flex;
                align-items:center;
                gap:.7em;
                cursor:pointer;
            }

            #JellyfinQoLUserSettingsPage input.qol-native-checkbox {
                -webkit-appearance:checkbox !important;
                appearance:auto !important;
                display:inline-block !important;
                position:static !important;
                width:1.25em !important;
                height:1.25em !important;
                min-width:1.25em !important;
                margin:0 !important;
                padding:0 !important;
                opacity:1 !important;
                visibility:visible !important;
                clip:auto !important;
                clip-path:none !important;
                pointer-events:auto !important;
                vertical-align:middle;
                cursor:pointer;
                accent-color:var(--theme-primary-color, #00a4dc);
            }

            #JellyfinQoLUserSettingsPage input.qol-native-checkbox:focus-visible {
                outline:2px solid currentColor;
                outline-offset:2px;
            }

            #JellyfinQoLUserSettingsPage input.qol-native-checkbox:disabled {
                cursor:default;
                opacity:.55 !important;
            }
        `;
        document.head.appendChild(style);
        return true;
    }

    function sanitizeQoLMarkup(value) {
        if (typeof value !== 'string') return value;
        return value.replace(
            /\s+is=(['"])emby-(input|select|checkbox|button|linkbutton)\1/gi,
            (_match, _quote, kind) => ` data-qol-emby-style="${String(kind).toLowerCase()}"`
        );
    }

    function applyQoLControlClasses(scope) {
        if (!scope?.querySelectorAll) return 0;
        ensureNativeControlStyles();

        let applied = 0;
        scope.querySelectorAll('[data-qol-emby-style]').forEach(element => {
            const kind = String(element.dataset.qolEmbyStyle || '').toLowerCase();
            if (kind === 'input') element.classList.add('emby-input');
            else if (kind === 'select') element.classList.add('emby-select', 'emby-select-withcolor');
            else if (kind === 'checkbox') {
                element.classList.remove('emby-checkbox');
                element.classList.add('qol-native-checkbox');
            }
            else if (kind === 'button' || kind === 'linkbutton') element.classList.add('emby-button');
            element.removeAttribute('data-qol-emby-style');
            applied += 1;
        });
        return applied;
    }

    function installSafeDynamicControls(page) {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (!descriptor?.get || !descriptor?.set) return false;

        let installed = 0;
        for (const id of ['qolUserBindings', 'qolUserProtectedInputs']) {
            const host = page?.querySelector(`#${id}`);
            if (!host || host.dataset.qolSafeDynamicControls === 'true') continue;
            Object.defineProperty(host, 'innerHTML', {
                configurable: true,
                enumerable: descriptor.enumerable,
                get() { return descriptor.get.call(this); },
                set(value) {
                    descriptor.set.call(this, sanitizeQoLMarkup(value));
                    applyQoLControlClasses(this);
                }
            });
            host.dataset.qolSafeDynamicControls = 'true';
            installed += 1;
        }
        return installed > 0;
    }

    function loadKeybindIntegration() {
        const existingRuntime = QoL.userSettingsKeybindIntegration;
        if (existingRuntime?.version === '1.1.0') {
            existingRuntime.decorateDirectionalRows?.();
            return Promise.resolve(existingRuntime);
        }

        if (existingRuntime) {
            try { existingRuntime.destroy?.(); } catch (_) {}
            try { delete QoL.userSettingsKeybindIntegration; } catch (_) {}
        }

        if (keybindLoading) return keybindLoading;
        keybindLoading = new Promise((resolve, reject) => {
            document.querySelectorAll('script[data-jellyfin-qol-keybind-settings]').forEach(script => script.remove());
            const script = document.createElement('script');
            script.async = true;
            script.dataset.jellyfinQolKeybindSettings = 'true';
            script.src = clientResourceUrl(KEYBIND_RESOURCE) + `?qolkeybind=${encodeURIComponent(Date.now().toString())}`;
            script.onload = () => {
                const runtime = QoL.userSettingsKeybindIntegration;
                if (!runtime) return reject(new Error('Keybind settings integration loaded without registering runtime.'));
                runtime.decorateDirectionalRows?.();
                enableQoLScannerFormSurface('keybind-integration-ready');
                resolve(runtime);
            };
            script.onerror = () => reject(new Error('Failed to load keybind settings integration.'));
            document.head.appendChild(script);
        }).finally(() => { keybindLoading = null; });
        return keybindLoading;
    }

    async function openUserSettings() {
        if (opening) return opening;

        if (!isPreferencesMenuRoute()) {
            reconcileLifecycle('open-outside-preferences');
            return false;
        }

        if (document.getElementById(HOST_ID)) {
            ensureNavigationSuspended();
            enableQoLScannerFormSurface('already-open');
            return true;
        }

        const openToken = ++openGeneration;
        suspendNavigationForSettings();

        opening = (async () => {
            Dashboard.showLoadingMsg?.();
            try {
                const response = await fetch(configurationResourceUrl(PAGE_RESOURCE), { credentials:'same-origin' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const html = await response.text();

                // The user may navigate away while the settings page resource is
                // loading. In that case, abandon the open without touching the
                // newly-active Jellyfin surface.
                if (!isOpenAttemptCurrent(openToken)) {
                    restoreNavigationSuspension();
                    return false;
                }

                const sourcePage = document.querySelector('#myPreferencesMenuPage.page:not(.hide), #myPreferencesMenuPage');
                const mountPoint = sourcePage?.parentElement || document.body;
                const host = document.createElement('div');
                host.id = HOST_ID;
                host.innerHTML = sanitizeQoLMarkup(html);
                applyQoLControlClasses(host);

                if (sourcePage) {
                    hiddenSourcePage = sourcePage;
                    sourcePage.classList.add('hide');
                    sourcePage.setAttribute('aria-hidden', 'true');
                }

                setNativeHeaderTitle('QoL Settings');
                mountPoint.appendChild(host);

                if (!isOpenAttemptCurrent(openToken, host)) {
                    closeUserSettings({ restoreSource:false, reason:'open-route-left-after-mount' });
                    return false;
                }

                await loadScript();

                if (!isOpenAttemptCurrent(openToken, host)) {
                    if (host.isConnected) {
                        closeUserSettings({ restoreSource:false, reason:'open-route-left-after-script' });
                    }
                    return false;
                }

                const page = host.querySelector('#JellyfinQoLUserSettingsPage');
                installSafeDynamicControls(page);
                await window.JellyfinQoLUserSettingsPage.initialize(page);

                if (!isOpenAttemptCurrent(openToken, host)) {
                    if (host.isConnected) {
                        closeUserSettings({ restoreSource:false, reason:'open-route-left-after-initialize' });
                    }
                    return false;
                }

                applyQoLControlClasses(page);
                ensureNavigationSuspended();
                enableQoLScannerFormSurface('page-initialized');

                // Reconcile once more after asynchronous page initialization.
                // This closes the host if a Jellyfin SPA transition won the race
                // without delivering hashchange to this bridge.
                reconcileLifecycle('page-initialized');

                if (!isOpenAttemptCurrent(openToken, host)) {
                    return false;
                }

                setTimeout(() => {
                    if (!isOpenAttemptCurrent(openToken, host)) return;
                    loadKeybindIntegration().catch(error => {
                        console.error(LOG, 'Keybind settings integration could not be loaded.', error);
                    });
                }, 0);

                console.log(LOG, 'Opened DLL-hosted QoL settings as an AirNav form surface.');
                return true;
            } catch (error) {
                const staleOpen = openToken !== openGeneration || !isPreferencesMenuRoute();

                document.getElementById(HOST_ID)?.remove();
                if (hiddenSourcePage?.isConnected && !staleOpen) {
                    hiddenSourcePage.classList.remove('hide');
                    hiddenSourcePage.removeAttribute('aria-hidden');
                }
                hiddenSourcePage = null;
                restoreQoLScannerFormSurface(staleOpen ? 'open-stale' : 'open-failed');

                if (staleOpen) {
                    headerTitleSnapshot = null;
                    restoreNavigationSuspension();
                    return false;
                }

                restoreNativeHeaderTitle();
                restoreNavigationSuspension();
                throw error;
            } finally {
                opening = null;
                Dashboard.hideLoadingMsg?.();
            }
        })();
        return opening;
    }

    function closeUserSettings(options = {}) {
        // Invalidate any asynchronous open still awaiting a resource/script or
        // page initialization before removing the current host.
        openGeneration += 1;

        try { QoL.userSettingsKeybindIntegration?.pageClosed?.(); } catch (_) {}
        try { window.JellyfinQoLUserSettingsPage?.destroy?.(); } catch (_) {}
        document.getElementById(HOST_ID)?.remove();

        const shouldRestore = options.restoreSource !== false && isPreferencesMenuRoute();
        if (shouldRestore && hiddenSourcePage?.isConnected) {
            hiddenSourcePage.classList.remove('hide');
            hiddenSourcePage.removeAttribute('aria-hidden');
            restoreNativeHeaderTitle();
        } else {
            headerTitleSnapshot = null;
        }
        hiddenSourcePage = null;
        restoreQoLScannerFormSurface(options.reason || 'page-closed');
        restoreNavigationSuspension();
        return true;
    }

    function handleNavigationChange(event) {
        const reason = event?.type || 'navigation';

        // Synchronous pass closes stale settings immediately; the rAF pass
        // catches DOM/route state that settles a moment later.
        reconcileLifecycle(reason);
        scheduleLifecycleReconcile(`${reason}:settled`);
    }

    function start() {
        if (!observer) {
            observer = new MutationObserver(() => scheduleLifecycleReconcile('mutation'));
            observer.observe(document.documentElement, { childList:true, subtree:true });
            window.addEventListener('hashchange', handleNavigationChange);
            window.addEventListener('popstate', handleNavigationChange);
            document.addEventListener('click', handleHeaderBack, true);
        }
        scheduleLifecycleReconcile('start');
    }

    function destroy() {
        observer?.disconnect();
        observer = null;
        window.removeEventListener('hashchange', handleNavigationChange);
        window.removeEventListener('popstate', handleNavigationChange);
        document.removeEventListener('click', handleHeaderBack, true);
        closeUserSettings({ reason:'bridge-destroy' });
        restoreQoLScannerFormSurface('bridge-destroy');
        document.getElementById(ENTRY_ID)?.remove();
    }

    QoL.openQoLUserSettings = openUserSettings;
    QoL.closeQoLUserSettings = closeUserSettings;
    QoL.userSettingsBridge = Object.freeze({
        version: VERSION,
        start,
        destroy,
        ensureEntry,
        open:openUserSettings,
        close:closeUserSettings,
        loadKeybindIntegration,
        ensureNavigationSuspended,
        suspendNavigationForSettings,
        restoreNavigationSuspension,
        enableQoLScannerFormSurface,
        restoreQoLScannerFormSurface,
        reconcileLifecycle,
        scheduleLifecycleReconcile,
        sanitizeQoLMarkup,
        applyQoLControlClasses,
        installSafeDynamicControls,
        ensureNativeControlStyles
    });

    start();
})();
