let agentTerminalModulePromise = null;

/**
 * 仅在独立 Dev Shell 确实需要本机 Agent PTY 时加载原生终端依赖。
 * DSH 正式壳不能导入这个实现，否则 node-pty 会重新变成 Editor Core 的硬依赖。
 */
export async function createAgentTerminalSession(options) {
  agentTerminalModulePromise ??= import('./agent-terminal-session.mjs');
  const { AgentTerminalSession } = await agentTerminalModulePromise;
  return new AgentTerminalSession(options);
}
