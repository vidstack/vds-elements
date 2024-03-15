import type { google } from '@alugha/ima';
import { computed, effect, peek, signal } from 'maverick.js';
import { type ElementAttributesRecord } from 'maverick.js/element';
import {
  DOMEvent,
  isFunction,
  isString,
  setAttribute,
  useDisposalBin,
  type DisposalBin,
} from 'maverick.js/std';

import type { MediaPlayerEvents } from '..';
import type { MediaContext } from '../api/media-context';
import type { MediaEvents } from '../api/media-events';
import { MediaPlayerController } from '../api/player-controller';
import { TimeRange } from '../time-ranges';
import { ImaSdkLoader } from './lib-loader';
import type { ImaSdk } from './types';

const toDOMEventType = (type: string) => type.replace(/_/g, '-'); // ad_break_ready => ad-break-ready

export class AdsController extends MediaPlayerController {
  private readonly _defaultBottomMargin = 50; // px

  private _sdk: typeof google.ima | null = null;
  private _adContainerElement: HTMLElement | null = null;
  private _adDisplayContainer: google.ima.AdDisplayContainer | null = null;
  private _adsLoader: google.ima.AdsLoader | null = null;
  private _adsRequest: google.ima.AdsRequest | null = null;
  private _adsManager: google.ima.AdsManager | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _disposablBin: DisposalBin = useDisposalBin();
  private _adsLoadingPromise!: Promise<void>;
  private _adEventsToDispatch: AdEventDispatchMapping = {
    adBreakReady: 'ad_break_ready',
    adBuffering: 'ad_buffering',
    adMetadata: 'ad_metadata',
    adProgress: 'ad_progress',
    allAdsCompleted: 'ad_all_complete',
    click: 'ad_click',
    complete: 'ad_complete',
    contentPauseRequested: 'content_pause_requested',
    contentResumeRequested: 'content_resume_requested',
    durationChange: 'ad_duration_change',
    firstQuartile: 'ad_first_quartile',
    impression: 'ad_impression',
    interaction: 'ad_interaction',
    linearChanged: 'ad_linear_changed',
    loaded: 'ad_loaded',
    log: 'ad_log',
    midpoint: 'ad_midpoint',
    pause: 'ad_pause',
    resume: 'ad_resume',
    skippableStateChanged: 'ad_skippable_state_changed',
    skip: 'ad_skip',
    start: 'ad_start',
    thirdQuartile: 'ad_third_quartile',
    userClose: 'ad_user_close',
    volumeChange: 'ad_volume_change',
    mute: 'ad_mute',
    adCanPlay: 'ad_can_play',
  };
  // used to keep track of where the ad started playing
  // so we can reset the current time to this position
  // same with the already played timeranges
  private _previousPlaybackPosition = signal(0);
  private _previousPlayedTimeranges = signal<TimeRanges | null>(null);
  // non linear ads behave differently so we need to keep track of this
  private _playingNonLinear = signal(false);
  private _adEventHandlerMapping: AdEventHandlerMapping = {
    adBuffering: this._onAdBuffering,
    start: this._onAdStart,
    adProgress: this._onAdProgress,
    complete: this._onAdComplete,
    contentPauseRequested: this._onContentPauseRequested,
    contentResumeRequested: this._onContentResumeRequested,
    loaded: this._onAdLoaded,
    click: this._onAdClick,
    skip: this._onAdSkip,
    linearChanged: this._onAdLinearChanged,
  };
  private _mediaEventHandlerMapping: EventHandlerMapping = {
    ended: this._onContentEnded.bind(this),
  };

  constructor(private _media: MediaContext) {
    super();
  }

  protected override onSetup() {
    new ImaSdkLoader(this._media, this._setup.bind(this));
  }

