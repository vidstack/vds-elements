import {
  Component,
  effect,
  hasProvidedContext,
  method,
  onDispose,
  peek,
  prop,
  provideContext,
  signal,
  tick,
  useContext,
} from 'maverick.js';
import {
  animationFrameThrottle,
  ariaBool,
  DOMEvent,
  EventsController,
  isKeyboardEvent,
  listenEvent,
  setAttribute,
  setStyle,
} from 'maverick.js/std';

import { useMediaContext, type MediaContext } from '../../../core/api/media-context';
import type { MediaRequestEvents } from '../../../core/api/media-request-events';
import { $ariaBool } from '../../../utils/aria';
import {
  isElementParent,
  isElementVisible,
  isEventInside,
  isHTMLElement,
  onPress,
  setAttributeIfEmpty,
} from '../../../utils/dom';
import { Popper } from '../popper/popper';
import { sliderObserverContext } from '../sliders/slider/slider-context';
import type { MenuButton } from './menu-button';
import { menuContext, type MenuContext, type MenuObserver } from './menu-context';
import { MenuFocusController } from './menu-focus-controller';
import type { MenuItems } from './menu-items';

let idCount = 0;

/**
 * Root menu container used to hold and manage a menu button and menu items. This component is
 * used to display options in a floating panel. They can be nested to create submenus.
 *
 * @attr data-root - Whether this is the root menu items.
 * @attr data-submenu - Whether menu is a submenu.
 * @attr data-open - Whether menu is open.
 * @attr data-keyboard - Whether the menu is opened via keyboard.
 * @attr data-disabled - Whether menu is disabled.
 * @docs {@link https://www.vidstack.io/docs/player/components/menu/menu}
 */
export class Menu extends Component<MenuProps, {}, MenuEvents> {
  static props: MenuProps = {
    showDelay: 0,
  };

  #media!: MediaContext;

  #menuId!: string;
  #menuButtonId!: string;

  #expanded = signal(false);
  #disabled = signal(false);

  #trigger = signal<HTMLElement | null>(null);
  #content = signal<HTMLElement | null>(null);

  #parentMenu?: MenuContext;
  #submenus = new Set<Menu>();
  #menuObserver: MenuObserver | null = null;

  #popper: Popper;
  #focus!: MenuFocusController;

  #isSliderActive = false;
  #isTriggerDisabled = signal(false);
  #transitionCallbacks = new Set<(event: TransitionEvent) => void>();

  /**
   * The menu trigger element.
   */
  @prop
  get triggerElement() {
    return this.#trigger();
  }

  /**
   * The menu items element.
   */
  @prop
  get contentElement() {
    return this.#content();
  }

  /**
   * Whether this menu is the child of another menu that contains it.
   */
  @prop
  get isSubmenu() {
    return !!this.#parentMenu;
  }

