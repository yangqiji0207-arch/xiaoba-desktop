// Windows uses the DPAPI sync provider; macOS needs the async Keychain provider.
function usesAsyncStorage(storage, platform = process.platform) {
  return platform !== "win32" && typeof storage.encryptStringAsync === "function";
}
async function storageAvailable(storage) {
  if (usesAsyncStorage(storage) && storage.isAsyncEncryptionAvailable)
    return storage.isAsyncEncryptionAvailable();
  return storage.isEncryptionAvailable();
}
module.exports = { usesAsyncStorage, storageAvailable };
