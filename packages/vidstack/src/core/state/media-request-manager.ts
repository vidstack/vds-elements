import { effect, peek, type ReadSignal } from 'maverick.js';
import { EventsController, isUndefined } from 'maverick.js/std';

import {
  FullscreenController,
  type FullscreenAdapter,
} from '../../foundation/fullscreen/controller';
import { ScreenOrientationController } from '../../foundation/orientation/controller';
import { Queue } from '../../foundation/queue/queue';
import { RequestQueue } from '../../foundation/queue/request-queue';
import type { GoogleCastPromptError } from '../../providers/google-cast/events';
import type { GoogleCastLoader } from '../../providers/google-cast/loader';
import type { MediaProviderAdapter } from '../../providers/types';
import { coerceToError } from '../../utils/error';
import { canGoogleCastSrc } from '../../utils/mime';
import { preconnect } from '../../utils/network';
import { IS_CHROME, IS_IOS } from '../../utils/support';
import type { MediaContext } from '../api/media-context';
import type { MediaFullscreenChangeEvent } from '../api/media-events';
import * as RE from '../api/media-request-events';
import { MediaPlayerController } from '../api/player-controller';
import { boundTime } from '../api/player-state';
import { MediaControls } from '../controls';
import type { MediaStateManager } from './media-state-manager';
import { prefersReducedMotion } from '../../utils/aria';

/**
 * This class is responsible for listening to media request events and calling the appropriate
 * actions on the current media provider. Do note, actions are queued until a media provider
 * has connected.
 */
export class MediaRequestManager extends MediaPlayerController implements MediaRequestHandler {
  #stateMgr: MediaStateManager;
  #request: MediaRequestContext;
  #media: MediaContext;

  readonly controls: MediaControls;
  readonly #fullscreen: FullscreenController;
  readonly #orientation: ScreenOrientationController;

  readonly #$provider: ReadSignal<MediaProviderAdapter | null>;
  readonly #providerQueue = new RequestQueue();

  constructor(stateMgr: MediaStateManager, request: MediaRequestContext, media: MediaContext) {
    super();
    this.#stateMgr = stateMgr;
    this.#request = request;
    this.#media = media;
    this.#$provider = media.$provider;
    this.controls = new MediaControls();
    this.#fullscreen = new FullscreenController();
    this.#orientation = new ScreenOrientationController();
  }