  private _setup(imaSdk: ImaSdk) {
    this._adContainerElement = document.createElement('media-ads');
    this._media.player.$el?.append(this._adContainerElement);
    this._setAttributesOnAdContainer({
      'data-ads-paused': computed(() => !this.$state.playing() && this.$state.adStarted()),
      'data-ads-playing': computed(() => this.$state.playing() && this.$state.adStarted()),
      'data-ads-started': this.$state.adStarted,
      'data-non-linear': this._playingNonLinear,
    });
    this._sdk = imaSdk;
    this._sdk.settings.setDisableCustomPlaybackForIOS10Plus(true);
    this._sdk.settings.setVpaidMode(this._sdk.ImaSdkSettings.VpaidMode.ENABLED);

    this._adDisplayContainer = new imaSdk.AdDisplayContainer(
      this._adContainerElement,
      this._media.player as unknown as HTMLVideoElement,
    );
    this._adDisplayContainer?.initialize();

    this._adsLoader = new imaSdk.AdsLoader(this._adDisplayContainer);

    this._adsLoadingPromise = new Promise((resolve, reject) => {
      this._addEventListener(
        this._adsLoader,
        this._sdk!.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED,
        (adsManagerLoadedEvent: google.ima.AdsManagerLoadedEvent) => {
          this._onAdsManagerLoaded(adsManagerLoadedEvent), this.$state.adsLoaded.set(true);
          resolve();
        },
      );

      this._addEventListener(
        this._adsLoader,
        this._sdk!.AdErrorEvent.Type.AD_ERROR,
        (adErrorEvent: google.ima.AdErrorEvent) => {
          this._onAdsLoaderError();
          reject();
        },
      );
    });

    if (!__SERVER__ && window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(this._onResized.bind(this));
      this._resizeObserver.observe(this._media.player.$el!);
    }

    this._adsRequest = new this._sdk.AdsRequest();
    this._adsRequest.adTagUrl = this.$props.adsUrl();

    // Specify the linear and nonlinear slot sizes. This helps the SDK to
    // select the correct creative if multiple are returned.
    this._adsRequest.linearAdSlotWidth = this._media.player.el!.clientWidth;
    this._adsRequest.linearAdSlotHeight = this._media.player.el!.clientHeight;
    this._adsRequest.nonLinearAdSlotWidth = this._media.player.el!.clientWidth;
    this._adsRequest.nonLinearAdSlotHeight = this._media.player.el!.clientHeight / 3;

    this._adsRequest.forceNonLinearFullSlot = false;

    this._adsRequest.setAdWillPlayMuted(this.$state.muted());
    this._adsRequest.setAdWillAutoPlay(this.$state.autoPlay());

    // Pass the request to the adsLoader to request ads
    this._adsLoader.requestAds(this._adsRequest);
  }

  protected override onDestroy() {
    this._disposablBin.empty(); // removes all the listeners
    this._resizeObserver?.disconnect();
    this._adsManager?.destroy();
    this._adsLoader?.destroy();
  }

  async play() {
    // only start playback after the ads are loaded and everything is ready
    await this._adsLoadingPromise;

    if (this.$state.adStarted()) {
      this.resume();
      return;
    }

    var width = this._media.player.el!.clientWidth;
    var height = this._media.player.el!.clientHeight;
    this._adsManager!.init(
      width,
      height,
      peek(this.$state.fullscreen) ? this._sdk!.ViewMode.FULLSCREEN : this._sdk!.ViewMode.NORMAL,
    );
    this._adsManager!.start(); // start the ad playback
  }

  resume() {
    if (this._adsManager && this._adsManager.getRemainingTime() > 0) {
      this._adsManager.resume();
    }
  }

  pause() {
    if (this._adsManager && this._adsManager.getRemainingTime() > 0) {
      this._adsManager.pause();
    }
  }

  enterFullscreen() {
    if (this._adsManager && this._media.player && this._sdk) {
      this._adsManager.resize(
        this._media.player.el!.clientWidth,
        this._media.player.el!.clientHeight,
        this._sdk.ViewMode.FULLSCREEN,
      );
    }
  }

  exitFullscreen() {
    if (this._adsManager && this._media.player && this._sdk) {
      this._adsManager.resize(
        this._media.player.el!.clientWidth,
        this._media.player.el!.clientHeight,
        this._sdk.ViewMode.NORMAL,
      );
    }
  }

  setVolume(volume: number) {
    if (this._adsManager) {
      this._adsManager.setVolume(volume);
    }
  }

  mute() {
    this.setVolume(0);
  }

