import debounce from 'just-debounce-it';
import {
  Component,
  computed,
  createScope,
  effect,
  method,
  onDispose,
  peek,
  prop,
  scoped,
  signal,
  useState,
  type ReadSignalRecord,
  type Scope,
} from 'maverick.js';
import {
  animationFrameThrottle,
  EventsController,
  listenEvent,
  setAttribute,
} from 'maverick.js/std';
import type { VTTCue } from 'media-captions';

import { useMediaContext, type MediaContext } from '../../../../core/api/media-context';
import type { TextTrack } from '../../../../core/tracks/text/text-track';
import { watchActiveTextTrack } from '../../../../core/tracks/text/utils';
import { round } from '../../../../utils/number';
import type { SliderState } from '../slider/api/state';
import { TimeSlider } from './time-slider';

/**
 * Used to create predefined sections within a time slider interface based on the currently
 * active chapters text track.
 *
 * @docs {@link https://www.vidstack.io/docs/player/components/sliders/slider-chapters}
 */
export class SliderChapters extends Component<SliderChaptersProps, {}, SliderChaptersCSSVars> {
  static props: SliderChaptersProps = {
    disabled: false,
  };

  #media!: MediaContext;
  #sliderState!: ReadSignalRecord<SliderState>;
  #updateScope?: Scope;

  #titleRef: HTMLElement | null = null;
  #refs: HTMLElement[] = [];

  #$track = signal<TextTrack | null>(null);
  #$cues = signal<VTTCue[]>([]);

  #activeIndex = signal(-1);
  #activePointerIndex = signal(-1);
  #bufferedIndex = 0;

  @prop
  get cues() {
    return this.#$cues();
  }

  @prop
  get activeCue(): VTTCue | null {
    return this.#$cues()[this.#activeIndex()] || null;
  }

  @prop
  get activePointerCue(): VTTCue | null {
    return this.#$cues()[this.#activePointerIndex()] || null;
  }

  protected override onSetup(): void {
    this.#media = useMediaContext();
    this.#sliderState = useState(TimeSlider.state);
  }

