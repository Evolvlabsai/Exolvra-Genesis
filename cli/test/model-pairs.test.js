import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const modelRoot = fileURLToPath(new URL('../../docs/models/', import.meta.url));
const testRoot = fileURLToPath(new URL('./', import.meta.url));
function invariantNames(source) {
  const names = [];
  const ast = ts.createSourceFile('explorer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'invariants' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const item of node.initializer.elements) {
        assert.ok(ts.isObjectLiteralExpression(item), 'an invariant must expose its name in the explorer');
        const name = item.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'name');
        assert.ok(name && ts.isStringLiteral(name.initializer), 'an invariant needs a literal name');
        names.push(name.initializer.text);
      }
    } else ts.forEachChild(node, visit);
  }
  visit(ast); return names.sort();
}

test('every TLA model discovers exactly one explorer and mirrors every named invariant', () => {
  const models = readdirSync(modelRoot).filter((p) => p.endsWith('.tla'));
  assert.ok(models.length >= 2, 'the required claim and distributed models must ship');
  const tests = readdirSync(testRoot).filter((p) => p.endsWith('.test.js')).map((file) => ({ file, source: readFileSync(join(testRoot, file), 'utf8') }));
  const pairs = new Map();
  for (const spec of tests) for (const match of spec.source.matchAll(/docs\/models\/([\w-]+\.tla)/g)) {
    assert.ok(models.includes(match[1]), spec.file + ' names a missing model ' + match[1]);
    pairs.set(match[1], [...new Set([...(pairs.get(match[1]) ?? []), spec.file])]);
  }
  for (const file of models) {
    const text = readFileSync(join(modelRoot, file), 'utf8');
    assert.equal(text.match(/MODULE\s+(\w+)\s+-+/)?.[1], basename(file, '.tla'), 'valid TLA module name must match its filename');
    const linked = pairs.get(file) ?? [];
    assert.equal(linked.length, 1, file + ' must name one executable explorer test');
    const explorer = tests.find((spec) => spec.file === linked[0]).source;
    assert.match(explorer, /explore\(model\(/, 'the pair must execute its model');
    const block = text.match(/\\\* (?:INVARIANTS:|Invariants\b)([\s\S]*?)(?=^Spec\s*==|^\\\* Weak fairness)/m)?.[1];
    assert.ok(block, file + ' needs an explicit invariant declaration section');
    const declared = [...block.matchAll(/^(\w+)\s*==/gm)].map((m) => m[1]).filter((s) => s !== 'Invariants').sort();
    assert.ok(declared.length > 0); assert.deepEqual(declared, invariantNames(explorer), file + ' drifted from ' + linked[0]);
  }
});
