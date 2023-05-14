import {
  createContext,
  useContext,
  type ReadSignal,
  type ReadSignalRecord,
  type WriteSignal,
} from 'maverick.js';

import type { Logger } from '../../../foundation/logger/controller';
import { AdsController } from '../ads/ads';
import type { MediaKeyShortcuts } from '../keyboard/types';
import type { MediaPlayerElement } from '../player';
import type { MediaProvider, MediaProviderLoader } from '../providers/types';
import type { VideoQualityList } from '../quality/video-quality';
import type { MediaPlayerDelegate } from '../state/media-player-delegate';
import type { MediaRemoteControl } from '../state/remote-control';
import type { AudioTrackList } from '../tracks/audio-tracks';
import type { TextRenderers } from '../tracks/text/render/text-renderer';
import type { TextTrackList } from '../tracks/text/text-tracks';
import type { PlayerProps } from './player-props';
import type { MediaStore } from './store';

export interface MediaContext {
  player: MediaPlayerElement | null;
  remote: MediaRemoteControl;
  delegate: MediaPlayerDelegate;
  qualities: VideoQualityList;
  audioTracks: AudioTrackList;
  textTracks: TextTrackList;
  textRenderers: TextRenderers;
  ariaKeys: MediaKeyShortcuts;
  logger?: Logger;
  $loader: WriteSignal<MediaProviderLoader | null>;
  $provider: WriteSignal<MediaProvider | null>;
  $iosControls: ReadSignal<boolean>;
  $props: ReadSignalRecord<PlayerProps>;
  $store: MediaStore;
  ads: WriteSignal<AdsController | null>;
}

export const mediaContext = createContext<MediaContext>();

export function useMedia(): MediaContext {
  return useContext(mediaContext);
}
