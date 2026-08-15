// Jellyfin Air Navigation - Phase 12.2 Select Option Menu Prototype
//
// Generic edit subcontext for ordinary PAGE settings forms.
// Scanner owns DOM discovery/classification. No physical input codes live here.
//
// checkbox/radio -> ACTIVATE clicks
// button         -> ACTIVATE clicks
// select         -> ACTIVATE opens option menu; UP/DOWN preview; ACTIVATE commits; BACK cancels
// range          -> ACTIVATE edit; LEFT/RIGHT adjusts
// number         -> ACTIVATE edit; UP/DOWN adjusts
// ACTIVATE/BACK  -> exit edit mode

// Jellyfin QoL - Production Navigation PageForm v1.0.0
// Legacy compatibility: Phase 12.2 Select Option Menu Prototype.
//
// The production API remains passive while the injected PageFormNavigation
// module owns JellyfinQoL.airPageForm. Disable only that old script and reload
// to transfer ownership without changing Controller or canonical input.
(function (QoL) {
  'use strict';

  const VERSION = '1.0.0';
  const LEGACY_VERSION = '12.2';
  const LOG =
    '[JellyfinQoL.NavigationPageForm]';

  class PageFormNavigation {
    constructor(options = {}) {
      this.cfg = Object.assign(
        {
          rescanDelayMs: 70,
          styleId:
            'airnav-page-form-edit-style',

          // Selects use an AirNav-owned option menu rather than changing the
          // native <select> value on every UP/DOWN. Many Jellyfin settings save
          // immediately on change, so previewing must not mutate the setting.
          selectMenuId:
            'airnav-page-select-menu',
          selectMenuMaxHeightVh: 64,
          selectMenuMinWidthPx: 260
        },
        options
      );

      this.editingControlKey = null;
      this.editingKind = null;
      this.lastActivation = null;
      this.lastEdit = null;

      // Select menu is a logical nested context. Moving in the menu only
      // changes previewIndex. The underlying <select> changes exactly once,
      // when ACTIVATE commits the highlighted option.
      this.selectMenu = null;

      this.unsubscribeRoute =
        QoL.airScanner?.on?.(
          'routeChanged',
          () =>
            this.exitEdit(
              'route-changed',
              false
            )
        ) || null;

      this.unsubscribeModal =
        QoL.airScanner?.on?.(
          'modalOpened',
          () =>
            this.exitEdit(
              'modal-opened',
              false
            )
        ) || null;

      this.injectCss();
    }

    destroy() {
      this.closeSelectMenu(
        'destroy',
        false
      );

      this.exitEdit(
        'destroy',
        false
      );

      try {
        this.unsubscribeRoute?.();
      } catch (_) {}

      try {
        this.unsubscribeModal?.();
      } catch (_) {}
    }

    ownsItem(item) {
      return !!(
        item?.metadata
          ?.pageFormControl
      );
    }

    ownsElement(element) {
      if (!element) return false;

      const selected =
        QoL.airFocus
          ?.getSelectedItem?.();

      return !!(
        this.ownsItem(
          selected
        ) &&
        selected.element ===
          element
      );
    }

    isEditing() {
      return !!this.editingControlKey;
    }

    activateSelected(item = null) {
      item =
        item ||
        QoL.airFocus
          ?.getSelectedItem?.();

      if (!this.ownsItem(item)) {
        return this.result(
          false,
          'page-form-item-required'
        );
      }

      const element =
        item.element;

      if (!element?.isConnected) {
        return this.result(
          true,
          'page-form-element-missing'
        );
      }

      const kind =
        item.metadata
          ?.pageFormControlKind ||
        'action';

      if (
        kind === 'select' ||
        kind === 'range' ||
        kind === 'number'
      ) {
        return this.enterEdit(
          item,
          kind
        );
      }

      try {
        element.click();
      } catch (error) {
        return this.result(
          true,
          'page-form-click-failed',
          { error }
        );
      }

      this.lastActivation = {
        timestamp: Date.now(),
        itemKey: item.key,
        title: item.title || null,
        kind
      };

      this.scheduleRescan(
        'page-form-click'
      );

      return this.result(
        true,
        'page-form-activated',
        {
          activation:
            this.lastActivation
        }
      );
    }

    dispatch(action) {
      action =
        String(action || '')
          .toUpperCase();

      if (!this.isEditing()) {
        return this.result(
          false,
          'page-form-not-editing'
        );
      }

      // SELECT is a real option-menu context. BACK cancels without touching
      // the setting; ACTIVATE commits the currently highlighted option.
      if (
        this.editingKind ===
          'select' &&
        this.selectMenu
      ) {
        if (action === 'BACK') {
          return this.closeSelectMenu(
            'back',
            false
          );
        }

        if (action === 'ACTIVATE') {
          return this.commitSelectMenu();
        }

        if (
          action === 'UP' ||
          action === 'DOWN'
        ) {
          return this.moveSelectMenu(
            action
          );
        }

        return this.result(
          true,
          'page-form-select-menu-clamp',
          {
            action,
            selectedIndex:
              this.selectMenu
                ?.previewIndex ??
              null
          }
        );
      }

      if (
        action === 'ACTIVATE' ||
        action === 'BACK'
      ) {
        return this.exitEdit(
          action.toLowerCase()
        );
      }

      const item =
        this.findItemByKey(
          this.editingControlKey
        );

      const element =
        item?.element || null;

      if (
        !item ||
        !element?.isConnected
      ) {
        this.editingControlKey =
          null;
        this.editingKind =
          null;

        return this.result(
          true,
          'page-form-edit-target-lost'
        );
      }

      if (
        this.editingKind ===
          'select'
      ) {
        const reopened =
          this.openSelectMenu(
            item,
            element
          );

        return reopened?.handled
          ? this.dispatch(action)
          : this.result(
              true,
              'page-form-select-menu-unavailable'
            );
      }

      if (
        this.editingKind ===
          'range'
      ) {
        if (
          action !== 'LEFT' &&
          action !== 'RIGHT'
        ) {
          return this.result(
            true,
            'page-form-range-edit-clamp'
          );
        }

        return this.adjustNumeric(
          element,
          action === 'RIGHT'
            ? 1
            : -1,
          item
        );
      }

      if (
        this.editingKind ===
          'number'
      ) {
        if (
          action !== 'UP' &&
          action !== 'DOWN'
        ) {
          return this.result(
            true,
            'page-form-number-edit-clamp'
          );
        }

        return this.adjustNumeric(
          element,
          action === 'UP'
            ? 1
            : -1,
          item
        );
      }

      return this.result(
        true,
        'page-form-edit-unsupported'
      );
    }

    enterEdit(item, kind) {
      const element =
        item?.element;

      if (!element?.isConnected) {
        return this.result(
          true,
          'page-form-edit-element-missing'
        );
      }

      if (this.isEditing()) {
        this.exitEdit(
          'switch-control',
          false
        );
      }

      this.editingControlKey =
        item.key;
      this.editingKind =
        kind;

      try {
        element.setAttribute(
          'data-airnav-page-form-editing',
          'true'
        );
      } catch (_) {}

      // FocusManager synchronises DOM focus to the selected control so ordinary
      // page navigation can reach form elements. Edit mode itself must remain
      // LOGICAL, though: allowing a native <select>/<input> to retain DOM focus
      // can make the browser consume the next ENTER/arrow key and trap AirNav
      // inside the control. Remove native focus immediately; the AirNav visual
      // selection + edit ring remain authoritative.
      this.releaseDomFocus(
        element
      );

      this.lastEdit = {
        timestamp: Date.now(),
        state: 'entered',
        itemKey: item.key,
        title: item.title || null,
        kind,
        value:
          'value' in element
            ? element.value
            : null
      };

      if (kind === 'select') {
        const menu =
          this.openSelectMenu(
            item,
            element
          );

        if (!menu.handled) {
          this.editingControlKey =
            null;
          this.editingKind =
            null;

          try {
            element.removeAttribute(
              'data-airnav-page-form-editing'
            );
          } catch (_) {}

          return menu;
        }

        return menu;
      }

      return this.result(
        true,
        'page-form-edit-entered',
        {
          edit:
            this.lastEdit
        }
      );
    }

    exitEdit(
      reason = 'done',
      restore = true
    ) {
      const key =
        this.editingControlKey;

      if (!key) {
        return this.result(
          false,
          'page-form-not-editing'
        );
      }

      const item =
        this.findItemByKey(key);

      const element =
        item?.element || null;

      if (this.selectMenu) {
        this.destroySelectMenuDom();
      }

      try {
        element?.removeAttribute?.(
          'data-airnav-page-form-editing'
        );
      } catch (_) {}

      // Explicitly release the browser-native control before restoring logical
      // AirNav selection. This makes ENTER/BACK a real "defocus" operation from
      // the user's perspective and prevents a select from continuing to own
      // subsequent arrows.
      this.releaseDomFocus(
        element
      );

      this.lastEdit = {
        timestamp: Date.now(),
        state: 'exited',
        reason,
        itemKey: key,
        title: item?.title || null,
        kind: this.editingKind,
        value:
          element &&
          'value' in element
            ? element.value
            : null
      };

      this.editingControlKey = null;
      this.editingKind = null;

      if (
        restore &&
        item?.key
      ) {
        QoL.airFocus
          ?.selectByKey?.(
            item.key,
            `page-form-edit-exit:${reason}`,
            {
              preservePreferredX:
                false
            }
          );
      }

      return this.result(
        true,
        'page-form-edit-exited',
        {
          edit:
            this.lastEdit
        }
      );
    }

    openSelectMenu(
      item,
      select
    ) {
      if (
        !item?.key ||
        !select?.isConnected ||
        String(
          select.tagName || ''
        ).toLowerCase() !==
          'select'
      ) {
        return this.result(
          true,
          'page-form-select-menu-invalid'
        );
      }

      this.destroySelectMenuDom();

      const options =
        Array.from(
          select.options || []
        )
          .map((option, index) => ({
            index,
            value:
              option.value,
            label:
              String(
                option.textContent ||
                option.label ||
                option.value ||
                `Option ${index + 1}`
              ).trim(),
            disabled:
              !!option.disabled,
            hidden:
              !!option.hidden
          }))
          .filter(option =>
            !option.hidden
          );

      if (!options.length) {
        return this.result(
          true,
          'page-form-select-menu-no-options'
        );
      }

      let selectedIndex =
        Number(
          select.selectedIndex
        );

      if (
        !Number.isInteger(
          selectedIndex
        ) ||
        selectedIndex < 0
      ) {
        selectedIndex =
          options.find(
            option =>
              !option.disabled
          )?.index ??
          0;
      }

      // selectedIndex belongs to the native <select>; preview position belongs
      // to our filtered option list.
      let previewIndex =
        options.findIndex(
          option =>
            option.index ===
              selectedIndex
        );

      if (
        previewIndex < 0 ||
        options[
          previewIndex
        ]?.disabled
      ) {
        previewIndex =
          options.findIndex(
            option =>
              !option.disabled
          );
      }

      if (previewIndex < 0) {
        return this.result(
          true,
          'page-form-select-menu-all-disabled'
        );
      }

      const menuElement =
        document.createElement(
          'div'
        );

      menuElement.id =
        this.cfg.selectMenuId;
      menuElement.className =
        'airnav-page-select-menu';
      menuElement.setAttribute(
        'data-airnav-select-menu',
        'true'
      );
      menuElement.setAttribute(
        'role',
        'listbox'
      );

      const title =
        document.createElement(
          'div'
        );

      title.className =
        'airnav-page-select-menu-title';
      title.textContent =
        item.title ||
        'Select option';

      menuElement.appendChild(
        title
      );

      const list =
        document.createElement(
          'div'
        );

      list.className =
        'airnav-page-select-menu-list';

      const optionElements = [];

      options.forEach(
        (option, menuIndex) => {
          const row =
            document.createElement(
              'div'
            );

          row.className =
            'airnav-page-select-menu-option';
          row.setAttribute(
            'role',
            'option'
          );
          row.setAttribute(
            'data-airnav-menu-index',
            String(menuIndex)
          );
          row.setAttribute(
            'aria-disabled',
            option.disabled
              ? 'true'
              : 'false'
          );

          const label =
            document.createElement(
              'span'
            );

          label.className =
            'airnav-page-select-menu-option-label';
          label.textContent =
            option.label;

          row.appendChild(
            label
          );

          if (
            option.index ===
            select.selectedIndex
          ) {
            const current =
              document.createElement(
                'span'
              );

            current.className =
              'airnav-page-select-menu-current';
            current.textContent =
              '✓';

            row.appendChild(
              current
            );
          }

          list.appendChild(
            row
          );

          optionElements.push(
            row
          );
        }
      );

      menuElement.appendChild(
        list
      );

      (
        document.body ||
        document.documentElement
      ).appendChild(
        menuElement
      );

      this.selectMenu = {
        controlKey:
          item.key,
        select,
        originalValue:
          select.value,
        originalSelectedIndex:
          select.selectedIndex,
        options,
        previewIndex,
        element:
          menuElement,
        listElement:
          list,
        optionElements,
        openedAt:
          Date.now()
      };

      this.renderSelectMenu();

      this.lastEdit = {
        timestamp:
          Date.now(),
        state:
          'menu-opened',
        itemKey:
          item.key,
        title:
          item.title || null,
        kind:
          'select',
        value:
          select.value,
        selectedIndex:
          select.selectedIndex,
        previewIndex,
        optionCount:
          options.length
      };

      return this.result(
        true,
        'page-form-select-menu-opened',
        {
          edit:
            this.lastEdit
        }
      );
    }

    moveSelectMenu(direction) {
      const menu =
        this.selectMenu;

      if (!menu) {
        return this.result(
          true,
          'page-form-select-menu-missing'
        );
      }

      const step =
        direction === 'DOWN'
          ? 1
          : -1;

      let next =
        menu.previewIndex +
        step;

      while (
        next >= 0 &&
        next <
          menu.options.length &&
        menu.options[
          next
        ]?.disabled
      ) {
        next += step;
      }

      if (
        next < 0 ||
        next >=
          menu.options.length
      ) {
        return this.result(
          true,
          'page-form-select-menu-edge',
          {
            direction,
            previewIndex:
              menu.previewIndex
          }
        );
      }

      menu.previewIndex =
        next;

      this.renderSelectMenu();

      const option =
        menu.options[next];

      this.lastEdit = {
        timestamp:
          Date.now(),
        state:
          'preview',
        itemKey:
          menu.controlKey,
        kind:
          'select',
        direction,
        originalValue:
          menu.originalValue,
        previewIndex:
          next,
        previewValue:
          option.value,
        previewText:
          option.label
      };

      return this.result(
        true,
        'page-form-select-menu-moved',
        {
          edit:
            this.lastEdit
        }
      );
    }

    commitSelectMenu() {
      const menu =
        this.selectMenu;

      if (!menu) {
        return this.result(
          true,
          'page-form-select-menu-missing'
        );
      }

      const option =
        menu.options[
          menu.previewIndex
        ];

      const select =
        menu.select;

      if (
        !option ||
        option.disabled ||
        !select?.isConnected
      ) {
        return this.closeSelectMenu(
          'target-lost',
          false
        );
      }

      const before =
        select.value;

      // Close visual/menu state BEFORE dispatching change. Jellyfin/plugin
      // handlers may synchronously rebuild the page or even reload it.
      const key =
        menu.controlKey;
      const chosenIndex =
        option.index;
      const chosenValue =
        option.value;
      const chosenText =
        option.label;

      this.destroySelectMenuDom();

      try {
        select.selectedIndex =
          chosenIndex;
      } catch (_) {
        try {
          select.value =
            chosenValue;
        } catch (_) {}
      }

      const changed =
        select.value !==
        before;

      if (changed) {
        this.dispatchChangeEvents(
          select
        );
      }

      this.lastEdit = {
        timestamp:
          Date.now(),
        state:
          changed
            ? 'committed'
            : 'committed-no-change',
        itemKey:
          key,
        kind:
          'select',
        before,
        value:
          select.value,
        selectedIndex:
          select.selectedIndex,
        optionText:
          chosenText
      };

      // Finish the edit context immediately. This is important for settings
      // like Theme where the change handler may reload the page.
      this.editingControlKey =
        null;
      this.editingKind =
        null;

      try {
        select.removeAttribute(
          'data-airnav-page-form-editing'
        );
      } catch (_) {}

      this.releaseDomFocus(
        select
      );

      if (changed) {
        this.scheduleRescan(
          'page-form-select-commit'
        );
      } else {
        QoL.airFocus
          ?.selectByKey?.(
            key,
            'page-form-select-no-change',
            {
              preservePreferredX:
                false
            }
          );
      }

      return this.result(
        true,
        changed
          ? 'page-form-select-committed'
          : 'page-form-select-committed-no-change',
        {
          edit:
            this.lastEdit
        }
      );
    }

    closeSelectMenu(
      reason = 'back',
      commit = false
    ) {
      if (commit) {
        return this.commitSelectMenu();
      }

      const menu =
        this.selectMenu;

      if (!menu) {
        if (this.editingKind === 'select') {
          return this.exitEdit(
            reason
          );
        }

        return this.result(
          false,
          'page-form-select-menu-not-open'
        );
      }

      const key =
        menu.controlKey;

      const select =
        menu.select;

      this.lastEdit = {
        timestamp:
          Date.now(),
        state:
          'cancelled',
        reason,
        itemKey:
          key,
        kind:
          'select',
        value:
          menu.originalValue,
        selectedIndex:
          menu.originalSelectedIndex
      };

      // No value was ever modified while previewing, so cancel is truly free.
      this.destroySelectMenuDom();

      this.editingControlKey =
        null;
      this.editingKind =
        null;

      try {
        select?.removeAttribute?.(
          'data-airnav-page-form-editing'
        );
      } catch (_) {}

      this.releaseDomFocus(
        select
      );

      if (key) {
        QoL.airFocus
          ?.selectByKey?.(
            key,
            `page-form-select-menu-close:${reason}`,
            {
              preservePreferredX:
                false
            }
          );
      }

      return this.result(
        true,
        'page-form-select-menu-closed',
        {
          edit:
            this.lastEdit
        }
      );
    }

    destroySelectMenuDom() {
      const element =
        this.selectMenu
          ?.element ||
        document.getElementById(
          this.cfg.selectMenuId
        );

      try {
        element?.remove?.();
      } catch (_) {}

      this.selectMenu =
        null;
    }

    renderSelectMenu() {
      const menu =
        this.selectMenu;

      if (!menu) return;

      menu.optionElements
        .forEach(
          (element, index) => {
            const selected =
              index ===
              menu.previewIndex;

            element.classList.toggle(
              'airnav-page-select-menu-option-selected',
              selected
            );

            element.setAttribute(
              'aria-selected',
              selected
                ? 'true'
                : 'false'
            );
          }
        );

      const selectedElement =
        menu.optionElements[
          menu.previewIndex
        ];

      try {
        selectedElement
          ?.scrollIntoView?.({
            block: 'nearest',
            inline: 'nearest',
            behavior: 'auto'
          });
      } catch (_) {}
    }

    adjustNumeric(
      input,
      sign,
      item
    ) {
      const before =
        String(
          input.value ?? ''
        );

      try {
        if (sign > 0) {
          input.stepUp?.();
        } else {
          input.stepDown?.();
        }
      } catch (_) {
        const current =
          Number(input.value);

        const step =
          Number(
            input.step || 1
          ) || 1;

        if (
          Number.isFinite(current)
        ) {
          input.value =
            String(
              current +
              sign * step
            );
        }
      }

      this.dispatchChangeEvents(
        input
      );

      this.lastEdit = {
        timestamp: Date.now(),
        state: 'changed',
        itemKey: item.key,
        title: item.title || null,
        kind: this.editingKind,
        before,
        value: input.value
      };

      this.scheduleRescan(
        'page-form-numeric-change'
      );

      return this.result(
        true,
        'page-form-numeric-changed',
        {
          edit:
            this.lastEdit
        }
      );
    }

    dispatchChangeEvents(element) {
      try {
        element.dispatchEvent(
          new Event(
            'input',
            { bubbles: true }
          )
        );

        element.dispatchEvent(
          new Event(
            'change',
            { bubbles: true }
          )
        );
      } catch (_) {}
    }

    scheduleRescan(reason) {
      setTimeout(() => {
        try {
          QoL.airScanner
            ?.scan?.(
              reason
            );

          QoL.airFocus
            ?.refresh?.(
              reason
            );

          this.rebindEditingControl(
            reason
          );
        } catch (_) {}
      }, Math.max(
        0,
        Number(
          this.cfg.rescanDelayMs
        ) || 70
      ));
    }

    releaseDomFocus(element) {
      if (!element) return;

      try {
        if (
          document.activeElement ===
          element
        ) {
          element.blur?.();
        }
      } catch (_) {}

      // Some custom-elements/native wrappers immediately restore focus during
      // their own change handler. A microtask check releases it once more
      // without moving logical AirNav selection.
      queueMicrotask(() => {
        try {
          if (
            document.activeElement ===
            element
          ) {
            element.blur?.();
          }
        } catch (_) {}
      });
    }

    rebindEditingControl(
      reason = 'rebind'
    ) {
      if (!this.editingControlKey) {
        return null;
      }

      const item =
        this.findItemByKey(
          this.editingControlKey
        );

      const element =
        item?.element || null;

      if (!element?.isConnected) {
        return null;
      }

      try {
        element.setAttribute(
          'data-airnav-page-form-editing',
          'true'
        );
      } catch (_) {}

      this.releaseDomFocus(
        element
      );

      return {
        reason,
        itemKey:
          item.key,
        title:
          item.title || null,
        kind:
          this.editingKind
      };
    }

    findItemByKey(key) {
      const model =
        QoL.airScanner
          ?.getModel?.();

      for (
        const section of
        model?.sections || []
      ) {
        const item =
          (section.items || [])
            .find(candidate =>
              candidate.key === key
            );

        if (item) {
          return item;
        }
      }

      return null;
    }

    injectCss() {
      if (
        document.getElementById(
          this.cfg.styleId
        )
      ) {
        return;
      }

      const style =
        document.createElement(
          'style'
        );

      style.id =
        this.cfg.styleId;

      style.textContent = `
        [data-airnav-page-form-editing="true"] {
          outline: 3px solid rgba(255,255,255,.98) !important;
          outline-offset: 4px !important;
          box-shadow:
            0 0 0 7px
              var(--theme-primary-color, var(--primary-accent-color, #00a4dc)),
            0 0 20px rgba(0,164,220,.75)
              !important;
        }

        .airnav-page-select-menu {
          position: fixed;
          z-index: 2147483000;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          min-width:
            ${Math.max(
              180,
              Number(
                this.cfg
                  .selectMenuMinWidthPx
              ) || 260
            )}px;
          width: min(78vw, 560px);
          max-height:
            ${Math.max(
              30,
              Number(
                this.cfg
                  .selectMenuMaxHeightVh
              ) || 64
            )}vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border-radius: 12px;
          background:
            rgba(22, 27, 34, .98);
          border:
            1px solid
            rgba(255,255,255,.18);
          box-shadow:
            0 18px 60px
            rgba(0,0,0,.55);
          color: #fff;
          font: inherit;
        }

        .airnav-page-select-menu-title {
          padding: 14px 18px;
          font-weight: 700;
          border-bottom:
            1px solid
            rgba(255,255,255,.12);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .airnav-page-select-menu-list {
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 6px;
        }

        .airnav-page-select-menu-option {
          display: flex;
          align-items: center;
          justify-content:
            space-between;
          gap: 16px;
          min-height: 44px;
          padding: 8px 12px;
          border-radius: 8px;
          opacity: .92;
        }

        .airnav-page-select-menu-option[
          aria-disabled="true"
        ] {
          opacity: .35;
        }

        .airnav-page-select-menu-option-selected {
          outline:
            3px solid
            rgba(255,255,255,.98);
          outline-offset: -3px;
          background:
            var(
              --theme-primary-color,
              var(
                --primary-accent-color,
                rgba(0,164,220,.82)
              )
            );
        }

        .airnav-page-select-menu-current {
          flex: 0 0 auto;
          font-weight: 800;
        }
      `;

      (
        document.head ||
        document.documentElement
      ).appendChild(
        style
      );
    }

    getState() {
      return {
        version: LEGACY_VERSION,
        editing:
          this.isEditing(),
        editingControlKey:
          this.editingControlKey,
        editingKind:
          this.editingKind,
        selectMenu:
          this.selectMenu
            ? {
                controlKey:
                  this.selectMenu
                    .controlKey,
                originalValue:
                  this.selectMenu
                    .originalValue,
                previewIndex:
                  this.selectMenu
                    .previewIndex,
                previewValue:
                  this.selectMenu
                    .options[
                      this.selectMenu
                        .previewIndex
                    ]?.value ??
                  null,
                previewText:
                  this.selectMenu
                    .options[
                      this.selectMenu
                        .previewIndex
                    ]?.label ??
                  null,
                optionCount:
                  this.selectMenu
                    .options.length
              }
            : null,
        lastActivation:
          this.lastActivation,
        lastEdit:
          this.lastEdit
      };
    }

    result(
      handled,
      reason,
      extra = {}
    ) {
      return {
        handled:
          !!handled,
        reason,
        ...extra
      };
    }
  }

  let instance = null;

  function getInstance() {
    if (!instance) {
      instance =
        new PageFormNavigation();
    }

    return instance;
  }

  const api = Object.freeze({
    version: VERSION,
    VERSION,
    LEGACY_VERSION,
    production: true,

    ownsItem(item) {
      return getInstance()
        ?.ownsItem?.(item) ||
        false;
    },

    ownsElement(element) {
      return getInstance()
        ?.ownsElement?.(
          element
        ) || false;
    },

    isEditing() {
      return getInstance()
        ?.isEditing?.() ||
        false;
    },

    activateSelected(item = null) {
      return getInstance()
        ?.activateSelected?.(
          item
        ) || {
          handled: false,
          reason:
            'page-form-unavailable'
        };
    },

    dispatch(action) {
      return getInstance()
        ?.dispatch?.(
          action
        ) || {
          handled: false,
          reason:
            'page-form-unavailable'
        };
    },

    getState() {
      return instance
        ?.getState?.() || {
          version:
            LEGACY_VERSION,
          editing: false
        };
    },

    compatibilityReport() {
      const takeoverActive =
        QoL.airPageForm === api;

      const legacyPresent =
        !!QoL.airPageForm &&
        QoL.airPageForm !== api;

      let activeApiVersion = null;

      try {
        activeApiVersion =
          QoL.airPageForm?.version ||
          QoL.airPageForm?.VERSION ||
          QoL.airPageForm
            ?.getState?.()?.version ||
          null;
      } catch (_) {}

      return {
        version: VERSION,
        legacyVersion:
          LEGACY_VERSION,
        production: true,
        takeoverActive,
        legacyPresent,
        activeApiVersion,
        started: !!instance,
        editing:
          !!instance?.isEditing?.(),
        dependencies: {
          scanner:
            !!QoL.airScanner,
          focus:
            !!QoL.airFocus
        }
      };
    },

    destroy() {
      instance?.destroy?.();
      instance = null;
    }
  });

  const existingPageForm =
    QoL.airPageForm || null;

  QoL.navigationPageFormRuntime =
    api;

  if (
    !existingPageForm ||
    existingPageForm === api
  ) {
    QoL.airPageForm = api;

    console.log(
      LOG,
      'Production Navigation PageForm registered as window.JellyfinQoL.airPageForm.',
      {
        version: VERSION,
        legacyCompatibility:
          LEGACY_VERSION
      }
    );
  } else {
    console.log(
      LOG,
      'Production Navigation PageForm loaded passively; existing window.JellyfinQoL.airPageForm remains authoritative.',
      {
        version: VERSION,
        legacyCompatibility:
          LEGACY_VERSION
      }
    );
  }

})(window.JellyfinQoL = window.JellyfinQoL || {});