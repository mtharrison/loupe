import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/app';
import './src/styles.css';

const rootElement = document.getElementById('app');

if (!rootElement) {
  throw new Error('Missing #app mount node.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
