# Third-party notices

magic-omo itself contains no third-party code. It **downloads at setup time** the unmodified, integrity-pinned `@cortexkit/pi-magic-context` package (and its npm dependencies, resolved from `vendor/package-lock.json`) into `~/.local/share/magic-omo/vendor`, and it **reads** files of an installed OMO Native. Their notices are reproduced below from the actual distributed files.

## Magic Context (`@cortexkit/pi-magic-context` 0.43.2)

- Source: https://github.com/cortexkit/magic-context — npm author `ualtinok`, org `cortexkit`
- Used: downloaded and loaded unmodified as an OMO extension.

```
MIT License

Copyright (c) 2025 Ufuk Altinok

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Transitive dependencies of the pinned package

Installed from the shipped lockfile. Licenses as declared in `vendor/package-lock.json` (count of packages):

- (MIT OR CC0-1.0): 1
- 0BSD: 1
- Apache-2.0: 16
- Apache-2.0 AND LGPL-3.0-or-later: 3
- Apache-2.0 AND LGPL-3.0-or-later AND MIT: 1
- BSD-2-Clause: 1
- BSD-3-Clause: 11
- ISC: 2
- LGPL-3.0-or-later: 10
- MIT: 36

Note: several optional native packages (e.g. `sharp`/libvips binaries) are LGPL-3.0-or-later; they are fetched by npm from the registry, never redistributed by this repository.

## oh-my-openagent / OMO Native (`omo-ai`)

- Source: https://github.com/code-yeongyu/oh-my-openagent — Yeongyu Kim (`code-yeongyu`)
- Used: not redistributed. magic-omo reads its config/package files and edits the user's own OMO settings.

```
MIT License

Copyright (c) 2026 Yeongyu Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of the Senpi LSP adapter descriptor, schema, renderer, path extraction,
post-edit wiring, and migration-warning helper portions of this package to
deal in those portions without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of those portions, and to permit persons to whom those portions
are furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of those portions.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THOSE PORTIONS OR THE USE OR OTHER DEALINGS IN
THOSE PORTIONS.
```

NOTICE file shipped with `omo-ai/plugin`:

```
omo-senpi LSP adapter notice

The Senpi LSP descriptor, schema, renderer, path extraction, post-edit wiring, and migration-warning helpers include code adapted from pi-lsp-client / oh-my-pi by Yeongyu Kim.

The former duplicated Senpi LSP client, transport, JSON-RPC, manager, server-resolution, project-trust, diagnostics, workspace-edit, and process execution engine has been removed. Runtime LSP execution is provided by the packaged @code-yeongyu/lsp-daemon runtime and @oh-my-opencode/lsp-core.
```

## Senpi (`@code-yeongyu/senpi` 2026.9.30)

- Source: https://github.com/code-yeongyu/senpi — `package.json` declares `"license": "MIT"`, `"author": "Mario Zechner"`.
- The published package ships **no LICENSE file**; the declaration above is the only license text available in the distributed package. Not redistributed by magic-omo (only read).
