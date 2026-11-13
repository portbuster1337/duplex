import { render } from 'preact';
import { App } from './app';
import { initAppearance } from './appearance';
import './styles.css';

await initAppearance();
render(<App />, document.getElementById('app')!);
