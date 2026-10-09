const RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000];

export function connectEvents({
  url,
  token,
  onEvent = () => {},
  onState = () => {},
  onDiagnostic = () => {},
  WebSocketImpl = globalThis.WebSocket,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let socket;
  let reconnectTimer;
  let reconnectIndex = 0;
  let disposed = false;
  let state;

  const setState = next => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  const diagnostic = (event, details = {}) => {
    try { onDiagnostic({event, ...details}); } catch { /* 诊断不得中断连接 */ }
  };
  const connect = () => {
    if (disposed) return;
    const endpoint = new URL(url, globalThis.location?.href);
    endpoint.searchParams.set('token', token);
    diagnostic('connecting', {attempt:reconnectIndex});
    const nextSocket = new WebSocketImpl(endpoint);
    let opened = false;
    socket = nextSocket;
    nextSocket.addEventListener('open', () => {
      if (disposed || socket !== nextSocket) return;
      opened = true;
      diagnostic('open', {attempt:reconnectIndex});
      reconnectIndex = 0;
      setState('online');
    });
    nextSocket.addEventListener('message', event => {
      if (disposed || socket !== nextSocket) return;
      try {
        onEvent(JSON.parse(event.data));
      } catch {
        // 非 JSON 事件不属于 Deck 协议，安全忽略。
      }
    });
    nextSocket.addEventListener('error', () => {
      if (!disposed && socket === nextSocket) diagnostic('socket-error', {opened});
    });
    nextSocket.addEventListener('close', event => {
      if (disposed || socket !== nextSocket || reconnectTimer !== undefined) return;
      diagnostic('close', {code:event.code, wasClean:event.wasClean, opened});
      setState('offline');
      const delay = RECONNECT_DELAYS[Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
      reconnectIndex += 1;
      diagnostic('reconnect-scheduled', {attempt:reconnectIndex, delayMs:delay});
      reconnectTimer = setTimer(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    });
  };

  setState('offline');
  connect();

  return {
    send(message) {
      if (socket?.readyState !== WebSocketImpl.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimer(reconnectTimer);
        reconnectTimer = undefined;
      }
      const currentSocket = socket;
      socket = undefined;
      currentSocket?.close();
    },
  };
}
