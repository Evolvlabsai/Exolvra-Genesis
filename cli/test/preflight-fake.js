/** An external SDK fixture, shared without replacing any CLI behaviour. */
export const PREFLIGHT_FAKE = String.raw`
  if (prompt.startsWith('GENESIS_EXECUTION_PREFLIGHT\n')) {
    const command = prompt.split('\n').at(-1);
    const marker = command.match(/'(genesis-preflight-[^']+)'$/)[1];
    const denied = process.env.GENESIS_TEST_PREFLIGHT_OUTCOME === 'denied-all' ||
      (process.env.GENESIS_TEST_PREFLIGHT_OUTCOME === 'denied' && options.permissionMode !== 'bypassPermissions');
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', session_id: 'probe', message: { content: [
          { type: 'tool_use', id: 'probe-command', name: 'Bash', input: { command } }
        ] } };
        yield { type: 'user', session_id: 'probe', message: { content: [
          { type: 'tool_result', tool_use_id: 'probe-command', is_error: denied,
            content: denied ? 'Permission denied' : marker + '\n' }
        ] } };
        yield { type: 'result', subtype: 'success', session_id: 'probe', num_turns: 1,
          total_cost_usd: 0, result: 'probe complete', errors: [], permission_denials: [],
          usage: { input_tokens: 0, output_tokens: 0 } };
      }
    };
  }
`;
