/** Manual design-system document editing on the standard catalog API. */
export interface DesignSystemDocumentWrite {
  title?: string;
  summary?: string;
  category?: string;
  surface?: 'web' | 'image' | 'video' | 'audio';
  status?: 'draft' | 'published';
  body?: string;
}
