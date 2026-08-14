(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.userSettingsBridge?.version === '1.1.2') return;

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

    function setNativeHeaderTitle(title) {
        const element = document.querySelector('.skinHeader .pageTitle, .pageTitle');
        if (!element) return false;

        if (!headerTitleSnapshot) {
            headerTitleSnapshot = {
                element,
                html: element.innerHTML
            };
        }

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

    function scheduleEnsureEntry() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            ensureEntry();
        }, 50);
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
                <div class="listItemBody">
                    <div class="listItemBodyText">QoL Settings</div>
                </div>
            </div>`;

        entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openUserSettings().catch(error => console.error(LOG, 'Could not open QoL Settings.', error));
        });

        const enhanced = section.querySelector('#jellyfinEnhancedUserPrefsLink');
        if (enhanced?.nextSibling) enhanced.parentNode.insertBefore(entry, enhanced.nextSibling);
        else section.appendChild(entry);

        console.log(LOG, 'Added Profile → Settings → QoL Settings entry.');
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

    function installSafeDynamicGridInputs(page) {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (!descriptor?.get || !descriptor?.set) {
            console.warn(LOG, 'Could not install dynamic settings input compatibility shim: innerHTML descriptor unavailable.');
            return false;
        }

        let installed = 0;
        for (const id of ['qolUserBindings', 'qolUserProtectedInputs']) {
            const host = page?.querySelector(`#${id}`);
            if (!host || host.dataset.qolSafeDynamicInputs === 'true') continue;

            Object.defineProperty(host, 'innerHTML', {
                configurable: true,
                enumerable: descriptor.enumerable,
                get() {
                    return descriptor.get.call(this);
                },
                set(value) {
                    let next = value;
                    if (typeof next === 'string') {
                        // Jellyfin's customized emby-input element assumes a
                        // labelled inputContainer and can throw from its legacy
                        // attachedCallback when used inside table/grid cells.
                        // These dynamic controls only need Jellyfin styling, so
                        // keep them as normal HTML inputs with the emby-input CSS
                        // class instead of upgrading them as Web Components.
                        next = next.replace(/\sis=(['"])emby-input\1/gi, ' class="emby-input"');
                    }
                    descriptor.set.call(this, next);
                }
            });

            host.dataset.qolSafeDynamicInputs = 'true';
            installed += 1;
        }

        if (installed) {
            console.log(LOG, 'Installed safe dynamic-input rendering for QoL settings grids.', { installed });
        }
        return installed > 0;
    }

    function loadKeybindIntegration() {
        const existingRuntime = window.JellyfinQoL?.userSettingsKeybindIntegration;
        if (existingRuntime) {
            try { existingRuntime.decorateDirectionalRows?.(); } catch (_) {}
            return Promise.resolve(existingRuntime);
        }

        if (keybindLoading) return keybindLoading;

        keybindLoading = new Promise((resolve, reject) => {
            const existingScript = document.querySelector('script[data-jellyfin-qol-keybind-settings]');
            if (existingScript) {
                const started = Date.now();
                const timer = setInterval(() => {
                    const runtime = window.JellyfinQoL?.userSettingsKeybindIntegration;
                    if (runtime) {
                        clearInterval(timer);
                        resolve(runtime);
                    } else if (Date.now() - started > 5000) {
                        clearInterval(timer);
                        reject(new Error('Timed out waiting for keybind settings integration.'));
                    }
                }, 50);
                return;
            }

            const script = document.createElement('script');
            script.async = true;
            script.dataset.jellyfinQolKeybindSettings = 'true';
            script.src = clientResourceUrl(KEYBIND_RESOURCE) +
                `?qolkeybind=${encodeURIComponent(Date.now().toString())}`;
            script.onload = () => {
                const runtime = window.JellyfinQoL?.userSettingsKeybindIntegration;
                if (!runtime) {
                    reject(new Error('Keybind settings integration loaded without registering runtime.'));
                    return;
                }
                try { runtime.decorateDirectionalRows?.(); } catch (_) {}
                resolve(runtime);
            };
            script.onerror = () => reject(new Error('Failed to load keybind settings integration.'));
            document.head.appendChild(script);
        }).finally(() => {
            keybindLoading = null;
        });

        return keybindLoading;
    }

    async function openUserSettings() {
        if (opening) return opening;
        if (document.getElementById(HOST_ID)) return true;

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
                host.innerHTML = html;

                // Behave like a normal Jellyfin preference page rather than a
                // modal overlay: hide the Settings menu page and mount the QoL
                // page into the same animated-page container. The normal
                // Jellyfin header/background remain visible and authoritative.
                if (sourcePage) {
                    hiddenSourcePage = sourcePage;
                    sourcePage.classList.add('hide');
                    sourcePage.setAttribute('aria-hidden', 'true');
                }

                setNativeHeaderTitle('QoL Settings');
                mountPoint.appendChild(host);

                await loadScript();
                const page = host.querySelector('#JellyfinQoLUserSettingsPage');
                installSafeDynamicGridInputs(page);
                await window.JellyfinQoLUserSettingsPage.initialize(page);

                console.log(LOG, 'Opened DLL-hosted user QoL settings page.');

                // Keybind controls are an enhancement of an already usable
                // settings page. Load them only after initialization completes,
                // and never keep Jellyfin's loading overlay open while doing so.
                setTimeout(() => {
                    loadKeybindIntegration().catch(error => {
                        console.error(LOG, 'Keybind settings integration could not be loaded.', error);
                    });
                }, 0);

                return true;
            } catch (error) {
                document.getElementById(HOST_ID)?.remove();
                throw error;
            } finally {
                opening = null;
                Dashboard.hideLoadingMsg?.();
            }
        })();

        return opening;
    }

    function closeUserSettings(options = {}) {
        try { window.JellyfinQoLUserSettingsPage?.destroy?.(); } catch (_) {}
        document.getElementById(HOST_ID)?.remove();

        const shouldRestore =
            options.restoreSource !== false &&
            /^#\/mypreferencesmenu\b/i.test(location.hash || '');

        if (shouldRestore && hiddenSourcePage?.isConnected) {
            hiddenSourcePage.classList.remove('hide');
            hiddenSourcePage.removeAttribute('aria-hidden');
            restoreNativeHeaderTitle();
        } else {
            // A real Jellyfin route change owns the next header title. Do not
            // restore the old Settings title over the router's new value.
            headerTitleSnapshot = null;
        }

        hiddenSourcePage = null;
        console.log(LOG, 'Closed user QoL settings page.');
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
        version:'1.1.2',
        start,
        destroy,
        ensureEntry,
        open:openUserSettings,
        close:closeUserSettings,
        loadKeybindIntegration,
        installSafeDynamicGridInputs
    });

    start();
})();