  protected override onAttach(el: HTMLElement): void {
    watchActiveTextTrack(this.#media.textTracks, 'chapters', this.#setTrack.bind(this));
    effect(this.#watchSource.bind(this));
  }

  protected override onConnect(): void {
    onDispose(() => this.#reset.bind(this));
  }

  protected override onDestroy(): void {
    this.#setTrack(null);
  }

  @method
  setRefs(refs: HTMLElement[]) {
    this.#refs = refs;
    this.#updateScope?.dispose();
    if (this.#refs.length === 1) {
      const el = this.#refs[0];
      el.style.width = '100%';
      el.style.setProperty('--chapter-fill', 'var(--slider-fill)');
      el.style.setProperty('--chapter-progress', 'var(--slider-progress)');
    } else if (this.#refs.length > 0) {
      scoped(() => this.#watch(), (this.#updateScope = createScope()));
    }
  }

  #setTrack(track: TextTrack | null) {
    if (peek(this.#$track) === track) return;
    this.#reset();
    this.#$track.set(track);
  }

  #reset() {
    this.#refs = [];
    this.#$cues.set([]);
    this.#activeIndex.set(-1);
    this.#activePointerIndex.set(-1);
    this.#bufferedIndex = 0;
    this.#updateScope?.dispose();
  }

  #watch() {
    if (!this.#refs.length) return;

    effect(this.#watchUpdates.bind(this));
  }
  #watchUpdates() {
    const { hidden } = this.#sliderState;

    if (hidden()) return;

    effect(this.#watchContainerWidths.bind(this));
    effect(this.#watchFillPercent.bind(this));
    effect(this.#watchPointerPercent.bind(this));
    effect(this.#watchBufferedPercent.bind(this));
  }

  #watchContainerWidths() {
    const cues = this.#$cues();

    if (!cues.length) return;

    let cue: VTTCue,
      { seekableStart, seekableEnd } = this.#media.$state,
      startTime = seekableStart(),
      endTime = seekableEnd() || cues[cues.length - 1].endTime,
      duration = endTime - startTime,
      remainingWidth = 100;

    for (let i = 0; i < cues.length; i++) {
      cue = cues[i];
      if (this.#refs[i]) {
        const width =
          i === cues.length - 1
            ? remainingWidth
            : round(((cue.endTime - Math.max(startTime, cue.startTime)) / duration) * 100, 3);

        this.#refs[i].style.width = width + '%';

        remainingWidth -= width;
      }
    }
  }

  #watchFillPercent() {
    let { liveEdge, seekableStart, seekableEnd } = this.#media.$state,
      { fillPercent, value } = this.#sliderState,
      cues = this.#$cues(),
      isLiveEdge = liveEdge(),
      prevActiveIndex = peek(this.#activeIndex),
      currentChapter = cues[prevActiveIndex];

    let currentActiveIndex = isLiveEdge
      ? this.#$cues.length - 1
      : this.#findActiveChapterIndex(
          currentChapter
            ? (currentChapter.startTime / seekableEnd()) * 100 <= peek(value)
              ? prevActiveIndex
              : 0
            : 0,
          fillPercent(),
        );

    if (isLiveEdge || !currentChapter) {
      this.#updateFillPercents(0, cues.length, 100);
    } else if (currentActiveIndex > prevActiveIndex) {
      this.#updateFillPercents(prevActiveIndex, currentActiveIndex, 100);
    } else if (currentActiveIndex < prevActiveIndex) {
      this.#updateFillPercents(currentActiveIndex + 1, prevActiveIndex + 1, 0);
    }

    const percent = isLiveEdge
      ? 100
      : this.#calcPercent(
          cues[currentActiveIndex],
          fillPercent(),
          seekableStart(),
          this.#getEndTime(cues),
        );

    this.#updateFillPercent(this.#refs[currentActiveIndex], percent);

    this.#activeIndex.set(currentActiveIndex);
  }

  #watchPointerPercent() {
    let { hidden, pointerPercent } = this.#sliderState;

    if (hidden()) {
      this.#activePointerIndex.set(-1);
      return;
    }

    const activeIndex = this.#findActiveChapterIndex(0, pointerPercent());
    this.#activePointerIndex.set(activeIndex);
  }

  #updateFillPercents(start: number, end: number, percent: number) {
    for (let i = start; i < end; i++) this.#updateFillPercent(this.#refs[i], percent);
  }

  #updateFillPercent(ref: HTMLElement | null, percent: number) {
    if (!ref) return;

    ref.style.setProperty('--chapter-fill', percent + '%');

    setAttribute(ref, 'data-active', percent > 0 && percent < 100);
    setAttribute(ref, 'data-ended', percent === 100);
  }

  #findActiveChapterIndex(startIndex: number, percent: number) {
    let chapterPercent = 0,
      cues = this.#$cues();

    if (percent === 0) return 0;
    else if (percent === 100) return cues.length - 1;

    let { seekableStart } = this.#media.$state,
      startTime = seekableStart(),
      endTime = this.#getEndTime(cues);

    for (let i = startIndex; i < cues.length; i++) {
      chapterPercent = this.#calcPercent(cues[i], percent, startTime, endTime);
      if (chapterPercent >= 0 && chapterPercent < 100) return i;
    }

    return 0;
  }

  #watchBufferedPercent() {
    this.#updateBufferedPercent(this.#bufferedPercent());
  }

  #updateBufferedPercent = animationFrameThrottle((bufferedPercent: number) => {
    let percent: number,
      cues = this.#$cues(),
      { seekableStart } = this.#media.$state,
      startTime = seekableStart(),
      endTime = this.#getEndTime(cues);

