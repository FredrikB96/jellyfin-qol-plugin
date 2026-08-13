// TEMPORARY DEVELOPMENT LOADER ONLY.
//
// All settings UI and persistence live in Jellyfin.Plugin.QoL.dll.
// This tiny loader only asks Jellyfin to serve the bridge embedded inside the DLL
// so it can add Profile -> Settings -> QoL Settings to jellyfin-web.
// Remove this loader once the final plugin owns its client bootstrap/injection.
(() => {
    'use strict';

    const MARKER = 'jellyfin-qol-dll-user-settings-bridge-loader';
    if (document.querySelector(`script[data-owner="${MARKER}"]`)) return;

    function load() {
        if (!window.ApiClient?.getUrl) {
            setTimeout(load, 250);
            return;
        }

        const script = document.createElement('script');
        script.dataset.owner = MARKER;
        script.src = ApiClient.getUrl('web/ConfigurationPage?name=JellyfinQoLUserSettingsBridge.js') + '&qolv=2.2.0';
        script.onload = () => console.log('[JellyfinQoL] DLL user-settings bridge loaded.');
        script.onerror = error => console.error('[JellyfinQoL] Could not load DLL user-settings bridge.', error);
        document.head.appendChild(script);
    }

    load();
})();
