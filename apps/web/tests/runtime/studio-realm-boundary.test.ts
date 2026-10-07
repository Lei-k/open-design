import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const shim = /\bstudio(?:Window)?(?:Fetch|SetTimeout|SetInterval|LocalStorage|SessionStorage)\b/;

it('keeps host Studio shims out of literals and serialized functions in every web source module', () => {
  const root = resolve(import.meta.dirname, '../../src');
  const failures: string[] = [];
  let scripts = 0;
  let serialized = 0;
  for (const relative of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(relative)) continue;
    const text = readFileSync(resolve(root, relative), 'utf8');
    if (!/studio|<script|toString/.test(text)) continue;
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
    const aliases = new Set<string>();
    const functions = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
    const fail = (node: ts.Node, detail: string) => failures.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${detail}`);
    const collect = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && shim.test((node.propertyName ?? node.name).text)) aliases.add(node.name.text);
      if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (node.text.includes('<script')) scripts++;
        if (shim.test(node.text)) fail(node, 'host shim in emitted text');
      }
      // Every way source text of a function reaches a string (#75): x.toString(),
      // String(x), `${x}` and '...' + x.
      const isText = (part: ts.Node) => ts.isStringLiteralLike(part) || ts.isTemplateExpression(part);
      const serializedName = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'toString' && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text
        : ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String'
          && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]!) ? node.arguments[0].text
        : ts.isTemplateSpan(node) && ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
          && ((isText(node.left) && ts.isIdentifier(node.right)) || (isText(node.right) && ts.isIdentifier(node.left)))
          ? (ts.isIdentifier(node.right) ? node.right.text : (node.left as ts.Identifier).text)
        : null;
      if (serializedName !== null) {
        if (aliases.has(serializedName)) fail(node, 'serialized host shim import');
        const fn = functions.get(serializedName);
        if (fn) {
          serialized++;
          const check = (part: ts.Node) => {
            if (ts.isIdentifier(part) && !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part)
              && (aliases.has(part.text) || shim.test(part.text))) fail(part, 'host shim in serialized function');
            ts.forEachChild(part, check);
          };
          check(fn);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(scripts).toBeGreaterThan(15);
  expect(serialized).toBeGreaterThanOrEqual(2);
  expect(failures).toEqual([]);
}, 20_000);
