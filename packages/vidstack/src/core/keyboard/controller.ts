import { effect, peek, signal } from 'maverick.js';
import { EventsController, isArray, isKeyboardClick, isString, listenEvent } from 'maverick.js/std';

import { isHTMLMediaElement } from '../../providers/type-check';
import type { MediaContext } from '../api/media-context';
import { MediaPlayerController } from '../api/player-controller';
import type { MediaKeyShortcuts } from './types';

export const MEDIA_KEY_SHORTCUTS: MediaKeyShortcuts = {
  togglePaused: 'k Space',
  toggleMuted: 'm',
  toggleFullscreen: 'f',
  togglePictureInPicture: 'i',
  toggleCaptions: 'c',
  seekBackward: 'j J ArrowLeft',
  seekForward: 'l L ArrowRight',
  volumeUp: 'ArrowUp',
  volumeDown: 'ArrowDown',
  speedUp: '>',
  slowDown: '<',
};

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Meta', 'Ctrl']),
  BUTTON_SELECTORS = 'button, [role="button"]',
  IGNORE_SELECTORS =
    'input, textarea, select, [contenteditable], [role^="menuitem"], [role="timer"]';

export class MediaKeyboardController extends MediaPlayerController {
  #media: MediaContext;

  constructor(media: MediaContext) {
    super();
    this.#media = media;
  }

  protected override onConnect(): void {
    effect(this.#onTargetChange.bind(this));
  }

  #onTargetChange() {
    const { keyDisabled, keyTarget } = this.$props;
    if (keyDisabled()) return;

    const target = keyTarget() === 'player' ? this.el! : document,
      $active = signal(false);

    if (target === this.el) {
      new EventsController(this.el)
        .add('focusin', () => $active.set(true))
        .add('focusout', (event) => {
          if (!this.el!.contains(event.target as Node)) $active.set(false);
        });
    } else {
      if (!peek($active)) $active.set(document.querySelector('[data-media-player]') === this.el);
      listenEvent(document, 'focusin', (event) => {
        const activePlayer = event
          .composedPath()
          .find((el) => el instanceof Element && el.localName === 'media-player');
        if (activePlayer !== undefined) $active.set(this.el === activePlayer);
      });
    }

    effect(() => {
      if (!$active()) return;
      new EventsController(target)
        .add('keyup', this.#onKeyUp.bind(this))
        .add('keydown', this.#onKeyDown.bind(this))
        .add('keydown', this.#onPreventVideoKeys.bind(this), { capture: true });
    });
  }

  #onKeyUp(event: KeyboardEvent) {
    const focusedEl = document.activeElement;

    if (!event.key || !this.$state.canSeek() || focusedEl?.matches(IGNORE_SELECTORS)) {
      return;
    }

    let { method, value } = this.#getMatchingMethod(event);

    if (!isString(value) && !isArray(value)) {
      value?.onKeyUp?.({
        event,
        player: this.#media.player,
        remote: this.#media.remote,
      });

      value?.callback?.(event, this.#media.remote);

      return;
    }

    if (method?.startsWith('seek')) {
      event.preventDefault();
      event.stopPropagation();
      if (this.#timeSlider) {
        this.#forwardTimeKeyboardEvent(event, method === 'seekForward');
        this.#timeSlider = null;
      } else {
        this.#media.remote.seek(this.#seekTotal!, event);
        this.#seekTotal = undefined;
      }
    }

    if (method?.startsWith('volume')) {
      const volumeSlider = this.el!.querySelector('[data-media-volume-slider]');
      volumeSlider?.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: method === 'volumeUp' ? 'Up' : 'Down',
          shiftKey: event.shiftKey,
          trigger: event,
        } as KeyboardEventInit),
      );
    }
  }

  #onKeyDown(event: KeyboardEvent) {
    if (!event.key || MODIFIER_KEYS.has(event.key)) return;

    const focusedEl = document.activeElement;

    if (
      focusedEl?.matches(IGNORE_SELECTORS) ||
      (isKeyboardClick(event) && focusedEl?.matches(BUTTON_SELECTORS))
    ) {
      return;
    }

    let { method, value } = this.#getMatchingMethod(event),
      isNumberPress = !event.metaKey && /^[0-9]$/.test(event.key);

