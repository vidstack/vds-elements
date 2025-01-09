import { html } from 'lit-html';
import { computed } from 'maverick.js';

import { useDefaultLayoutContext } from '../../../../../../components/layouts/default/context';
import { i18n } from '../../../../../../components/layouts/default/translations';
import { useMediaState } from '../../../../../../core/api/media-context';
import { $signal } from '../../../../../lit/directives/signal';
import { $i18n } from '../utils';
import { DefaultFontMenu } from './font-menu';
import { DefaultMenuCheckbox } from './items/menu-checkbox';
import { DefaultMenuButton, DefaultMenuItem, DefaultMenuSection } from './items/menu-items';

export function DefaultAccessibilityMenu() {
  return $signal(() => {
    const {
      flatSettingsMenu,
      noAnnouncements,
      noKeyboardAnimations,
      noCaptionStyles,
      translations,
    } = useDefaultLayoutContext();

    if (flatSettingsMenu()) {
      const items: any[] = [];
      if (!noAnnouncements()) {
        items.push(DefaultAnnouncementsMenuCheckbox());
      }
      if (!noKeyboardAnimations()) {
        items.push(DefaultKeyboardAnimationsMenuCheckbox());
      }
      if (!noCaptionStyles()) {
        items.push(DefaultFontMenu());
      }

      return items.length
        ? DefaultMenuSection({
            label: i18n(translations, 'Accessibility'),
            children: items,
          })
        : null;
    }

    const items: any[] = [];
    const topItems: any[] = [];
    const bottomItems: any[] = [];

    if (!noAnnouncements()) {
      topItems.push(DefaultAnnouncementsMenuCheckbox());
    }
    if (!noKeyboardAnimations()) {
      topItems.push(DefaultKeyboardAnimationsMenuCheckbox());
    }
    if (!noCaptionStyles()) {
      bottomItems.push(DefaultFontMenu());
    }

    if (topItems.length) {
      items.push(
        DefaultMenuSection({
          children: topItems,
        }),
      );
    }
    if (bottomItems.length) {
      items.push(
        DefaultMenuSection({
          children: bottomItems,
        }),
      );
    }

    if (!items.length) return null;

    return html`
      <media-menu class="vds-accessibility-menu vds-menu">
        ${DefaultMenuButton({
          label: () => i18n(translations, 'Accessibility'),
          icon: 'menu-accessibility',
        })}
        <media-menu-items class="vds-menu-items"> ${items} </media-menu-items>
      </media-menu>
    `;
  });
}

function DefaultAnnouncementsMenuCheckbox() {
  const { userPrefersAnnouncements, translations } = useDefaultLayoutContext(),
    label = 'Announcements';

  return DefaultMenuItem({
    label: $i18n(translations, label),
    children: DefaultMenuCheckbox({
      label,
      storageKey: 'vds-player::announcements',
      onChange(checked) {
        userPrefersAnnouncements.set(checked);
      },
    }),
  });
}

function DefaultKeyboardAnimationsMenuCheckbox() {
  return $signal(() => {
    const { translations, userPrefersKeyboardAnimations, noKeyboardAnimations } =
        useDefaultLayoutContext(),
      { viewType } = useMediaState(),
      $disabled = computed(() => viewType() !== 'video' || noKeyboardAnimations());

    if ($disabled()) return null;

    const label = 'Keyboard Animations';

    return DefaultMenuItem({
      label: $i18n(translations, label),
      children: DefaultMenuCheckbox({
        label,
        defaultChecked: true,
        storageKey: 'vds-player::keyboard-animations',
        onChange(checked) {
          userPrefersKeyboardAnimations.set(checked);
        },
      }),
    });
  });
}
