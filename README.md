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
opencode-terminal-cli --sessions           # list every session, newest first
opencode-terminal-cli --sessions <id>      # resume by id prefix, full id or slug
opencode-terminal-cli --model zai/glm-4.7  # model for this run
opencode-terminal-cli --system-prompt "…"  # extra system prompt for this run
opencode-terminal-cli --system-prompt-file ./reviewer.md
opencode-terminal-cli --login zai          # log in once, no -e needed afterwards
opencode-terminal-cli --web 5000           # run `opencode web`, publish the port
opencode-terminal-cli --runtime-arg=--cap-add=NET_RAW   # forward an arg to docker/podman
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

### Runtime passthrough

`--runtime-arg=<arg>` appends one argument to the `docker`/`podman` command line.
Repeat it for more than one. Nothing else in the CLI claims unknown arguments for
the runtime — anything it does not recognise goes to opencode — so this is the only
way to reach the runtime for a single run.

```bash
# tcpdump inside the container needs CAP_NET_RAW
opencode-terminal-cli --runtime-arg=--cap-add=NET_RAW -i

# then, inside: the image ships sudo but not tcpdump
sudo apt-get update && sudo apt-get install -y tcpdump
sudo tcpdump -i any -w /home/dev/work/cap.pcap   # cwd is mounted, pcap lands on the host
```

Use the `=` form: the value usually starts with `-`, and that is explicitly
allowed here. A runtime flag that takes a separate value needs one occurrence per
token:

```bash
opencode-terminal-cli --runtime-arg=--cap-add --runtime-arg=NET_RAW
```

These are appended *after* `extra_args` from the config file, and both runtimes
let the later flag win, so a one-off run can override the config without editing
it. `OC_DEBUG=1` prints the full command that gets built.

Three things that bite:

- `--secure` adds `--cap-drop=ALL`, which overrides any `--cap-add` you pass. The
  CLI warns when you combine them.
- Docker's default capability set already includes `NET_RAW`; podman's does not.
  Check with `podman info --format '{{.Host.Security.Capabilities}}'` before
  blaming the flag.
- Capabilities land in the bounding set, and under podman the container process is
  your own uid (`--userns=keep-id`), which holds nothing effective. That is why
  `tcpdump` needs the image's passwordless `sudo` and not just the capability.

Note that model traffic is TLS. tcpdump gives you ciphertext; the image's retry
proxy already terminates and re-originates every model call with its own CA in the
container trust store, which is the decrypted tap and needs no capability at all.

### Isolation flags

- `--secure` — host cwd is **not** mounted, so the container starts with an empty
  workdir and can't touch your files. Config dir is still mounted, so auth and
  session resume keep working. Also adds `--cap-drop=ALL` and
  `--security-opt=no-new-privileges`. Combinable with `-i`.
- `--read-only` — host cwd mounted `:ro`. Container can
  read your files but not write them. Config dir stays writable.

### Sessions

Per-directory session tracking. The CLI records every session started or resumed
from a host directory and auto-resumes the newest one on the next run. The list
itself is never filtered — every session shows up wherever you run it from.

```bash
cd ~/coding/project-a
oc                           # first run: creates a session
# ...do stuff, exit

oc                           # second run: auto-resumes it
oc --new                     # ignore it, start fresh
oc --sessions                # list every session, * marks the one resumed here
oc --sessions ec6b0c16       # resume by id prefix
oc --sessions swift-forest   # or by slug
oc --sessions -v             # add slug, message count, model, cost and host dir
```

Session list output:

```
sessions (7) — * = last used here:

  ec6b0c19  2026-10-13 14:00  before you do anything what can you see ? like you can only see work f
* ec6b0c16  2026-10-13 05:40  why the fk are you sending it ??? it should not be sent!!!
  ec6b0c13  2026-10-11 06:26  yo quick, from the mcp build me a simple fps limiter... (allow user to
  ec6b0c10  2026-10-08 22:53  hey build me an all in one dns server and client
  ec6b0c07  2026-10-07 19:06  (no user message yet)
```

The id column drops opencode's `ses_` prefix and prints the shortest tail that is
still unique across the list — 8 characters unless two sessions genuinely collide
there. Full ids look like `ses_ec942c6e4ffeCn7lZE1xEQlj0k`, where `ses_ec` and
the `ffe` in the middle are the same for every session cut around the same time,
so a raw prefix tells you nothing. Resuming accepts the short form, the full id,
or the slug opencode assigns (`swift-forest`); an ambiguous prefix lists the
candidates instead of guessing.

opencode keeps sessions in SQLite, not one file per session, so the list is read
from `config_dir/.local/share/opencode/opencode.db` (read-only; archived sessions
and subagent children are skipped) and resumed with `opencode -s <id>`.

What each column comes from, verified against the 1.19.0 binary's own migrations:

| shown | source |
|---|---|
| id | `session.id` minus `ses_`, cut to the shortest unique length |
| timestamp | newest `message.time_created` for the session, else `session.time_created` |
| preview | first non-synthetic user text `part`, else the session title |

Not `session.time_updated`: opencode does not bump it when a message lands, and a
projection rebuild restamps every row with the same value — which is why every
session used to list as last used at the same minute. Not `session.title` either:
an unnamed session's title is literally `New session - <ISO date>`.

Inside the container the cwd is always `/home/dev/work`, so every host directory
is the same opencode project — the host path mapping lives in
`config_dir/sessions.json`, which `-v` prints. That file used to hold only the
last id per directory; it is upgraded in place on first read.

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
| `extra_args` | string[] | Extra args appended to runtime, e.g. `["--network=host"]`. Same place `--runtime-arg` writes to, but permanent; `--runtime-arg` is appended after these and wins. |

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
