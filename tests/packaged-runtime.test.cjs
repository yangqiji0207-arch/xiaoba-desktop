const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyRuntime } = require("../scripts/verify-runtime.cjs");

test("packaging rejects missing peers even if the build machine has them", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-package-check-"));
  const bundle = path.join(parent, "app.asar.unpacked");
  function manifest(base, name, data) {
    const dir = path.join(base, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data));
  }
  try {
    manifest(bundle, "@deepseek-ai/dsh", {
      peerDependencies: { "required-peer": "1" },
    });
    manifest(parent, "required-peer", {});
    assert.throws(() => verifyRuntime(bundle), /required-peer/);
    manifest(bundle, "required-peer", {
      peerDependencies: { "@deepseek-ai/dsh": "1" },
    });
    assert.doesNotThrow(() => verifyRuntime(bundle));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("Windows packaging requires Windows native binaries even when Mac binaries exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-native-check-"));
  function manifest(name, data) {
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data));
    return dir;
  }
  try {
    manifest("@deepseek-ai/dsh", { dependencies: { "node-addon-require-builtin": "0.1.6" } });
    manifest("node-addon-require-builtin", {
      optionalDependencies: { "node-addon-require-builtin-win32-x64-msvc": "0.1.6" },
    });
    manifest("node-addon-require-builtin-darwin-arm64", { version: "0.1.6" });
    const target = { platform: "win32", arch: "x64" };
    assert.throws(() => verifyRuntime(root, [], target), /win32-x64-msvc/);
    const native = manifest("node-addon-require-builtin-win32-x64-msvc", { version: "0.1.6" });
    assert.throws(() => verifyRuntime(root, [], target), /native binary/);
    fs.mkdirSync(path.join(native, "prebuilt"));
    fs.writeFileSync(path.join(native, "prebuilt", "win32-x64-msvc-napi-v9.node"), "test binary");
    assert.doesNotThrow(() => verifyRuntime(root, [], target));
    manifest("koffi", { version: "3.1.1" });
    assert.throws(() => verifyRuntime(root, [], target), /native persistence binary/);
    const ffi = manifest("@koromix/koffi-win32-x64", { version: "3.1.1" });
    fs.mkdirSync(path.join(ffi, "win32_x64"));
    fs.writeFileSync(path.join(ffi, "win32_x64", "koffi.node"), "test binary");
    assert.doesNotThrow(() => verifyRuntime(root, [], target));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
