export function getAntiFlickerSnippet(maxHideMs: number = 3000): string {
  return "(function(){var t=setTimeout(function(){document.documentElement.style.opacity='1'}," +
    maxHideMs +
    ");document.documentElement.style.opacity='0';window.__ab_reveal=function(){clearTimeout(t);document.documentElement.style.opacity='1'};})()";
}

export function revealPage(): void {
  if (typeof window !== 'undefined' && typeof window.__ab_reveal === 'function') {
    window.__ab_reveal();
  }
}