  protected override onAttach(): void {
    this.listen('fullscreen-change', this.#onFullscreenChange.bind(this));
  }

  protected override onConnect(el: HTMLElement) {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(this)),
      events = new EventsController(el as unknown as MediaPlayerController),
      handleRequest = this.#handleRequest.bind(this);

    for (const name of names) {
      if (name.startsWith('media-')) {
        events.add(name as keyof RE.MediaRequestEvents, handleRequest);
      }
    }

    this.#attachLoadPlayListener();

    effect(this.#watchProvider.bind(this));
    effect(this.#watchControlsDelayChange.bind(this));
    effect(this.#watchAudioGainSupport.bind(this));
    effect(this.#watchAirPlaySupport.bind(this));
    effect(this.#watchGoogleCastSupport.bind(this));
    effect(this.#watchFullscreenSupport.bind(this));
    effect(this.#watchPiPSupport.bind(this));
  }

  protected override onDestroy(): void {
    try {
      const destroyEvent = this.createEvent('destroy'),
        { pictureInPicture, fullscreen } = this.$state;

      if (fullscreen()) this.exitFullscreen('prefer-media', destroyEvent);

      if (pictureInPicture()) this.exitPictureInPicture(destroyEvent);
    } catch (e) {
      // no-op
    }

    this.#providerQueue.reset();
  }

  #attachLoadPlayListener() {
    const { load } = this.$props,
      { canLoad } = this.$state;

    if (load() !== 'play' || canLoad()) return;

    const off = this.listen('media-play-request', (event) => {
      this.#handleLoadPlayStrategy(event);
      off();
    });
  }

  #watchProvider() {
    const provider = this.#$provider(),
      canPlay = this.$state.canPlay();

    if (provider && canPlay) {
      this.#providerQueue.start();
    }

    return () => {
      this.#providerQueue.stop();
    };
  }

  #handleRequest(event: Event) {
    event.stopPropagation();
    if (event.defaultPrevented) return;

    if (__DEV__) {
      this.#media.logger
        ?.infoGroup(`📬 received \`${event.type}\``)
        .labelledLog('Request', event)
        .dispatch();
    }

    if (!this[event.type]) return;

    if (peek(this.#$provider)) {
      this[event.type](event);
    } else {
      this.#providerQueue.enqueue(event.type, () => {
        if (peek(this.#$provider)) this[event.type](event);
      });
    }
  }

  async play(trigger?: Event) {
    if (__SERVER__) return;

    const { canPlay, paused, autoPlaying } = this.$state;

    if (this.#handleLoadPlayStrategy(trigger)) return;

    if (!peek(paused)) return;

    if (trigger) this.#request.queue.enqueue('media-play-request', trigger);

    const isAutoPlaying = peek(autoPlaying);

    try {
      const provider = peek(this.#$provider);
      throwIfNotReadyForPlayback(provider, peek(canPlay));
      throwIfAutoplayingWithReducedMotion(isAutoPlaying);
      return await provider!.play();
    } catch (error) {
      if (__DEV__) this.#logError('play request failed', error, trigger);

      const errorEvent = this.createEvent('play-fail', {
        detail: coerceToError(error),
        trigger,
      });

      errorEvent.autoPlay = isAutoPlaying;

      this.#stateMgr.handle(errorEvent);
      throw error;
    }
  }

  #handleLoadPlayStrategy(trigger?: Event) {
    const { load } = this.$props,
      { canLoad } = this.$state;

    if (load() === 'play' && !canLoad()) {
      const event = this.createEvent('media-start-loading', { trigger });
      this.dispatchEvent(event);

      this.#providerQueue.enqueue('media-play-request', async () => {
        try {
          await this.play(event);
        } catch (error) {
          // no-op
        }
      });

      return true;
    }

    return false;
  }

  async pause(trigger?: Event) {
    if (__SERVER__) return;

    const { canPlay, paused } = this.$state;

    if (peek(paused)) return;

    if (trigger) {
      this.#request.queue.enqueue('media-pause-request', trigger);
    }

    try {
      const provider = peek(this.#$provider);
      throwIfNotReadyForPlayback(provider, peek(canPlay));
      return await provider!.pause();
    } catch (error) {
      this.#request.queue.delete('media-pause-request');

      if (__DEV__) {
        this.#logError('pause request failed', error, trigger);
      }

      throw error;
    }
  }

  setAudioGain(gain: number, trigger?: Event) {
    const { audioGain, canSetAudioGain } = this.$state;

    if (audioGain() === gain) return;

    const provider = this.#$provider();

    if (!provider?.audioGain || !canSetAudioGain()) {
      throw Error('[vidstack] audio gain api not available');
    }

    if (trigger) {
      this.#request.queue.enqueue('media-audio-gain-change-request', trigger);
    }

    provider.audioGain.setGain(gain);
  }

  seekToLiveEdge(trigger?: Event) {
    if (__SERVER__) return;

    const { canPlay, live, liveEdge, canSeek, liveSyncPosition, seekableEnd, userBehindLiveEdge } =
      this.$state;

    userBehindLiveEdge.set(false);

    if (peek(() => !live() || liveEdge() || !canSeek())) return;

    const provider = peek(this.#$provider);
    throwIfNotReadyForPlayback(provider, peek(canPlay));

    if (trigger) this.#request.queue.enqueue('media-seek-request', trigger);

    const end = seekableEnd() - 2;
    provider!.setCurrentTime(Math.min(end, liveSyncPosition() ?? end));
  }

  #wasPIPActive = false;
  async enterFullscreen(target: RE.MediaFullscreenRequestTarget = 'prefer-media', trigger?: Event) {
    if (__SERVER__) return;

    const adapter = this.#getFullscreenAdapter(target);

    throwIfFullscreenNotSupported(target, adapter);

    if (adapter!.active) return;

    if (peek(this.$state.pictureInPicture)) {
      this.#wasPIPActive = true;
      await this.exitPictureInPicture(trigger);
    }

    if (trigger) {
      this.#request.queue.enqueue('media-enter-fullscreen-request', trigger);
    }

    return adapter!.enter();
  }

  async exitFullscreen(target: RE.MediaFullscreenRequestTarget = 'prefer-media', trigger?: Event) {
    if (__SERVER__) return;

    const adapter = this.#getFullscreenAdapter(target);

    throwIfFullscreenNotSupported(target, adapter);

    if (!adapter!.active) return;

    if (trigger) {
      this.#request.queue.enqueue('media-exit-fullscreen-request', trigger);
    }

    try {
      const result = await adapter!.exit();

      if (this.#wasPIPActive && peek(this.$state.canPictureInPicture)) {
        await this.enterPictureInPicture();
      }

      return result;
    } finally {
      this.#wasPIPActive = false;
    }
  }

  #getFullscreenAdapter(target: RE.MediaFullscreenRequestTarget) {
    const provider = peek(this.#$provider);
    return (target === 'prefer-media' && this.#fullscreen.supported) || target === 'media'
      ? this.#fullscreen
      : provider?.fullscreen;
  }

  async enterPictureInPicture(trigger?: Event) {
    if (__SERVER__) return;

    this.#throwIfPIPNotSupported();

    if (this.$state.pictureInPicture()) return;

    if (trigger) {
      this.#request.queue.enqueue('media-enter-pip-request', trigger);
    }

    return await this.#$provider()!.pictureInPicture!.enter();
  }

  async exitPictureInPicture(trigger?: Event) {
    if (__SERVER__) return;

    this.#throwIfPIPNotSupported();

    if (!this.$state.pictureInPicture()) return;

    if (trigger) {
      this.#request.queue.enqueue('media-exit-pip-request', trigger);
    }

    return await this.#$provider()!.pictureInPicture!.exit();
  }

  #throwIfPIPNotSupported() {
    if (this.$state.canPictureInPicture()) return;
    throw Error(
      __DEV__
        ? `[vidstack] picture-in-picture is not currently available`
        : '[vidstack] no pip support',
    );
  }

  #watchControlsDelayChange() {
    this.controls.defaultDelay = this.$props.controlsDelay();
  }

  #watchAudioGainSupport() {
    const { canSetAudioGain } = this.$state,
      supported = !!this.#$provider()?.audioGain?.supported;
    canSetAudioGain.set(supported);
  }

  #watchAirPlaySupport() {
    const { canAirPlay } = this.$state,
      supported = !!this.#$provider()?.airPlay?.supported;
    canAirPlay.set(supported);
  }

  #watchGoogleCastSupport() {
    const { canGoogleCast, source } = this.$state,
      supported = IS_CHROME && !IS_IOS && canGoogleCastSrc(source());
    canGoogleCast.set(supported);
  }

  #watchFullscreenSupport() {
    const { canFullscreen } = this.$state,
      supported = this.#fullscreen.supported || !!this.#$provider()?.fullscreen?.supported;
    canFullscreen.set(supported);
  }

  #watchPiPSupport() {
    const { canPictureInPicture } = this.$state,
      supported = !!this.#$provider()?.pictureInPicture?.supported;
    canPictureInPicture.set(supported);
  }

