from pathlib import Path

path = Path('Jellyfin.Plugin.QoL/Web/navigationScanner.js')
text = path.read_text(encoding='utf-8')

old_version = "const VERSION = '1.0.2';"
if text.count(old_version) != 1:
    raise SystemExit(f'Expected exactly one {old_version!r}, found {text.count(old_version)}')
text = text.replace(old_version, "const VERSION = '1.0.3';", 1)

# ---------------------------------------------------------------------------
# 1. Add narrow structural adapter selectors. Generic semantics still own all
# ordinary controls; these selectors only cover structures evidenced by the
# runtime corpus that otherwise sit outside the legacy section projection.
# ---------------------------------------------------------------------------
marker = "      sectionSelector: '.verticalSection, .jellyseerr-section, .mainDetailButtons, .qol-user-settings-preferences-card',\n"
insert = marker + "\n      // Compatibility adapters for visually meaningful controls that are not\n      // children of the legacy card/list section projection. These augment the\n      // generic model; they are never used to classify ordinary buttons/links.\n      sectionTitleActionSelector: [\n        '.sectionTitleContainer a[href]',\n        '.sectionTitleContainer button',\n        '.sectionTitleContainer [role=\"button\"]'\n      ].join(', '),\n      heroContainerSelector: '.slides-container',\n      heroActiveSlideSelector: '.slide.active[data-item-id], .slide.active[tabindex]',\n      heroPrimaryActionSelector: '.detail-button, .detailButton.detail-button',\n      heroChildActionSelector: '.btnPlay, .play-button, .trailer-button, .favorite-button',\n      heroUtilityActionSelector: '.pause-button, .mute-button',\n"
if text.count(marker) != 1:
    raise SystemExit(f'Expected one sectionSelector marker, found {text.count(marker)}')
text = text.replace(marker, insert, 1)

# ---------------------------------------------------------------------------
# 2. Insert adapter builders before production residual semantic controls.
# ---------------------------------------------------------------------------
marker = '      buildProductionResidualSections(model, surfaceId) {'
if text.count(marker) != 1:
    raise SystemExit(f'Expected one residual-section marker, found {text.count(marker)}')

