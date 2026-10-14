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
opencode-terminal-cli --sessions           # list this dir's sessions
opencode-terminal-cli --sessions --all     # list sessions from every directory
opencode-terminal-cli --sessions <slug>    # resume by slug (or id / id prefix)
opencode-terminal-cli --model zai/glm-4.7  # model for this run
opencode-terminal-cli --system-prompt "…"  # extra system prompt for this run
opencode-terminal-cli --system-prompt-file ./reviewer.md
opencode-terminal-cli --login zai          # log in once, no -e needed afterwards
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
- `--read-only` — host cwd mounted `:ro`. Container can
  read your files but not write them. Config dir stays writable.

### Sessions

Per-directory session tracking. The CLI records every session started or resumed
from a host directory and auto-resumes the newest one on the next run.

```bash
cd ~/coding/project-a
oc                           # first run: creates a session
# ...do stuff, exit

oc                           # second run: auto-resumes it
oc --new                     # ignore it, start fresh
oc --sessions                # this dir's sessions, * marks the one that auto-resumes
oc --sessions --all          # every session, whatever directory it came from
oc --sessions swift-forest   # resume by slug
oc --sessions -v             # add full id, start time, cost and host path
```

Session list output:

```
sessions — /home/you/coding/project-a (2 of 7) — * = resumed by default here

* swift-forest    ses_ec6b0c16cffe  12m ago  34 msgs  zai/glm-5.3
    fix the retry popup so it shows up again
  playful-falcon  ses_ec6b0c19effe  2d ago    6 msgs  zai/glm-4.7
    explain webpack loaders
```

Resume by the **slug**. opencode ids are `ses_` + a reverse-time prefix + a
random tail, so every session cut in the same minute shares its first ~10
characters — a short prefix is almost never unique. The list prints the shortest
prefix that still is; the slug is shorter and unique anyway.

opencode keeps sessions in SQLite, not one file per session, so the list is read
from `config_dir/.local/share/opencode/opencode.db` (read-only; archived sessions
and subagent children are skipped) and resumed with `opencode -s <id>`.

What each column comes from, verified against the 1.19.0 binary's own migrations:

| shown | source |
|---|---|
| slug | `session.slug` |
| age | newest `message.time_created` for the session |
| count | rows in `message` for the session |
| model | `providerID`/`modelID` of the last assistant message |
| description | first non-synthetic user text `part`, else the session title |

Not `session.time_updated`: opencode does not bump it when a message lands, and
a projection rebuild restamps every row with the same value — which is why every
session used to list as last used at the same minute.

Inside the container the cwd is always `/home/dev/work`, so every host directory
is the same opencode project — the host path mapping lives in
`config_dir/sessions.json`. That file used to hold only the last id per
directory; it is upgraded in place on first read.

## Auth and models

Two ways in, and you only need one.

**Log in once (no env var afterwards):**

```bash
oc --login zai          # or: oc --login  (pick the provider from the list)
```

That runs opencode's own interactive login in the container and asks for the key. It is stored in the `credential` table of `config_dir/.local/share/opencode/opencode.db`, which is a mounted host path — so every later `oc` already has it and you never pass `-e` or export anything. `/connect` inside the TUI does the same thing. `oc auth list` shows what is stored, `oc auth logout` removes it.

**Or forward an env var**, handy for CI or a throwaway shell:

```bash
export ZHIPU_API_KEY=...
oc --model zai/glm-5.3
```

`ZHIPU_API_KEY` covers all four GLM providers (`zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`); `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `OPENCODE_API_KEY` are forwarded the same way when present.

`OC_RETRY_MAX`, `OC_RETRY_CAP`, `OC_RETRY_BASE`, `OC_RETRY_DEADLINE`, `OC_PROXY` and `OC_PROXY_INSECURE` are forwarded too — they tune the image's retry proxy, which absorbs a busy provider's 429s and 5xx so a turn isn't dropped after opencode's own five attempts. The image defaults to 200 attempts with a 60s ceiling (~3h 15m). For policy per provider, edit `retry.json` in the container's config dir — see the image README.

Per run, `--retry` and `--retry-cap` (seconds) are shorter than the env vars and win over them:

```bash
opencode-terminal --retry 5 --retry-cap 30    # stock opencode: gives up after ~1 min
opencode-terminal --retry 400                 # ~6h 40m, for a long unattended run
```

Set `retry` / `retry_cap` in the wrapper config to change the default for every run.

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
| `selinux` | `auto` / `on` / `off` | `auto` runs `getenforce`; on enforcing/permissive the container gets `--security-opt label=disable` |
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