  async ['media-airplay-request'](event: RE.MediaAirPlayRequestEvent) {
    try {
      await this.requestAirPlay(event);
    } catch (error) {
      // no-op
    }
  }

  async requestAirPlay(trigger?: Event) {
    try {
      const adapter = this.#$provider()?.airPlay;

      if (!adapter?.supported) {
        throw Error(__DEV__ ? 'AirPlay adapter not available on provider.' : 'No AirPlay adapter.');
      }

      if (trigger) {
        this.#request.queue.enqueue('media-airplay-request', trigger);
      }

      return await adapter.prompt();
    } catch (error) {
      this.#request.queue.delete('media-airplay-request');

      if (__DEV__) {
        this.#logError('airplay request failed', error, trigger);
      }

      throw error;
    }
  }

  async ['media-google-cast-request'](event: RE.MediaGoogleCastRequestEvent) {
    try {
      await this.requestGoogleCast(event);
    } catch (error) {
      // no-op
    }
  }

  #googleCastLoader?: GoogleCastLoader;
  async requestGoogleCast(trigger?: Event) {
    try {
      const { canGoogleCast } = this.$state;

      if (!peek(canGoogleCast)) {
        const error = Error(
          __DEV__ ? 'Google Cast not available on this platform.' : 'Cast not available.',
        ) as GoogleCastPromptError;

        error.code = 'CAST_NOT_AVAILABLE';

        throw error;
      }

      preconnect('https://www.gstatic.com');

      if (!this.#googleCastLoader) {
        const $module = await import('../../providers/google-cast/loader');
        this.#googleCastLoader = new $module.GoogleCastLoader();
      }

      await this.#googleCastLoader.prompt(this.#media);

      if (trigger) {
        this.#request.queue.enqueue('media-google-cast-request', trigger);
      }

      const isConnecting = peek(this.$state.remotePlaybackState) !== 'disconnected';

      if (isConnecting) {
        this.$state.savedState.set({
          paused: peek(this.$state.paused),
          currentTime: peek(this.$state.currentTime),
        });
      }

      this.$state.remotePlaybackLoader.set(isConnecting ? this.#googleCastLoader : null);
    } catch (error) {
      this.#request.queue.delete('media-google-cast-request');

      if (__DEV__) {
        this.#logError('google cast request failed', error, trigger);
      }

      throw error;
    }
  }

  ['media-clip-start-change-request'](event: RE.MediaClipStartChangeRequestEvent) {
    const { clipStartTime } = this.$state;
    clipStartTime.set(event.detail);
  }

  ['media-clip-end-change-request'](event: RE.MediaClipEndChangeRequestEvent) {
    const { clipEndTime } = this.$state;
    clipEndTime.set(event.detail);
    this.dispatch('duration-change', {
      detail: event.detail,
      trigger: event,
    });
  }

  ['media-duration-change-request'](event: RE.MediaDurationChangeRequestEvent) {
    const { providedDuration, clipEndTime } = this.$state;
    providedDuration.set(event.detail);
    if (clipEndTime() <= 0) {
      this.dispatch('duration-change', {
        detail: event.detail,
        trigger: event,
      });
    }
  }

  ['media-audio-track-change-request'](event: RE.MediaAudioTrackChangeRequestEvent) {
    const { logger, audioTracks } = this.#media;

    if (audioTracks.readonly) {
      if (__DEV__) {
        logger
          ?.warnGroup(`[vidstack] attempted to change audio track but it is currently read-only`)
          .labelledLog('Request Event', event)
          .dispatch();
      }

      return;
    }

    const index = event.detail,
      track = audioTracks[index];

    if (track) {
      const key = event.type as 'media-audio-track-change-request';
      this.#request.queue.enqueue(key, event);
      track.selected = true;
    } else if (__DEV__) {
      logger
        ?.warnGroup('[vidstack] failed audio track change request (invalid index)')
        .labelledLog('Audio Tracks', audioTracks.toArray())
        .labelledLog('Index', index)
        .labelledLog('Request Event', event)
        .dispatch();
    }
  }

  async ['media-enter-fullscreen-request'](event: RE.MediaEnterFullscreenRequestEvent) {
    try {
      await this.enterFullscreen(event.detail, event);
    } catch (error) {
      this.#onFullscreenError(error, event);
    }
  }

  async ['media-exit-fullscreen-request'](event: RE.MediaExitFullscreenRequestEvent) {
    try {
      await this.exitFullscreen(event.detail, event);
    } catch (error) {
      this.#onFullscreenError(error, event);
    }
  }

  async #onFullscreenChange(event: MediaFullscreenChangeEvent) {
    const lockType = peek(this.$props.fullscreenOrientation),
      isFullscreen = event.detail;

    if (isUndefined(lockType) || lockType === 'none' || !this.#orientation.supported) return;

    if (isFullscreen) {
      if (this.#orientation.locked) return;
      this.dispatch('media-orientation-lock-request', {
        detail: lockType,
        trigger: event,
      });
    } else if (this.#orientation.locked) {
      this.dispatch('media-orientation-unlock-request', {
        trigger: event,
      });
    }
  }

  #onFullscreenError(error: unknown, request?: Event) {
    if (__DEV__) {
      this.#logError('fullscreen request failed', error, request);
    }

    this.#stateMgr.handle(
      this.createEvent('fullscreen-error', {
        detail: coerceToError(error),
      }),
    );
  }