    if (!isString(value) && !isArray(value) && !isNumberPress) {
      value?.onKeyDown?.({
        event,
        player: this.#media.player,
        remote: this.#media.remote,
      });

      value?.callback?.(event, this.#media.remote);

      return;
    }

    if (!method && isNumberPress) {
      event.preventDefault();
      event.stopPropagation();
      this.#media.remote.seek((this.$state.duration() / 10) * Number(event.key), event);
      return;
    }

    if (!method) return;

    event.preventDefault();
    event.stopPropagation();

    switch (method) {
      case 'seekForward':
      case 'seekBackward':
        this.#seeking(event, method, method === 'seekForward');
        break;
      case 'volumeUp':
      case 'volumeDown':
        const volumeSlider = this.el!.querySelector('[data-media-volume-slider]');
        if (volumeSlider) {
          volumeSlider.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: method === 'volumeUp' ? 'Up' : 'Down',
              shiftKey: event.shiftKey,
              trigger: event,
            } as KeyboardEventInit),
          );
        } else {
          const value = event.shiftKey ? 0.1 : 0.05;
          this.#media.remote.changeVolume(
            this.$state.volume() + (method === 'volumeUp' ? +value : -value),
            event,
          );
        }
        break;
      case 'toggleFullscreen':
        this.#media.remote.toggleFullscreen('prefer-media', event);
        break;
      case 'speedUp':
      case 'slowDown':
        const playbackRate = this.$state.playbackRate();
        this.#media.remote.changePlaybackRate(
          Math.max(0.25, Math.min(2, playbackRate + (method === 'speedUp' ? 0.25 : -0.25))),
          event,
        );
        break;
      default:
        this.#media.remote[method]?.(event);
    }

    this.$state.lastKeyboardAction.set({
      action: method,
      event,
    });
  }

  #onPreventVideoKeys(event: KeyboardEvent) {
    if (isHTMLMediaElement(event.target) && this.#getMatchingMethod(event).method) {
      event.preventDefault();
    }
  }

  #getMatchingMethod(event: KeyboardEvent) {
    const keyShortcuts = {
      ...this.$props.keyShortcuts(),
      ...this.#media.ariaKeys,
    };

    const method = Object.keys(keyShortcuts).find((method) => {
      const value = keyShortcuts[method as keyof typeof keyShortcuts],
        keys = isArray(value) ? value.join(' ') : isString(value) ? value : value?.keys;

      const combinations = (isArray(keys) ? keys : keys?.split(' '))?.map((key) =>
        replaceSymbolKeys(key)
          .replace(/Control/g, 'Ctrl')
          .split('+'),
      );

      return combinations?.some((combo) => {
        const modifierKeys = new Set(combo.filter((key) => MODIFIER_KEYS.has(key)));
        if ('<>'.includes(event.key)) {
          modifierKeys.add('Shift');
        }

        // Check whether a modifier key was pressed that's not part of this combination.
        for (const modKey of MODIFIER_KEYS) {
          const modKeyProp = modKey.toLowerCase() + 'Key';
          if (!modifierKeys.has(modKey) && event[modKeyProp]) {
            return false;
          }
        }

        return combo.every((key) => {
          return MODIFIER_KEYS.has(key)
            ? event[key.toLowerCase() + 'Key']
            : event.key === key.replace('Space', ' ');
        });
      });
    });

    return {
      method,
      value: method ? keyShortcuts[method] : null,
    };
  }

  #seekTotal: number | undefined;
  #calcSeekAmount(event: KeyboardEvent, type: string) {
    const seekBy = event.shiftKey ? 10 : 5;
    return (this.#seekTotal = Math.max(
      0,
      Math.min(
        (this.#seekTotal ?? this.$state.currentTime()) +
          (type === 'seekForward' ? +seekBy : -seekBy),
        this.$state.duration(),
      ),
    ));
  }

  #timeSlider: Element | null = null;
  #forwardTimeKeyboardEvent(event: KeyboardEvent, forward: boolean) {
    this.#timeSlider?.dispatchEvent(
      new KeyboardEvent(event.type, {
        key: !forward ? 'Left' : 'Right',
        shiftKey: event.shiftKey,
        trigger: event,
      } as KeyboardEventInit),
    );
  }

  #seeking(event: KeyboardEvent, type: string, forward: boolean) {
    if (!this.$state.canSeek()) return;

    if (!this.#timeSlider) {
      this.#timeSlider = this.el!.querySelector('[data-media-time-slider]');
    }

    if (this.#timeSlider) {
      this.#forwardTimeKeyboardEvent(event, forward);
    } else {
      this.#media.remote.seeking(this.#calcSeekAmount(event, type), event);
    }
  }
}

const SYMBOL_KEY_MAP = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
function replaceSymbolKeys(key: string) {
  return key.replace(/Shift\+(\d)/g, (_, num) => SYMBOL_KEY_MAP[num - 1]);
}
