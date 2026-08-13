// TEMPORARY DEVELOPMENT LOADER ONLY.
//
// The production client runtime lives in Jellyfin.Plugin.QoL.dll.
// This tiny loader only starts the DLL-owned client bootstrap. It contains no
// settings, input, navigation or runtime logic and can be removed when the
// plugin owns its final jellyfin-web injection mechanism.
(() => {
    'use strict';

    const MARKER = 'jellyfin-qol-dll-client-bootstrap-loader';
    if (document.querySelector(`script[data-owner="${MARKER}"]`)) return;

    function load() {
        if (!window.ApiClient?.getUrl) {
            setTimeout(load, 250);
            return;
        }

        const cacheToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const script = document.createElement('script');
        script.dataset.owner = MARKER;
        script.src = ApiClient.getUrl('JellyfinQoL/Client/clientBootstrap.js') +
            `?qoldev=${encodeURIComponent(cacheToken)}`;
        script.async = true;
        script.onload = () => console.log('[JellyfinQoL] DLL client bootstrap loaded.');
        script.onerror = error => console.error('[JellyfinQoL] Could not load DLL client bootstrap.', error);
        document.head.appendChild(script);
    }

    load();
})();