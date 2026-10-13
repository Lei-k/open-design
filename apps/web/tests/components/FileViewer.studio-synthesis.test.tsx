// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities, type StudioSynthesisState } from '@open-design/contracts';
import { StudioSynthesisActions } from '../../src/components/StudioSynthesisActions';
import { FileViewer } from '../../src/components/FileViewer';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
const account: AuthAccount = { id:'A', username:'A', role:'user', active:true, passwordState:'set', createdAt:1, updatedAt:1 };
const capabilities = { schemaVersion:1, shell:'studio', features:Object.fromEntries(STUDIO_PARITY_LANES.map(({id}) => [id,{status:'pilot',reason:'Pilot'}])) } as StudioRuntimeCapabilities;
async function mount(source: 'personal_api_key' | 'personal_subscription' | null, viewerOnly = false) {
  const state: StudioSynthesisState = { digest:'a'.repeat(64), defaultSource:source, sources:[
    { executionSource:'personal_api_key',available:true,reason:null },
    { executionSource:'company_pool',available:true,reason:null },
    { executionSource:'personal_subscription',available:false,reason:'personal-codex' },
  ], results:{} };
  const calls: Array<{url:string;body:any}> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url=String(input); const body=init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({url,body});
    if (url === '/api/auth/me') return Response.json({account,studio:capabilities,studioRevision:1,studioMessageIdPrefix:'mua_0123456789abcdef01234567_'});
    if (url.endsWith('/synthesis')) return Response.json(state);
    if (url.endsWith('/finalize/openai')) {
      const result = {id:'job',projectId:'p',action:'finalize' as const,conversationId:null,executionSource:'personal_api_key' as const,
        fileName:'DESIGN.md' as const,digest:state.digest,current:true,createdAt:1,model:'fixture',inputTokens:1,outputTokens:1,transcriptMessageCount:1};
      state.results.finalize=result; return Response.json(result);
    }
    return Response.json({ versions:[],deployments:[],files:[],url:null,content:'<h1>Design</h1>' });
  }));
  const session = new CookieSession(); await session.verify(); const snap=session.snapshot();
  render(<StudioCapabilitiesProvider session={session} generation={snap.generation} actor={account} capabilities={snap.studio!}>
    <StudioSynthesisActions projectId="p" conversationId="c" canWrite={!viewerOnly} />
    <FileViewer projectId="p" projectKind="prototype" viewerOnly={viewerOnly} liveHtml="<h1>Design</h1>"
      file={{name:'index.html',path:'index.html',type:'file',size:32,mtime:1,kind:'html',mime:'text/html',
        artifactManifest:{version:1,kind:'html',title:'Design',entry:'index.html',renderer:'html',exports:['html']}}} />
  </StudioCapabilitiesProvider>);
  return calls;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('C: FileViewer with no actor pin requires explicit source selection before any spend', async () => {
  const calls=await mount(null);
  const actions=within(await screen.findByTestId('studio-synthesis-actions'));
  await waitFor(() => expect(actions.getByRole('status').getAttribute('data-refusal')).toBe('source-required'));
  const finalize=actions.getByRole('button',{name:'Finalize with AI'}) as HTMLButtonElement;
  expect(finalize.disabled).toBe(true);fireEvent.click(finalize);
  expect(calls.filter((call)=>call.url.endsWith('/finalize/openai'))).toEqual([]);
  fireEvent.change(actions.getByRole('combobox'),{target:{value:'personal_api_key'}});fireEvent.click(finalize);
  await waitFor(() => expect(calls.filter((call)=>call.url.endsWith('/finalize/openai'))).toHaveLength(1));
  expect(calls.find((call)=>call.url.endsWith('/finalize/openai'))!.body.executionSource).toBe('personal_api_key');
});
it('FileViewer exposes Studio AI finalize using the account source and shared contract', async () => {
  const calls=await mount('personal_api_key');
  const actions=within(await screen.findByTestId('studio-synthesis-actions'));
  await waitFor(() => expect((actions.getByRole('button',{name:'Finalize with AI'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(actions.getByRole('button',{name:'Finalize with AI'}));
  await waitFor(() => expect(calls.find((call) => call.url.endsWith('/finalize/openai'))?.body).toEqual({executionSource:'personal_api_key',digest:'a'.repeat(64)}));
});
it('FileViewer explains a personal Codex refusal instead of a dead finalize button', async () => {
  await mount('personal_subscription');
  const actions=within(await screen.findByTestId('studio-synthesis-actions'));
  await waitFor(() => expect(actions.getByRole('status').getAttribute('data-refusal')).toBe('personal-codex'));
  expect((actions.getByRole('button',{name:'Finalize with AI'}) as HTMLButtonElement).disabled).toBe(true);
});
it('FileViewer keeps synthesis disabled for read-only project viewers', async () => {
  const calls=await mount('personal_api_key',true);
  const actions=within(await screen.findByTestId('studio-synthesis-actions'));
  expect(actions.getByRole('status').getAttribute('data-refusal')).toBe('project-read-only');
  expect((actions.getByRole('button',{name:'Finalize with AI'}) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.body?.executionSource)).toBe(false);
});

it('layout: a project delivery panel beside an HTML FileViewer owns exactly one source poller', async () => {
  const calls = await mount('personal_api_key');
  await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/synthesis'))).toHaveLength(1));
  expect(screen.getAllByTestId('studio-synthesis-actions')).toHaveLength(1);
});
