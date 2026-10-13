// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const shell = readFileSync(resolve(process.cwd(), 'src/styles/shell.css'), 'utf8');
const studio = readFileSync(resolve(process.cwd(), 'src/styles/studio.css'), 'utf8');
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

function layout(isStudio: boolean, phone = false, collapsed = false) {
  const style = document.createElement('style');
  style.textContent = shell + studio;
  document.head.append(style);
  // jsdom has no viewport layout engine; apply the phone rules as a browser
  // would at <=600px, then inspect the resulting containing block and tracks.
  if (phone) {
    const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSMediaRule =>
      rule instanceof CSSMediaRule && rule.conditionText === '(max-width: 600px)');
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = rules.map((rule) => Array.from(rule.cssRules).map((item) => item.cssText).join('\n')).join('\n');
    document.head.append(mobileStyle);
  }
  document.body.innerHTML = `<div class="workspace-shell" ${isStudio ? 'data-studio-pilot' : ''}>
    <div class="split"><div class="workspace"></div><div class="comment-float-host"><div ${collapsed ? 'class="comment-side-rail"' : ''}>Comments</div></div></div></div>`;
  return { split: getComputedStyle(document.querySelector('.split')!), host: getComputedStyle(document.querySelector('.comment-float-host')!) };
}

it('anchors Studio comments below the workspace Share row as preceding content changes height', () => {
  const { split, host } = layout(true);
  expect(split.position).toBe('relative');
  expect(host.position).toBe('absolute');
  expect(host.gridArea).toBe('1 / 3 / 2 / 4');
  // The shared tab/Share row is 44px tall. The card must start below it.
  expect(parseFloat(host.top)).toBeGreaterThan(44);
});

it('keeps the phone comment card in the workspace row below its Share row', () => {
  const { host } = layout(true, true);
  expect(host.position).toBe('absolute');
  expect(host.gridArea).toBe('2 / 1 / 3 / 2');
  expect(parseFloat(host.top)).toBeGreaterThan(44);
});

it('preserves the desktop single-user floating comment placement', () => {
  const { host } = layout(false);
  expect(host.position).toBe('fixed');
  expect(host.top).toBe('96px');
});

it('lets the collapsed Studio comment card shrink to its rail', () => {
  const { host } = layout(true, false, true);
  expect(host.width).toBe('auto');
});