  private _getEnabled() {
    return (
      (this._media.$provider()?.type === 'video' || this._media.$provider()?.type === 'hls') &&
      isString(this.$props.adsUrl())
    );
  }

  private _onAdsManagerLoaded(adsManagerLoadedEvent: google.ima.AdsManagerLoadedEvent) {
    // Load could occur after a source change (race condition)
    if (!this._getEnabled()) {
      return;
    }

    // Get the ads manager
    const settings = new this._sdk!.AdsRenderingSettings();

    // Tell the SDK to save and restore content video state on our behalf
    settings.restoreCustomPlaybackStateOnAdBreakComplete = true;
    if (this.$props.load() === 'eager') {
      settings.enablePreloading = true;
    }

    // Instantiate the AdsManager from the adsLoader response and pass it the video element
    this._adsManager = adsManagerLoadedEvent.getAdsManager(
      this._media.player! as unknown as HTMLVideoElement,
      settings,
    );

    this.$state.adCuePoints.set(this._adsManager.getCuePoints());

    // Add listeners to the required events
    for (const [event, mapping] of Object.entries(this._adEventsToDispatch)) {
      this._addEventListener(this._adsManager, event, (e) => {
        this._onAdEvent(e, mapping);
      });
    }

    for (const [event, mapping] of Object.entries(this._adEventHandlerMapping)) {
      this._addEventListener(this._adsManager, event, mapping.bind(this));
    }

    for (const [event, mapping] of Object.entries(this._mediaEventHandlerMapping)) {
      this._addEventListener(this._media.player, event, mapping.bind(this));
    }

    this._addEventListener(
      this._adsManager,
      this._sdk!.AdErrorEvent.Type.AD_ERROR,
      this._onAdsManagerAdError.bind(this),
    );
  }

  private _setAttributesOnAdContainer(attributes: ElementAttributesRecord) {
    if (!this._adContainerElement) return;

    for (const name of Object.keys(attributes)) {
      if (isFunction(attributes[name])) {
        effect(() =>
          setAttribute(this._adContainerElement!, name, (attributes[name] as Function)()),
        );
      } else {
        setAttribute(this._adContainerElement!, name, attributes[name]);
      }
    }
  }

  private _addEventListener(target: any, event: any, handler: (...args: any) => any) {
    target.addEventListener(event, handler);
    this._disposablBin.add(() => target.removeEventListener(event, handler));
  }

  private _onResized() {
    /* TODO
     * for non linear ads we should adjust the size of the ad container
     * so that it will be visible on the screen and not overlap with the video controlbar ui
     */

    if (this._adsManager) {
      this._adsManager.resize(
        this._media.player.el!.clientWidth,
        this._media.player.el!.clientHeight -
          (this._playingNonLinear() ? this._defaultBottomMargin : 0),
        this._sdk!.ViewMode.NORMAL,
      );
    }
  }

  private _onContentEnded() {
    if (this._adsLoader) {
      this._adsLoader.contentComplete();
    }
  }

  private _onAdsLoaderError() {
    if (this._adsLoader) {
      this._adsLoader.destroy();
    }
  }

  private _onAdsManagerAdError() {
    if (this._adsManager) {
      this._adsManager.destroy();
    }
  }

  private _onAdBuffering() {
    this._media.delegate._notify('waiting');
  }

  private _onContentPauseRequested() {
    this._media.remote.pause();
  }

  private _onContentResumeRequested() {
    if (!this.$state.ended()) {
      this._media.remote.play();
    }
  }

  private _onAdLoaded(adEvent: google.ima.AdEvent) {
    let ad = adEvent.getAd();

    if (!this.$state.playedPreroll()) this.$state.playedPreroll.set(true);

    if (ad && !ad.isLinear()) {
      // non linear ads overlay the content while the content plays
      // so we put the state into paused again so we can trigger media play request
      // and start the content
      // @ts-ignore
      this._media.delegate._notify('pause', null, adEvent);
      this._media.remote.play();
    }
    console.log('Ad Loaded');
  }

