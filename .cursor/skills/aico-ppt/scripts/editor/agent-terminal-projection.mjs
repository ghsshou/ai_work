import headlessPackage from '@xterm/headless';
import serializePackage from '@xterm/addon-serialize';

const { Terminal } = headlessPackage;
const { SerializeAddon } = serializePackage;

export function createAgentTerminalProjection({ cols = 80, rows = 24 } = {}) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500
    || !Number.isInteger(rows) || rows < 2 || rows > 300) {
    throw new TypeError('终端投影尺寸无效');
  }
  const terminal = new Terminal({
    allowProposedApi:true,
    cols,
    rows,
    // 恢复目标只是最终 framebuffer；不保留历史 scrollback，避免把几十 MB
    // rollout 再复制一份到服务端内存。
    scrollback:0,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  let disposed = false;
  return {
    write(data) {
      if (!disposed && typeof data === 'string' && data) terminal.write(data);
    },
    resize(nextCols, nextRows) {
      if (disposed || !Number.isInteger(nextCols) || !Number.isInteger(nextRows)
        || nextCols < 2 || nextCols > 500 || nextRows < 2 || nextRows > 300) return;
      terminal.resize(nextCols, nextRows);
    },
    snapshot() {
      if (disposed) return Promise.resolve('');
      return new Promise((resolve, reject) => {
        terminal.write('', () => {
          try {
            resolve(serializer.serialize({ scrollback:0 }));
          } catch (error) {
            reject(error);
          }
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
    },
  };
}
