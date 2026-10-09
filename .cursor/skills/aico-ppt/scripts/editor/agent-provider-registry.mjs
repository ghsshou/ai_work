const DEFINITIONS = Object.freeze([
  Object.freeze({
    id:'codex', label:'Codex',
    terminal:Object.freeze({
      executable:'codex',
      args:Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
    }),
  }),
  Object.freeze({
    id:'claude-code', label:'Claude Code',
    terminal:Object.freeze({
      executable:'claude',
      args:Object.freeze(['--dangerously-skip-permissions']),
    }),
  }),
  Object.freeze({
    id:'opencode', label:'OpenCode',
    terminal:Object.freeze({ executable:'opencode', args:Object.freeze([]) }),
  }),
]);

const BY_ID = new Map(DEFINITIONS.map(value => [value.id, value]));

export const AGENT_PROVIDER_IDS = Object.freeze(DEFINITIONS.map(value => value.id));

export function isAgentProviderId(value) {
  return typeof value === 'string' && BY_ID.has(value);
}

export function agentProviderDefinition(provider) {
  const definition = BY_ID.get(provider);
  if (!definition) {
    throw Object.assign(new Error(`不支持的终端 Agent：${String(provider)}`), {
      code:'AGENT_PROVIDER_UNAVAILABLE',
    });
  }
  return definition;
}

export function publicAgentProviders() {
  return DEFINITIONS.map(({ id, label }) => ({ id, label }));
}

export function buildRegisteredTerminalCommand(provider, {
  platform = process.platform,
  conversationId = null,
  resume = false,
} = {}) {
  const definition = agentProviderDefinition(provider);
  let args;
  if (definition.id === 'codex' && conversationId) {
    args = ['resume', ...definition.terminal.args, conversationId];
  } else if (definition.id === 'claude-code' && conversationId) {
    args = [
      ...definition.terminal.args,
      resume ? '--resume' : '--session-id',
      conversationId,
    ];
  } else if (definition.id === 'opencode' && conversationId) {
    args = ['--session', conversationId, ...definition.terminal.args];
  } else {
    args = [...definition.terminal.args];
  }
  return {
    provider:definition.id,
    label:definition.label,
    executable:platform === 'win32'
      ? `${definition.terminal.executable}.cmd`
      : definition.terminal.executable,
    args,
  };
}
