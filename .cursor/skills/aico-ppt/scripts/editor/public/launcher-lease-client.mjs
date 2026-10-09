function leaseSocketUrl(workspaceUrl, clientId, sequence) {
  const url = new URL('/launcher-lease', workspaceUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', workspaceUrl.searchParams.get('token') ?? '');
  url.searchParams.set('clientId', clientId);
  url.searchParams.set('sequence', String(sequence));
  return url;
}

export function createLauncherLeaseClient({
  workspaceUrl,
  clientId,
  sequence,
  reconnectDelayMs = 250,
} = {}) {
  if (!(workspaceUrl instanceof URL)) throw new TypeError('workspaceUrl 必须是 URL');
  if (typeof clientId !== 'string' || !clientId
    || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('页面租约身份无效');
  }
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;

  const connect = () => {
    if (stopped || socket) return;
    const candidate = new WebSocket(leaseSocketUrl(workspaceUrl, clientId, sequence));
    socket = candidate;
    candidate.addEventListener('close', event => {
      if (socket === candidate) socket = null;
      if (event.code === 1008) {
        stopped = true;
        return;
      }
      if (stopped) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });
  };

  return {
    start() { connect(); },
    close() {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
  };
}
