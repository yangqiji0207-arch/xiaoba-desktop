const fs = require("node:fs");
const path = require("node:path");

function locate(name, base, root) {
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(manifest)) return manifest;
    if (dir === root || dir === path.dirname(dir)) return null;
  }
}

function verifyRuntime(root, extra = [], target = {}) {
  root = path.resolve(root);
  const visited = new Set();
  const missing = new Set();
  function walk(name, base, required = true) {
    const manifest = locate(name, base, root);
    if (!manifest) {
      if (required) missing.add(name);
      return;
    }
    if (visited.has(manifest)) return;
    visited.add(manifest);
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const dependency of Object.keys(pkg.dependencies || {}))
      walk(
        dependency,
        path.dirname(manifest),
        !(dependency in (pkg.optionalDependencies || {})),
      );
    for (const dependency of Object.keys(pkg.optionalDependencies || {}))
      walk(dependency, path.dirname(manifest), false);
    for (const dependency of Object.keys(pkg.peerDependencies || {}))
      walk(
        dependency,
        path.dirname(manifest),
        !pkg.peerDependenciesMeta?.[dependency]?.optional,
      );
  }
  walk("@deepseek-ai/dsh", root);
  for (const name of extra) walk(name, root);
  const platform = target.platform || process.platform;
  const arch = target.arch || process.arch;
  // Optional to npm does not mean optional to the target runtime. Cross builds
  // can otherwise contain only the build host's native binary.
  for (const family of ["node-addon-require-builtin", "node-addon-internal-loader"]) {
    const entry = locate(family, root, root);
    if (!entry) continue;
    const suffix = platform === "win32" ? "-msvc" : platform === "linux" ? "-gnu" : "";
    const name = `${family}-${platform}-${arch}${suffix}`;
    const pkg = JSON.parse(fs.readFileSync(entry, "utf8"));
    const manifest = locate(name, path.dirname(entry), root);
    const binary = `${platform}-${arch}${suffix}-napi-v9.node`;
    if (!manifest || !fs.existsSync(path.join(path.dirname(manifest), "prebuilt", binary)))
      missing.add(`${name} (native binary for ${platform}/${arch})`);
    else if (JSON.parse(fs.readFileSync(manifest, "utf8")).version !== pkg.optionalDependencies?.[name])
      missing.add(`${name} (native package version mismatch)`);
  }
  const koffi = locate("koffi", root, root);
  if (koffi) {
    const name = `@koromix/koffi-${platform}-${arch}`;
    const manifest = locate(name, path.dirname(koffi), root);
    if (!manifest || !fs.existsSync(path.join(path.dirname(manifest), `${platform}_${arch}`, "koffi.node")))
      missing.add(`${name} (native persistence binary for ${platform}/${arch})`);
  }
  if (missing.size)
    throw Error(
      "Packaged Harness dependencies missing: " + [...missing].join(", "),
    );
  console.log(
    `Verified packaged Harness dependency graph (${visited.size} packages, including peers).`,
  );
}

module.exports = async (context) =>
  verifyRuntime(
    path.join(
      context.appOutDir,
      context.electronPlatformName === "darwin"
        ? `${context.packager.appInfo.productFilename}.app/Contents/Resources/app.asar.unpacked`
        : "resources/app.asar.unpacked",
    ),
    ["jose"],
    { platform: context.electronPlatformName, arch: require("builder-util").Arch[context.arch] },
  );
module.exports.verifyRuntime = verifyRuntime;
if (require.main === module)
  verifyRuntime(process.argv[2] || path.join(__dirname, ".."));