  async ['media-orientation-lock-request'](event: RE.MediaOrientationLockRequestEvent) {
    const key = event.type as 'media-orientation-lock-request';

    try {
      this.#request.queue.enqueue(key, event);
      await this.#orientation.lock(event.detail);
    } catch (error) {
      this.#request.queue.delete(key);
      if (__DEV__) {
        this.#logError('failed to lock screen orientation', error, event);
      }
    }
  }

  async ['media-orientation-unlock-request'](event: RE.MediaOrientationUnlockRequestEvent) {
    const key = event.type as 'media-orientation-unlock-request';

    try {
      this.#request.queue.enqueue(key, event);
      await this.#orientation.unlock();
    } catch (error) {
      this.#request.queue.delete(key);
      if (__DEV__) {
        this.#logError('failed to unlock screen orientation', error, event);
      }
    }
  }

  async ['media-enter-pip-request'](event: RE.MediaEnterPIPRequestEvent) {
    try {
      await this.enterPictureInPicture(event);
    } catch (error) {
      this.#onPictureInPictureError(error, event);
    }
  }

  async ['media-exit-pip-request'](event: RE.MediaExitPIPRequestEvent) {
    try {
      await this.exitPictureInPicture(event);
    } catch (error) {
      this.#onPictureInPictureError(error, event);
    }
  }

