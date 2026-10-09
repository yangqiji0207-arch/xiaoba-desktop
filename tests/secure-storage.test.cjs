const { test } = require("node:test");
const assert = require("node:assert/strict");
const { usesAsyncStorage } = require("../src/secure-storage.cjs");
test("Windows DPAPI selection stays separate from Mac async Keychain", () => {
  const storage = { encryptStringAsync() {} };
  assert.equal(usesAsyncStorage(storage, "win32"), false);
  assert.equal(usesAsyncStorage(storage, "darwin"), true);
  assert.equal(usesAsyncStorage({}, "darwin"), false);
});
