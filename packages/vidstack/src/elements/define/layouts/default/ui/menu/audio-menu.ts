import { html } from 'lit-html';
import { computed } from 'maverick.js';
import { isArray } from 'maverick.js/std';

import { useDefaultLayoutContext } from '../../../../../../components/layouts/default/context';
import { i18n } from '../../../../../../components/layouts/default/translations';
import { useMediaState } from '../../../../../../core/api/media-context';
import { $signal } from '../../../../../lit/directives/signal';
import { $i18n } from '../utils';
import { DefaultMenuButton, DefaultMenuSection } from './items/menu-items';
import { DefaultMenuSliderItem, DefaultSliderParts, DefaultSliderSteps } from './items/menu-slider';

export function DefaultAudioMenu() {
  return $signal(() => {
    const { flatSettingsMenu, noAudioGain, noAudioTracks, translations } =
        useDefaultLayoutContext(),
      { audioTracks, canSetAudioGain } = useMediaState(),
      $disabled = computed(() => {
        const hasGainSlider = canSetAudioGain() && !noAudioGain();
        return !hasGainSlider && audioTracks().length <= 1;
      });

    if ($disabled()) return null;

    const items: any[] = [];
    if (!noAudioGain()) {
      items.push(DefaultAudioBoostSection());
    }
    if (!noAudioTracks()) {
      items.push(DefaultAudioTracksMenu());
    }

    if (!items.length) {
      return null;
    }

    if (flatSettingsMenu())
      return [
        DefaultMenuSection({
          label: i18n(translations, 'Audio'),
          children: items,
        }),
      ];

    return html`
      <media-menu class="vds-audio-menu vds-menu">
        ${DefaultMenuButton({
          label: () => i18n(translations, 'Audio'),
          icon: 'menu-audio',
        })}
        <media-menu-items class="vds-menu-items"> ${items} </media-menu-items>
      </media-menu>
    `;
  });
}

function DefaultAudioTracksMenu() {
  return $signal(() => {
    const { translations } = useDefaultLayoutContext(),
      { audioTracks } = useMediaState(),
      $defaultText = $i18n(translations, 'Default'),
      $disabled = computed(() => audioTracks().length <= 1);

    if ($disabled()) return null;

    return DefaultMenuSection({
      children: html`
        <media-menu class="vds-audio-tracks-menu vds-menu">
          ${DefaultMenuButton({
            label: () => i18n(translations, 'Track'),
          })}
          <media-menu-items class="vds-menu-items">
            <media-audio-radio-group
              class="vds-audio-track-radio-group vds-radio-group"
              empty-label=${$defaultText}
            >
              <template>
                <media-radio class="vds-audio-track-radio vds-radio">
                  <slot name="menu-radio-check-icon" data-class="vds-icon"></slot>
                  <span class="vds-radio-label" data-part="label"></span>
                </media-radio>
              </template>
            </media-audio-radio-group>
          </media-menu-items>
        </media-menu>
      `,
    });
  });
}

function DefaultAudioBoostSection() {
  return $signal(() => {
    const { noAudioGain, translations } = useDefaultLayoutContext(),
      { canSetAudioGain } = useMediaState(),
      $disabled = computed(() => !canSetAudioGain() || noAudioGain());

    if ($disabled()) return null;

    const { audioGain } = useMediaState();

    return DefaultMenuSection({
      label: $i18n(translations, 'Boost'),
      value: $signal(() => Math.round(((audioGain() ?? 1) - 1) * 100) + '%'),
      children: [
        DefaultMenuSliderItem({
          upIcon: 'menu-audio-boost-up',
          downIcon: 'menu-audio-boost-down',
          children: DefaultAudioGainSlider(),
          isMin: () => ((audioGain() ?? 1) - 1) * 100 <= getGainMin(),
          isMax: () => ((audioGain() ?? 1) - 1) * 100 === getGainMax(),
        }),
      ],
    });
  });
}

function DefaultAudioGainSlider() {
  const { translations } = useDefaultLayoutContext(),
    $label = $i18n(translations, 'Boost'),
    $min = getGainMin,
    $max = getGainMax,
    $step = getGainStep;

  return html`
    <media-audio-gain-slider
      class="vds-audio-gain-slider vds-slider"
      aria-label=${$label}
      min=${$signal($min)}
      max=${$signal($max)}
      step=${$signal($step)}
      key-step=${$signal($step)}
    >
      ${DefaultSliderParts()}${DefaultSliderSteps()}
    </media-audio-gain-slider>
  `;
}

function getGainMin() {
  const { audioGains } = useDefaultLayoutContext(),
    gains = audioGains();
  return isArray(gains) ? (gains[0] ?? 0) : gains.min;
}

function getGainMax() {
  const { audioGains } = useDefaultLayoutContext(),
    gains = audioGains();
  return isArray(gains) ? (gains[gains.length - 1] ?? 300) : gains.max;
}

function getGainStep() {
  const { audioGains } = useDefaultLayoutContext(),
    gains = audioGains();
  return isArray(gains) ? gains[1] - gains[0] || 25 : gains.step;
}