adapter_methods = r'''      makeAdapterNavigationItem(element, sectionId, index, metadata = {}) {
        if (!element?.isConnected) return null;
        const stable = this.makeElementStableKey(element, sectionId, index, element);
        const rect = this.rectSnapshot(element);
        const title = this.getElementTitle(element, element) || stable.id || stable.key;

        return {
          key: stable.key,
          id: stable.id,
          type: 'navigation',
          title,
          element,
          activationTarget: element,
          sectionId,
          rect,
          state: {
            visible: this.isRenderedRelaxed(element),
            enabled: !this.isDisabled(element),
            focusable: this.isFocusable(element),
            clickable: this.isClickable(element),
            selectedByJellyfin: this.isSelectedByJellyfin(element, element)
          },
          actions: [],
          metadata: {
            href: this.getHref(element),
            itemIdSource: stable.source,
            entityKey: stable.entityKey || null,
            inViewport: this.rectIntersectsViewport(rect),
            domIndex: index,
            adapter: true,
            ...metadata
          }
        };
      }

      makeAdapterOwnerActions(ownerStable, elements) {
        const result = [];
        const usedKeys = new Set();
        const candidates = this.dedupeInteractiveElements(elements || [])
          .filter(element => this.isActionLayoutAvailable(element));

        for (let index = 0; index < candidates.length; index += 1) {
          const element = candidates[index];
          const action = this.detectQuickActionType(element);
          const title = this.getElementTitle(element, element) || action;
          let key = `${ownerStable.key}:action:${action}`;
          if (usedKeys.has(key)) {
            key = `${key}:${this.hashString([element.id || '', element.className || '', title || '', index].join('|'))}`;
          }
          usedKeys.add(key);
          result.push({
            key,
            action,
            title,
            element,
            rect: this.rectSnapshot(element),
            enabled: !this.isDisabled(element)
          });
        }
        return result;
      }

      scanSectionTitleActionSections(existingSections = []) {
        const represented = new Set();
        for (const section of existingSections || []) {
          for (const item of section?.items || []) {
            if (item?.element) represented.add(item.element);
            if (item?.activationTarget) represented.add(item.activationTarget);
          }
        }

        let candidates = [];
        try { candidates = Array.from(document.querySelectorAll(this.cfg.sectionTitleActionSelector)); } catch (_) {}

        const links = this.dedupeInteractiveElements(candidates).filter(element => {
          if (!element?.isConnected || represented.has(element)) return false;
          if (!this.isRenderedRelaxed(element) || this.isDisabled(element)) return false;
          // A section-title adapter must actually own/contain the visual heading.
          // This prevents arbitrary toolbar links inside the same container from
          // being promoted merely because of their location.
          return !!element.querySelector?.('.sectionTitle, h1, h2, h3') ||
            element.classList?.contains('sectionTitleTextButton');
        });

        return links.map((element, index) => {
          const heading = element.querySelector?.('.sectionTitle, h1, h2, h3');
          const title = this.cleanText(heading?.textContent) || this.getElementTitle(element, element) || `Section link ${index + 1}`;
          const sectionId = `section:title-action:${this.slugify(title)}:${this.hashString(this.getHref(element) || index)}`;
          const item = this.makeAdapterNavigationItem(element, sectionId, 0, {
            adapterSource: 'linked-section-heading'
          });
          if (!item) return null;
          item.title = title;
          return {
            id: sectionId,
            type: 'actions',
            title,
            element,
            rect: this.rectSnapshot(element),
            visible: true,
            order: 0,
            items: [item],
            scroll: {
              horizontal: false,
              vertical: false,
              container: null,
              viewportRect: null,
              virtualized: false,
              mode: 'none',
              contentElement: element
            },
            metadata: {
              source: 'linked-section-heading',
              adapter: true,
              visualRows: 1,
              scrollMode: 'none'
            }
          };
        }).filter(Boolean);
      }

      scanHeroCarouselSections() {
        let containers = [];
        try { containers = Array.from(document.querySelectorAll(this.cfg.heroContainerSelector)); } catch (_) {}
        const sections = [];

        for (const container of containers) {
          if (!this.isRenderedRelaxed(container)) continue;
          const containerRect = this.rectSnapshot(container);
          if (!this.rectIntersectsViewport(containerRect)) continue;

          let slide = null;
          try {
            slide = Array.from(container.querySelectorAll(this.cfg.heroActiveSlideSelector))
              .find(element => this.isRenderedRelaxed(element) && this.rectIntersectsViewport(this.rectSnapshot(element))) || null;
          } catch (_) {}
          if (!slide) continue;

          const itemId = slide.getAttribute('data-item-id') || slide.dataset?.itemId || this.hashString(this.selectorHint(slide));
          const mediaSectionId = `section:hero-media:${this.slugify(itemId)}`;
          const primary = slide.querySelector?.(this.cfg.heroPrimaryActionSelector) || slide;
          const stable = this.makeElementStableKey(slide, mediaSectionId, 0, primary);
          const logoTitle = this.cleanText(slide.querySelector?.('.logo[alt]')?.getAttribute('alt'));
          const title = logoTitle || this.getElementTitle(slide, primary) || 'Featured media';
          const actionElements = Array.from(slide.querySelectorAll(this.cfg.heroChildActionSelector))
            .filter(element => element !== primary);
          const actions = this.makeAdapterOwnerActions(stable, actionElements);
          const rect = this.rectSnapshot(slide);
          const href = this.getHref(primary) || this.getHref(slide);
          const serverId = this.getServerId(slide, primary);

          const mediaItem = {
            key: stable.key,
            id: stable.id,
            type: 'media',
            title,
            element: slide,
            activationTarget: primary,
            sectionId: mediaSectionId,
            rect,
            state: {
              visible: true,
              enabled: !this.isDisabled(primary),
              focusable: this.isFocusable(slide) || this.isFocusable(primary),
              clickable: this.isClickable(primary) || this.isClickable(slide),
              selectedByJellyfin: this.isSelectedByJellyfin(slide, primary)
            },
            actions,
            metadata: {
              href,
              detailsHref: this.buildDetailsHref(stable, href, serverId),
              serverId,
              mediaType: null,
              itemIdSource: stable.source,
              entityKey: stable.entityKey || `hero:${itemId}`,
              inViewport: true,
              domIndex: 0,
              adapter: true,
              adapterSource: 'active-hero-slide'
            }
          };

          sections.push({
            id: mediaSectionId,
            type: 'row',
            title: 'Featured',
            element: slide,
            rect,
            visible: true,
            order: 0,
            items: [mediaItem],
            scroll: {
              horizontal: false,
              vertical: false,
              container: null,
              viewportRect: containerRect,
              virtualized: false,
              mode: 'none',
              contentElement: slide
            },
            metadata: {
              source: 'active-hero-slide',
              adapter: true,
              visualRows: 1,
              scrollMode: 'none'
            }
          });

          const utilityElements = Array.from(container.querySelectorAll(this.cfg.heroUtilityActionSelector))
            .filter(element => this.isRenderedRelaxed(element) && this.rectIntersectsViewport(this.rectSnapshot(element)));
          if (utilityElements.length) {
            const utilitySectionId = `section:hero-utilities:${this.slugify(itemId)}`;
            const utilityItems = utilityElements
              .map((element, index) => this.makeAdapterNavigationItem(element, utilitySectionId, index, {
                adapterSource: 'hero-utility'
              }))
              .filter(Boolean);
            this.ensureUniqueItemKeys(utilityItems);
            if (utilityItems.length) {
              sections.push({
                id: utilitySectionId,
                type: 'actions',
                title: 'Featured controls',
                element: container,
                rect: this.unionItemRects(utilityItems) || containerRect,
                visible: true,
                order: 0,
                items: utilityItems,
                scroll: {
                  horizontal: false,
                  vertical: false,
                  container: null,
                  viewportRect: containerRect,
                  virtualized: false,
                  mode: 'none',
                  contentElement: container
                },
                metadata: {
                  source: 'hero-utility',
                  adapter: true,
                  visualRows: this.countVisualRows(utilityItems.map(item => item.element)),
                  scrollMode: 'none'
                }
              });
            }
          }
        }

        return sections;
      }

      scanProductionAdapterSections(route, existingSections = []) {
        const result = [
          ...this.scanSectionTitleActionSections(existingSections),
          ...this.scanHeroCarouselSections()
        ];
        const usedIds = new Set((existingSections || []).map(section => section?.id).filter(Boolean));
        return result.filter(section => {
          if (!section?.id || usedIds.has(section.id)) return false;
          usedIds.add(section.id);
          return true;
        });
      }

'''
text = text.replace(marker, adapter_methods + marker, 1)

