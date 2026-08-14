(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.userSettingsBridge?.version === '1.2.0') return;

    const VERSION = '1.2.0';
    const LOG = '[JellyfinQoL.UserSettingsBridge]';
    const ENTRY_ID = 'jellyfinQoLUserSettingsLink';
    const HOST_ID = 'jellyfinQoLUserSettingsHost';
    const PAGE_RESOURCE = 'JellyfinQoLUserSettingsPage';
    const SCRIPT_RESOURCE = 'JellyfinQoLUserSettingsPage.js';
    const KEYBIND_RESOURCE = 'userSettingsKeybindIntegration.js';

    let observer = null;
    let scheduled = false;
    let opening = null;
    let hiddenSourcePage = null;
    let headerTitleSnapshot = null;
    let keybindLoading = null;
    let navigationSuspensionCaptured = false;
    let suspensionBeforeOpen = null;

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

    function configurationResourceUrl(name) {
        return ApiClient.getUrl(`web/ConfigurationPage?name=${encodeURIComponent(name)}`);
    }

    function clientResourceUrl(name) {
        return ApiClient.getUrl(`JellyfinQoL/Client/${name}`);
    }

    function suspendNavigationForSettings() {
        const input = QoL.airNavInput;
        if (!input?.suspend) return false;

        if (!navigationSuspensionCaptured) {
            const state = input.getState?.() || {};
            suspensionBeforeOpen = state.suspended ? (state.suspendReason || 'manual') : null;
            navigationSuspensionCaptured = true;
        }

        try {
            input.suspend('qol-user-settings');
            return true;
        } catch (error) {
            console.warn(LOG, 'Could not suspend AirNav for QoL Settings.', error);
            return false;
        }
    }

    function ensureNavigationSuspended() {
        if (!document.getElementById(HOST_ID)) return false;
        const input = QoL.airNavInput;
        if (!input?.suspend) return false;
        const state = input.getState?.() || {};
        if (state.suspended && state.suspendReason === 'qol-user-settings') return true;
        try {
            input.suspend('qol-user-settings');
            return true;
        } catch (error) {
            console.warn(LOG, 'Could not restore QoL Settings input suspension.', error);
            return false;
        }
    }

    function restoreNavigationSuspension() {
        if (!navigationSuspensionCaptured) return true;
        const input = QoL.airNavInput;
        const previousReason = suspensionBeforeOpen;
        navigationSuspensionCaptured = false;
        suspensionBeforeOpen = null;

        if (!input) return true;
        try {
            if (input.getState?.().suspended) input.resume?.();
            if (previousReason) input.suspend?.(previousReason);
            return true;
        } catch (error) {
            console.warn(LOG, 'Could not restore previous AirNav suspension state.', error);
            return false;
        }
    }

    function scheduleEnsureEntry() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            ensureEntry();
        });
    }

    function ensureEntry() {
        if (!/^#\/mypreferencesmenu\b/i.test(location.hash || '')) return false;
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

    function sanitizeQoLMarkup(value) {
        if (typeof value !== 'string') return value;
        return value.replace(
            /\s+is=(['"])emby-(input|select|checkbox|button|linkbutton)\1/gi,
            (_match, _quote, kind) => ` data-qol-emby-style="${String(kind).toLowerCase()}"`
        );
    }

    function applyQoLControlClasses(scope) {
        if (!scope?.querySelectorAll) return 0;
        let applied = 0;
        scope.querySelectorAll('[data-qol-emby-style]').forEach(element => {
            const kind = String(element.dataset.qolEmbyStyle || '').toLowerCase();
            if (kind === 'input') element.classList.add('emby-input');
            else if (kind === 'select') element.classList.add('emby-select', 'emby-select-withcolor');
            else if (kind === 'checkbox') element.classList.add('emby-checkbox');
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
                resolve(runtime);
            };
            script.onerror = () => reject(new Error('Failed to load keybind settings integration.'));
            document.head.appendChild(script);
        }).finally(() => { keybindLoading = null; });
        return keybindLoading;
    }

    async function openUserSettings() {
        if (opening) return opening;
        if (document.getElementById(HOST_ID)) {
            ensureNavigationSuspended();
            return true;
        }

        suspendNavigationForSettings();
        opening = (async () => {
            Dashboard.showLoadingMsg?.();
            try {
                const response = await fetch(configurationResourceUrl(PAGE_RESOURCE), { credentials:'same-origin' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const html = await response.text();

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
                await loadScript();

                const page = host.querySelector('#JellyfinQoLUserSettingsPage');
                installSafeDynamicControls(page);
                await window.JellyfinQoLUserSettingsPage.initialize(page);
                applyQoLControlClasses(page);
                ensureNavigationSuspended();

                setTimeout(() => {
                    loadKeybindIntegration().catch(error => {
                        console.error(LOG, 'Keybind settings integration could not be loaded.', error);
                    });
                }, 0);

                console.log(LOG, 'Opened DLL-hosted QoL settings with native-input ownership.');
                return true;
            } catch (error) {
                document.getElementById(HOST_ID)?.remove();
                if (hiddenSourcePage?.isConnected) {
                    hiddenSourcePage.classList.remove('hide');
                    hiddenSourcePage.removeAttribute('aria-hidden');
                }
                hiddenSourcePage = null;
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
        try { QoL.userSettingsKeybindIntegration?.pageClosed?.(); } catch (_) {}
        try { window.JellyfinQoLUserSettingsPage?.destroy?.(); } catch (_) {}
        document.getElementById(HOST_ID)?.remove();

        const shouldRestore = options.restoreSource !== false && /^#\/mypreferencesmenu\b/i.test(location.hash || '');
        if (shouldRestore && hiddenSourcePage?.isConnected) {
            hiddenSourcePage.classList.remove('hide');
            hiddenSourcePage.removeAttribute('aria-hidden');
            restoreNativeHeaderTitle();
        } else {
            headerTitleSnapshot = null;
        }
        hiddenSourcePage = null;
        restoreNavigationSuspension();
        return true;
    }

    function handleHashChange() {
        if (document.getElementById(HOST_ID) && !/^#\/mypreferencesmenu\b/i.test(location.hash || '')) {
            closeUserSettings({ restoreSource:false });
        }
        scheduleEnsureEntry();
    }

    function start() {
        if (!observer) {
            observer = new MutationObserver(scheduleEnsureEntry);
            observer.observe(document.documentElement, { childList:true, subtree:true });
            window.addEventListener('hashchange', handleHashChange);
        }
        scheduleEnsureEntry();
    }

    function destroy() {
        observer?.disconnect();
        observer = null;
        window.removeEventListener('hashchange', handleHashChange);
        closeUserSettings();
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
        sanitizeQoLMarkup,
        applyQoLControlClasses,
        installSafeDynamicControls
    });

    start();
})();