  #onPictureInPictureError(error: unknown, request?: Event) {
    if (__DEV__) {
      this.#logError('pip request failed', error, request);
    }

    this.#stateMgr.handle(
      this.createEvent('picture-in-picture-error', {
        detail: coerceToError(error),
      }),
    );
  }

  ['media-live-edge-request'](event: RE.MediaLiveEdgeRequestEvent) {
    const { live, liveEdge, canSeek } = this.$state;

    if (!live() || liveEdge() || !canSeek()) return;

    this.#request.queue.enqueue('media-seek-request', event);

    try {
      this.seekToLiveEdge();
    } catch (error) {
      this.#request.queue.delete('media-seek-request');
      if (__DEV__) {
        this.#logError('seek to live edge fail', error, event);
      }
    }
  }

  async ['media-loop-request'](event: RE.MediaLoopRequestEvent) {
    try {
      this.#request.looping = true;
      this.#request.replaying = true;
      await this.play(event);
    } catch (error) {
      this.#request.looping = false;
    }
  }

  ['media-user-loop-change-request'](event: RE.MediaUserLoopChangeRequestEvent) {
    this.$state.userPrefersLoop.set(event.detail);
  }

  async ['media-pause-request'](event: RE.MediaPauseRequestEvent) {
    if (this.$state.paused()) return;
    try {
      await this.pause(event);
    } catch (error) {
      // no-op
    }
  }

  async ['media-play-request'](event: RE.MediaPlayRequestEvent) {
    if (!this.$state.paused()) return;
    try {
      await this.play(event);
    } catch (e) {
      // no-op
    }
  }

  ['media-rate-change-request'](event: RE.MediaRateChangeRequestEvent) {
    const { playbackRate, canSetPlaybackRate } = this.$state;
    if (playbackRate() === event.detail || !canSetPlaybackRate()) return;

    const provider = this.#$provider();
    if (!provider?.setPlaybackRate) return;

    this.#request.queue.enqueue('media-rate-change-request', event);
    provider.setPlaybackRate(event.detail);
  }

  ['media-audio-gain-change-request'](event: RE.MediaAudioGainChangeRequestEvent) {
    try {
      this.setAudioGain(event.detail, event);
    } catch (e) {
      // no-op
    }
  }

  ['media-quality-change-request'](event: RE.MediaQualityChangeRequestEvent) {
    const { qualities, storage, logger } = this.#media;

    if (qualities.readonly) {
      if (__DEV__) {
        logger
          ?.warnGroup(`[vidstack] attempted to change video quality but it is currently read-only`)
          .labelledLog('Request Event', event)
          .dispatch();
      }

      return;
    }

    this.#request.queue.enqueue('media-quality-change-request', event);

    const index = event.detail;

    if (index < 0) {
      qualities.autoSelect(event);
      if (event.isOriginTrusted) storage?.setVideoQuality?.(null);
    } else {
      const quality = qualities[index];
      if (quality) {
        quality.selected = true;
        if (event.isOriginTrusted) {
          storage?.setVideoQuality?.({
            id: quality.id,
            width: quality.width,
            height: quality.height,
            bitrate: quality.bitrate,
          });
        }
      } else if (__DEV__) {
        logger
          ?.warnGroup('[vidstack] failed quality change request (invalid index)')
          .labelledLog('Qualities', qualities.toArray())
          .labelledLog('Index', index)
          .labelledLog('Request Event', event)
          .dispatch();
      }
    }
  }

  ['media-pause-controls-request'](event: RE.MediaPauseControlsRequestEvent) {
    const key = event.type as 'media-pause-controls-request';
    this.#request.queue.enqueue(key, event);
    this.controls.pause(event);
  }

  ['media-resume-controls-request'](event: RE.MediaResumeControlsRequestEvent) {
    const key = event.type as 'media-resume-controls-request';
    this.#request.queue.enqueue(key, event);
    this.controls.resume(event);
  }

  ['media-seek-request'](event: RE.MediaSeekRequestEvent) {
    const { canSeek, ended, live, seekableEnd, userBehindLiveEdge } = this.$state,
      seekTime = event.detail;

    if (ended()) this.#request.replaying = true;

    const key = event.type as 'media-seek-request';

    this.#request.seeking = false;
    this.#request.queue.delete(key);

    const boundedTime = boundTime(seekTime, this.$state);

    if (!Number.isFinite(boundedTime) || !canSeek()) return;

    this.#request.queue.enqueue(key, event);
    this.#$provider()!.setCurrentTime(boundedTime);

    if (live() && event.isOriginTrusted && Math.abs(seekableEnd() - boundedTime) >= 2) {
      userBehindLiveEdge.set(true);
    }
  }

  ['media-seeking-request'](event: RE.MediaSeekingRequestEvent) {
    const key = event.type as 'media-seeking-request';
    this.#request.queue.enqueue(key, event);
    this.$state.seeking.set(true);
    this.#request.seeking = true;
  }

  ['media-start-loading'](event: RE.MediaStartLoadingRequestEvent) {
    if (this.$state.canLoad()) return;
    const key = event.type as 'media-start-loading';
    this.#request.queue.enqueue(key, event);
    this.#stateMgr.handle(this.createEvent('can-load'));
  }

  ['media-poster-start-loading'](event: RE.MediaPosterStartLoadingRequestEvent) {
    if (this.$state.canLoadPoster()) return;
    const key = event.type as 'media-poster-start-loading';
    this.#request.queue.enqueue(key, event);
    this.#stateMgr.handle(this.createEvent('can-load-poster'));
  }

  ['media-text-track-change-request'](event: RE.MediaTextTrackChangeRequestEvent) {
    const { index, mode } = event.detail,
      track = this.#media.textTracks[index];
    if (track) {
      const key = event.type as 'media-text-track-change-request';
      this.#request.queue.enqueue(key, event);
      track.setMode(mode, event);
    } else if (__DEV__) {
      this.#media.logger
        ?.warnGroup('[vidstack] failed text track change request (invalid index)')
        .labelledLog('Text Tracks', this.#media.textTracks.toArray())
        .labelledLog('Index', index)
        .labelledLog('Request Event', event)
        .dispatch();
    }
  }

  ['media-mute-request'](event: RE.MediaMuteRequestEvent) {
    if (this.$state.muted()) return;
    const key = event.type as 'media-mute-request';
    this.#request.queue.enqueue(key, event);
    this.#$provider()!.setMuted(true);
  }

  ['media-unmute-request'](event: RE.MediaUnmuteRequestEvent) {
    const { muted, volume } = this.$state;

    if (!muted()) return;

    const key = event.type as 'media-unmute-request';

    this.#request.queue.enqueue(key, event);
    this.#media.$provider()!.setMuted(false);

    if (volume() === 0) {
      this.#request.queue.enqueue(key, event);
      this.#$provider()!.setVolume(0.25);
    }
  }

  ['media-volume-change-request'](event: RE.MediaVolumeChangeRequestEvent) {
    const { muted, volume } = this.$state;

    const newVolume = event.detail;
    if (volume() === newVolume) return;

    const key = event.type as 'media-volume-change-request';

    this.#request.queue.enqueue(key, event);
    this.#$provider()!.setVolume(newVolume);

    if (newVolume > 0 && muted()) {
      this.#request.queue.enqueue(key, event);
      this.#$provider()!.setMuted(false);
    }
  }

  #logError(title: string, error: unknown, request?: Event) {
    if (!__DEV__) return;
    this.#media.logger
      ?.errorGroup(`[vidstack] ${title}`)
      .labelledLog('Error', error)
      .labelledLog('Media Context', { ...this.#media })
      .labelledLog('Trigger Event', request)
      .dispatch();
  }
}

function throwIfNotReadyForPlayback(provider: MediaProviderAdapter | null, canPlay: boolean) {
  if (provider && canPlay) return;
  throw Error(
    __DEV__
      ? `[vidstack] media is not ready - wait for \`can-play\` event.`
      : '[vidstack] media not ready',
  );
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

function throwIfAutoplayingWithReducedMotion(autoplaying: boolean) {
  if (!prefersReducedMotion() || !autoplaying) return;
  throw Error(
    __DEV__
      ? '[vidstack] autoplay is blocked due to user preference for reduced motion'
      : '[vidstack] autoplay blocked',
  );
}

export class MediaRequestContext {
  seeking = false;
  looping = false;
  replaying = false;
  queue = new Queue<MediaRequestQueueItems>();
}

export type MediaRequestQueueItems = {
  [P in keyof RE.MediaRequestEvents]: Event;
};

export type MediaRequestHandler = {
  [Type in keyof RE.MediaRequestEvents]: (event: RE.MediaRequestEvents[Type]) => unknown;
};
