(function () {
    'use strict';

    const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
    if (QoL.universalInputRuntime?.version === '1.0.2') {
        QoL.universalInputRuntime.reconcileOwnership?.();
        return;
    }

    const VERSION = '1.0.2';
    const LOG = '[JellyfinQoL.UniversalInput]';
    const DEFAULTS = Object.freeze({
        capture: true,
        gamepadAxisThreshold: 0.65,
        gamepadAxisReleaseThreshold: 0.45,
        gamepadButtonThreshold: 0.5,
        pointerClickSuppressMs: 650,
        nativeFollowupSuppressMs: 750,
        wheelMinDelta: 2,
        debug: false
    });

    function nowMs() {
        try { return performance.now(); }
        catch (_) { return Date.now(); }
    }

    function clone(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch (_) { return value; }
    }

    function mergeConfig(options = {}) {
        return {
            ...DEFAULTS,
            ...(QoL.settings?.airNav?.input?.universal || {}),
            ...(QoL.runtimeConfig?.input?.universal || {}),
            ...options
        };
    }

    function clampNumber(value, fallback, min, max) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    }

    function modifiersFromKeyboardEvent(event) {
        return {
            ctrl: !!event?.ctrlKey,
            alt: !!event?.altKey,
            shift: !!event?.shiftKey,
            meta: !!event?.metaKey
        };
    }

    function getTextContext(target = null) {
        const active = target || document.activeElement || null;
        const textEntryActive = isTextEntry(active);
        const searchEntryActive = textEntryActive && isSearchEntry(active);
        return { textEntryActive, searchEntryActive };
    }

    function isPlayerRoute(route = null) {
        const value = String(
            route || location.hash || `${location.pathname}${location.search}` || ''
        ).trim().toLowerCase();
        return /^#\/video(?:[/?#]|$)/.test(value) || /^\/video(?:[/?#]|$)/.test(value);
    }

    function getControllerMode() {
        try {
            const ownerState = QoL.airNav?.getState?.();
            if (ownerState?.mode) return String(ownerState.mode).toUpperCase();
        } catch (_) {}
        try {
            const runtimeState = QoL.navigationControllerRuntime?.getState?.();
            if (runtimeState?.mode) return String(runtimeState.mode).toUpperCase();
        } catch (_) {}
        return '';
    }

    function makeInputContext(base = {}) {
        const model = QoL.airScanner?.getModel?.() || null;
        const controllerMode = getControllerMode();
        const modalActive =
            model?.activeSurfaceHint === 'modal' ||
            (
                model?.modal?.root?.isConnected &&
                QoL.airModal?.isActive?.()
            );
        const playerSurface =
            model?.activeSurfaceHint === 'player' ||
            isPlayerRoute(model?.route);
        let inputContext = 'page';

        // Overlay/text ownership must win over the underlying player route.
        // When AirNav explicitly takes native player control, expose a distinct
        // context so one physical trigger can mean ACTIVATE there and
        // PLAY_PAUSE while normal playback owns input.
        if (modalActive) inputContext = 'modal';
        else if (base.textEntryActive === true) inputContext = 'text';
        else if (playerSurface) {
            inputContext = controllerMode === 'NATIVE_CONTROL'
                ? 'player-control'
                : 'player';
        }

        return { ...base, inputContext };
    }

    function isTextEntry(element) {
        if (!element) return false;
        const tag = element.tagName?.toLowerCase?.() || '';

        if (tag === 'input') {
            const type = String(element.getAttribute?.('type') || 'text').toLowerCase();
            if (type === 'checkbox') return false;
            if (['radio', 'range', 'number'].includes(type) && QoL.airPageForm?.ownsElement?.(element)) return false;
            return true;
        }

        if (tag === 'select') {
            const model = QoL.airScanner?.getModel?.();
            const root = model?.modal?.root || null;
            if ((QoL.airModal?.isActive?.() && root?.contains?.(element)) || QoL.airPageForm?.ownsElement?.(element)) {
                return false;
            }
            return true;
        }

        return tag === 'textarea' || element.isContentEditable === true;
    }

    function isSearchEntry(element) {
        if (!isTextEntry(element)) return false;
        const type = String(element.getAttribute?.('type') || '').toLowerCase();
        const role = String(element.getAttribute?.('role') || '').toLowerCase();
        const semantic = [
            element.id,
            element.getAttribute?.('name'),
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('title'),
            typeof element.className === 'string' ? element.className : ''
        ].filter(Boolean).join(' ').toLowerCase();
        return type === 'search' || role === 'searchbox' || /\bsearch\b/.test(semantic);
    }

    function nativeNavigationRisk(input = {}) {
        const source = String(input.source || '').toLowerCase();
        if (source === 'pointer') {
            if (Number(input.button) === 3) return 'browser-back';
            if (Number(input.button) === 4) return 'browser-forward';
            return null;
        }

        if (source === 'keyboard') {
            const code = String(input.code || '');
            const key = String(input.key || '');
            if (code === 'BrowserBack' || key === 'BrowserBack') return 'browser-back';
            if (code === 'BrowserForward' || key === 'BrowserForward') return 'browser-forward';
            if (input.modifiers?.alt === true && (code === 'ArrowLeft' || key === 'ArrowLeft')) return 'browser-back';
            if (input.modifiers?.alt === true && (code === 'ArrowRight' || key === 'ArrowRight')) return 'browser-forward';
        }
        return null;
    }

    function formatKeyboard(event) {
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (event.metaKey) parts.push('Meta');
        parts.push(event.code || event.key || 'Unknown');
        return parts.join('+');
    }

    function formatPointerButton(button) {
        const index = Number(button);
        const friendly = {
            0: 'Mouse 1',
            1: 'Mouse 3',
            2: 'Mouse 2',
            3: 'Mouse Back',
            4: 'Mouse Forward'
        };
        return friendly[index] || `Mouse Button ${index + 1}`;
    }

    class UniversalInputAdapter {
        constructor(options = {}) {
            this.options = { ...options };
            this.cfg = mergeConfig(options);
            this.started = false;
            this.dispatch = null;
            this.captureSession = null;
            this.captureListenersAttached = false;
            this.captureSuppressedKeyUps = new Set();
            this.ownedKeyboard = new Set();
            this.ownedPointer = new Set();
            this.suppressedPointerClicks = new Map();
            this.nativeFollowupSuppressUntil = { contextmenu: 0 };
            this.gamepadRaf = null;
            this.gamepadStates = new Map();
            this.captureGamepadBaseline = new Map();
            this.lastKnownGamepads = [];
            this.resolver = options.resolver || QoL.gestureResolverRuntime?.create?.({
                autoSync: true,
                profileId: options.profileId || null
            }) || null;

            this.boundKeyDown = event => this.handleKeyDown(event);
            this.boundKeyUp = event => this.handleKeyUp(event);
            this.boundPointerDown = event => this.handlePointerDown(event);
            this.boundPointerUp = event => this.handlePointerUp(event);
            this.boundMouseDown = event => this.handleLegacyMouseOwnership(event);
            this.boundMouseUp = event => this.handleLegacyMouseOwnership(event);
            this.boundClick = event => this.handleClickSuppression(event);
            this.boundAuxClick = event => this.handleClickSuppression(event);
            this.boundContextMenu = event => this.handleContextMenuSuppression(event);
            this.boundWheel = event => this.handleWheel(event);
            this.boundVisibility = () => this.handleVisibilityChanged();
            this.boundGamepadConnected = () => this.updateGamepadPolling();
            this.boundGamepadDisconnected = () => this.updateGamepadPolling();
        }

        ensureResolver() {
            if (this.resolver) return this.resolver;
            const factory = QoL.gestureResolverRuntime?.create;
            if (typeof factory !== 'function') return null;
            this.resolver = factory({ autoSync: true, profileId: this.options.profileId || null });
            return this.resolver;
        }

        start(dispatch) {
            if (this.started) return this;
            if (typeof dispatch !== 'function') {
                throw new Error(`${LOG} start(dispatch) requires dispatcher.`);
            }

            const resolver = this.ensureResolver();
            if (!resolver) {
                throw new Error(`${LOG} gestureResolverRuntime is required.`);
            }

            const resolverState = resolver.start(dispatch, {
                profileId: this.options.profileId || null,
                reloadBindings: true
            });
            if (resolverState?.started === false) {
                throw new Error(`${LOG} could not start gesture resolver: ${resolverState.reason || 'unknown'}`);
            }

            this.dispatch = dispatch;
            this.attachRuntimeListeners();
            this.started = true;
            this.updateGamepadPolling();
            this.log('started', this.getState());
            return this;
        }

        stop() {
            if (!this.started) return false;
            this.detachRuntimeListeners();
            this.started = false;
            this.dispatch = null;
            this.ownedKeyboard.clear();
            this.ownedPointer.clear();
            this.suppressedPointerClicks.clear();
            this.gamepadStates.clear();
            try { this.resolver?.stop?.({ cancel: true }); } catch (_) {}
            if (!this.captureSession) this.stopGamepadPolling();
            this.log('stopped');
            return true;
        }

        reloadBindings(profileId = null) {
            const resolver = this.ensureResolver();
            if (!resolver) return [];
            return resolver.reloadBindings(profileId, 'universal-input-reload');
        }

        getBindings() {
            return this.resolver?.getBindings?.() || [];
        }

        attachRuntimeListeners() {
            window.addEventListener('keydown', this.boundKeyDown, true);
            window.addEventListener('keyup', this.boundKeyUp, true);

            if (typeof PointerEvent === 'function') {
                window.addEventListener('pointerdown', this.boundPointerDown, true);
                window.addEventListener('pointerup', this.boundPointerUp, true);
                window.addEventListener('mousedown', this.boundMouseDown, true);
                window.addEventListener('mouseup', this.boundMouseUp, true);
            } else {
                window.addEventListener('mousedown', this.boundPointerDown, true);
                window.addEventListener('mouseup', this.boundPointerUp, true);
            }

            window.addEventListener('click', this.boundClick, true);
            window.addEventListener('auxclick', this.boundAuxClick, true);
            window.addEventListener('contextmenu', this.boundContextMenu, true);
            window.addEventListener('wheel', this.boundWheel, { capture: true, passive: false });
            document.addEventListener('visibilitychange', this.boundVisibility, true);
            window.addEventListener('gamepadconnected', this.boundGamepadConnected);
            window.addEventListener('gamepaddisconnected', this.boundGamepadDisconnected);
        }

        detachRuntimeListeners() {
            window.removeEventListener('keydown', this.boundKeyDown, true);
            window.removeEventListener('keyup', this.boundKeyUp, true);
            window.removeEventListener('pointerdown', this.boundPointerDown, true);
            window.removeEventListener('pointerup', this.boundPointerUp, true);
            window.removeEventListener('mousedown', this.boundMouseDown, true);
            window.removeEventListener('mouseup', this.boundMouseUp, true);
            window.removeEventListener('click', this.boundClick, true);
            window.removeEventListener('auxclick', this.boundAuxClick, true);
            window.removeEventListener('contextmenu', this.boundContextMenu, true);
            window.removeEventListener('wheel', this.boundWheel, true);
            document.removeEventListener('visibilitychange', this.boundVisibility, true);
            window.removeEventListener('gamepadconnected', this.boundGamepadConnected);
            window.removeEventListener('gamepaddisconnected', this.boundGamepadDisconnected);
        }

        attachCaptureOnlyListeners() {
            if (this.started || this.captureListenersAttached) return;
            window.addEventListener('keydown', this.boundKeyDown, true);
            window.addEventListener('keyup', this.boundKeyUp, true);
            if (typeof PointerEvent === 'function') {
                window.addEventListener('pointerdown', this.boundPointerDown, true);
            } else {
                window.addEventListener('mousedown', this.boundPointerDown, true);
            }
            window.addEventListener('wheel', this.boundWheel, { capture: true, passive: false });
            window.addEventListener('contextmenu', this.boundContextMenu, true);
            this.captureListenersAttached = true;
        }

        detachCaptureOnlyListeners() {
            if (!this.captureListenersAttached) return;
            window.removeEventListener('keydown', this.boundKeyDown, true);
            window.removeEventListener('keyup', this.boundKeyUp, true);
            window.removeEventListener('pointerdown', this.boundPointerDown, true);
            window.removeEventListener('mousedown', this.boundPointerDown, true);
            window.removeEventListener('wheel', this.boundWheel, true);
            window.removeEventListener('contextmenu', this.boundContextMenu, true);
            this.captureListenersAttached = false;
        }

        beginCapture(callback, options = {}) {
            if (typeof callback !== 'function') {
                throw new Error(`${LOG} beginCapture(callback) requires callback.`);
            }
            if (this.captureSession) {
                return { started: false, reason: 'capture-already-active', adapter: 'universal' };
            }

            this.captureSession = {
                callback,
                options: { ...options },
                startedAt: nowMs()
            };
            this.captureGamepadBaseline.clear();
            this.snapshotCaptureGamepads();
            this.attachCaptureOnlyListeners();
            this.updateGamepadPolling();
            return {
                started: true,
                adapter: 'universal',
                startedAt: this.captureSession.startedAt,
                runtimeStarted: this.started
            };
        }

        endCapture(reason = 'manual') {
            if (!this.captureSession) {
                return { ended: false, reason: 'capture-not-active', adapter: 'universal' };
            }
            this.captureSession = null;
            this.captureGamepadBaseline.clear();
            this.detachCaptureOnlyListeners();
            this.updateGamepadPolling();
            return { ended: true, reason, adapter: 'universal' };
        }

        getCaptureState() {
            return {
                active: !!this.captureSession,
                adapter: 'universal',
                startedAt: this.captureSession?.startedAt || null,
                runtimeStarted: this.started,
                browserApis: {
                    keyboard: true,
                    pointer: typeof PointerEvent === 'function',
                    wheel: true,
                    gamepad: typeof navigator?.getGamepads === 'function'
                }
            };
        }

        completeCapture(capture) {
            const session = this.captureSession;
            if (!session) return false;
            this.captureSession = null;
            this.captureGamepadBaseline.clear();
            this.detachCaptureOnlyListeners();
            this.updateGamepadPolling();
            try { session.callback(capture); }
            catch (error) { console.error(LOG, 'Capture callback failed.', error); }
            return true;
        }

        dispatchPhysical(envelope) {
            const resolver = this.ensureResolver();
            if (!resolver || !this.started) {
                return { handled: false, claimed: false, reason: 'runtime-not-started' };
            }
            try {
                return resolver.ingest(envelope) || { handled: false, claimed: false, reason: 'resolver-returned-nothing' };
            } catch (error) {
                console.error(LOG, 'Gesture resolver ingest failed.', error);
                return { handled: false, claimed: false, reason: 'resolver-threw', error };
            }
        }

        keyboardEnvelope(event, phase) {
            const modifiers = modifiersFromKeyboardEvent(event);
            const context = makeInputContext(getTextContext(
                isTextEntry(event.target) ? event.target : (isTextEntry(document.activeElement) ? document.activeElement : null)
            ));
            return {
                adapter: 'keyboard',
                source: 'keyboard',
                deviceId: 'keyboard:default',
                deviceMatch: '*',
                phase,
                trigger: {
                    type: phase === 'release' ? 'keyup' : 'keydown',
                    code: event.code || null,
                    key: event.key || null,
                    modifiers
                },
                context: {
                    ...context,
                    nativeNavigationRisk: nativeNavigationRisk({
                        source: 'keyboard',
                        code: event.code || null,
                        key: event.key || null,
                        modifiers
                    })
                },
                raw: {
                    code: event.code || null,
                    key: event.key || null,
                    repeat: !!event.repeat,
                    modifiers,
                    ...context
                },
                timestamp: nowMs()
            };
        }

        handleKeyDown(event) {
            if (event.__airNavNativeBridge === true) return;

            if (this.captureSession) {
                if (event.repeat) return;
                const capture = {
                    adapter: 'keyboard',
                    deviceMatch: '*',
                    deviceId: 'keyboard:default',
                    label: formatKeyboard(event),
                    trigger: {
                        type: 'keydown',
                        code: event.code || null,
                        key: event.key || null,
                        modifiers: modifiersFromKeyboardEvent(event)
                    },
                    timestamp: nowMs()
                };
                const keyId = event.code || event.key;
                if (keyId) this.captureSuppressedKeyUps.add(keyId);
                if (this.isContextMenuKeyboardEvent(event)) this.armNativeFollowupSuppression('contextmenu');
                this.consumeEvent(event);
                this.completeCapture(capture);
                return;
            }

            if (!this.started) return;
            const keyId = event.code || event.key;
            const phase = event.repeat ? 'repeat' : 'press';
            const result = this.dispatchPhysical(this.keyboardEnvelope(event, phase));

            if (!event.repeat && result.claimed) this.ownedKeyboard.add(keyId);
            if (result.claimed || result.handled) {
                if (this.isContextMenuKeyboardEvent(event)) this.armNativeFollowupSuppression('contextmenu');
                this.consumeEvent(event);
            }
        }

        handleKeyUp(event) {
            const keyId = event.code || event.key;
            if (this.captureSuppressedKeyUps.has(keyId)) {
                this.captureSuppressedKeyUps.delete(keyId);
                this.consumeEvent(event, false);
                return;
            }
            if (this.captureSession || !this.started) return;

            const ownedPress = this.ownedKeyboard.has(keyId);
            const result = this.dispatchPhysical(this.keyboardEnvelope(event, 'release'));
            this.ownedKeyboard.delete(keyId);

            if (ownedPress || result.claimed || result.handled) this.consumeEvent(event);
        }

        pointerEnvelope(event, phase) {
            const pointerType = event.pointerType || (event.type.startsWith('mouse') ? 'mouse' : 'mouse');
            const button = Number(event.button);
            const textContext = getTextContext(isTextEntry(event.target) ? event.target : null);
            return {
                adapter: 'pointer',
                source: 'pointer',
                deviceId: `pointer:${pointerType}`,
                deviceMatch: '*',
                phase,
                trigger: {
                    type: 'pointer-button',
                    button,
                    pointerType
                },
                context: makeInputContext({
                    ...textContext,
                    nativeNavigationRisk: nativeNavigationRisk({ source: 'pointer', button })
                }),
                raw: {
                    button,
                    pointerType,
                    pointerId: Number.isFinite(Number(event.pointerId)) ? Number(event.pointerId) : null
                },
                timestamp: nowMs()
            };
        }

        pointerKey(event) {
            return `${event.pointerId ?? 'mouse'}:${Number(event.button)}`;
        }

        handlePointerDown(event) {
            const pointerType = event.pointerType || 'mouse';
            const button = Number(event.button);
            if (!Number.isInteger(button)) return;

            if (this.captureSession) {
                const capture = {
                    adapter: 'pointer',
                    deviceMatch: '*',
                    deviceId: `pointer:${pointerType}`,
                    label: formatPointerButton(button),
                    trigger: {
                        type: 'pointer-button',
                        button,
                        pointerType
                    },
                    timestamp: nowMs()
                };
                if (button === 2) this.armNativeFollowupSuppression('contextmenu');
                this.suppressPointerClick(button);
                this.consumeEvent(event);
                this.completeCapture(capture);
                return;
            }

            if (!this.started) return;
            const result = this.dispatchPhysical(this.pointerEnvelope(event, 'press'));
            if (result.claimed) this.ownedPointer.add(this.pointerKey(event));
            if (result.claimed || result.handled) {
                this.suppressPointerClick(button);
                if (button === 2) this.armNativeFollowupSuppression('contextmenu');
                this.consumeEvent(event);
            }
        }

        handlePointerUp(event) {
            if (this.captureSession || !this.started) return;
            const button = Number(event.button);
            if (!Number.isInteger(button)) return;
            const key = this.pointerKey(event);
            const ownedPress = this.ownedPointer.has(key);
            const result = this.dispatchPhysical(this.pointerEnvelope(event, 'release'));
            this.ownedPointer.delete(key);
            if (ownedPress || result.claimed || result.handled) {
                this.suppressPointerClick(button);
                this.consumeEvent(event);
            }
        }

        handleLegacyMouseOwnership(event) {
            if (typeof PointerEvent !== 'function') return;
            const button = Number(event?.button);
            if (!Number.isInteger(button)) return;
            const owned = [...this.ownedPointer].some(key => key.endsWith(`:${button}`));
            const suppressed = this.suppressedPointerClicks.has(button);
            if (!owned && !suppressed && !this.captureSession) return;
            this.suppressPointerClick(button);
            this.consumeEvent(event);
        }

        wheelDirection(event) {
            const dx = Number(event.deltaX) || 0;
            const dy = Number(event.deltaY) || 0;
            const min = Math.max(0, Number(this.cfg.wheelMinDelta) || DEFAULTS.wheelMinDelta);
            if (Math.abs(dx) < min && Math.abs(dy) < min) return null;
            if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'up' : 'down';
            return dx < 0 ? 'left' : 'right';
        }

        handleWheel(event) {
            const direction = this.wheelDirection(event);
            if (!direction) return;

            if (this.captureSession) {
                const capture = {
                    adapter: 'wheel',
                    deviceMatch: '*',
                    deviceId: 'wheel:default',
                    label: `Wheel ${direction.charAt(0).toUpperCase()}${direction.slice(1)}`,
                    trigger: { type: 'wheel', direction },
                    timestamp: nowMs()
                };
                this.consumeEvent(event, false);
                this.completeCapture(capture);
                return;
            }

            if (!this.started) return;
            const context = makeInputContext(getTextContext(isTextEntry(event.target) ? event.target : null));
            const result = this.dispatchPhysical({
                adapter: 'wheel',
                source: 'wheel',
                deviceId: 'wheel:default',
                deviceMatch: '*',
                phase: 'pulse',
                trigger: { type: 'wheel', direction },
                context,
                raw: {
                    direction,
                    deltaX: Number(event.deltaX) || 0,
                    deltaY: Number(event.deltaY) || 0,
                    deltaMode: Number(event.deltaMode) || 0,
                    ...context
                },
                timestamp: nowMs()
            });
            if (result.claimed || result.handled) this.consumeEvent(event);
        }

        consumeEvent(event, immediate = true) {
            try { event.preventDefault?.(); } catch (_) {}
            try { event.stopPropagation?.(); } catch (_) {}
            if (immediate) {
                try { event.stopImmediatePropagation?.(); } catch (_) {}
            }
        }

        suppressPointerClick(button) {
            this.suppressedPointerClicks.set(
                Number(button),
                nowMs() + Math.max(100, Number(this.cfg.pointerClickSuppressMs) || DEFAULTS.pointerClickSuppressMs)
            );
        }

        handleClickSuppression(event) {
            const button = Number(event.button);
            const until = this.suppressedPointerClicks.get(button);
            if (!until) return;
            if (nowMs() > until) {
                this.suppressedPointerClicks.delete(button);
                return;
            }
            this.consumeEvent(event);
            this.suppressedPointerClicks.delete(button);
        }

        isContextMenuKeyboardEvent(event) {
            return !!(
                event?.code === 'ContextMenu' ||
                event?.key === 'ContextMenu' ||
                (event?.code === 'F10' && event?.shiftKey === true)
            );
        }

        armNativeFollowupSuppression(type) {
            if (type !== 'contextmenu') return;
            this.nativeFollowupSuppressUntil.contextmenu = nowMs() +
                Math.max(100, Number(this.cfg.nativeFollowupSuppressMs) || DEFAULTS.nativeFollowupSuppressMs);
        }

        handleContextMenuSuppression(event) {
            const until = Number(this.nativeFollowupSuppressUntil.contextmenu) || 0;
            if (!until || nowMs() > until) {
                this.nativeFollowupSuppressUntil.contextmenu = 0;
                return;
            }
            this.consumeEvent(event);
            this.nativeFollowupSuppressUntil.contextmenu = 0;
            this.log('suppressed native contextmenu follow-up');
        }

        updateGamepadPolling() {
            const shouldPoll = !document.hidden &&
                typeof navigator?.getGamepads === 'function' &&
                (this.started || !!this.captureSession);
            if (shouldPoll) this.startGamepadPolling();
            else this.stopGamepadPolling();
        }

        startGamepadPolling() {
            if (this.gamepadRaf) return;
            const loop = () => {
                this.gamepadRaf = null;
                if (document.hidden || (!this.started && !this.captureSession)) return;
                this.pollGamepads();
                this.gamepadRaf = requestAnimationFrame(loop);
            };
            this.gamepadRaf = requestAnimationFrame(loop);
        }

        stopGamepadPolling() {
            if (!this.gamepadRaf) return;
            cancelAnimationFrame(this.gamepadRaf);
            this.gamepadRaf = null;
        }

        handleVisibilityChanged() {
            if (document.hidden) this.gamepadStates.clear();
            this.updateGamepadPolling();
        }

        getGamepads() {
            if (typeof navigator?.getGamepads !== 'function') return [];
            try { return Array.from(navigator.getGamepads() || []).filter(Boolean); }
            catch (_) { return []; }
        }

        snapshotCaptureGamepads() {
            for (const gamepad of this.getGamepads()) {
                this.captureGamepadBaseline.set(gamepad.index, {
                    buttons: Array.from(gamepad.buttons || []).map(button => Number(button?.value || 0)),
                    axes: Array.from(gamepad.axes || []).map(value => Number(value) || 0)
                });
            }
        }

        pollGamepads() {
            const pads = this.getGamepads();
            this.lastKnownGamepads = pads.map(gamepad => ({
                index: gamepad.index,
                id: gamepad.id || `Gamepad ${gamepad.index}`,
                mapping: gamepad.mapping || null,
                connected: gamepad.connected !== false,
                buttons: gamepad.buttons?.length || 0,
                axes: gamepad.axes?.length || 0
            }));

            if (this.captureSession && this.pollGamepadCapture(pads)) return;
            if (!this.started) return;

            const connected = new Set();
            for (const gamepad of pads) {
                connected.add(String(gamepad.index));
                this.pollGamepadButtons(gamepad);
                this.pollGamepadAxes(gamepad);
            }

            for (const key of [...this.gamepadStates.keys()]) {
                if (!connected.has(key.split('::')[0])) this.gamepadStates.delete(key);
            }
        }

        pollGamepadButtons(gamepad) {
            const threshold = clampNumber(this.cfg.gamepadButtonThreshold, DEFAULTS.gamepadButtonThreshold, 0, 1);
            for (let index = 0; index < (gamepad.buttons?.length || 0); index += 1) {
                const value = Number(gamepad.buttons[index]?.value || 0);
                const key = `${gamepad.index}::button::${index}`;
                const wasActive = this.gamepadStates.get(key) === true;
                const active = value >= threshold;
                if (active === wasActive) continue;
                this.gamepadStates.set(key, active);
                const phase = active ? 'press' : 'release';
                this.dispatchPhysical({
                    adapter: 'gamepad',
                    source: 'gamepad',
                    deviceId: `gamepad:${gamepad.index}`,
                    deviceMatch: '*',
                    phase,
                    trigger: { type: 'gamepad-button', button: index, threshold },
                    context: makeInputContext({ textEntryActive: false, searchEntryActive: false, nativeNavigationRisk: null }),
                    raw: {
                        button: index,
                        value,
                        threshold,
                        gamepadId: gamepad.id || null,
                        mapping: gamepad.mapping || null
                    },
                    timestamp: nowMs()
                });
            }
        }

        pollGamepadAxes(gamepad) {
            const pressThreshold = clampNumber(this.cfg.gamepadAxisThreshold, DEFAULTS.gamepadAxisThreshold, 0.2, 0.98);
            const releaseThreshold = Math.min(
                pressThreshold,
                clampNumber(this.cfg.gamepadAxisReleaseThreshold, DEFAULTS.gamepadAxisReleaseThreshold, 0.05, pressThreshold)
            );

            for (let axis = 0; axis < (gamepad.axes?.length || 0); axis += 1) {
                const value = Number(gamepad.axes[axis] || 0);
                for (const direction of ['negative', 'positive']) {
                    const key = `${gamepad.index}::axis::${axis}::${direction}`;
                    const wasActive = this.gamepadStates.get(key) === true;
                    const active = direction === 'negative'
                        ? value <= -(wasActive ? releaseThreshold : pressThreshold)
                        : value >= (wasActive ? releaseThreshold : pressThreshold);
                    if (active === wasActive) continue;
                    this.gamepadStates.set(key, active);
                    const phase = active ? 'press' : 'release';
                    this.dispatchPhysical({
                        adapter: 'gamepad',
                        source: 'gamepad',
                        deviceId: `gamepad:${gamepad.index}`,
                        deviceMatch: '*',
                        phase,
                        trigger: {
                            type: 'gamepad-axis',
                            axis,
                            direction,
                            threshold: pressThreshold,
                            releaseThreshold
                        },
                        context: makeInputContext({ textEntryActive: false, searchEntryActive: false, nativeNavigationRisk: null }),
                        raw: {
                            axis,
                            direction,
                            value,
                            threshold: pressThreshold,
                            releaseThreshold,
                            gamepadId: gamepad.id || null,
                            mapping: gamepad.mapping || null
                        },
                        timestamp: nowMs()
                    });
                }
            }
        }

        pollGamepadCapture(pads) {
            const buttonThreshold = clampNumber(this.cfg.gamepadButtonThreshold, DEFAULTS.gamepadButtonThreshold, 0, 1);
            const axisThreshold = clampNumber(this.cfg.gamepadAxisThreshold, DEFAULTS.gamepadAxisThreshold, 0.2, 0.98);
            const axisReleaseThreshold = Math.min(
                axisThreshold,
                clampNumber(this.cfg.gamepadAxisReleaseThreshold, DEFAULTS.gamepadAxisReleaseThreshold, 0.05, axisThreshold)
            );

            for (const gamepad of pads) {
                let baseline = this.captureGamepadBaseline.get(gamepad.index);
                if (!baseline) {
                    baseline = {
                        buttons: Array.from(gamepad.buttons || []).map(button => Number(button?.value || 0)),
                        axes: Array.from(gamepad.axes || []).map(value => Number(value) || 0)
                    };
                    this.captureGamepadBaseline.set(gamepad.index, baseline);
                    continue;
                }

                for (let i = 0; i < (gamepad.buttons?.length || 0); i += 1) {
                    const before = Number(baseline.buttons[i] || 0);
                    const current = Number(gamepad.buttons[i]?.value || 0);
                    baseline.buttons[i] = current;
                    if (before < buttonThreshold && current >= buttonThreshold) {
                        this.completeCapture({
                            adapter: 'gamepad',
                            deviceMatch: '*',
                            deviceId: `gamepad:${gamepad.index}`,
                            deviceLabel: gamepad.id || `Gamepad ${gamepad.index}`,
                            label: `Gamepad Button ${i}`,
                            trigger: { type: 'gamepad-button', button: i, threshold: buttonThreshold },
                            timestamp: nowMs()
                        });
                        return true;
                    }
                }

                for (let i = 0; i < (gamepad.axes?.length || 0); i += 1) {
                    const before = Number(baseline.axes[i] || 0);
                    const current = Number(gamepad.axes[i] || 0);
                    baseline.axes[i] = current;
                    if (Math.abs(before) < axisThreshold && Math.abs(current) >= axisThreshold) {
                        const direction = current < 0 ? 'negative' : 'positive';
                        this.completeCapture({
                            adapter: 'gamepad',
                            deviceMatch: '*',
                            deviceId: `gamepad:${gamepad.index}`,
                            deviceLabel: gamepad.id || `Gamepad ${gamepad.index}`,
                            label: `Gamepad Axis ${i} ${direction === 'negative' ? 'Negative' : 'Positive'}`,
                            trigger: {
                                type: 'gamepad-axis',
                                axis: i,
                                direction,
                                threshold: axisThreshold,
                                releaseThreshold: axisReleaseThreshold
                            },
                            timestamp: nowMs()
                        });
                        return true;
                    }
                }
            }
            return false;
        }

        getDeviceInfo() {
            const bindings = this.getBindings();
            return {
                adapter: 'universal',
                label: 'Universal Browser Input',
                version: VERSION,
                gestureResolverVersion: QoL.gestureResolverRuntime?.version || null,
                browserApis: {
                    keyboard: true,
                    pointer: typeof PointerEvent === 'function',
                    wheel: true,
                    gamepad: typeof navigator?.getGamepads === 'function'
                },
                gamepads: this.lastKnownGamepads.map(clone),
                bindingCounts: bindings.reduce((result, binding) => {
                    result[binding.adapter] = (result[binding.adapter] || 0) + 1;
                    return result;
                }, {})
            };
        }

        getState() {
            return {
                version: VERSION,
                started: this.started,
                captureActive: !!this.captureSession,
                resolver: this.resolver?.getState?.() || null,
                gamepadPolling: !!this.gamepadRaf,
                ownedKeyboardCount: this.ownedKeyboard.size,
                ownedPointerCount: this.ownedPointer.size,
                lastKnownGamepads: this.lastKnownGamepads.map(clone)
            };
        }

        log(...args) {
            if (!(this.cfg.debug || QoL.settings?.DEBUG || QoL.settings?.airNav?.debug || QoL.settings?.airNav?.input?.debug)) return;
            console.log(LOG, ...args);
        }
    }

    let api = null;
    let factoryRegistered = false;

    function currentOwnership() {
        const owner = QoL.airNavUniversalInput || null;
        return {
            takeoverActive: !!api && owner === api,
            passiveComparisonMode: !!owner && owner !== api,
            legacyPresent: !!owner && owner !== api,
            owner
        };
    }

    function registerProductionFactory() {
        if (factoryRegistered) {
            return { registered: true, reason: 'production-factory-already-registered' };
        }
        if (!QoL.airNavInput?.registerAdapter) {
            return { registered: false, reason: 'input-registry-not-ready' };
        }
        QoL.airNavInput.registerAdapter('universal', options => new UniversalInputAdapter(options));
        factoryRegistered = true;
        return { registered: true, reason: 'production-factory-registered' };
    }

    function reconcileOwnership() {
        if (!api) return { takeoverActive: false, reason: 'runtime-not-ready' };
        const current = QoL.airNavUniversalInput || null;
        if (!current || current === api) {
            QoL.airNavUniversalInput = api;
            const registration = registerProductionFactory();
            return {
                takeoverActive: true,
                passiveComparisonMode: false,
                legacyPresent: false,
                registration,
                reason: current === api ? 'already-production-owner' : 'production-owner-claimed'
            };
        }
        factoryRegistered = false;
        return {
            takeoverActive: false,
            passiveComparisonMode: true,
            legacyPresent: true,
            legacyVersion: current.VERSION || current.version || null,
            reason: 'legacy-owner-present'
        };
    }

    function compatibilityReport() {
        const ownership = reconcileOwnership();
        const requiredAdapterMethods = [
            'start', 'stop', 'reloadBindings', 'getDeviceInfo',
            'beginCapture', 'endCapture', 'getCaptureState'
        ];
        let probe = null;
        let missingAdapterMethods = [];
        try {
            probe = new UniversalInputAdapter({ captureOnly: true });
            missingAdapterMethods = requiredAdapterMethods.filter(method => typeof probe?.[method] !== 'function');
        } catch (error) {
            missingAdapterMethods = requiredAdapterMethods.slice();
        } finally {
            try { probe?.stop?.(); } catch (_) {}
        }

        return {
            version: VERSION,
            ready: missingAdapterMethods.length === 0 && !!QoL.gestureResolverRuntime && !!QoL.airNavInput,
            missingAdapterMethods,
            takeoverActive: ownership.takeoverActive,
            passiveComparisonMode: ownership.passiveComparisonMode,
            legacyPresent: ownership.legacyPresent,
            legacyVersion: ownership.legacyVersion || null,
            registryPresent: !!QoL.airNavInput,
            registryVersion: QoL.airNavInput?.version || QoL.airNavInput?.VERSION || null,
            gestureResolverPresent: !!QoL.gestureResolverRuntime,
            gestureResolverVersion: QoL.gestureResolverRuntime?.version || null,
            profileRuntimePresent: !!QoL.profileRuntime,
            profileRuntimeVersion: QoL.profileRuntime?.version || null,
            browserApis: {
                keyboard: true,
                pointer: typeof PointerEvent === 'function',
                wheel: true,
                gamepad: typeof navigator?.getGamepads === 'function'
            },
            gestureOwnership: 'gesture-resolver',
            nativeKeyboardRepeatOwnership: 'suppressed-by-resolver',
            captureReady: true,
            productionFactoryRegistered: QoL.airNavInput?.getState?.().registeredAdapters?.includes?.('universal') === true,
            ownershipReason: ownership.reason
        };
    }

    api = Object.freeze({
        version: VERSION,
        VERSION,
        DEFAULTS,
        create: options => new UniversalInputAdapter(options),
        reconcileOwnership,
        compatibilityReport
    });

    QoL.universalInputRuntime = api;
    const ownership = reconcileOwnership();

    console.log(
        LOG,
        ownership.takeoverActive
            ? 'Production Universal Input owns JellyfinQoL.airNavUniversalInput.'
            : 'Production Universal Input registered in passive comparison mode.',
        compatibilityReport()
    );
})();
