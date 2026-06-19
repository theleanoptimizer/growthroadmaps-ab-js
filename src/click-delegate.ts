type ClickHandler = (e: MouseEvent) => void;

const handlers: ClickHandler[] = [];
let attached = false;

function dispatch(e: MouseEvent): void {
  for (const h of handlers) h(e);
}

/** Single capture-phase document click listener; handlers run in registration order. */
export function registerClickHandler(fn: ClickHandler): () => void {
  handlers.push(fn);
  if (!attached && typeof document !== 'undefined') {
    document.addEventListener('click', dispatch, { capture: true, passive: true });
    attached = true;
  }
  return () => {
    const idx = handlers.indexOf(fn);
    if (idx >= 0) handlers.splice(idx, 1);
    if (handlers.length === 0 && attached && typeof document !== 'undefined') {
      document.removeEventListener('click', dispatch, true);
      attached = false;
    }
  };
}
