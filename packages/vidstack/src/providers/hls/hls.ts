import type * as HLS from 'hls.js';
import { effect, peek } from 'maverick.js';
import { camelToKebabCase, DOMEvent, isString, listenEvent } from 'maverick.js/std';

import type { MediaContext } from '../../core/api/media-context';
import type { Src } from '../../core/api/src-types';
import { QualitySymbol } from '../../core/quality/symbols';
import { TextTrackSymbol } from '../../core/tracks/text/symbols';
import { TextTrack } from '../../core/tracks/text/text-track';
import { ListSymbol } from '../../foundation/list/symbols';
import { RAFLoop } from '../../foundation/observers/raf-loop';
import { IS_CHROME } from '../../utils/support';
import type { HLSConstructor, HLSInstanceCallback } from './types';

const toDOMEventType = (type: string) => camelToKebabCase(type);

export class HLSController {
  #video: HTMLVideoElement;
  #ctx: MediaContext;
  #instance: HLS.default | null = null;
  #stopLiveSync: (() => void) | null = null;

  config: Partial<HLS.HlsConfig> = {};
  #callbacks = new Set<HLSInstanceCallback>();

  get instance() {
    return this.#instance;
  }

  constructor(video: HTMLVideoElement, ctx: MediaContext) {
    this.#video = video;
    this.#ctx = ctx;
  }

