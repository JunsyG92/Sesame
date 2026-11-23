import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mount } from '../../../src/renderer/lib/bootstrap';
import { mainStrings } from '../../../src/shared/i18n/main';
import { FakeApi, ok, SETTINGS, STATUS } from './fakeApi';

describe('bootstrap', () => {
  it('waits for settings and status, then applies the language and the theme', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const api = new FakeApi({
      'settings:get': () => ok({ ...SETTINGS, theme: 'dark' }),
      'app:status': () => ok({ ...STATUS, locale: 'fr' }),
    });
    act(() => {
      mount(api, ({ status }) => <p>locale={status.locale}</p>);
    });
    expect(await screen.findByText('locale=fr')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('fr');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    act(() => {
      api.emit('status:changed', { ...STATUS, locale: 'en' });
    });
    expect(await screen.findByText('locale=en')).toBeInTheDocument();
  });

  it('fails loudly without a root element', () => {
    document.body.innerHTML = '';
    expect(() => {
      mount(new FakeApi(), () => null);
    }).toThrow('#root missing');
  });
});

describe('tray strings', () => {
  it('exist in both languages', () => {
    expect(mainStrings.fr.clearNow(12)).toBe('Effacer le presse-papiers (encore 12 s)');
    expect(mainStrings.en.clearingIn(3)).toBe('Sesame — clipboard cleared in 3 s');
    expect(mainStrings.en.clearNow(1)).toContain('1 s left');
    expect(mainStrings.fr.clearingIn(5)).toContain('5 s');
  });
});