  private _onAdStart(adEvent: google.ima.AdEvent) {
    let ad = adEvent.getAd();

    // non linear ads overlay the content and the content should keep playing
    if (ad && ad.isLinear()) {
      this._playingNonLinear.set(false);
      this._previousPlaybackPosition.set(this.$state.currentTime());
      this._previousPlayedTimeranges.set(this.$state.played());

      // @ts-ignore
      this._media.delegate._notify('duration-change', ad?.getDuration() ?? 0, adEvent);
      // @ts-ignore
      this._media.delegate._notify('play', undefined, adEvent);
      this.$state.adStarted.set(true);
    } else {
      this._playingNonLinear.set(true);
    }

    this._onResized(); // resize the ad container to leave a margin for the controlbar if needed
  }

  /**
   * This is called a linear ad is completed.
   */
  private _onAdComplete() {
    console.log('on ad complete');
    this._media.delegate._notify('duration-change', this.$state.seekableEnd());
    this._media.delegate._notify('time-update', {
      currentTime: this._previousPlaybackPosition(),
      played: this._previousPlayedTimeranges() || new TimeRange(0, 0),
    });
    this._media.delegate._notify('ad-ended');
  }

  private _onAdSkip() {
    // if the ad is skipped the complete callback is not called so we have to manually do it
    this._onAdComplete();
  }

  private _onAdLinearChanged(event: google.ima.AdEvent) {
    // this is called when the ad changes from linear to non linear or vice versa
    console.log('on ad linear changed');
    const ad = event.getAd();
    if (ad && ad.isLinear()) {
      this._playingNonLinear.set(false);
    } else {
      this._playingNonLinear.set(true);
    }

    this._onResized(); // resize the ad container to leave a margin for the controlbar if needed
  }

  private _onAdProgress() {
    // this is called whenever the ad progress is updated BUT only for linear ads.
    const { duration } = this.$state;
    const remainingTime = this._adsManager?.getRemainingTime() || 0;
    const currentTime = duration() - remainingTime;
    this._media.delegate._notify('time-update', {
      currentTime,
      played: new TimeRange(0, currentTime),
    });
  }

  private _onAdClick() {
    // the ad gets paused on click so we want to update our state accordingly
    this._media.delegate._notify('pause');
  }

  private _onAdEvent(adEvent: google.ima.AdEvent, mapping: keyof AdEvents) {
    console.log('ad event', mapping, adEvent);
    this.dispatch(toDOMEventType(mapping) as keyof AdEvents, {
      detail: adEvent.getAd(),
      trigger: adEvent as unknown as Event,
    });
  }
}

export interface AdEvents extends MediaEvents {
  ad_can_play: AdEvent;
  ad_error: AdEvent;
  ad_buffering: AdEvent;
  ad_progress: AdEvent;
  ad_volume_change: AdEvent;
  ad_complete: AdEvent;
  ad_all_complete: AdEvent;
  ad_clicked: AdEvent;
  ad_break_ready: AdEvent;
  ad_metadata: AdEvent;
  all_ads_completed: AdEvent;
  ad_click: AdEvent;
  content_pause_requested: AdEvent;
  content_resume_requested: AdEvent;
  ad_duration_change: AdEvent;
  ad_first_quartile: AdEvent;
  ad_impression: AdEvent;
  ad_interaction: AdEvent;
  ad_linear_changed: AdEvent;
  ad_loaded: AdEvent;
  ad_log: AdEvent;
  ad_midpoint: AdEvent;
  ad_pause: AdEvent;
  ad_resume: AdEvent;
  ad_skippable_state_changed: AdEvent;
  ad_skip: AdEvent;
  ad_start: AdEvent;
  ad_third_quartile: AdEvent;
  ad_user_close: AdEvent;
  ad_mute: AdEvent;
}

export interface AdEvent extends DOMEvent<void> {
  trigger: Event;
}

type EventHandlerMapping = Partial<{
  [value in keyof MediaPlayerEvents]: (event: DOMEvent<void>) => void;
}>;

type AdEventHandlerMapping = Partial<{
  [value in google.ima.AdEvent.Type | 'adCanPlay']: (event: google.ima.AdEvent) => void;
}>;

type AdEventDispatchMapping = {
  [value in google.ima.AdEvent.Type | 'adCanPlay']: keyof AdEvents;
};