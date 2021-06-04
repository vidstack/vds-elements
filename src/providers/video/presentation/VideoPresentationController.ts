import { PropertyValues } from 'lit-element';

import {
	DisposalBin,
	listen,
	redispatchNativeEvent,
	WithEvents
} from '../../../shared/events';
import { WebKitPresentationMode } from '../../../ts/media';
import { Unsubscribe } from '../../../ts/utils';
import { IS_IOS } from '../../../utils/support';
import { isFunction, isNil, noop } from '../../../utils/unit';
import { VideoPresentationControllerEvents } from './VideoPresentationControllerEvents';
import { VideoPresentationControllerHost } from './VideoPresentationControllerHost';

/**
 * Contains the logic for handling presentation modes on Safari. This class is used by
 * the `VideoFullscreenController` as a fallback when the native Fullscreen API is not
 * available (ie: iOS Safari).
 *
 * @example
 * ```ts
 * class MyElement extends LitElement implements PresentationControllerHost {
 *   presentationController = new PresentationController(this);
 *
 *   get videoElement(): HTMLVideoElement | undefined {
 *     return this.videoEl;
 *   }
 * }
 * ```
 */
export class VideoPresentationController extends WithEvents<VideoPresentationControllerEvents>(
	class {}
) {
	protected disposal = new DisposalBin();

	constructor(protected host: VideoPresentationControllerHost) {
		super();

		const firstUpdated = (host as any).firstUpdated;
		(host as any).firstUpdated = (changedProperties: PropertyValues) => {
			firstUpdated?.call(host, changedProperties);
			this.disposal.add(this.addPresentationModeChangeEventListener());
		};

		const disconnectedCallback = host.disconnectedCallback;
		host.disconnectedCallback = async () => {
			await this.destroy();
			disconnectedCallback?.call(host);
		};
	}

	/**
	 * The current presentation mode, possible values include `inline`, `picture-in-picture` and
	 * `fullscreen`. Only available in Safari.
	 *
	 * @default undefined
	 * @link https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1631913-webkitpresentationmode
	 */
	get presentationMode(): WebKitPresentationMode | undefined {
		return this.host.videoElement?.webkitPresentationMode;
	}

	/**
	 * Whether the current `presentationMode` is `inline`.
	 */
	get isInlineMode(): boolean {
		return this.presentationMode === 'inline';
	}

	/**
	 * Whether the current `presentationMode` is `picture-in-picture`.
	 */
	get isPictureInPictureMode(): boolean {
		return this.presentationMode === 'inline';
	}

	/**
	 * Whether the current `presentationMode` is `fullscreen`.
	 */
	get isFullscreenMode(): boolean {
		return this.presentationMode === 'fullscreen';
	}

	/**
	 * Whether the presentation mode API is available.
	 *
	 * @link https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1628805-webkitsupportsfullscreen
	 */
	get isSupported(): boolean {
		return (
			IS_IOS &&
			isFunction(this.host.videoElement?.webkitSetPresentationMode) &&
			(this.host.videoElement?.webkitSupportsFullscreen ?? false)
		);
	}

	setPresentationMode(mode: WebKitPresentationMode): void {
		this.host.videoElement?.webkitSetPresentationMode?.(mode);
	}

	destroy(): void {
		this.setPresentationMode('inline');
		this.disposal.empty();
		super.destroy();
	}

	protected addPresentationModeChangeEventListener(): Unsubscribe {
		if (!this.isSupported || isNil(this.host.videoElement)) return noop;
		return listen(
			this.host.videoElement,
			'webkitpresentationmodechanged',
			this.handlePresentationModeChange.bind(this)
		);
	}

	protected handlePresentationModeChange(originalEvent: Event): void {
		redispatchNativeEvent(this.host, originalEvent);
		this.dispatchEvent('presentation-mode-change', {
			detail: this.presentationMode,
			originalEvent
		});
	}
}
