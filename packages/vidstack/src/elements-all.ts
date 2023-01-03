import { MediaDefinition } from './player/media/element/element';
import { AudioDefinition } from './player/providers/audio/element';
import { HLSVideoDefinition } from './player/providers/hls/element';
import { VideoDefinition } from './player/providers/video/element';
import { FullscreenButtonDefinition } from './player/ui/fullscreen-button/element';
import { MuteButtonDefinition } from './player/ui/mute-button/element';
import { PlayButtonDefinition } from './player/ui/play-button/element';
import { TimeSliderDefinition } from './player/ui/time-slider/element';
import { VolumeSliderDefinition } from './player/ui/volume-slider/element';

export default [
  MediaDefinition,
  AudioDefinition,
  VideoDefinition,
  HLSVideoDefinition,
  PlayButtonDefinition,
  MuteButtonDefinition,
  FullscreenButtonDefinition,
  TimeSliderDefinition,
  VolumeSliderDefinition,
];