import { effect, peek, signal, Signals } from 'maverick.js';
import { createEvent, isUndefined, keysOf, listenEvent, noop } from 'maverick.js/std';

import {
  createFullscreenAdapter,
  FullscreenAdapter,
} from '../../../foundation/fullscreen/fullscreen';
import {
  createScreenOrientationAdapter,
  ScreenOrientationAdapter,
} from '../../../foundation/orientation/screen-orientation';
import { Queue } from '../../../foundation/queue/queue';
import { coerceToError } from '../../../utils/error';
import type { MediaContext } from '../context';
import type * as RE from '../request-events';
import { createMediaUser, Mediauser } from '../user';
import type { MediaStateManager } from './state-manager';
import type { MediaControllerProps } from './types';

/**
 * This hook is responsible for listening to media request events and calling the appropriate
 * actions on the current media provider. Do note that we queue actions until a media provider
 * has connected.
 */
export function createMediaRequestManager(
  { $player, $store, $provider, logger }: MediaContext,
  handler: MediaStateManager,
  requests: MediaRequestContext,
  $props: Signals<MediaControllerProps>,
): MediaRequestManager {
  const user = createMediaUser($player, $store),
    orientation = createScreenOrientationAdapter($player),
    fullscreen = createFullscreenAdapter($player);

  if (__SERVER__) {
    return {
      _user: user,
      _orientation: orientation,
      _play: noop as () => Promise<void>,
      _pause: noop as () => Promise<void>,
      _enterFullscreen: noop as () => Promise<void>,
      _exitFullscreen: noop as () => Promise<void>,
    };
  }

  effect(() => {
    user.idle.delay = $props.$userIdleDelay();
  });

  effect(() => {
    const supported = fullscreen.supported || $provider()?.fullscreen?.supported || false;
    if ($store.canLoad && peek(() => $store.canFullscreen) === supported) return;
    $store.canFullscreen = supported;
  });

  function logRequest(event: Event) {
    if (__DEV__) {
      logger?.infoGroup(`📬 received \`${event.type}\``).labelledLog('Request', event).dispatch();
    }
  }

  const eventHandlers = {
    'media-start-loading': onStartLoading,
    'media-mute-request': onMuteRequest,
    'media-unmute-request': onUnmuteRequest,
    'media-play-request': onPlayRequest,
    'media-pause-request': onPauseRequest,
    'media-seeking-request': onSeekingRequest,
    'media-seek-request': onSeekRequest,
    'media-volume-change-request': onVolumeChangeRequest,
    'media-enter-fullscreen-request': onEnterFullscreenRequest,
    'media-exit-fullscreen-request': onExitFullscreenRequest,
    'media-resume-user-idle-request': onResumeIdlingRequest,
    'media-pause-user-idle-request': onPauseIdlingRequest,
    'media-show-poster-request': onShowPosterRequest,
    'media-hide-poster-request': onHidePosterRequest,
    'media-loop-request': onLoopRequest,
  };

  effect(() => {
    const target = $player();
    if (!target) return;
    for (const eventType of keysOf(eventHandlers)) {
      const handler = eventHandlers[eventType];
      listenEvent(target, eventType, (event) => {
        event.stopPropagation();
        if (__DEV__) logRequest(event);
        if (peek($provider)) handler(event as any);
      });
    }
  });

  function onStartLoading(event: RE.MediaStartLoadingRequestEvent) {
    if ($store.canLoad) return;
    requests._queue._enqueue('load', event);
    handler.handle(createEvent($player, 'can-load'));
  }

  function onMuteRequest(event: RE.MediaMuteRequestEvent) {
    if ($store.muted) return;
    requests._queue._enqueue('volume', event);
    $provider()!.muted = true;
  }

  function onUnmuteRequest(event: RE.MediaUnmuteRequestEvent) {
    if (!$store.muted) return;
    requests._queue._enqueue('volume', event);
    $provider()!.muted = false;
    if ($store.volume === 0) {
      requests._queue._enqueue('volume', event);
      $provider()!.volume = 0.25;
    }
  }

  async function onPlayRequest(event: RE.MediaPlayRequestEvent) {
    if (!$store.paused) return;
    try {
      requests._queue._enqueue('play', event);
      await $provider()!.play();
    } catch (e) {
      const errorEvent = createEvent($player, 'play-fail', { detail: coerceToError(e) });
      handler.handle(errorEvent);
    }
  }

  async function onPauseRequest(event: RE.MediaPauseRequestEvent) {
    if ($store.paused) return;
    try {
      requests._queue._enqueue('pause', event);
      await $provider()!.pause();
    } catch (e) {
      requests._queue._delete('pause');
      if (__DEV__) logger?.error('pause-fail', e);
    }
  }

  function onSeekingRequest(event: RE.MediaSeekingRequestEvent) {
    requests._queue._enqueue('seeking', event);
    $store.seeking = true;
    requests._$isSeeking.set(true);
  }

  function onSeekRequest(event: RE.MediaSeekRequestEvent) {
    if ($store.ended) requests._$isReplay.set(true);
    requests._queue._enqueue('seeked', event);
    requests._$isSeeking.set(false);
    // Span to end if close enough.
    $provider()!.currentTime =
      $store.duration - event.detail < 0.25 ? $store.duration : event.detail;
  }

  function onVolumeChangeRequest(event: RE.MediaVolumeChangeRequestEvent) {
    const volume = event.detail;
    if ($store.volume === volume) return;
    requests._queue._enqueue('volume', event);
    $provider()!.volume = volume;
    if (volume > 0 && $store.muted) {
      requests._queue._enqueue('volume', event);
      $provider()!.muted = false;
    }
  }

  async function onEnterFullscreenRequest(event: RE.MediaEnterFullscreenRequestEvent) {
    try {
      requests._queue._enqueue('fullscreen', event);
      await enterFullscreen(event.detail);
    } catch (e) {
      const errorEvent = createEvent($player, 'fullscreen-error', { detail: coerceToError(e) });
      handler.handle(errorEvent);
    }
  }

  async function onExitFullscreenRequest(event: RE.MediaExitFullscreenRequestEvent) {
    try {
      requests._queue._enqueue('fullscreen', event);
      await exitFullscreen(event.detail);
    } catch (e) {
      const errorEvent = createEvent($player, 'fullscreen-error', { detail: coerceToError(e) });
      handler.handle(errorEvent);
    }
  }

  function onResumeIdlingRequest(event: RE.MediaResumeUserIdleRequestEvent) {
    requests._queue._enqueue('userIdle', event);
    user.idle.paused = false;
  }

  function onPauseIdlingRequest(event: RE.MediaPauseUserIdleRequestEvent) {
    requests._queue._enqueue('userIdle', event);
    user.idle.paused = true;
  }

  function onShowPosterRequest(event: RE.MediaShowPosterRequestEvent) {
    $store.canLoadPoster = true;
  }

  function onHidePosterRequest(event: RE.MediaHidePosterRequestEvent) {
    $store.canLoadPoster = false;
  }

  function onLoopRequest(event: RE.MediaLoopRequestEvent) {
    window.requestAnimationFrame(async () => {
      try {
        requests._$isLooping.set(true);
        requests._$isReplay.set(true);
        await play();
      } catch (e) {
        requests._$isLooping.set(false);
        requests._$isReplay.set(false);
      }
    });
  }

  function throwIfFullscreenNotSupported(
    target: RE.MediaFullscreenRequestTarget,
    fullscreen?: FullscreenAdapter,
  ) {
    if (fullscreen?.supported) return;
    throw Error(
      __DEV__
        ? `[vidstack] fullscreen is not currently available on target \`${target}\``
        : '[vidstack] no fullscreen support',
    );
  }

  async function play() {
    if (!$store.paused) return;
    try {
      const provider = peek($provider);
      if (!provider || !$player()?.state.canPlay) throwIfNotReadyForPlayback();
      if ($store.ended || $store.currentTime === 0) provider!.currentTime = 0;
      return provider!.play();
    } catch (error) {
      const errorEvent = createEvent($player, 'play-fail', { detail: coerceToError(error) });
      errorEvent.autoplay = $store.attemptingAutoplay;
      handler.handle(errorEvent);
      throw error;
    }
  }

  async function pause() {
    if ($store.paused) return;
    const provider = peek($provider);
    if (!provider || !$player()?.state.canPlay) throwIfNotReadyForPlayback();
    return provider!.pause();
  }

  async function enterFullscreen(target: RE.MediaFullscreenRequestTarget = 'prefer-media') {
    const provider = peek($provider),
      fs =
        (target === 'prefer-media' && fullscreen.supported) || target === 'media'
          ? fullscreen
          : provider?.fullscreen;

    throwIfFullscreenNotSupported(target, fs);
    if (fs!.active) return;

    // TODO: Check if PiP is active, if so make sure to exit.
    const lockType = peek($props.$fullscreenOrientation);
    if (orientation.supported && !isUndefined(lockType)) await orientation.lock(lockType);

    return fs!.enter();
  }

  async function exitFullscreen(target: RE.MediaFullscreenRequestTarget = 'prefer-media') {
    const provider = peek($provider),
      fs =
        (target === 'prefer-media' && fullscreen.supported) || target === 'media'
          ? fullscreen
          : provider?.fullscreen;

    throwIfFullscreenNotSupported(target, fs);
    if (!fs!.active) return;

    if (orientation.locked) await orientation.unlock();
    // TODO: If PiP was active put it back _after_ exiting.

    return fs!.exit();
  }

  return {
    _user: user,
    _orientation: orientation,
    _play: play,
    _pause: pause,
    _enterFullscreen: enterFullscreen,
    _exitFullscreen: exitFullscreen,
  };
}

