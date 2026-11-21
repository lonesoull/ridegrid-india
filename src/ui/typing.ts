/** True when a key press is someone typing (incl. inside Google's search box, whose field is in a shadow DOM). */
export function isTyping(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof HTMLElement && (n.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || n.tagName.includes('-')));
}
