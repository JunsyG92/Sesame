import { mount } from '../lib/bootstrap';
import { Launcher } from './Launcher';

mount(window.sesame, ({ settings, status }) => (
  <Launcher settings={settings} mac={status.platform === 'darwin'} />
));
