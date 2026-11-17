import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { mainText } from '../apps/electron/main-text.mjs';
const hostSources = readdirSync(new URL('../apps/electron/', import.meta.url), { recursive: true })
  .filter((file) => file.endsWith('.mjs'))
  .map((file) =>
    ts.createSourceFile(
      file,
      readFileSync(
        new URL(`../apps/electron/${file.replaceAll('\\', '/')}`, import.meta.url),
        'utf8',
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
  );
const catalog = JSON.parse(
  readFileSync(new URL('../packages/components/main-text.zh-CN.json', import.meta.url), 'utf8'),
);

test('all main process copy references resolve, including interpolated dialog text', () => {
  const used = new Set();
  function visit(node, sf) {
    if (ts.isCallExpression(node) && (node.expression.getText(sf) === 'mainText' ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'mainText'))) {
      const id = node.arguments[0].text;
      assert.equal(typeof catalog[id], 'string', id);
      used.add(id);
      const params = node.arguments[1];
      if (params && ts.isObjectLiteralExpression(params)) {
        const names = new Set(params.properties.map((p) => p.name?.getText(sf)));
        for (const match of catalog[id].matchAll(/\{(value\d+)\}/g))
          assert.ok(names.has(match[1]), `${id}: ${match[1]}`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, sf));
  }
  for (const hostSource of hostSources) visit(hostSource, hostSource);
  assert.ok(used.size > 250);
  for (const id of Object.keys(catalog)) assert.ok(used.has(id), `unused copy: ${id}`);
});

test('main process UI sinks contain no inline Chinese text', () => {
  const failures = [];
  function inspect(node, sf) {
    if (ts.isStringLiteralLike(node) && /\p{Script=Han}/u.test(node.text))
      failures.push(
        `${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${node.text.slice(0, 40)}`,
      );
    if (
      ts.isTemplateExpression(node) &&
      [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].some((t) =>
        /\p{Script=Han}/u.test(t),
      )
    )
      failures.push(`inline template ${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    ts.forEachChild(node, (child) => inspect(child, sf));
  }
  function visit(node, sf) {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ['Error', 'uiText', 'dialog.showMessageBox', 'dialog.showOpenDialog', 'confirmBox'].includes(
        node.expression.getText(sf),
      )
    )
      inspect(node, sf);
    if (
      ts.isPropertyAssignment(node) &&
      ['receipt', 'message', 'detail', 'title', 'status', 'buttons'].includes(node.name.getText(sf))
    )
      inspect(node.initializer, sf);
    ts.forEachChild(node, (child) => visit(child, sf));
  }
  // Keep extracted host services in the same copy boundary as the main entry point.
  for (const sf of hostSources.filter((source) => /\bmainText\(/.test(source.text))) visit(sf, sf);
  assert.deepEqual(failures, []);
});

test('copy interpolation preserves user parameters and rejects missing resource IDs', () => {
  const [id, template] = Object.entries(catalog).find(([, text]) => text.includes('{value0}'));
  assert.equal(
    mainText(id, { value0: '<tag> $& {value0}' }),
    template.replaceAll('{value0}', () => '<tag> $& {value0}'),
  );
  assert.throws(() => mainText('missing.key'), /Unknown main text key/);
});
