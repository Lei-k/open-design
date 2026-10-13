import type { DaemonAgentPayload, MultiUserRunProgressEvent } from '@open-design/contracts';

/** Legacy cards are a view of the standard stream, never another event log. */
export function runProgress(event: DaemonAgentPayload, tools: Map<string, { name: string; path?: string }>): MultiUserRunProgressEvent[] {
  if (event.type === 'tool_use') {
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
    if (/todo|update_plan/iu.test(event.name) && Array.isArray(input.todos)) {
      return [{ kind: 'todo', items: input.todos.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const todo = item as Record<string, unknown>;
        return typeof todo.content === 'string' ? [{ content: todo.content, status: String(todo.status ?? 'pending') }] : [];
      }) }];
    }
    tools.set(event.id, { name: event.name, ...(typeof input.file_path === 'string' ? { path: input.file_path } : {}) });
    if (/^(Bash|Shell|exec_command|shell_command)$/u.test(event.name)) return [{ kind: 'command', name: event.name, status: 'started' }];
  }
  if (event.type === 'tool_result') {
    const tool = tools.get(event.toolUseId); tools.delete(event.toolUseId);
    if (tool?.path && !event.isError) return [{ kind: 'file', path: tool.path, status: 'changed' }];
    if (tool && /^(Bash|Shell|exec_command|shell_command)$/u.test(tool.name)) return [{ kind: 'command', name: tool.name, status: event.isError ? 'failed' : 'completed' }];
  }
  return [];
}
