// Node paths use different separators on Windows and macOS.
function unpackedPath(file) {
  return file.replace(/(^|[/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
}
module.exports = { unpackedPath };
