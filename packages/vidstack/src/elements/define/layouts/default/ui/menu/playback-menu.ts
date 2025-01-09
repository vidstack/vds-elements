import { html } from 'lit-html';
import { computed } from 'maverick.js';
import { isArray } from 'maverick.js/std';

import { useDefaultLayoutContext } from '../../../../../../components/layouts/default/context';
import { i18n } from '../../../../../../components/layouts/default/translations';
import { useMediaContext, useMediaState } from '../../../../../../core/api/media-context';
import { sortVideoQualities } from '../../../../../../core/quality/utils';
import { $signal } from '../../../../../lit/directives/signal';
import { $i18n } from '../utils';
import { DefaultMenuCheckbox } from './items/menu-checkbox';
import { DefaultMenuButton, DefaultMenuItem, DefaultMenuSection } from './items/menu-items';
import { DefaultMenuSliderItem, DefaultSliderParts, DefaultSliderSteps } from './items/menu-slider';

export function DefaultPlaybackMenu() {
  return $signal(() => {
    const { flatSettingsMenu, noMediaLoop, noMediaSpeed, noMediaQuality, translations } =
      useDefaultLayoutContext();

    const items: any[] = [];

    if (!noMediaLoop()) {
      items.push(
        DefaultMenuSection({
          children: DefaultLoopCheckbox(),
        }),
      );
    }
    if (!noMediaSpeed()) {
      items.push(DefaultSpeedMenuSection());
    }
    if (!noMediaQuality()) {
      items.push(DefaultQualityMenuSection());
    }

    if (!items.length) return null;

    if (flatSettingsMenu()) return items;

    return html`
      <media-menu class="vds-playback-menu vds-menu">
        ${DefaultMenuButton({
          label: () => i18n(translations, 'Playback'),
          icon: 'menu-playback',
        })}
        <media-menu-items class="vds-menu-items">
          ${items}
        </media-menu-items>
      </media-menu>
    `;
  });
}

function DefaultLoopCheckbox() {
  const { remote } = useMediaContext(),
    { translations } = useDefaultLayoutContext(),
    label = 'Loop';

  return DefaultMenuItem({
    label: $i18n(translations, label),
    children: DefaultMenuCheckbox({
      label,
      storageKey: 'vds-player::user-loop',
      onChange(checked, trigger) {
        remote.userPrefersLoopChange(checked, trigger);
      },
    }),
  });
}

function DefaultSpeedMenuSection() {
  return $signal(() => {
    const { translations } = useDefaultLayoutContext(),
      { canSetPlaybackRate, playbackRate } = useMediaState();

    if (!canSetPlaybackRate()) return null;

    return DefaultMenuSection({
      label: $i18n(translations, 'Speed'),
      value: $signal(() =>
        playbackRate() === 1 ? i18n(translations, 'Normal') : playbackRate() + 'x',
      ),
      children: [
        DefaultMenuSliderItem({
          upIcon: 'menu-speed-up',
          downIcon: 'menu-speed-down',
          children: DefaultSpeedSlider(),
          isMin: () => playbackRate() === getSpeedMin(),
          isMax: () => playbackRate() === getSpeedMax(),
        }),
      ],
    });
  });
}

function getSpeedMin() {
  const { playbackRates } = useDefaultLayoutContext(),
    rates = playbackRates();
  return isArray(rates) ? rates[0] ?? 0 : rates.min;
}

function getSpeedMax() {
  const { playbackRates } = useDefaultLayoutContext(),
    rates = playbackRates();
  return isArray(rates) ? rates[rates.length - 1] ?? 2 : rates.max;
}

function getSpeedStep() {
  const { playbackRates } = useDefaultLayoutContext(),
    rates = playbackRates();
  return isArray(rates) ? rates[1] - rates[0] || 0.25 : rates.step;
}

function DefaultSpeedSlider() {
  const { translations } = useDefaultLayoutContext(),
    $label = $i18n(translations, 'Speed'),
    $min = getSpeedMin,
    $max = getSpeedMax,
    $step = getSpeedStep;

  return html`
    <media-speed-slider
      class="vds-speed-slider vds-slider"
      aria-label=${$label}
      min=${$signal($min)}
      max=${$signal($max)}
      step=${$signal($step)}
      key-step=${$signal($step)}
    >
      ${DefaultSliderParts()}${DefaultSliderSteps()}
    </media-speed-slider>
  `;
}
function DefaultAutoQualityCheckbox() {
  const { remote, qualities } = useMediaContext(),
    { autoQuality, canSetQuality, qualities: $qualities } = useMediaState(),
    { translations } = useDefaultLayoutContext(),
    label = 'Auto',
    $disabled = computed(() => !canSetQuality() || $qualities().length <= 1);

  if ($disabled()) return null;

  return DefaultMenuItem({
    label: $i18n(translations, label),
    children: DefaultMenuCheckbox({
      label,
      checked: autoQuality,
      onChange(checked, trigger) {
        if (checked) {
          remote.requestAutoQuality(trigger);
        } else {
          remote.changeQuality(qualities.selectedIndex, trigger);
        }
      },
    }),
  });
}

function DefaultQualityMenuSection() {
  return $signal(() => {
    const { hideQualityBitrate, translations } = useDefaultLayoutContext(),
      { canSetQuality, qualities, quality } = useMediaState(),
      $disabled = computed(() => !canSetQuality() || qualities().length <= 1),
      $sortedQualities = computed(() => sortVideoQualities(qualities()));

    if ($disabled()) return null;

    return DefaultMenuSection({
      label: $i18n(translations, 'Quality'),
      value: $signal(() => {
        const height = quality()?.height,
          bitrate = !hideQualityBitrate() ? quality()?.bitrate : null,
          bitrateText = bitrate && bitrate > 0 ? `${(bitrate / 1000000).toFixed(2)} Mbps` : null,
          autoText = i18n(translations, 'Auto');
        return height ? `${height}p${bitrateText ? ` (${bitrateText})` : ''}` : autoText;
      }),
      children: [
        DefaultMenuSliderItem({
          upIcon: 'menu-quality-up',
          downIcon: 'menu-quality-down',
          children: DefaultQualitySlider(),
          isMin: () => $sortedQualities()[0] === quality(),
          isMax: () => $sortedQualities().at(-1) === quality(),
        }),
        DefaultAutoQualityCheckbox(),
      ],
    });
  });
}

function DefaultQualitySlider() {
  const { translations } = useDefaultLayoutContext(),
    $label = $i18n(translations, 'Quality');
  return html`
    <media-quality-slider class="vds-quality-slider vds-slider" aria-label=${$label}>
      ${DefaultSliderParts()}${DefaultSliderSteps()}
    </media-quality-slider>
  `;
}
