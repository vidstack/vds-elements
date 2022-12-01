import { effect, observable } from 'maverick.js';
import { onConnect } from 'maverick.js/element';
import { dispatchEvent, listenEvent } from 'maverick.js/std';

import { useMediaState } from './store';

const IDLE_EVENTS = ['pointerdown', 'pointermove', 'focus', 'keydown'] as const;

export function useMediaUser(): UseMediaUser {
  let $media = useMediaState(),
    idleTimeout: any,
    delay = 2000,
    triggerEvent: Event | undefined,
    $idle = observable(false),
    $paused = observable(false);

  effect(() => {
    if ($media.paused) $paused.set(true);
  });

  onConnect((host) => {
    for (const eventType of IDLE_EVENTS) {
      listenEvent(host, eventType, handleIdleChange);
    }

    effect(() => {
      if ($paused()) {
        triggerEvent = undefined;
        $idle.set(true);
      }
    });

    effect(() => {
      const idle = $idle();
      window.clearTimeout(idleTimeout);
      dispatchIdleChange(host, idle, triggerEvent);
      triggerEvent = undefined;
    });

    return () => {
      triggerEvent = undefined;
      $idle.set(true);
    };
  });

  function handleIdleChange(event: Event) {
    if ($paused()) return;
    window.clearTimeout(idleTimeout);
    idleTimeout = window.setTimeout(() => {
      triggerEvent = event;
      $idle.set(false);
    }, delay);
  }

  return {
    idle: {
      get idling() {
        return $idle();
      },
      get paused() {
        return $paused();
      },
      set paused(paused) {
        $paused.set(paused);
      },
      get delay() {
        return delay;
      },
      set delay(newDelay) {
        delay = newDelay;
      },
    },
  };
}

export interface UseMediaUser {
  idle: {
    /**
     * Whether the media user is currently idle.
     *
     * @observable
     */
    readonly idling: boolean;
    /**
     * Whether idle state tracking has been paused.
     *
     * @observable
     */
    paused: boolean;
    /**
     * The amount of delay in milliseconds while media playback is progressing without user
     * activity to indicate an idle state.
     *
     * @defaultValue 2000
     */
    delay: number;
  };
}

function dispatchIdleChange(target: EventTarget | null, isIdle: boolean, triggerEvent?: Event) {
  dispatchEvent(target, 'vds-user-idle-change', { detail: isIdle, triggerEvent });
}