  setup(ctor: HLSConstructor) {
    const { streamType } = this.#ctx.$state;

    const isLive = peek(streamType).includes('live'),
      isLiveLowLatency = peek(streamType).includes('ll-');

    this.#instance = new ctor({
      lowLatencyMode: isLiveLowLatency,
      backBufferLength: isLiveLowLatency ? 4 : isLive ? 8 : undefined,
      renderTextTracksNatively: false,
      ...this.config,
    });

    const dispatcher = this.#dispatchHLSEvent.bind(this);
    for (const event of Object.values(ctor.Events)) this.#instance.on(event, dispatcher);

    this.#instance.on(ctor.Events.ERROR, this.#onError.bind(this));
    for (const callback of this.#callbacks) callback(this.#instance);

    this.#ctx.player.dispatch('hls-instance', {
      detail: this.#instance,
    });

    this.#instance.attachMedia(this.#video);

    // Enable remote playback for AirPlay 
    this.#video.disableRemotePlayback = false;

    this.#instance.on(ctor.Events.AUDIO_TRACK_SWITCHED, this.#onAudioSwitch.bind(this));
    this.#instance.on(ctor.Events.LEVEL_SWITCHED, this.#onLevelSwitched.bind(this));
    this.#instance.on(ctor.Events.LEVEL_LOADED, this.#onLevelLoaded.bind(this));
    this.#instance.on(ctor.Events.LEVEL_UPDATED, this.#onLevelUpdated.bind(this));
    this.#instance.on(ctor.Events.NON_NATIVE_TEXT_TRACKS_FOUND, this.#onTracksFound.bind(this));
    this.#instance.on(ctor.Events.CUES_PARSED, this.#onCuesParsed.bind(this));

    this.#ctx.qualities[QualitySymbol.enableAuto] = this.#enableAutoQuality.bind(this);

    listenEvent(this.#ctx.qualities, 'change', this.#onUserQualityChange.bind(this));
    listenEvent(this.#ctx.audioTracks, 'change', this.#onUserAudioChange.bind(this));

    this.#stopLiveSync = effect(this.#liveSync.bind(this));
  }

  #createDOMEvent<T>(type: string, data: T): DOMEvent<T> {
    return new DOMEvent<any>(toDOMEventType(type), { detail: data });
  }

  #liveSync() {
    if (!this.#ctx.$state.live()) return;
    const raf = new RAFLoop(this.#liveSyncPosition.bind(this));
    raf.start();
    return raf.stop.bind(raf);
  }

  #liveSyncPosition() {
    this.#ctx.$state.liveSyncPosition.set(this.#instance?.liveSyncPosition ?? Infinity);
  }

  #dispatchHLSEvent(type: string, data: any) {
    this.#ctx.player?.dispatch(this.#createDOMEvent(type, data));
  }

  #onTracksFound(eventType: string, data: HLS.NonNativeTextTracksData) {
    const event = this.#createDOMEvent(eventType, data);

    let currentTrack = -1;

    for (let i = 0; i < data.tracks.length; i++) {
      const nonNativeTrack = data.tracks[i],
        init = nonNativeTrack.subtitleTrack ?? nonNativeTrack.closedCaptions,
        track = new TextTrack({
          id: `hls-${nonNativeTrack!.kind}-${i}`,
          src: init?.url,
          label: nonNativeTrack!.label,
          language: init?.lang,
          kind: nonNativeTrack!.kind as TextTrackKind,
          default: nonNativeTrack.default,
        });

      track[TextTrackSymbol.readyState] = 2;
      track[TextTrackSymbol.onModeChange] = () => {
        if (track.mode === 'showing') {
          this.#instance!.subtitleTrack = i;
          currentTrack = i;
        } else if (currentTrack === i) {
          this.#instance!.subtitleTrack = -1;
          currentTrack = -1;
        }
      };

      this.#ctx.textTracks.add(track, event);
    }
  }

  #onCuesParsed(eventType: string, data: HLS.CuesParsedData) {
    const index = this.#instance?.subtitleTrack,
      track = this.#ctx.textTracks.getById(`hls-${data.type}-${index}`);

    if (!track) return;

    const event = this.#createDOMEvent(eventType, data);

    for (const cue of data.cues) {
      cue.positionAlign = 'auto';
      track.addCue(cue, event);
    }
  }

  #onAudioSwitch(eventType: string, data: HLS.AudioTrackSwitchedData) {
    const track = this.#ctx.audioTracks[data.id];
    if (track) {
      const trigger = this.#createDOMEvent(eventType, data);
      this.#ctx.audioTracks[ListSymbol.select](track, true, trigger);
    }
  }

  #onLevelSwitched(eventType: string, data: HLS.LevelSwitchedData) {
    const quality = this.#ctx.qualities[data.level];
    if (quality) {
      const trigger = this.#createDOMEvent(eventType, data);
      this.#ctx.qualities[ListSymbol.select](quality, true, trigger);
    }
  }

  #onLevelUpdated(eventType: string, data: HLS.LevelUpdatedData): void {
    if (data.details.totalduration > 0) {
      this.#ctx.$state.inferredLiveDVRWindow.set(data.details.totalduration);
    }
  }

  #onLevelLoaded(eventType: string, data: HLS.LevelLoadedData): void {
    if (this.#ctx.$state.canPlay()) return;

    const { type, live, totalduration: duration, targetduration } = data.details,
      trigger = this.#createDOMEvent(eventType, data);

    this.#ctx.notify(
      'stream-type-change',
      live
        ? type === 'EVENT' && Number.isFinite(duration) && targetduration >= 10
          ? 'live:dvr'
          : 'live'
        : 'on-demand',
      trigger,
    );

    this.#ctx.notify('duration-change', duration, trigger);

    const media = this.#instance!.media!;

    if (this.#instance!.currentLevel === -1) {
      this.#ctx.qualities[QualitySymbol.setAuto](true, trigger);
    }

    for (const remoteTrack of this.#instance!.audioTracks) {
      const localTrack = {
        id: remoteTrack.id.toString(),
        label: remoteTrack.name,
        language: remoteTrack.lang || '',
        kind: 'main',
      };

      this.#ctx.audioTracks[ListSymbol.add](localTrack, trigger);
    }

    for (const level of this.#instance!.levels) {
      const videoQuality = {
        id: level.id?.toString() ?? level.height + 'p',
        width: level.width,
        height: level.height,
        codec: level.codecSet,
        bitrate: level.bitrate,
      };

      this.#ctx.qualities[ListSymbol.add](videoQuality, trigger);
    }

    media.dispatchEvent(new DOMEvent<void>('canplay', { trigger }));
  }

  #onError(eventType: string, data: HLS.ErrorData) {
    if (__DEV__) {
      this.#ctx.logger
        ?.errorGroup(`[vidstack] HLS error \`${eventType}\``)
        .labelledLog('Media Element', this.#instance?.media)
        .labelledLog('HLS Instance', this.#instance)
        .labelledLog('Event Type', eventType)
        .labelledLog('Data', data)
        .labelledLog('Src', peek(this.#ctx.$state.source))
        .labelledLog('Media Store', { ...this.#ctx.$state })
        .dispatch();
    }

    if (data.fatal) {
      switch (data.type) {
        case 'mediaError':
          this.#instance?.recoverMediaError();
          break;
        default:
          this.#onFatalError(data.error);
          break;
      }
    }
  }

  #onFatalError(error: Error) {
    this.#ctx.notify('error', {
      message: error.message,
      code: 1,
      error: error,
    });
  }

  #enableAutoQuality() {
    if (this.#instance) this.#instance.currentLevel = -1;
  }

  #onUserQualityChange() {
    const { qualities } = this.#ctx;

    if (!this.#instance || qualities.auto) return;

    this.#instance[qualities.switch + 'Level'] = qualities.selectedIndex;

    /**
     * Chrome has some strange issue with detecting keyframes inserted before the current
     * playhead position. This can cause playback to freeze until a new keyframe. It seems
     * setting the current time forces chrome to seek back to the last keyframe and adjust
     * playback. Weird fix, but it works!
     */
    if (IS_CHROME) {
      this.#video.currentTime = this.#video.currentTime;
    }
  }

  #onUserAudioChange() {
    const { audioTracks } = this.#ctx;
    if (this.#instance && this.#instance.audioTrack !== audioTracks.selectedIndex) {
      this.#instance.audioTrack = audioTracks.selectedIndex;
    }
  }

  onInstance(callback: HLSInstanceCallback) {
    this.#callbacks.add(callback);
    return () => this.#callbacks.delete(callback);
  }

  loadSource(src: Src) {
    if (!isString(src.src)) return;
    this.#instance?.loadSource(src.src);
  }

  destroy() {
    this.#instance?.destroy();
    this.#instance = null;
    this.#stopLiveSync?.();
    this.#stopLiveSync = null;
    if (__DEV__) this.#ctx?.logger?.info('🏗️ Destroyed HLS instance');
  }
}
