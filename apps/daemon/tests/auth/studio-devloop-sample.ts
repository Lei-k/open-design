import type { StudioLiveArtifactCreateRequest, StudioPluginExecutionSource } from '@open-design/contracts';

const allSources: StudioPluginExecutionSource[] = ['personal-codex', 'company-openai', 'account-openai'];

/** A valid one-pixel PNG; the provider response, project bytes and preview must agree. */
export const S70_MEDIA_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMoWHDhPwAGRALgq4wNjAAAAABJRU5ErkJggg==';

export function s70MediaArtifactDraft(mediaPath: string): StudioLiveArtifactCreateRequest {
  return { input: { title: 'Generated hero image', preview: { type: 'html', entry: 'index.html' },
    document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
      dataJson: { mediaPath, imageDataUrl: `data:image/png;base64,${S70_MEDIA_PNG_BASE64}` } } },
    templateHtml: '<figure><img src="{{data.imageDataUrl}}" alt="Generated hero"><figcaption>{{data.mediaPath}}</figcaption></figure>' };
}

/** Stratified sample of the S70 opening: injected quality floors vs declared
 * loops, inherited/explicit/no brand, discovery, craft, assets and source gaps.
 * These are test witnesses, never an admission allowlist. */
export const S70_DEVLOOP_SAMPLE: Array<{
  id: string; category: string; projectDesign: boolean; sources: StudioPluginExecutionSource[];
  expectedFiles: string[];
  inputs?: Record<string, string>; media?: boolean; ceiling?: boolean;
}> = [
  { id: 'design-system-apple', category: 'review neighbor / bundled design package', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-simple-deck', category: 'review neighbor / deck with inherited brand', projectDesign: true, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-article-magazine', category: 'article / skill brand opt-out', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-dashboard', category: 'dashboard / inherited brand and craft', projectDesign: true, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-ve-terminal-mono', category: 'deck / discovery and former false desktop detection', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'design-system-linear-app', category: 'design system / explicit bundled brand', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-wireframe-greybox', category: 'wireframe / captured HTML seed', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-huashu-slides', category: 'presentation / discovery and assets', projectDesign: false, sources: allSources, expectedFiles: ['index.html'] },
  { id: 'example-webgl-aurora-veil', category: 'WebGL / inherited brand', projectDesign: true, sources: allSources, expectedFiles: ['index.html'], ceiling: true },
  { id: 'od-media-generation', category: 'media scenario / declared loop and Codex source gap', projectDesign: false,
    sources: ['company-openai', 'account-openai'], inputs: { subject: 'A calm product hero', mediaKind: 'image' }, media: true, expectedFiles: ['assets/hero.png'] },
];
