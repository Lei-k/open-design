/** Transient UI focus. Multi-user daemons isolate this by authenticated session. */
export type ActiveContextWriteRequest =
  | { active: false }
  | { projectId: string; fileName?: string | null };

export type ActiveContextWriteResponse =
  | { active: false }
  | { active: true; projectId: string; fileName: string | null; ts: number };

export type ActiveContextReadResponse =
  | { active: false }
  | { active: true; projectId: string; projectName: string | null; fileName: string | null; ts: number; ageMs: number };

export interface RunContextSelection {
  skillIds?: string[];
  pluginIds?: string[];
  mcpServerIds?: string[];
  connectorIds?: string[];
  workspaceItems?: WorkspaceContextItem[];
}

export type WorkspaceContextKind =
  | 'design-files'
  | 'design-system'
  | 'project'
  | 'local-code'
  | 'file'
  | 'folder'
  | 'project'
  | 'local-code'
  | 'browser'
  | 'terminal'
  | 'side-chat'
  | 'live-artifact';

export interface WorkspaceContextItem {
  id: string;
  kind: WorkspaceContextKind;
  label: string;
  tabId?: string;
  path?: string;
  absolutePath?: string;
  url?: string;
  title?: string;
}

export interface ProjectContextPluginRef {
  id: string;
  title: string;
  description?: string;
}

export interface ProjectContextMcpServerRef {
  id: string;
  label?: string;
  transport?: string;
  url?: string;
  command?: string;
}

export interface ProjectContextConnectorRef {
  id: string;
  name: string;
  provider?: string;
  category?: string;
  description?: string;
  status?: string;
  accountLabel?: string;
}
