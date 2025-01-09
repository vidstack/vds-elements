import { html } from 'lit-html';

import { useDefaultLayoutContext } from '../../../../../../components/layouts/default/context';
import { i18n } from '../../../../../../components/layouts/default/translations';
import { useMediaState } from '../../../../../../core/api/media-context';
import { $signal } from '../../../../../lit/directives/signal';
import { $i18n } from '../utils';
import { DefaultMenuButton, DefaultMenuSection } from './items/menu-items';

export function DefaultCaptionsMenu() {
  return $signal(() => {
    const { flatSettingsMenu, noCaptions, translations } = useDefaultLayoutContext(),
      { hasCaptions } = useMediaState();

    if (!hasCaptions() || noCaptions()) return null;

    if (flatSettingsMenu())
      return [
        DefaultMenuSection({
          label: i18n(translations, 'Captions'),
          children: [DefaultCaptionsMenuItems()],
        }),
      ];

    return html`
      <media-menu class="vds-captions-menu vds-menu">
        ${DefaultMenuButton({
          label: () => i18n(translations, 'Captions'),
          icon: 'menu-captions',
        })}
        <media-menu-items class="vds-menu-items"> ${DefaultCaptionsMenuItems()} </media-menu-items>
      </media-menu>
    `;
  });
}

function DefaultCaptionsMenuItems() {
  const { translations } = useDefaultLayoutContext(),
    $offText = $i18n(translations, 'Off');

  return html`
    <media-captions-radio-group
      class="vds-captions-radio-group vds-radio-group"
      off-label=${$offText}
    >
      <template>
        <media-radio class="vds-caption-radio vds-radio">
          <slot name="menu-radio-check-icon" data-class="vds-icon"></slot>
          <span class="vds-radio-label" data-part="label"></span>
        </media-radio>
      </template>
    </media-captions-radio-group>
  `;
}