# ---------------------------------------------------------------------------
# 3. Feed those adapters into the legacy-compatible page projection before
# geometry/focus consumers see the model.
# ---------------------------------------------------------------------------
marker = "          if (formSection) {\n            sections.push(\n              formSection\n            );\n          }\n"
insert = marker + "\n          const adapterSections =\n            this.scanProductionAdapterSections(\n              route,\n              sections\n            );\n\n          if (adapterSections.length) {\n            sections.push(...adapterSections);\n          }\n"
if text.count(marker) != 1:
    raise SystemExit(f'Expected one form-section insertion marker, found {text.count(marker)}')
text = text.replace(marker, insert, 1)

# ---------------------------------------------------------------------------
# 4. Tighten cursor:pointer candidate discovery. CSS cursor is inherited, so a
# pointer on a clickable parent previously made every decorative descendant look
# interactive. Keep only the point where pointer intent begins unless the child
# already has independent semantic evidence (which is discovered earlier).
# ---------------------------------------------------------------------------
marker = '      genericCandidateSnapshot(element) {'
if text.count(marker) != 1:
    raise SystemExit(f'Expected one genericCandidateSnapshot marker, found {text.count(marker)}')

helpers = r'''      hasDirectPointerIntent(element, computedStyle = null) {
        if (!element?.isConnected) return false;
        let style = computedStyle;
        try { style = style || getComputedStyle(element); } catch (_) { return false; }
        if (style?.cursor !== 'pointer') return false;

        // Semantic controls do not depend on cursor inference at all. Returning
        // true here only preserves useful diagnostic evidence for them.
        try {
          if (element.matches(this.cfg.genericInteractiveSelector) ||
              element.matches(this.cfg.genericSuspiciousSelector)) return true;
        } catch (_) {}

        const parent = element.parentElement;
        if (!parent?.isConnected) return true;
        try {
          return getComputedStyle(parent).cursor !== 'pointer';
        } catch (_) {
          return true;
        }
      }

      isInactiveCarouselCandidate(element) {
        if (!element?.closest) return false;
        const slide = element.closest('.slide');
        if (!slide) return false;
        const container = slide.closest(this.cfg.heroContainerSelector);
        if (!container) return false;
        return !slide.classList.contains('active');
      }

'''
text = text.replace(marker, helpers + marker, 1)

