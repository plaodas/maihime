export function isMobileDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone/i.test(navigator.userAgent);
}
