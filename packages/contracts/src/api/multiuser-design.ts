import type { Conversation } from './projects.js';

/** Safe, body-free catalogue exposed only by the multi-user daemon. */
export interface MultiUserDesignCatalogSkill {
  id: string;
  name: string;
  displayName?: Record<string, string>;
  description: string;
  descriptionI18n?: Record<string, string>;
  mode: 'prototype' | 'deck' | 'template' | 'design-system' | 'image' | 'video' | 'audio';
  previewType: string;
  designSystemRequired: boolean;
}

export interface MultiUserDesignCatalogSystem {
  id: string;
  title: string;
  category: string;
  summary: string;
  swatches?: string[];
}

export interface MultiUserDesignCatalogResponse {
  skills: MultiUserDesignCatalogSkill[];
  designSystems: MultiUserDesignCatalogSystem[];
}

export interface MultiUserDesignSelection {
  conversationId: string;
  skillId: string;
  designSystemId: string;
  locale: string;
}

export interface CreateMultiUserDesignConversationRequest {
  title?: string | null;
  skillId: string;
  designSystemId: string;
  locale?: string;
}

export interface CreateMultiUserDesignConversationResponse {
  conversation: Conversation;
  design: MultiUserDesignSelection;
}

export interface MultiUserDesignSelectionResponse {
  design: MultiUserDesignSelection;
}

export interface MultiUserDesignSelectionsResponse {
  designs: MultiUserDesignSelection[];
}

export interface MultiUserPreviewUrlResponse {
  url: string;
  /** Main-app-origin endpoint used by the authenticated host to extend this scope. */
  renewUrl: string;
  expiresAt: number;
}

export interface MultiUserPreviewRenewResponse {
  expiresAt: number;
}

export type MultiUserRunProgressEvent =
  | { kind: 'file'; path: string; status: 'changed' }
  | { kind: 'command'; name: string; status: 'started' | 'completed' | 'failed' }
  | { kind: 'todo'; items: Array<{ content: string; status: string }> };

export interface MultiUserRunOutput {
  text: string;
  textTruncated: boolean;
  files: string[];
  threadId?: string | null;
}
