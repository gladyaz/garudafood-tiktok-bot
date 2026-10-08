# Node.js runtime license — provenance

AI LIVE HOST bundles a private Node.js runtime (`resources/runtime/node/node.exe`) so the
customer does not need Node installed. Redistributing that binary carries the obligation to
ship Node's license and notices with it, so the license text sits next to the binary in the
packaged app at `resources/licenses/node/LICENSE`.

The text in `LICENSE` beside this file was **not written here and not paraphrased**. It was
retrieved verbatim from the official `nodejs/node` repository at the exact release tag of the
runtime we bundle:

| field | value |
| --- | --- |
| Node version bundled | `v24.19.0` |
| Source | `https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE` |
| Retrieved | 2026-10-08 |
| Size | 157606 bytes |
| SHA-256 | `148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5` |

The release tag itself was confirmed to exist as a published Node release by fetching
`https://nodejs.org/dist/v24.19.0/SHASUMS256.txt`, which lists `node-v24.19.0-win-x64.zip`
and `node-v24.19.0-x64.msi`.

## Why the license is committed rather than downloaded at build time

The Windows **MSI** installation of Node on the build machine
(`C:\Program Files\nodejs\`) does **not** place a `LICENSE` file on disk — only
`node_modules/npm/LICENSE` and `node_modules/corepack/LICENSE.md`, which are the licenses of
npm and corepack, not of Node itself. So the license cannot be staged by copying from the
local installation the way `node.exe` is.

The alternative — fetching it during `package:prepare` — would make every build depend on
network access and on GitHub being reachable. Committing the text instead keeps builds
offline and reproducible, and it is license text, not a binary, so it does not bloat the
repository the way committing `node.exe` (92.8 MB) or Chrome (386 MB) would.

## When this must be refreshed

`scripts/package/prepare-runtime.js` records the staged runtime's version in the build
manifest and **fails the build** if the bundled Node version no longer matches the version
recorded here. If you upgrade the bundled Node runtime, re-retrieve `LICENSE` from the
matching tag and update the table above in the same commit.
