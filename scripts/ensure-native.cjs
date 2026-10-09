const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const tar = require("tar");

module.exports = async function ensureNative(context) {
  const root = context.packager.projectDir;
  const arch = require("builder-util").Arch[context.arch];
  const platform = context.electronPlatformName;
  if (platform !== "win32") return;
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [name, binaryPath] of [
    [`node-addon-require-builtin-win32-${arch}-msvc`, `prebuilt/win32-${arch}-msvc-napi-v9.node`],
    [`@koromix/koffi-win32-${arch}`, `win32_${arch}/koffi.node`],
  ]) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.resolved || !entry.integrity) throw Error(`Native package missing from lockfile: ${name}`);
  const target = path.join(root, "node_modules", name);
  const binary = path.join(target, binaryPath);
  if (fs.existsSync(binary) && JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version === entry.version) continue;
  console.log(`Preparing locked native package for Windows ${arch}: ${name}@${entry.version}`);
  const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`Native package download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, digest] = entry.integrity.split("-");
  if (algorithm !== "sha512" || crypto.createHash(algorithm).update(bytes).digest("base64") !== digest)
    throw Error(`Native package integrity check failed: ${name}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoba-native-package-"));
  try {
    const archive = path.join(temp, "package.tgz");
    const unpacked = path.join(temp, "unpacked");
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(unpacked);
    await tar.x({ file: archive, cwd: unpacked, strip: 1, strict: true,
      filter: (name, entry) => name.startsWith("package/") && !name.split("/").includes("..") && !["SymbolicLink", "Link"].includes(entry.type),
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== entry.version || !fs.existsSync(path.join(unpacked, binaryPath)))
      throw Error(`Downloaded native package is invalid: ${name}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(unpacked, target, { recursive: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  }
};
