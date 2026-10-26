'use strict';
// Where Cipher keeps its data, and why: docs/DESKTOP.md (feat/desktop-shell)
// - "Keys, chats and settings live in a folder beside the app. On Tails,
// dragging that folder into Persistent Storage is the persistence switch;
// on a normal desktop, the same folder is what a backup copies."

const fs = require('node:fs');
const path = require('node:path');

// The data folder is always named 'data' beside the app root, nothing clever.
// Pure so it is testable without electron.
function dataDirBeside(appRoot) {
  return path.resolve(appRoot, 'data');
}

// The app root for this run:
//   dev (electron . inside desktop/): the project dir, so data lands in desktop/data.
//   packaged tar.gz: the folder holding the program itself. electron-builder's
//   linux layout runs the binary at the top of the unpacked folder; some
//   distro layouts put the binary in a bin/ subfolder - then the app root is
//   its parent. Derived from process.execPath, never from the working
//   directory, so launching from any path resolves the same folder.
function resolveAppRoot(execPath, { isPackaged, projectDir }) {
  if (!isPackaged) return path.resolve(projectDir);
  let dir = path.dirname(path.resolve(execPath));
  if (path.basename(dir) === 'bin') dir = path.dirname(dir);
  return dir;
}

// Make sure the data folder can actually be written. The v1 Linux target is
// the portable tar.gz (docs/DESKTOP.md); a deb-style install would park the
// app somewhere read-only, and this is where that fails, loudly and in
// plain words, before any window opens.
function createDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.cipher-write-probe');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    const tailsHint = (() => {
      try {
        return /^ID=["']?tails["']?\s*$/m.test(fs.readFileSync('/etc/os-release', 'utf8'))
          ? ' On Tails, run Cipher from your Persistent folder (~/Persistent) so its data survives the reboot.'
          : '';
      } catch {
        return '';
      }
    })();
    throw new Error(
      `Cipher cannot write its data folder at ${dir} (${e.code || e.message}). `
      + 'This install kind puts the folder where it cannot live. '
      + `Run the portable build from the tar.gz file instead.${tailsHint}`,
    );
  }
  return dir;
}

module.exports = { dataDirBeside, resolveAppRoot, createDataDir };
