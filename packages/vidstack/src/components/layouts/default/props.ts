import type { MediaPlayerQuery } from '../../../core/api/player-state';
import type { FileDownloadInfo } from '../../../utils/network';
import type { ThumbnailSrc } from '../../ui/thumbnails/thumbnail-loader';
import type { DefaultLayoutTranslations } from './translations';

export const defaultLayoutProps: DefaultLayoutProps = {
  colorScheme: null,
  download: null,
  customIcons: false,
  disableTimeSlider: false,
  menuGroup: 'bottom',
  noAudioGain: false,
  noGestures: false,
  noKeyboardAnimations: false,
  noModal: false,
  noScrubGesture: false,
  playbackRates: { min: 0, max: 2, step: 0.25 },
  audioGains: { min: 0, max: 300, step: 25 },
  seekStep: 10,
  sliderChaptersMinWidth: 325,
  hideQualityBitrate: false,
  smallWhen: false,
  thumbnails: null,
  translations: null,
  when: false,
};

export interface DefaultLayoutProps {
  /**
   * Determines when the UI should be displayed.
   */
  when: boolean | MediaPlayerQuery;
  /**
   * Determines when the small (e.g., mobile) UI should be displayed.
   */
  smallWhen: 'never' | boolean | MediaPlayerQuery;
  /**
   * The thumbnails resource.
   *
   * @see {@link https://www.vidstack.io/docs/wc/player/core-concepts/loading#thumbnails}
   */
  thumbnails: ThumbnailSrc;
  /**
   * Whether light or dark color theme should be active. Defaults to user operating system
   * preference.
   *
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme}
   */
  colorScheme: 'light' | 'dark' | null;
  /**
   * Sets the download URL and filename for the download button.
   */
  download: FileDownloadInfo;
  /**
   * Whether the default icons should _not_ be loaded. Set this to `true` when providing your own
   * icons.
   */
  customIcons: boolean;
  /**
   * Translation map from english to your desired language for words used throughout the layout.
   */
  translations: Partial<DefaultLayoutTranslations> | null;
  /**
   * Specifies whether menu buttons should be placed in the top or bottom controls group. This
   * only applies to the large video layout.
   */
  menuGroup: 'top' | 'bottom';
  /**
   * Disable audio boost slider in the settings menu.
   */
  noAudioGain: boolean;
  /**
   * Whether modal menus should be disabled when the small layout is active. A modal menu is
   * a floating panel that floats up from the bottom of the screen (outside of the player). It's
   * enabled by default as it provides a better user experience for touch devices.
   */
  noModal: boolean;
  /**
   * Whether to disable scrubbing by touch swiping left or right on the player canvas.
   */
  noScrubGesture: boolean;
  /**
   * The minimum width of the slider to start displaying slider chapters when available.
   */
  sliderChaptersMinWidth: number;
  /**
   * Whether the time slider should be disabled.
   */
  disableTimeSlider: boolean;
  /**
   * Whether all gestures such as press to play or seek should not be active.
   */
  noGestures: boolean;
  /**
   * Whether keyboard actions should not be displayed.
   */
  noKeyboardAnimations: boolean;
  /**
   * Whether the bitrate should be hidden in the settings quality hint.
   *
   * @defaultValue false
   */
  hideQualityBitrate: boolean;
  /**
   * The playback rate options to be displayed in the settings menu.
   */
  playbackRates: number[] | { min: number; max: number; step: number };
  /**
   * The audio gain options to be displayed in the settings menu.
   */
  audioGains: number[] | { min: number; max: number; step: number };
  /**
   * The number of seconds to seek forward or backward when pressing the seek button or using
   * keyboard shortcuts.
   */
  seekStep: number;
}
