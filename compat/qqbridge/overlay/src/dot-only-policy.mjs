// Pure Dot mode has no DSH process, authentication, probes or event stream.
export function applyDotOnlyPolicy(cfg) {
  if (cfg.dot?.only !== true) return false;
  if (cfg.dot.enabled !== true) throw new Error('dot.only requires dot.enabled=true.');
  if (cfg.allowAllWhenEmpty === true)
    throw new Error('Pure Dot mode requires explicit conversation allowlists.');
  const keys = [];
  for (const [kind, plural] of [
    ['group', 'groups'],
    ['private', 'privates'],
  ]) {
    const denied = new Set((cfg.deny?.[kind] ?? cfg.deny?.[plural] ?? []).map(String));
    for (const id of cfg.allow?.[kind] ?? cfg.allow?.[plural] ?? []) {
      const value = String(id);
      if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid Dot conversation allowlist.');
      if (!denied.has(value)) keys.push(kind + ':' + value);
    }
  }
  cfg.dot.conversations = [...new Set(keys)];
  cfg.slang = { ...cfg.slang, enabled: false }; // The old learner executes DSH jobs.
  return true;
}

export function createDisabledDshClient() {
  const disabled = () => {
    throw Object.assign(
      new Error('DSH 已撤下；当前使用 Dot 后端，请在 ChatGPT 中管理模型与任务。'),
      { code: 'DSH_DISABLED', statusCode: 503 },
    );
  };
  return {
    settings: { describe: disabled, update: disabled },
    agentPresets: { list: disabled },
    workspace: { create: disabled, rename: disabled, archiveSession: disabled },
    sessions: { create: disabled, list: disabled, selectModel: disabled, prompt: disabled },
    events: {
      follow() {},
      forget() {},
      async *mux() {
        disabled();
      },
    },
    callUnary: disabled,
    stopSessionWork: disabled,
    respond: disabled,
  };
}
