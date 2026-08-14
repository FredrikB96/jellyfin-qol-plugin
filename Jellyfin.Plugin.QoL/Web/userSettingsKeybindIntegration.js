(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.userSettingsKeybindIntegration?.version === '1.0.0') return;

    const VERSION = '1.0.0';
    const LOG = '[JellyfinQoL.UserSettingsKeybindIntegration]';
    const ROOT_ID = 'JellyfinQoLUserSettingsPage';
    const DIRECTION_ACTIONS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT']);

    let activeRecordButton = null;
    let activeRecordOriginalText = null;
    let recorderUnsubscribers = [];
    let busy = false;
    let observer = null;

    function root() {
        return document.getElementById(ROOT_ID);
    }

    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return value; }
    }

    function setStatus(message) {
        const element = root()?.querySelector('#qolUserSaveStatus');
        if (element) element.textContent = String(message || '');
        console.log(LOG, message);
    }

    function notify(message) {
        try { Dashboard.alert(String(message || '')); }
        catch (_) { console.log(LOG, message); }
    }

    function selectedProfileId(page = root()) {
        return String(
            page?.querySelector('#qolUserProfileSelector')?.value ||
            QoL.profileRuntime?.getActiveProfileId?.() ||
            'default'
        );
    }

    function actionLabel(action) {
        const row = root()?.querySelector(`tr[data-binding-action="${CSS.escape(String(action || ''))}"]`);
        return row?.querySelector('strong')?.textContent?.trim() || String(action || '');
    }

    function describeTrigger(binding) {
        if (!binding) return 'Unbound';
        const trigger = binding.trigger || {};
        const adapter = String(binding.adapter || '').toLowerCase();

        if (adapter === 'keyboard') {
            const modifiers = trigger.modifiers || {};
            const parts = [];
            if (modifiers.ctrl) parts.push('Ctrl');
            if (modifiers.alt) parts.push('Alt');
            if (modifiers.shift) parts.push('Shift');
            if (modifiers.meta) parts.push('Meta');
            parts.push(trigger.code || trigger.key || 'Keyboard input');
            return parts.join('+');
        }
        if (adapter === 'pointer') return `Mouse button ${Number(trigger.button) + 1}`;
        if (adapter === 'wheel') return `Wheel ${trigger.direction || ''}`.trim();
        if (adapter === 'gamepad') {
            if (trigger.type === 'gamepad-axis') return `Gamepad axis ${trigger.axis} ${trigger.direction}`;
            return `Gamepad button ${trigger.button}`;
        }
        return binding.input || `${adapter || 'input'}:${trigger.type || 'unknown'}`;
    }

    function clearRecorderListeners() {
        recorderUnsubscribers.splice(0).forEach(unsubscribe => {
            try { unsubscribe?.(); } catch (_) {}
        });
    }

    function restoreRecordButton() {
        if (activeRecordButton?.isConnected) {
            activeRecordButton.disabled = false;
            activeRecordButton.removeAttribute('aria-busy');
            activeRecordButton.textContent = activeRecordOriginalText || 'Record';
        }
        activeRecordButton = null;
        activeRecordOriginalText = null;
    }

    function setRecordButton(button) {
        restoreRecordButton();
        activeRecordButton = button;
        activeRecordOriginalText = button.textContent;
        button.textContent = 'Press a button…';
        button.disabled = false;
        button.setAttribute('aria-busy', 'true');
    }

    function currentSaveStatus(page) {
        return String(page?.querySelector('#qolUserSaveStatus')?.textContent || '').trim();
    }

    async function waitForSave(page, timeoutMs = 12000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const status = currentSaveStatus(page);
            if (/^Saved\.?$/i.test(status)) return { saved:true, status };
            if (/save failed/i.test(status) || /could not load/i.test(status)) {
                return { saved:false, status };
            }
            await new Promise(resolve => setTimeout(resolve, 60));
        }
        return { saved:false, status:'Timed out waiting for settings save.' };
    }

    async function ensurePageSaved(page) {
        const status = currentSaveStatus(page);
        if (!status || /^Saved\.?$/i.test(status) || /^No unsaved changes/i.test(status)) {
            return { saved:true, skipped:true };
        }

        const form = page?.querySelector('#JellyfinQoLUserSettingsForm');
        if (!form) return { saved:false, status:'Settings form not found.' };

        setStatus('Saving current settings before changing keybinds…');
        try {
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
        } catch (error) {
            return { saved:false, status:String(error?.message || error) };
        }

        return await waitForSave(page);
    }

    async function refreshAndReloadPage(reason, successMessage) {
        try {
            await QoL.profileRuntime?.flushPersistence?.();
        } catch (error) {
            console.warn(LOG, 'Profile persistence flush failed.', error);
        }

        try {
            await QoL.runtimeSettings?.refresh?.(`keybind-ui:${reason}`, { forceServer:true });
        } catch (error) {
            console.warn(LOG, 'Runtime settings refresh failed.', error);
        }

        const page = root();
        if (page && window.JellyfinQoLUserSettingsPage?.initialize) {
            try {
                window.JellyfinQoLUserSettingsPage.destroy?.();
                await window.JellyfinQoLUserSettingsPage.initialize(page);
            } catch (error) {
                console.warn(LOG, 'Could not reload user settings page after keybind change.', error);
            }
        }

        decorateDirectionalRows();
        setStatus(successMessage || 'Saved.');
    }

    function conflictSummary(conflicts) {
        const unique = [];
        const seen = new Set();
        for (const conflict of conflicts || []) {
            const action = String(conflict?.binding?.action || 'UNKNOWN');
            if (seen.has(action)) continue;
            seen.add(action);
            unique.push(actionLabel(action));
        }
        return unique;
    }

    function confirmReplacement(action, binding, conflicts) {
        if (!conflicts?.length) return { allowed:true, allowCriticalUnbound:false };

        const labels = conflictSummary(conflicts);
        const critical = conflicts
            .filter(conflict => conflict?.criticalAction === true && conflict?.binding?.action !== action)
            .map(conflict => conflict.binding.action);

        let message = `${describeTrigger(binding)} is already bound to ${labels.join(', ')} with the same gesture.\n\nReplace that binding?`;
        if (critical.length) {
            const criticalLabels = [...new Set(critical)].map(actionLabel);
            message += `\n\nWarning: this will leave critical action${criticalLabels.length > 1 ? 's' : ''} ${criticalLabels.join(', ')} unbound.`;
        }

        return {
            allowed: window.confirm(message),
            allowCriticalUnbound: critical.length > 0
        };
    }

    async function handleCaptured(state, action, profileId) {
        const recorder = QoL.recordInputRuntime;
        const runtime = QoL.profileRuntime;
        if (!recorder || !runtime) return;

        const binding = clone(state?.binding);
        if (!binding) {
            recorder.cancel?.('settings-ui-missing-binding');
            restoreRecordButton();
            setStatus('Recording failed: no binding was produced.');
            return;
        }

        if (DIRECTION_ACTIONS.has(action)) {
            binding.gesture = 'repeat';
            binding.allowRepeat = true;
            binding.longPressMs = null;
        }

        const conflicts = runtime.analyzeConflicts?.(binding, profileId) || [];
        const decision = confirmReplacement(action, binding, conflicts);
        if (!decision.allowed) {
            recorder.cancel?.('settings-ui-conflict-cancelled');
            restoreRecordButton();
            clearRecorderListeners();
            setStatus('Keybind recording cancelled.');
            return;
        }

        const result = recorder.commit({
            resolution: conflicts.length ? 'replace' : 'replace',
            mode: 'replace-action',
            allowCriticalUnbound: decision.allowCriticalUnbound
        });

        if (!result?.changed) {
            recorder.cancel?.('settings-ui-commit-failed');
            restoreRecordButton();
            clearRecorderListeners();
            setStatus(`Could not save keybind: ${result?.reason || 'commit failed'}.`);
            return;
        }

        restoreRecordButton();
        clearRecorderListeners();
        await refreshAndReloadPage(
            'record',
            `${actionLabel(action)} bound to ${describeTrigger(result.binding || binding)}.`
        );
    }

    async function beginRecord(button) {
        if (busy) return;
        busy = true;
        try {
            const page = root();
            const recorder = QoL.recordInputRuntime;
            const runtime = QoL.profileRuntime;

            if (!page || !recorder || !runtime) {
                notify('Production keybind runtime is not ready yet.');
                return;
            }

            if (recorder.getState?.().mode !== 'IDLE') {
                recorder.cancel?.('settings-ui-restart-recording');
            }

            const saved = await ensurePageSaved(page);
            if (!saved.saved) {
                setStatus(`Cannot start recording until settings are saved: ${saved.status || 'save failed'}`);
                return;
            }

            try {
                await QoL.runtimeSettings?.refresh?.('keybind-ui-before-record', { forceServer:true });
            } catch (_) {}

            const action = String(button.dataset.action || '').toUpperCase();
            const profileId = selectedProfileId(page);
            if (!action) return;

            clearRecorderListeners();
            recorderUnsubscribers.push(recorder.on('captured', state => {
                handleCaptured(state, action, profileId).catch(error => {
                    console.error(LOG, 'Captured keybind commit failed.', error);
                    try { recorder.cancel?.('settings-ui-captured-error'); } catch (_) {}
                    restoreRecordButton();
                    clearRecorderListeners();
                    setStatus(`Keybind save failed: ${error?.message || error}`);
                });
            }));
            recorderUnsubscribers.push(recorder.on('captureRejected', payload => {
                restoreRecordButton();
                clearRecorderListeners();
                setStatus(`Input could not be recorded: ${payload?.result?.reason || 'unsupported input'}.`);
            }));

            setRecordButton(button);
            setStatus(`Recording ${actionLabel(action)} — press a button.`);

            const started = recorder.start(action, { profileId, adapter:'universal' });
            if (!started?.started) {
                restoreRecordButton();
                clearRecorderListeners();
                setStatus(`Could not start recording: ${started?.reason || 'unknown error'}.`);
            }
        } finally {
            busy = false;
        }
    }

    async function clearBinding(button) {
        if (busy) return;
        busy = true;
        try {
            const page = root();
            const runtime = QoL.profileRuntime;
            if (!page || !runtime) {
                notify('Production profile runtime is not ready yet.');
                return;
            }

            const saved = await ensurePageSaved(page);
            if (!saved.saved) {
                setStatus(`Cannot clear keybind until settings are saved: ${saved.status || 'save failed'}`);
                return;
            }

            try {
                await QoL.runtimeSettings?.refresh?.('keybind-ui-before-clear', { forceServer:true });
            } catch (_) {}

            const action = String(button.dataset.action || '').toUpperCase();
            const profileId = selectedProfileId(page);
            const meta = runtime.getActionMeta?.(action) || {};
            const current = runtime.getBinding?.(action, profileId) || null;

            if (!current) {
                setStatus(`${actionLabel(action)} is already unbound.`);
                return;
            }

            let allowCriticalUnbound = false;
            if (meta.critical === true) {
                const confirmed = window.confirm(
                    `${actionLabel(action)} is a critical navigation action.\n\nClear this binding anyway?`
                );
                if (!confirmed) {
                    setStatus('Clear cancelled.');
                    return;
                }
                allowCriticalUnbound = true;
            }

            const result = runtime.clearBindingsForAction?.(
                action,
                profileId,
                { allowCriticalUnbound }
            );

            if (!result?.changed) {
                setStatus(`Could not clear keybind: ${result?.reason || 'clear failed'}.`);
                return;
            }

            await refreshAndReloadPage('clear', `${actionLabel(action)} binding cleared.`);
        } finally {
            busy = false;
        }
    }

    function decorateDirectionalRows() {
        const page = root();
        if (!page) return;

        const keybindSection = page.querySelector('#qolUserBindings')?.closest('.qol-user-subsection');
        const description = keybindSection?.querySelector('.fieldDescription');
        if (description) {
            description.textContent = 'Press Record, then press any supported button. Directional actions always use tap = one step, double tap = two steps, and hold = repeat until release or the navigation edge.';
        }

        for (const action of DIRECTION_ACTIONS) {
            const row = page.querySelector(`tr[data-binding-action="${action}"]`);
            if (!row || row.dataset.qolDirectionalDecorated === VERSION) continue;

            const gesture = row.querySelector('[data-binding-field="gesture"]');
            const longPress = row.querySelector('[data-binding-field="longPressMs"]');
            const repeat = row.querySelector('[data-binding-field="allowRepeat"]');

            if (gesture?.closest('td')) gesture.closest('td').innerHTML = '<span class="fieldDescription">Tap / hold</span>';
            if (longPress?.closest('td')) longPress.closest('td').innerHTML = '<span aria-label="Not applicable">—</span>';
            if (repeat?.closest('td')) repeat.closest('td').innerHTML = '<span class="fieldDescription">Fixed</span>';

            row.dataset.qolDirectionalDecorated = VERSION;
        }
    }

    function handleClickCapture(event) {
        const page = root();
        if (!page) return;
        const button = event.target?.closest?.('[data-qol-command]');
        if (!button || !page.contains(button)) return;

        const command = button.dataset.qolCommand;
        if (command !== 'binding-record' && command !== 'binding-clear') return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (command === 'binding-record') {
            beginRecord(button).catch(error => {
                console.error(LOG, 'Record command failed.', error);
                restoreRecordButton();
                clearRecorderListeners();
                setStatus(`Record failed: ${error?.message || error}`);
            });
        } else {
            clearBinding(button).catch(error => {
                console.error(LOG, 'Clear command failed.', error);
                setStatus(`Clear failed: ${error?.message || error}`);
            });
        }
    }

    function handleMutation() {
        decorateDirectionalRows();
        if (!root() && QoL.recordInputRuntime?.getState?.().mode !== 'IDLE') {
            try { QoL.recordInputRuntime.cancel?.('settings-page-closed'); } catch (_) {}
            restoreRecordButton();
            clearRecorderListeners();
        }
    }

    function start() {
        document.addEventListener('click', handleClickCapture, true);
        observer = new MutationObserver(handleMutation);
        observer.observe(document.documentElement, { childList:true, subtree:true });
        decorateDirectionalRows();
        console.log(LOG, 'Production keybind settings integration started.');
    }

    function destroy() {
        document.removeEventListener('click', handleClickCapture, true);
        observer?.disconnect();
        observer = null;
        try { QoL.recordInputRuntime?.cancel?.('keybind-integration-destroyed'); } catch (_) {}
        restoreRecordButton();
        clearRecorderListeners();
    }

    QoL.userSettingsKeybindIntegration = Object.freeze({
        version: VERSION,
        start,
        destroy,
        decorateDirectionalRows,
        getState() {
            return {
                version: VERSION,
                ready: !!QoL.profileRuntime && !!QoL.recordInputRuntime,
                profileRuntimeVersion: QoL.profileRuntime?.version || null,
                recorderVersion: QoL.recordInputRuntime?.version || null,
                recorderState: clone(QoL.recordInputRuntime?.getState?.() || null),
                pageOpen: !!root(),
                busy
            };
        }
    });

    start();
})();
