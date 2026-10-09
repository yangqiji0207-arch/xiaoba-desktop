const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const from = path.resolve(root, pkg.build.directories.output);
const site = path.join(root, "..", "download-site");
const out = path.join(site, "downloads");
fs.mkdirSync(out, { recursive: true });
// Windows browsers can offer either the installer or a ZIP containing it.
const { execFileSync } = require("node:child_process");
const winInstaller = path.join(from, `Xiaoba-${pkg.version}-win-x64.exe`);
if (fs.existsSync(winInstaller)) {
  execFileSync(process.execPath, [
    path.join(__dirname, "zip-windows.cjs"),
    winInstaller,
  ]);
}
const files = fs.existsSync(from)
  ? fs
      .readdirSync(from)
      .filter(
        (n) =>
          n.startsWith(`Xiaoba-${pkg.version}-`) &&
          /^Xiaoba-[\w.-]+\.zip$/.test(n),
      )
  : [];
const releases = files.map((name) => {
  const bytes = fs.readFileSync(path.join(from, name));
  fs.writeFileSync(path.join(out, name), bytes);
  return {
    name,
    url: "downloads/" + name,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
});
fs.writeFileSync(
  path.join(site, "releases.json"),
  JSON.stringify({ version: pkg.version, files: releases }, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(out, "SHA256SUMS.txt"),
  releases.map((f) => f.sha256 + "  " + f.name).join("\n") + "\n",
);
fs.copyFileSync(
  path.join(root, "renderer/xiaoba.png"),
  path.join(site, "xiaoba.png"),
);
console.log(`Prepared ${releases.length} installer(s) in download-site/.`);
