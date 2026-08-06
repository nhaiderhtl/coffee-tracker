// Preloaded before every client test file (see ../../bunfig.toml).
//
// Bun's test runner has no DOM. happy-dom's global registrator installs
// `document`, `window`, `localStorage` and friends onto globalThis so
// @testing-library/react can render into a real tree. happy-dom over jsdom
// because it is markedly faster and this suite only needs standard DOM, not
// jsdom's deeper browser emulation.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// ORDER IS LOAD-BEARING. @testing-library/dom captures `document.body` at
// module-eval time to build `screen`, so importing it before the DOM exists
// leaves every screen.* query throwing "a global document has to be
// available". Static ESM imports are hoisted, so testing-library CANNOT be a
// top-level import here — it has to be pulled in after register() below.
GlobalRegistrator.register();

const { afterEach } = await import('bun:test');
const { cleanup } = await import('@testing-library/react');

// React 19 + Testing Library: unmount between tests so a component's effects
// and timers cannot leak into the next one.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
