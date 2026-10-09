const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const out = path.resolve(root, pkg.build.directories.output);
const winInstaller = path.join(out, `Xiaoba-${pkg.version}-win-x64.exe`);
if (fs.existsSync(winInstaller)) {
  execFileSync(process.execPath, [path.join(__dirname, "zip-windows.cjs"), winInstaller], { stdio: "inherit" });
}
const files = fs.existsSync(out)
  ? fs.readdirSync(out).filter(name => name.startsWith(`Xiaoba-${pkg.version}-`) && /\.(zip|dmg|exe)$/.test(name)).sort()
  : [];
if (!files.length) throw Error("No desktop installers found. Build Mac or Windows first.");
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), files.map(name => {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex");
  return `${digest}  ${name}`;
}).join("\n") + "\n");
console.log(`Prepared ${files.length} installer(s) and checksums for GitHub Releases.`);
