# opencode-terminal-cli

Bun-based CLI wrapper for [opencode-terminal](https://github.com/onixldlc/opencode-terminal). Runs [opencode](https://opencode.ai) in a container with auto-detected runtime (docker/podman), UID mapping, and SELinux support. Same ergonomics as [llm-terminal-cli](https://github.com/onixldlc/llm-terminal-cli), pointed at opencode and GLM models.

## Install

### From release (recommended)

Grab the binary for your platform from [Releases](../../releases/latest):

```bash
# Linux x64
curl -L -o opencode-terminal-cli https://github.com/onixldlc/opencode-terminal-cli/releases/latest/download/opencode-terminal-cli-linux-x64
chmod +x opencode-terminal-cli
sudo mv opencode-terminal-cli /usr/local/bin/
# or: install -m 755 opencode-terminal-cli ~/.local/bin/

# macOS arm64 (Apple Silicon)
curl -L -o opencode-terminal-cli https://github.com/onixldlc/opencode-terminal-cli/releases/latest/download/opencode-terminal-cli-darwin-arm64
chmod +x opencode-terminal-cli && sudo mv opencode-terminal-cli /usr/local/bin/
```

Available targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`.

### From source

```bash
git clone https://github.com/onixldlc/opencode-terminal-cli
cd opencode-terminal-cli
bun install
bun run install-local   # → ~/.local/bin/opencode-terminal-cli
```

## Usage

```bash
opencode-terminal-cli                      # resume last session in this dir (or start fresh)
opencode-terminal-cli --new                # start a new session (don't resume)
opencode-terminal-cli --sessions           # list all sessions for this dir
opencode-terminal-cli --sessions <id>      # resume specific session (id or prefix)
opencode-terminal-cli --model zai/glm-4.7  # model for this run
opencode-terminal-cli --system-prompt "…"  # extra system prompt for this run
opencode-terminal-cli --system-prompt-file ./reviewer.md
opencode-terminal-cli --web 5000           # run `opencode web`, publish the port
opencode-terminal-cli --secure             # don't mount cwd + least privilege (config still mounted)
opencode-terminal-cli --read-only          # mount cwd read-only
opencode-terminal-cli -i                   # interactive bash inside container (debug, plugin install)
opencode-terminal-cli --shell              # alias for -i
opencode-terminal-cli --version            # passes --version to opencode
opencode-terminal-cli --cli-version        # this wrapper's own version
opencode-terminal-cli --help               # this help
opencode-terminal-cli --config             # show current config
opencode-terminal-cli --edit-config        # open config in $EDITOR
```

Anything the wrapper does not claim goes straight to opencode, so `opencode-terminal-cli models zai`, `… session list` and `… stats` work as expected.

Tip: alias it short.

```bash
alias oc='opencode-terminal-cli'
```

### Isolation flags

- `--secure` — host cwd is **not** mounted, so the container starts with an empty
  workdir and can't touch your files. Config dir is still mounted, so auth and
  session resume keep working. Also adds `--cap-drop=ALL` and
  `--security-opt=no-new-privileges`. Combinable with `-i`.
- `--read-only` — host cwd mounted `:ro` (`:ro,Z` under SELinux). Container can
  read your files but not write them. Config dir stays writable.

### Sessions

Per-directory session tracking. The CLI remembers the last session id used in each host directory and auto-resumes on next run.

```bash
cd ~/coding/project-a
oc                           # first run: creates a session
# ...do stuff, exit

oc                           # second run: auto-resumes it
oc --new                     # ignore last, start fresh
oc --sessions                # list all sessions, * marks last used here
oc --sessions ses_abc        # resume ses_abc12345 (prefix match)
oc --sessions -v             # also print the host dir each session was used in
```

Session list output:

```
sessions (3) — * = last used here:

* ses_abc1  2026-10-11 20:39  debug the auth middleware
  ses_def6  2026-10-11 19:49  write a bun cli wrapper
  ses_ghi0  2026-10-10 22:33  explain webpack loaders
```

opencode keeps sessions in SQLite, not one file per session, so the list is read
from `config_dir/.local/share/opencode/opencode.db` (read-only, `session` table;
archived sessions and subagent children are skipped) and resumed with
`opencode -s <id>`. Inside the container the cwd is always `/home/dev/work`, so
every host directory is the same opencode project — the host path mapping lives
in `config_dir/sessions.json`.

## Auth and models

`ZHIPU_API_KEY` is forwarded into the container when set, which covers all four GLM providers (`zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`):

```bash
export ZHIPU_API_KEY=...
oc --model zai/glm-5.3
```

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `OPENCODE_API_KEY` are forwarded the same way if present. Otherwise run `/connect` in the TUI once — credentials land in `config_dir/.local/share/opencode/auth.json` and persist.

`oc models` lists every `provider/model` id your key unlocks.

## Config

Auto-created on first run at `~/.config/opencode-terminal-cli/config.json`:

```json
{
  "image": "ghcr.io/onixldlc/opencode-terminal:latest",
  "config_dir": "/home/USER/.local/share/opencode-terminal-cli/config",
  "runtime": "auto",
  "selinux": "auto",
  "model": "",
  "system_prompt_file": "",
  "extra_args": []
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `image` | string | Container image to run |
| `config_dir` | path | Host dir holding opencode's config and data. `config_dir/.config/opencode` and `config_dir/.local/share/opencode` are mounted into the container. Login, sessions, plugins persist here. |
| `runtime` | `auto` / `docker` / `podman` | `auto` prefers podman if both installed |
| `selinux` | `auto` / `on` / `off` | `auto` runs `getenforce`, adds `:Z` to mounts on enforcing/permissive |
| `model` | string | Default model, overridden by `--model` |
| `system_prompt_file` | path | Default extra system prompt file, overridden by `--system-prompt-file` |
| `extra_args` | string[] | Extra args appended to runtime, e.g. `["--network=host"]` |

System prompts have three layers: this flag (per run), `config_dir/.config/opencode/AGENTS.md` (global, seeded by the image), and `AGENTS.md` in the project itself.

## Plugin install (one-time)

```bash
oc -i
# inside container:
opencode plugin <module>
exit
```

Config and plugin entries persist in `config_dir/.config/opencode/`, auto-loaded next run.

## Debug

```bash
OC_DEBUG=1 opencode-terminal-cli
```

Prints detected runtime + full command before exec.

## Override config dir per-invocation

```bash
OPENCODE_TERMINAL_CONFIG_DIR=/tmp/test-cfg opencode-terminal-cli
```

That is this wrapper's own config dir — not opencode's `OPENCODE_CONFIG_DIR`.

## Versioning

The **major** tracks [llm-terminal-cli](https://github.com/onixldlc/llm-terminal-cli) — currently `0.x` (`v0.2.4` released), so this starts at `0.2.0`. Minor and patch are this repo's own: they are fixes against opencode, and those don't translate one-to-one to the claude wrapper.

`VERSION` holds the tag verbatim, `v` included — currently `v0.2.0`. A rebuild of the same code gets a revision written straight into the file (`v0.2.0-r2`). `package.json` cannot carry a `v`, so both workflows rewrite its `version` from `VERSION` (minus the prefix) before building. `src/main.ts` imports it and bun embeds it at compile time, so `--cli-version` on a released binary reports the release it was cut from; the release workflow asserts that. The committed `package.json` value is just a placeholder — `VERSION` is the single source.

## Releasing

No `git tag` needed. Edit **`VERSION`** on `main` and the push builds all five binaries, then creates the tag and release with checksums.

```bash
echo v0.2.1 > VERSION
git commit -am "release v0.2.1" && git push
```

Build without releasing: Actions → Build and Release → Run workflow → untick **publish**.
