// Jellyfin QoL - Modal BACK Transition Guard v1.0.0
//
// A narrow safety net for modal ownership transitions.
//
// The normal Controller/ModalNavigation path always gets first chance to handle
// canonical BACK. After that dispatch completes, this guard waits one task and
// checks the live Scanner model. If a modal is still physically connected, it
// routes BACK through ModalNavigation once more. This covers overlays opened
// from ItemActions or native player/OSD control while their ownership state is
// changing, without knowing anything about keyboard codes, remotes or devices.
(function (QoL) {
    'use strict';

    const VERSION = '1.0.0';
    const LOG = '[JellyfinQoL.ModalBackGuard]';

    if (QoL.modalBackGuardRuntime?.version === VERSION) return;

    let unsubscribe = null;
    let pendingTimer = null;
    let lastFallback = null;

    function controllerMode() {
        try {
            return String(QoL.airNav?.getState?.()?.mode || '').toUpperCase();
        } catch (_) {
            return '';
        }
    }

    function bridgeIsAdjusting() {
        try {
            return QoL.airControlBridge?.getState?.()?.adjustableMode === true;
        } catch (_) {
            return false;
        }
    }

    function currentModal() {
        let model = null;

        try {
            model = QoL.airScanner?.prepareForInput?.('BACK_POST_DISPATCH') || null;
        } catch (_) {}

        if (!model) {
            try { model = QoL.airScanner?.getModel?.() || null; }
            catch (_) {}
        }

        const modal = model?.modal || null;
        if (!modal?.root?.isConnected) return null;

        return { model, modal };
    }

    function ensureModalNavigation(modal) {
        const modalState = (() => {
            try { return QoL.airModal?.getState?.() || null; }
            catch (_) { return null; }
        })();

        const currentId = modalState?.contextId || null;
        const active = QoL.airModal?.isActive?.() === true;

        if (active && (!modal?.id || !currentId || currentId === modal.id)) {
            return { active:true, entered:null };
        }

        let entered = null;
        try {
            entered = QoL.airModal?.enter?.(
                modal,
                null,
                'modal-back-transition-guard'
            ) || null;
        } catch (error) {
            return {
                active:false,
                entered:null,
                error:String(error?.message || error)
            };
        }

        return {
            active:QoL.airModal?.isActive?.() === true,
            entered
        };
    }

    function runFallback(event, controllerResult) {
        pendingTimer = null;

        // Native OSD slider/edit ownership deliberately keeps BACK local to
        // ControlBridge. Do not turn that first BACK into a modal dismissal.
        if (controllerMode() === 'NATIVE_CONTROL' && bridgeIsAdjusting()) {
            return;
        }

        const live = currentModal();
        if (!live) return;

        const modalNavigation = ensureModalNavigation(live.modal);
        if (!modalNavigation.active) {
            lastFallback = {
                timestamp:Date.now(),
                handled:false,
                reason:'modal-navigation-unavailable',
                modalId:live.modal.id || null,
                controllerResult:controllerResult || null,
                modalNavigation
            };
            return;
        }

        let result = null;
        try {
            result = QoL.airModal.dispatch('BACK') || null;
        } catch (error) {
            result = {
                handled:false,
                reason:'modal-back-fallback-threw',
                error:String(error?.message || error)
            };
        }

        lastFallback = {
            timestamp:Date.now(),
            handled:result?.handled === true,
            reason:result?.reason || 'modal-back-fallback',
            modalId:live.modal.id || null,
            controllerMode:controllerMode() || null,
            source:event?.source || null,
            controllerResult:controllerResult || null,
            modalResult:result,
            entered:modalNavigation.entered || null
        };

        if (QoL.settings?.DEBUG || QoL.settings?.airNav?.debug) {
            console.log(LOG, 'post-dispatch BACK fallback', lastFallback);
        }
    }

    function onDispatch(payload) {
        const event = payload?.event || null;
        if (String(event?.action || '').toUpperCase() !== 'BACK') return;
        if (event?.phase === 'release' || event?.phase === 'repeat') return;

        if (pendingTimer) clearTimeout(pendingTimer);

        // Let click/close handlers from the primary Controller dispatch finish
        // first. If they succeeded, Scanner will report no connected modal and
        // this becomes a no-op rather than a second BACK.
        pendingTimer = setTimeout(
            () => runFallback(event, payload?.result || null),
            0
        );
    }

    function start() {
        if (unsubscribe) return getState();

        if (typeof QoL.airNavInput?.on !== 'function') {
            return {
                started:false,
                reason:'input-registry-not-ready'
            };
        }

        unsubscribe = QoL.airNavInput.on('dispatch', onDispatch);
        console.log(LOG, 'Started.');
        return getState();
    }

    function stop() {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = null;

        try { unsubscribe?.(); } catch (_) {}
        unsubscribe = null;
        return getState();
    }

    function getState() {
        return {
            version:VERSION,
            started:typeof unsubscribe === 'function',
            pending:!!pendingTimer,
            lastFallback:lastFallback ? { ...lastFallback } : null
        };
    }

    const api = Object.freeze({
        version:VERSION,
        VERSION,
        start,
        stop,
        getState
    });

    QoL.modalBackGuardRuntime = api;

    if (typeof QoL.airNavInput?.on === 'function') {
        start();
    } else {
        window.addEventListener('jellyfin-qol-client-ready', start, { once:true });
    }
})(window.JellyfinQoL = window.JellyfinQoL || {});
