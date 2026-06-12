'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitBlobs, isBlobishLine } = require('../memory-blob.js');

test('純粋な会話文は text のまま・blobs 空', () => {
  const src = 'これは普通の会話です。\n転入手続きについて教えてください。';
  const r = splitBlobs(src);
  assert.strictEqual(r.text, src.trim());
  assert.deepStrictEqual(r.blobs, []);
});

test('フェンス付きコードは code blob に分離され text から除かれる', () => {
  const src = '次のコードを実行しました。\n```js\nconsole.log(1);\n```\n結果は1です。';
  const r = splitBlobs(src);
  assert.strictEqual(r.blobs.length, 1);
  assert.strictEqual(r.blobs[0].kind, 'code');
  assert.ok(r.blobs[0].content.includes('console.log(1);'));
  assert.ok(!r.text.includes('console.log'));
  assert.ok(r.text.includes('次のコードを実行しました。'));
  assert.ok(r.text.includes('結果は1です。'));
});

test('貼り付けログ（連続するコマンド/出力行）は log blob に分離される', () => {
  const src = [
    'ターミナルの出力を貼ります。',
    '$ npm test',
    '> project@1.0.0 test',
    '{ "pass": 10, "fail": 0 }',
    '全部通りました。',
  ].join('\n');
  const r = splitBlobs(src);
  assert.ok(r.blobs.some((b) => b.kind === 'log'));
  assert.ok(!r.text.includes('npm test'));
  assert.ok(r.text.includes('ターミナルの出力を貼ります。'));
  assert.ok(r.text.includes('全部通りました。'));
});

test('単発の記号行（連続未満）は text に残す（過剰分割しない）', () => {
  const src = '重要な点は次の通り。\n[補足] これはメモです。\nよろしく。';
  const r = splitBlobs(src);
  assert.deepStrictEqual(r.blobs, []);
  assert.ok(r.text.includes('[補足]'));
});

test('isBlobishLine: シェル行/JSON行/長トークンを判定', () => {
  assert.strictEqual(isBlobishLine('$ ls -la'), true);
  assert.strictEqual(isBlobishLine('> project@1.0.0 test'), true); // npm 等の > プロンプト行
  assert.strictEqual(isBlobishLine('{ "a": 1 }'), true);
  assert.strictEqual(isBlobishLine('aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgdG9rZW4='), true);
  assert.strictEqual(isBlobishLine('これは普通の日本語の文です。'), false);
  assert.strictEqual(isBlobishLine(''), false);
});

test('非文字列入力でも例外を投げない', () => {
  const r = splitBlobs(undefined);
  assert.strictEqual(r.text, '');
  assert.deepStrictEqual(r.blobs, []);
});