    for (let i = this.#bufferedIndex; i < this.#refs.length; i++) {
      percent = this.#calcPercent(cues[i], bufferedPercent, startTime, endTime);
      this.#refs[i]?.style.setProperty('--chapter-progress', percent + '%');
      if (percent < 100) {
        this.#bufferedIndex = i;
        break;
      }
    }
  });

  #bufferedPercent = computed(this.#calcMediaBufferedPercent.bind(this));
  #calcMediaBufferedPercent() {
    const { bufferedEnd, duration } = this.#media.$state;
    return round(Math.min(bufferedEnd() / Math.max(duration(), 1), 1), 3) * 100;
  }

  #getEndTime(cues: VTTCue[]) {
    const { seekableEnd } = this.#media.$state,
      endTime = seekableEnd();
    return Number.isFinite(endTime) ? endTime : cues[cues.length - 1]?.endTime || 0;
  }

  #calcPercent(cue: VTTCue | undefined, percent: number, startTime: number, endTime: number) {
    if (!cue) return 0;

    const cues = this.#$cues();

    if (cues.length === 0) return 0;

    const duration = endTime - startTime,
      cueStartTime = Math.max(0, cue.startTime - startTime),
      cueEndTime = Math.min(endTime, cue.endTime) - startTime;

    const startRatio = cueStartTime / duration,
      startPercent = startRatio * 100,
      endPercent = Math.min(1, startRatio + (cueEndTime - cueStartTime) / duration) * 100;

    return Math.max(
      0,
      round(
        percent >= endPercent
          ? 100
          : ((percent - startPercent) / (endPercent - startPercent)) * 100,
        3,
      ),
    );
  }

  #fillGaps(cues: ReadonlyArray<VTTCue>) {
    let chapters: VTTCue[] = [],
      { seekableStart, seekableEnd, duration } = this.#media.$state,
      startTime = seekableStart(),
      endTime = seekableEnd();

    cues = cues.filter((cue) => cue.startTime <= endTime && cue.endTime >= startTime);

    const firstCue = cues[0];

    // Fill any time gaps where chapters are missing.
    if (firstCue && firstCue.startTime > startTime) {
      chapters.push(new window.VTTCue(startTime, firstCue.startTime, ''));
    }

    // Fill any time gaps where chapters are missing.
    for (let i = 0; i < cues.length - 1; i++) {
      const currentCue = cues[i],
        nextCue = cues[i + 1];
      chapters.push(currentCue);
      if (nextCue) {
        const timeDiff = nextCue.startTime - currentCue.endTime;
        if (timeDiff > 0) {
          chapters.push(new window.VTTCue(currentCue.endTime, currentCue.endTime + timeDiff, ''));
        }
      }
    }

    const lastCue = cues[cues.length - 1];
    if (lastCue) {
      chapters.push(lastCue);

      // Fill gap at the end if the last chapter doesn't extend all the way.
      const endTime = duration();
      if (endTime >= 0 && endTime - lastCue.endTime > 1) {
        chapters.push(new window.VTTCue(lastCue.endTime, duration(), ''));
      }
    }

    return chapters;
  }

  #watchSource() {
    const { source } = this.#media.$state;
    source();
    this.#onTrackChange();
  }

  #onTrackChange() {
    // Might run the "load" track event after the component is destroyed.
    if (!this.scope) return;

    const { disabled } = this.$props;

    if (disabled()) {
      this.#$cues.set([]);
      this.#activeIndex.set(0);
      this.#bufferedIndex = 0;
      return;
    }

    const track = this.#$track();

    if (track) {
      const onCuesChange = this.#onCuesChange.bind(this);

      onCuesChange();

      new EventsController(track).add('add-cue', onCuesChange).add('remove-cue', onCuesChange);

      effect(this.#watchMediaDuration.bind(this));
    }

    this.#titleRef = this.#findChapterTitleRef();
    if (this.#titleRef) effect(this.#onChapterTitleChange.bind(this));

    return () => {
      if (this.#titleRef) {
        this.#titleRef.textContent = '';
        this.#titleRef = null;
      }
    };
  }

  #watchMediaDuration() {
    this.#media.$state.duration();
    this.#onCuesChange();
  }

  #onCuesChange = debounce(
    () => {
      const track = peek(this.#$track);

      if (!this.scope || !track || !track.cues.length) return;

      this.#$cues.set(this.#fillGaps(track.cues));
      this.#activeIndex.set(0);
      this.#bufferedIndex = 0;
    },
    150,
    true,
  );

  #onChapterTitleChange() {
    const cue = this.activePointerCue || this.activeCue;
    if (this.#titleRef) this.#titleRef.textContent = cue?.text || '';
  }

  #findParentSlider() {
    let node = this.el;
    while (node && node.getAttribute('role') !== 'slider') {
      node = node.parentElement;
    }
    return node;
  }

  #findChapterTitleRef() {
    const slider = this.#findParentSlider();
    return slider ? slider.querySelector<HTMLElement>('[data-part="chapter-title"]') : null;
  }
}

export interface SliderChaptersProps {
  /**
   * Whether chapters should be disabled.
   */
  disabled: boolean;
}

export interface SliderChaptersCSSVars {
  /**
   * The percentage of the chapter that is filled.
   */
  readonly 'chapter-fill': string;
  /**
   * The percentage of the chapter that has been buffered.
   */
  readonly 'chapter-progress': string;
}