old = "        if (style?.cursor === 'pointer') evidence.push('cursor-pointer');\n\n        return {\n"
new = "        if (style?.cursor === 'pointer') {\n          evidence.push(\n            this.hasDirectPointerIntent(element, style)\n              ? 'cursor-pointer-direct'\n              : 'cursor-pointer-inherited'\n          );\n        }\n\n        return {\n"
if text.count(old) != 1:
    raise SystemExit(f'Expected one cursor evidence block, found {text.count(old)}')
text = text.replace(old, new, 1)

old = "          confidence: evidence.includes('native-semantic') ? 1 : evidence.some(v => v.startsWith('role:')) ? 0.97 : evidence.includes('tabindex') ? 0.9 : evidence.includes('data-action') ? 0.86 : evidence.includes('cursor-pointer') ? 0.62 : 0.45\n"
new = "          confidence: evidence.includes('native-semantic') ? 1 : evidence.some(v => v.startsWith('role:')) ? 0.97 : evidence.includes('tabindex') ? 0.9 : evidence.includes('data-action') ? 0.86 : evidence.includes('cursor-pointer-direct') ? 0.62 : 0.45\n"
if text.count(old) != 1:
    raise SystemExit(f'Expected one confidence expression, found {text.count(old)}')
text = text.replace(old, new, 1)

old = "            if (style.cursor !== 'pointer') continue;\n            const rect = element.getBoundingClientRect();\n"
new = "            if (style.cursor !== 'pointer') continue;\n            if (!this.hasDirectPointerIntent(element, style)) continue;\n            const rect = element.getBoundingClientRect();\n"
if text.count(old) != 1:
    raise SystemExit(f'Expected one pointer collector block, found {text.count(old)}')
text = text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# 5. Audit inactive carousel content as intentionally unavailable rather than a
# missing model item. The active slide/controls are represented by the adapter.
# ---------------------------------------------------------------------------
old = "          inactiveSurface: 0,\n          scrollChrome: 0,\n"
new = "          inactiveSurface: 0,\n          inactiveCarousel: 0,\n          scrollChrome: 0,\n"
if text.count(old) != 1:
    raise SystemExit(f'Expected one rejected-count block, found {text.count(old)}')
text = text.replace(old, new, 1)

marker = "          // Row scroll-arrow buttons are implementation chrome. Directional\n"
insert = "          if (this.isInactiveCarouselCandidate(element)) {\n            rejected.inactiveCarousel += 1;\n            continue;\n          }\n\n" + marker
if text.count(marker) != 1:
    raise SystemExit(f'Expected one scroll-chrome audit marker, found {text.count(marker)}')
text = text.replace(marker, insert, 1)

path.write_text(text, encoding='utf-8')
