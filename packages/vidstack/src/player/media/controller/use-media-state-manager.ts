import debounce from 'just-debounce-it';
import throttle from 'just-throttle';
import { computed, effect, ReadSignal, useContext } from 'maverick.js';
import { onAttach } from 'maverick.js/element';
import {
  appendTriggerEvent,
  dispatchEvent,
  DOMEvent,
  listenEvent,
  useDisposalBin,
} from 'maverick.js/std';

import type {
  FullscreenChangeEvent,
  FullscreenErrorEvent,
  FullscreenEventTarget,
} from '../../../foundation/fullscreen/events';
import type * as ME from '../events';
import type { MediaProviderElement } from '../provider/types';
import { MediaProviderContext } from '../provider/use-media-provider';
import type { MediaState } from '../state';
import { softResetMediaState, useInternalMediaState } from '../store';
import type { MediaRequestQueueRecord, UseMediaRequestManager } from './use-media-request-manager';

/**
 * This hook is responsible for listening to and normalizing media events, updating the media
 * state context, and satisfying media requests if a manager arg is provided.
 */
export function useMediaStateManager(
  $target: ReadSignal<FullscreenEventTarget | null>,
  requestManager?: UseMediaRequestManager,
) {
  const $media = useInternalMediaState()!,
    $mediaProvider = useContext(MediaProviderContext),
    disposal = useDisposalBin(),
    requestQueue = requestManager?.requestQueue,
    trackedEvents = new Map<string, ME.MediaEvent>();

  let provider: MediaProviderElement | null = null,
    skipInitialSrcChange = true,
    attachedCanLoadListeners = false,
    attachedLoadStartListeners = false,
    attachedCanPlayListeners = false,
    fireWaitingEvent: { (): void; cancel(): void },
    firingWaiting = false,
    connected = false,
    lastWaitingEvent: Event | undefined,
    $connectedMediaProvider = computed(() => ($target() ? $mediaProvider() : null));

  onAttach(() => {
    $target()?.setAttribute('aria-busy', 'true');
  });

  effect(() => {
    const target = $target();
    // target may be media controller which can also fullscreen.
    if (target && target !== provider) {
      listenEvent(target, 'vds-fullscreen-change', onFullscreenChange);
      listenEvent(target, 'vds-fullscreen-error', onFullscreenError);
    }
  });

  effect(() => {
    provider = $connectedMediaProvider();

    if (provider) {
      listenEvent(provider, 'vds-view-type-change', onViewTypeChange);
      listenEvent(provider, 'vds-can-load', trackEvent(onCanLoad));
      listenEvent(provider, 'vds-sources-change', trackEvent(onSourcesChange));
      listenEvent(provider, 'vds-source-change', trackEvent(onSourceChange));
      connected = true;
    } else if (connected) {
      resetTracking();
      softResetMediaState($media);
      disposal.empty();
      requestQueue?.reset();
      skipInitialSrcChange = true;
      attachedCanLoadListeners = false;
      attachedLoadStartListeners = false;
      attachedCanPlayListeners = false;
      $media.viewType = 'unknown';
      connected = false;
    }
  });

  function resetTracking() {
    stopWaiting();
    requestManager?.$isReplay.set(false);
    requestManager?.$isLooping.set(false);
    firingWaiting = false;
    lastWaitingEvent = undefined;
    trackedEvents.clear();
  }

  // Keep track of dispatched media events so we can use them to build event chains.
  function trackEvent<T extends (event: ME.MediaEvent<any>) => void>(callback: T): T {
    return ((event) => {
      trackedEvents.set(event.type, event);
      callback(event);
    }) as T;
  }

  function attachCanLoadEventListeners() {
    if (attachedCanLoadListeners) return;
    disposal.add(
      listenEvent(provider!, 'vds-media-type-change', onMediaTypeChange),
      listenEvent(provider!, 'vds-load-start', trackEvent(onLoadStart)),
      listenEvent(provider!, 'vds-abort', trackEvent(onAbort)),
      listenEvent(provider!, 'vds-error', trackEvent(onError)),
    );
    attachedCanLoadListeners = true;
  }

  function onMediaTypeChange(event: ME.MediaTypeChangeEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-source-change'));
    $media.mediaType = event.detail;
    $media.live = event.detail.includes('live');
  }

  function onViewTypeChange(event: ME.MediaViewTypeChangeEvent) {
    $media.viewType = event.detail;
  }

  function onCanLoad(event: ME.MediaCanLoadEvent) {
    $media.canLoad = true;
    attachCanLoadEventListeners();
    satisfyMediaRequest('load', event);
  }

  function onSourcesChange(event: ME.MediaSourcesChangeEvent) {
    $media.sources = event.detail;
  }

  function onSourceChange(event: ME.MediaSourceChangeEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-sources-change'));

    $media.source = event.detail;
    $target()?.setAttribute('aria-busy', 'true');

    // Skip resets before first playback to ensure initial properties and track events are kept.
    if (skipInitialSrcChange) {
      skipInitialSrcChange = false;
      return;
    }

    resetTracking();
    softResetMediaState($media);
    trackedEvents.set(event.type, event);
  }

  function attachLoadStartEventListeners() {
    if (attachedLoadStartListeners) return;
    disposal.add(
      listenEvent(provider!, 'vds-loaded-metadata', trackEvent(onLoadedMetadata)),
      listenEvent(provider!, 'vds-loaded-data', trackEvent(onLoadedData)),
      listenEvent(provider!, 'vds-can-play', trackEvent(onCanPlay)),
      listenEvent(provider!, 'vds-can-play-through', onCanPlayThrough),
      listenEvent(provider!, 'vds-duration-change', onDurationChange),
      listenEvent(provider!, 'vds-progress', (e) => onProgress($media, e)),
    );
    attachedLoadStartListeners = true;
  }

  function onAbort(event: ME.MediaAbortEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-source-change'));
    appendTriggerEvent(event, trackedEvents.get('vds-can-load'));
  }

  function onLoadStart(event: ME.MediaLoadStartEvent) {
    attachLoadStartEventListeners();
    appendTriggerEvent(event, trackedEvents.get('vds-source-change'));
    appendTriggerEvent(event, trackedEvents.get('vds-can-load'));
  }

  function onError(event: ME.MediaErrorEvent) {
    $media.error = event.detail;
    appendTriggerEvent(event, trackedEvents.get('vds-abort'));
  }

  function onLoadedMetadata(event: ME.MediaLoadedMetadataEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-load-start'));
  }

  function onLoadedData(event: ME.MediaLoadedDataEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-load-start'));
  }

  function attachCanPlayListeners() {
    if (attachedCanPlayListeners) return;
    disposal.add(
      listenEvent(provider!, 'vds-autoplay', trackEvent(onAutoplay)),
      listenEvent(provider!, 'vds-autoplay-fail', trackEvent(onAutoplayFail)),
      listenEvent(provider!, 'vds-pause', trackEvent(onPause)),
      listenEvent(provider!, 'vds-play', trackEvent(onPlay)),
      listenEvent(provider!, 'vds-play-fail', trackEvent(onPlayFail)),
      listenEvent(provider!, 'vds-playing', trackEvent(onPlaying)),
      listenEvent(provider!, 'vds-duration-change', onDurationChange),
      listenEvent(provider!, 'vds-time-update', onTimeUpdate),
      listenEvent(provider!, 'vds-volume-change', onVolumeChange),
      listenEvent(
        provider!,
        'vds-seeking',
        throttle(trackEvent(onSeeking), 150, { leading: true }),
      ),
      listenEvent(provider!, 'vds-seeked', trackEvent(onSeeked)),
      listenEvent(provider!, 'vds-waiting', onWaiting),
      listenEvent(provider!, 'vds-ended', onEnded),
    );
    attachedCanPlayListeners = true;
  }

  function onCanPlay(event: ME.MediaCanPlayEvent) {
    attachCanPlayListeners();

    // Avoid infinite chain - `hls.js` will not fire `canplay` event.
    if (event.triggerEvent?.type !== 'loadedmetadata') {
      appendTriggerEvent(event, trackedEvents.get('vds-loaded-metadata'));
    }

    $media.canPlay = true;
    $media.duration = event.detail.duration;
    $target()?.setAttribute('aria-busy', 'false');
  }

  function onCanPlayThrough(event: ME.MediaCanPlayThroughEvent) {
    $media.canPlay = true;
    $media.duration = event.detail.duration;
    appendTriggerEvent(event, trackedEvents.get('vds-can-play'));
  }

  function onDurationChange(event: ME.MediaDurationChangeEvent) {
    const duration = event.detail;
    $media.duration = !isNaN(duration) ? duration : 0;
  }

  function onAutoplay(event: ME.MediaAutoplayEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-play'));
    appendTriggerEvent(event, trackedEvents.get('vds-can-play'));
    $media.autoplayError = undefined;
  }

  function onAutoplayFail(event: ME.MediaAutoplayFailEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-play-fail'));
    appendTriggerEvent(event, trackedEvents.get('vds-can-play'));
    $media.autoplayError = event.detail;
    resetTracking();
  }

  function onPlay(event: ME.MediaPlayEvent) {
    if (requestManager?.$isLooping() || !$media.paused) {
      event.stopImmediatePropagation();
      return;
    }

    appendTriggerEvent(event, trackedEvents.get('vds-waiting'));
    satisfyMediaRequest('play', event);

    $media.paused = false;
    $media.autoplayError = undefined;

    if ($media.ended || requestManager?.$isReplay()) {
      requestManager?.$isReplay.set(false);
      $media.ended = false;
      dispatchEvent(provider, 'vds-replay', { triggerEvent: event });
    }
  }

  function onPlayFail(event: ME.MediaPlayFailEvent) {
    appendTriggerEvent(event, trackedEvents.get('vds-play'));
    satisfyMediaRequest('play', event);

    $media.paused = true;
    $media.playing = false;

    resetTracking();
  }

  function onPlaying(event: ME.MediaPlayingEvent) {
    const playEvent = trackedEvents.get('vds-play');

    if (playEvent) {
      appendTriggerEvent(event, trackedEvents.get('vds-waiting'));
      appendTriggerEvent(event, playEvent);
    } else {
      appendTriggerEvent(event, trackedEvents.get('vds-seeked'));
    }

    setTimeout(() => resetTracking(), 0);

    $media.paused = false;
    $media.playing = true;
    $media.seeking = false;
    $media.ended = false;

    if (requestManager?.$isLooping()) {
      event.stopImmediatePropagation();
      requestManager.$isLooping.set(false);
      return;
    }

    if (!$media.started) {
      $media.started = true;
      dispatchEvent(provider, 'vds-started', { triggerEvent: event });
    }
  }

  function onPause(event: ME.MediaPauseEvent) {
    if (requestManager?.$isLooping()) {
      event.stopImmediatePropagation();
      return;
    }

    appendTriggerEvent(event, trackedEvents.get('vds-seeked'));
    satisfyMediaRequest('pause', event);

    $media.paused = true;
    $media.playing = false;
    $media.seeking = false;

    resetTracking();
  }

  function onTimeUpdate(event: ME.MediaTimeUpdateEvent) {
    const { currentTime, played } = event.detail;
    $media.currentTime = currentTime;
    $media.played = played;
    $media.waiting = false;
  }

  function onVolumeChange(event: ME.MediaVolumeChangeEvent) {
    $media.volume = event.detail.volume;
    $media.muted = event.detail.muted || event.detail.volume === 0;
    satisfyMediaRequest('volume', event);
  }

  function onSeeking(event: ME.MediaSeekingEvent) {
    $media.seeking = true;
    $media.currentTime = event.detail;
    satisfyMediaRequest('seeking', event);
  }

  function onSeeked(event: ME.MediaSeekedEvent) {
    if (requestManager?.$isSeekingRequest()) {
      $media.seeking = true;
      event.stopImmediatePropagation();
    } else if ($media.seeking) {
      appendTriggerEvent(event, trackedEvents.get('vds-waiting'));
      appendTriggerEvent(event, trackedEvents.get('vds-seeking'));
      if ($media.paused) stopWaiting();
      $media.seeking = false;
      if (event.detail !== $media.duration) $media.ended = false;
      $media.currentTime = event.detail;
      satisfyMediaRequest('seeked', event);
    }
  }

  fireWaitingEvent = debounce(() => {
    if (!lastWaitingEvent) return;

    firingWaiting = true;

    const event = new DOMEvent('vds-waiting', {
      triggerEvent: lastWaitingEvent,
    }) as ME.MediaWaitingEvent;

    trackedEvents.set('vds-waiting', event);

    $media.waiting = true;
    $media.playing = false;

    provider?.dispatchEvent(event);
    lastWaitingEvent = undefined;
    firingWaiting = false;
  }, 300);

  function onWaiting(event: ME.MediaWaitingEvent) {
    if (firingWaiting || requestManager?.$isSeekingRequest()) return;
    event.stopImmediatePropagation();
    lastWaitingEvent = event;
    fireWaitingEvent();
  }

  function onEnded(event: ME.MediaEndedEvent) {
    if (requestManager?.$isLooping()) {
      event.stopImmediatePropagation();
      return;
    }

    $media.paused = true;
    $media.playing = false;
    $media.seeking = false;
    $media.ended = true;

    resetTracking();
  }

  function stopWaiting() {
    fireWaitingEvent?.cancel();
    $media.waiting = false;
  }

  function onFullscreenChange(event: FullscreenChangeEvent) {
    $media.fullscreen = event.detail;

    // @ts-expect-error - not a media event.
    satisfyMediaRequest('fullscreen', event);

    // Forward event on media provider for any listeners.
    if (event.target !== provider) {
      dispatchEvent(provider, 'vds-fullscreen-change', {
        detail: event.detail,
        triggerEvent: event,
      });
    }
  }

  function onFullscreenError(event: FullscreenErrorEvent) {
    // @ts-expect-error - not a media event.
    satisfyMediaRequest('fullscreen', event);

    // Forward event on media provider for any listeners.
    if (event.target !== provider) {
      dispatchEvent(provider, 'vds-fullscreen-error', {
        detail: event.detail,
        triggerEvent: event,
      });
    }
  }

  function satisfyMediaRequest<T extends keyof MediaRequestQueueRecord>(
    request: T,
    event: ME.MediaEvent,
  ) {
    requestQueue?.serve(request, (requestEvent) => {
      event.requestEvent = requestEvent;
      appendTriggerEvent(event, requestEvent);
    });
  }
}

function onProgress(media: MediaState, event: ME.MediaProgressEvent) {
  const { buffered, seekable } = event.detail;
  const bufferedAmount = buffered.length === 0 ? 0 : buffered.end(buffered.length - 1);
  const seekableAmount = seekable.length === 0 ? 0 : seekable.end(seekable.length - 1);
  media.buffered = buffered;
  media.bufferedAmount = bufferedAmount;
  media.seekable = seekable;
  media.seekableAmount = seekableAmount;
}
