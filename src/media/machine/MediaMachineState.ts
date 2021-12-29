import type { Values } from '../../global/helpers';
import type { MediaMachineContext } from './MediaMachineContext';

export type MediaMachineState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'can-play'
  | 'paused'
  | 'autoplay'
  | 'autoplay-fail'
  | 'play'
  | 'playing'
  | 'seeking'
  | 'seeked'
  | 'waiting'
  | 'ended'
  | 'aborted';

export type MediaMachineStates = Values<{
  [State in MediaMachineState]: { value: State; context: MediaMachineContext };
}>;
