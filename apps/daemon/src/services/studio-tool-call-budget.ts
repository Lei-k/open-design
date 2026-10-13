/** S61 reservation shared by connectors and remote MCP: no await between count and reserve. */
const reserved = new Map<string, number>();
export function reserveStudioToolCall(runId: string, completed: number, limit: number): (() => void) | null {
  if (completed + (reserved.get(runId) ?? 0) >= limit) return null;
  reserved.set(runId, (reserved.get(runId) ?? 0) + 1);
  return () => {
    const left = (reserved.get(runId) ?? 1) - 1;
    if (left > 0) reserved.set(runId, left); else reserved.delete(runId);
  };
}
