function shouldUseNativeClipboardPaste(event, platform) {
  const applePlatform = /^(Mac|iPhone|iPad|iPod)/i.test(platform ?? '');
  return !applePlatform && event.key.toLowerCase() === 'v'
    && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function shouldUseNativeClipboardCopy(event, platform, hasSelection) {
  const applePlatform = /^(Mac|iPhone|iPad|iPod)/i.test(platform ?? '');
  return !applePlatform && hasSelection && event.key.toLowerCase() === 'c'
    && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function shouldForwardTerminalKey(event, {
  platform = globalThis.navigator?.platform ?? '',
  hasSelection = false,
} = {}) {
  return !shouldUseNativeClipboardPaste(event, platform)
    && !shouldUseNativeClipboardCopy(event, platform, hasSelection);
}
