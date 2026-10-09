export function isRegionShortcutKey(event) {
  return event.code === 'KeyR' || event.key?.toLowerCase() === 'r';
}
