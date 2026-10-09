const test = require('node:test');
const assert = require('node:assert/strict');
const { unpackedPath } = require('../src/paths.cjs');
test('packaged Harness resolves unpacked paths on both target systems', () => {
  assert.equal(unpackedPath('/小八.app/Contents/Resources/app.asar/node_modules/dsh/bin.js'), '/小八.app/Contents/Resources/app.asar.unpacked/node_modules/dsh/bin.js');
  assert.equal(unpackedPath('C:\\小八\\resources\\app.asar\\harness\\companion.patch.yml'), 'C:\\小八\\resources\\app.asar.unpacked\\harness\\companion.patch.yml');
  assert.equal(unpackedPath('/src/main.cjs'), '/src/main.cjs');
});
