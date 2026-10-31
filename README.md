# Pinotator

A local-first configuration studio for [Pi](https://pi.dev). Inspect your agents, skills, models, providers, extensions, and MCP servers in a browser. Stage file edits, review their diffs, and apply them explicitly—your files stay the source of truth.

No cloud service, telemetry, or configuration database.

> Early release: review changes carefully and keep independent backups. Runtime-assisted features are version-gated to the reviewed Pi 1.4.0 and pi-subagents 0.84.0 interfaces. Unsupported runtime facts are shown as unknown, not assumed healthy.

## Get started

Requires **Node.js 22+**. Install Pi separately and make its `pi` command available on your PATH. Static inspection is available without running extensions or connecting to MCP servers.

### From GitHub (available now)

Source development uses **pnpm 12.4.2**, pinned in `package.json`.

```sh
git clone https://github.com/meowhib/pinotator.git
cd pinotator
pnpm install --frozen-lockfile
pnpm add --global "link:$PWD"
cd /path/to/your/project
pinotator --read-only
```

Installation builds the CLI and browser assets. If pnpm is not installed, install the pinned version with `npm install --global pnpm@12.4.2`. For global pnpm commands, ensure `PNPM_HOME` is on PATH (`pnpm setup` can configure it).

### From npm (after the first registry release)

The intended package name is **`@meowhib/pinotator`**. Registry publication is pending; the unscoped `pinotator` package is a different project.

Once published, choose one package manager:

```sh
npm install --global @meowhib/pinotator
# or
pnpm add --global @meowhib/pinotator
```

Both use the npm registry. Published packages include compiled assets; consumers do not need pnpm, TypeScript, or a build step when installing with npm.

Run `pinotator --read-only` in your project to begin with inspection only. Omit `--read-only` when you are ready to stage edits.

## Usage

```sh
pinotator                         # current project; opens the local UI
pinotator --read-only              # disable edits and package/runtime actions
pinotator --global --read-only     # inspect global configuration
pinotator --project /path/to/repo   # select a project
pinotator --no-open                # print a browser URL without opening it
pinotator doctor                  # check Pi availability
```

Pinotator binds to `127.0.0.1` on an OS-selected port and prints a one-time browser URL. Stop it with Ctrl+C. Never expose it through a reverse proxy or bind it to a public network interface. Do not share the startup URL.

## What you can do

- Inspect configuration candidates with source paths, scope, trust, and diagnostics.
- Browse agents, skills, prompt commands, settings, keybindings, models/providers, extensions/packages, and MCP declarations.
- Create and edit supported resources, review staged diffs, then explicitly Apply. Writes recheck source hashes, keep private backups, and support recovery/rollback.
- Filter user-installed/configured extensions separately from Pi defaults and unattributed package manifests. Package update availability is unknown: Pi exposes no check-only update command.
- Use explicit, confirmed package management and version-gated provider/MCP diagnostics. Passive inventory never runs third-party extension/package code, credential commands, MCP connections, or model inference.
- Import/export skills and sanitized snapshots; compare configurations and inspect declared dependency/context policies.
- Navigate with a command palette and keyboard shortcuts, light/dark/system themes, and responsive layouts.

The optional companion source is included at `integrations/pinotator-companion.ts`. It requires deliberate installation and pairing; Pinotator never automatically installs or loads it into Pi.

## Security and limitations

This is privileged local software: a person with access to an authenticated instance can change files that influence Pi's behavior. Loopback binding and private files do not protect against other processes running as your OS user.

- File edits are staged for review, but Pi package commands run immediately after confirmation and may download/run third-party lifecycle scripts. They are outside the file transaction. Pinotator never grants project trust.
- A separate API-key setup action can write a literal key directly to Pi's private `auth.json` on verified Pi 1.4.0. This is not staged or rollbackable through Changes. Keys are plaintext in a private file, never saved to browser storage, previews, snapshots, or backups. OAuth setup is not offered.
- Explicit MCP status checks can start processes/connect to servers. A separately confirmed per-model inference test may incur a charge; it sends a fixed minimal prompt, no project context/tools, and discards response text. None run during startup or Refresh.
- Secret redaction is applied to supported structures and outputs, but review exports before sharing. Unsupported, secret-bearing, package-owned, and legacy sources may be inspect-only.
- Static inventory cannot prove runtime activation, model availability, credentials, billing, or the exact prompt of an existing session. Discovery is bounded and can report scan limits.
- Cross-platform behavior and every editing/recovery flow have not been exhaustively verified. Build checks and manual browser checks are not a security certification.

For a suspected vulnerability, do not post secrets or exploitable details in public issues. Use [GitHub private vulnerability reporting](https://github.com/meowhib/pinotator/security/advisories/new) if enabled; otherwise request a private reporting channel without publishing the details.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run dev
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
```

The CLI/server are TypeScript; React and existing typed DOM controllers share ownership of the browser UI. shadcn/Radix components and semantic tokens provide shared controls and themes. `dist/` is generated and not committed. Rebuild and restart after source changes.

Use pnpm for source development; `pnpm-lock.yaml` is authoritative. Runtime schemas are validated, but TypeScript checking is not fully strict. There is no automated test suite at present. Verify relevant interactions manually in read-only mode or an isolated fixture; never use real credentials or apply changes to someone else's configuration just to test a UI change.

Internal design notes, specifications, and agent files are intentionally excluded from the public snapshot and npm archive.

## Maintainer release

```sh
pnpm install --frozen-lockfile
pnpm pack                       # checks formatting/lint and builds before packing
# Inspect the archive, install it in a temporary directory, and verify the CLI/UI.
pnpm login                      # authenticate an npm account that owns the meowhib scope
pnpm publish --access public    # only after reviewing the archive and version
```

The first scoped registry release still needs npm authentication/ownership. Do not publish the unscoped package name. For subsequent releases, increment `package.json`'s version and publish that reviewed version; registry versions cannot be overwritten.

## License

[MIT](LICENSE).
