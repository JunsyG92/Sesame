import { mount } from '../lib/bootstrap';
import { Manager } from './Manager';

mount(window.sesame, ({ settings, status }) => <Manager settings={settings} status={status} />);
