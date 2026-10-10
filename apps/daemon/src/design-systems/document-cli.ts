import type { DesignSystemDocumentWrite } from '@open-design/contracts';

/** Manual document commands share the standard HTTP surface with the editor.
 * File/stdin input and pinned session transport are supplied by the CLI shell.
 */
export async function runDesignSystemDocumentCli(input: {
  operation: 'create' | 'update' | 'delete'; id?: string; document: DesignSystemDocumentWrite;
  base: string; fetch: typeof fetch; json: boolean;
  failure(response: Response): Promise<unknown>; write(value: unknown): void;
}): Promise<void> {
  const { operation, id, document } = input;
  if (operation !== 'create' && !id) throw new Error('A design system id is required');
  if (operation === 'create' && !document.body?.trim()) throw new Error('Creation requires DESIGN.md content through --prompt-file <path|->');
  if (operation === 'update' && Object.keys(document).length === 0) throw new Error('Update requires a document field');
  const url = `${input.base}/api/design-systems${operation === 'create' ? '' : `/${encodeURIComponent(id!)}`}`;
  const response = await input.fetch(url, { method: operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation === 'delete' ? {} : document) });
  if (!response.ok) { await input.failure(response); return; }
  const result = await response.json() as { designSystem?: { id: string; title: string } };
  if (input.json) input.write(result);
  else process.stdout.write(result.designSystem ? `${result.designSystem.id}\t${result.designSystem.title}\n` : `Deleted ${id}\n`);
}