function throwIfNotReadyForPlayback() {
  throw Error(
    __DEV__
      ? `[vidstack] media is not ready - wait for \`can-play\` event.`
      : '[vidstack] media not ready',
  );
}

export class MediaRequestContext {
  _queue = new Queue<MediaRequestQueueRecord>();
  _$isSeeking = signal(false);
  _$isLooping = signal(false);
  _$isReplay = signal(false);
}

export interface MediaRequestQueueRecord {
  load: RE.MediaStartLoadingRequestEvent;
  play: RE.MediaPlayRequestEvent;
  pause: RE.MediaPauseRequestEvent;
  volume: RE.MediaVolumeChangeRequestEvent | RE.MediaMuteRequestEvent | RE.MediaUnmuteRequestEvent;
  fullscreen: RE.MediaEnterFullscreenRequestEvent | RE.MediaExitFullscreenRequestEvent;
  seeked: RE.MediaSeekRequestEvent;
  seeking: RE.MediaSeekingRequestEvent;
  userIdle: RE.MediaResumeUserIdleRequestEvent | RE.MediaPauseUserIdleRequestEvent;
}

export interface MediaRequestManager {
  _user: Mediauser;
  _orientation: ScreenOrientationAdapter;
  _play(): Promise<void>;
  _pause(): Promise<void>;
  _enterFullscreen(target?: RE.MediaFullscreenRequestTarget): Promise<void>;
  _exitFullscreen(target?: RE.MediaFullscreenRequestTarget): Promise<void>;
}