  constructor() {
    super();

    const { showDelay } = this.$props;
    this.#popper = new Popper({
      trigger: this.#trigger,
      content: this.#content,
      showDelay: showDelay,
      listen: (trigger, show, hide) => {
        onPress(trigger, (event) => {
          if (this.#expanded()) hide(event);
          else show(event);
        });

        const closeTarget = this.#getCloseTarget();
        if (closeTarget) {
          onPress(closeTarget, (event) => {
            event.stopPropagation();
            hide(event);
          });
        }
      },
      onChange: this.#onExpandedChange.bind(this),
    });
  }

  protected override onSetup(): void {
    this.#media = useMediaContext();

    const currentIdCount = ++idCount;
    this.#menuId = `media-menu-${currentIdCount}`;
    this.#menuButtonId = `media-menu-button-${currentIdCount}`;

    this.#focus = new MenuFocusController({
      closeMenu: this.close.bind(this),
    });

    if (hasProvidedContext(menuContext)) {
      this.#parentMenu = useContext(menuContext);
    }

    this.#observeSliders();

    this.setAttributes({
      'data-open': this.#expanded,
      'data-root': !this.isSubmenu,
      'data-submenu': this.isSubmenu,
      'data-disabled': this.#isDisabled.bind(this),
    });

    provideContext(menuContext, {
      button: this.#trigger,
      content: this.#content,
      expanded: this.#expanded,
      hint: signal(''),
      submenu: !!this.#parentMenu,
      disable: this.#disable.bind(this),
      attachMenuButton: this.#attachMenuButton.bind(this),
      attachMenuItems: this.#attachMenuItems.bind(this),
      attachObserver: this.#attachObserver.bind(this),
      disableMenuButton: this.#disableMenuButton.bind(this),
      addSubmenu: this.#addSubmenu.bind(this),
      onTransitionEvent: (callback) => {
        this.#transitionCallbacks.add(callback);
        onDispose(() => {
          this.#transitionCallbacks.delete(callback);
        });
      },
    });
  }

  protected override onAttach(el: HTMLElement) {
    el.style.setProperty('display', 'contents');
  }

  protected override onConnect(el: HTMLElement) {
    effect(this.#watchExpanded.bind(this));
    if (this.isSubmenu) {
      this.#parentMenu?.addSubmenu(this);
    }
  }

  protected override onDestroy() {
    this.#trigger.set(null);
    this.#content.set(null);
    this.#menuObserver = null;
    this.#transitionCallbacks.clear();
  }

  #observeSliders() {
    let sliderActiveTimer = -1,
      parentSliderObserver = hasProvidedContext(sliderObserverContext)
        ? useContext(sliderObserverContext)
        : null;

    provideContext(sliderObserverContext, {
      onDragStart: () => {
        parentSliderObserver?.onDragStart?.();
        window.clearTimeout(sliderActiveTimer);
        sliderActiveTimer = -1;
        this.#isSliderActive = true;
      },
      onDragEnd: () => {
        parentSliderObserver?.onDragEnd?.();
        sliderActiveTimer = window.setTimeout(() => {
          this.#isSliderActive = false;
          sliderActiveTimer = -1;
        }, 300);
      },
    });
  }

  #watchExpanded() {
    const expanded = this.#isExpanded();

    if (!this.isSubmenu) this.#onResize();
    this.#updateMenuItemsHidden(expanded);

    if (!expanded) return;

    effect(() => {
      const { height } = this.#media.$state,
        content = this.#content();

      content && setStyle(content, '--player-height', height() + 'px');
    });

    this.#focus.listen();

    this.listen('pointerup', this.#onPointerUp.bind(this));
    listenEvent(window, 'pointerup', this.#onWindowPointerUp.bind(this));
  }

  #attachMenuButton(button: MenuButton) {
    const el = button.el!,
      isMenuItem = this.isSubmenu,
      isARIADisabled = $ariaBool(this.#isDisabled.bind(this));

    setAttributeIfEmpty(el, 'tabindex', isMenuItem ? '-1' : '0');
    setAttributeIfEmpty(el, 'role', isMenuItem ? 'menuitem' : 'button');

    setAttribute(el, 'id', this.#menuButtonId);

    setAttribute(el, 'aria-haspopup', 'menu');
    setAttribute(el, 'aria-expanded', 'false');

    setAttribute(el, 'data-root', !this.isSubmenu);
    setAttribute(el, 'data-submenu', this.isSubmenu);

    const watchAttrs = () => {
      setAttribute(el, 'data-open', this.#expanded());
      setAttribute(el, 'aria-disabled', isARIADisabled());
    };

    if (__SERVER__) watchAttrs();
    else effect(watchAttrs);

    this.#trigger.set(el);
    onDispose(() => {
      this.#trigger.set(null);
    });
  }

  #attachMenuItems(items: MenuItems) {
    const el = items.el!;
    el.style.setProperty('display', 'none');

    setAttribute(el, 'id', this.#menuId);
    setAttributeIfEmpty(el, 'role', 'menu');
    setAttributeIfEmpty(el, 'tabindex', '-1');

    setAttribute(el, 'data-root', !this.isSubmenu);
    setAttribute(el, 'data-submenu', this.isSubmenu);

    this.#content.set(el);
    onDispose(() => this.#content.set(null));

    const watchAttrs = () => setAttribute(el, 'data-open', this.#expanded());
    if (__SERVER__) watchAttrs();
    else effect(watchAttrs);

    this.#focus.attachMenu(el);
    this.#updateMenuItemsHidden(false);

    const onTransition = this.#onResizeTransition.bind(this);

    if (!this.isSubmenu) {
      items.listen('transitionstart', onTransition);
      items.listen('transitionend', onTransition);
      items.listen('animationend', this.#onResize);
      items.listen('vds-menu-resize' as any, this.#onResize);
    } else {
      this.#parentMenu?.onTransitionEvent(onTransition);
    }
  }

  #attachObserver(observer: MenuObserver) {
    this.#menuObserver = observer;
  }

  #updateMenuItemsHidden(expanded: boolean) {
    const content = peek(this.#content);
    if (content) setAttribute(content, 'aria-hidden', ariaBool(!expanded));
  }

  #disableMenuButton(disabled: boolean) {
    this.#isTriggerDisabled.set(disabled);
  }

  #wasKeyboardExpand = false;
  #onExpandedChange(isExpanded: boolean, event?: Event) {
    this.#wasKeyboardExpand = isKeyboardEvent(event);

    event?.stopPropagation();

    if (this.#expanded() === isExpanded) return;

    if (this.#isDisabled()) {
      if (isExpanded) this.#popper.hide(event);
      return;
    }

    this.el?.dispatchEvent(
      new Event('vds-menu-resize', {
        bubbles: true,
        composed: true,
      }),
    );

    const trigger = this.#trigger(),
      content = this.#content();

    if (trigger) {
      setAttribute(trigger, 'aria-controls', isExpanded && this.#menuId);
      setAttribute(trigger, 'aria-expanded', ariaBool(isExpanded));
    }

    if (content) setAttribute(content, 'aria-labelledby', isExpanded && this.#menuButtonId);

    this.#expanded.set(isExpanded);
    this.#toggleMediaControls(event);
    tick();

    if (this.#wasKeyboardExpand) {
      if (isExpanded) content?.focus();
      else trigger?.focus();

      for (const el of [this.el, content]) {
        el && el.setAttribute('data-keyboard', '');
      }
    } else {
      for (const el of [this.el, content]) {
        el && el.removeAttribute('data-keyboard');
      }
    }

    this.dispatch(isExpanded ? 'open' : 'close', { trigger: event });

    if (isExpanded) {
      if (!this.isSubmenu && this.#media.activeMenu !== this) {
        this.#media.activeMenu?.close(event);
        this.#media.activeMenu = this;
      }

      this.#menuObserver?.onOpen?.(event);
    } else {
      if (this.isSubmenu) {
        for (const el of this.#submenus) el.close(event);
      } else {
        this.#media.activeMenu = null;
      }

      this.#menuObserver?.onClose?.(event);
    }

    if (isExpanded) {
      requestAnimationFrame(this.#updateFocus.bind(this));
    }
  }

  #updateFocus() {
    if (this.#isTransitionActive || this.#isSubmenuOpen) return;

    this.#focus.update();

    requestAnimationFrame(() => {
      if (this.#wasKeyboardExpand) {
        this.#focus.focusActive();
      } else {
        this.#focus.scroll();
      }
    });
  }

  #isExpanded() {
    return !this.#isDisabled() && this.#expanded();
  }

  #isDisabled() {
    return this.#disabled() || this.#isTriggerDisabled();
  }

  #disable(disabled: boolean) {
    this.#disabled.set(disabled);
  }

  #onPointerUp(event: PointerEvent) {
    const content = this.#content();

    if (this.#isSliderActive || (content && isEventInside(content, event))) {
      return;
    }

    // Prevent it bubbling up to window so we can determine when to close dialog.
    event.stopPropagation();
  }

  #onWindowPointerUp(event: Event) {
    const content = this.#content();

    if (this.#isSliderActive || (content && isEventInside(content, event))) {
      return;
    }

    this.close(event);
  }

  #getCloseTarget() {
    const target = this.el?.querySelector('[data-part="close-target"]');
    return this.el &&
      target &&
      isElementParent(this.el, target, (node) => node.getAttribute('role') === 'menu')
      ? target
      : null;
  }

  #toggleMediaControls(trigger?: Event) {
    if (this.isSubmenu) return;
    if (this.#expanded()) this.#media.remote.pauseControls(trigger);
    else this.#media.remote.resumeControls(trigger);
  }

  #addSubmenu(menu: Menu) {
    this.#submenus.add(menu);

    new EventsController(menu)
      .add('open', this.#onSubmenuOpenBind)
      .add('close', this.#onSubmenuCloseBind);

    onDispose(this.#removeSubmenuBind);
  }

  #removeSubmenuBind = this.#removeSubmenu.bind(this);
  #removeSubmenu(menu: Menu) {
    this.#submenus.delete(menu);
  }

  #isSubmenuOpen = false;
  #onSubmenuOpenBind = this.#onSubmenuOpen.bind(this);
  #onSubmenuOpen(event: MenuOpenEvent) {
    this.#isSubmenuOpen = true;

    const content = this.#content();

    if (this.isSubmenu) {
      this.triggerElement?.setAttribute('aria-hidden', 'true');
    }

    for (const target of this.#submenus) {
      if (target !== event.target) {
        for (const el of [target.el, target.triggerElement]) {
          el?.setAttribute('aria-hidden', 'true');
        }
      }
    }

    if (content) {
      const el = event.target.el;
      for (const child of content.children) {
        if (child.contains(el)) {
          child.setAttribute('data-open', '');
        } else if (child !== el) {
          child.setAttribute('data-hidden', '');
        }
      }
    }
  }

  #onSubmenuCloseBind = this.#onSubmenuClose.bind(this);
  #onSubmenuClose(event: MenuCloseEvent) {
    this.#isSubmenuOpen = false;

    const content = this.#content();

    if (this.isSubmenu) {
      this.triggerElement?.setAttribute('aria-hidden', 'false');
    }

    for (const target of this.#submenus) {
      for (const el of [target.el, target.triggerElement]) {
        el?.setAttribute('aria-hidden', 'false');
      }
    }

    if (content) {
      for (const child of content.children) {
        child.removeAttribute('data-open');
        child.removeAttribute('data-hidden');
      }
    }
  }

  #onResize = animationFrameThrottle(() => {
    const content = peek(this.#content);
    if (!content || __SERVER__) return;
    // Disable resize for flatSettingsMenu because it works wrong with DefaultFontMenu()
    if (content.getAttribute('flat') == 'true') return;

    let height = 0,
      styles = getComputedStyle(content),
      children = [...content.children];

    for (const prop of ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']) {
      height += parseFloat(styles[prop]) || 0;
    }

    for (const child of children) {
      if (isHTMLElement(child) && child.style.display === 'contents') {
        children.push(...child.children);
      } else if (child.nodeType === 3) {
        height += parseFloat(getComputedStyle(child).fontSize);
      } else if (isHTMLElement(child)) {
        if (!isElementVisible(child)) continue;
        const style = getComputedStyle(child);
        height +=
          child.offsetHeight +
          (parseFloat(style.marginTop) || 0) +
          (parseFloat(style.marginBottom) || 0);
      }
    }

    setStyle(content, '--menu-height', height + 'px');
  });

  #isTransitionActive = false;
  #onResizeTransition(event: TransitionEvent) {
    const content = this.#content();

    if (content && event.propertyName === 'height') {
      this.#isTransitionActive = event.type === 'transitionstart';
      setAttribute(content, 'data-transition', this.#isTransitionActive ? 'height' : null);
      if (this.#expanded()) this.#updateFocus();
    }

    for (const callback of this.#transitionCallbacks) callback(event);
  }

  /**
   * Open this menu. The first menu item will be focused if a `KeyboardEvent` trigger is provided
   */
  @method
  open(trigger?: Event) {
    if (peek(this.#expanded)) return;
    this.#popper.show(trigger);
    tick();
  }

  /**
   * Close this menu. The menu button that controls this menu will be focused if a `KeyboardEvent`
   * trigger is provided
   */
  @method
  close(trigger?: Event) {
    if (!peek(this.#expanded)) return;
    this.#popper.hide(trigger);
    tick();
  }
}

export interface MenuProps {
  /**
   * The amount of time in milliseconds to wait before showing the menu.
   */
  showDelay: number;
}

export interface MenuEvents
  extends Pick<
    MediaRequestEvents,
    'media-pause-controls-request' | 'media-resume-controls-request'
  > {
  open: MenuOpenEvent;
  close: MenuCloseEvent;
}

/**
 * Fired when the menu is opened.
 */
export interface MenuOpenEvent extends DOMEvent<void> {
  target: Menu;
}

/**
 * Fired when the menu is closed.
 */
export interface MenuCloseEvent extends DOMEvent<void> {
  target: Menu;
}
