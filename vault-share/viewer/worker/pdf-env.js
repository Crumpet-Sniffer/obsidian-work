// Loaded before pdf.js. In Node, pdf.js tries to load a canvas package and to polyfill DOMMatrix and Path2D, which
// it needs only to render pages. The worker never renders (it reads text and decodes images), so stand-ins are
// given and the warning about the missing canvas package is not logged.
globalThis.DOMMatrix ??= class DOMMatrix {};
globalThis.Path2D ??= class Path2D {};
const warn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith('Warning: Cannot load "@napi-rs/canvas"')) return;
  warn(...args);
};
