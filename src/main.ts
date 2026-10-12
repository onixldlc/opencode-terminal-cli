#!/usr/bin/env bun
// opencode-terminal-cli — wraps docker/podman to run opencode in container
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
// bun embeds this at compile time, and CI rewrites the version from VERSION
// before building, so the binary reports the release it was cut from
import pkg from "../package.json";

const BIN_NAME = "opencode-terminal-cli";
const CONFIG_DIR = process.env.OPENCODE_TERMINAL_CONFIG_DIR || join(homedir(), ".config", "opencode-terminal-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Config = {
  image: string;
  config_dir: string;
  runtime: "auto" | "docker" | "podman";
  selinux: "auto" | "on" | "off";
  model: string;
  system_prompt_file: string;
  extra_args: string[];
};

const DEFAULT_CONFIG: Config = {
  image: "ghcr.io/onixldlc/opencode-terminal:latest",
  config_dir: join(homedir(), ".local", "share", "opencode-terminal-cli", "config"),
  runtime: "auto",
  selinux: "auto",
  model: "",
  system_prompt_file: "",
  extra_args: [],
};

// ──────────────── config ────────────────

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.error(`[${BIN_NAME}] created default config at ${CONFIG_FILE}`);
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error(`[${BIN_NAME}] failed to parse ${CONFIG_FILE}, using defaults: ${e}`);
    return DEFAULT_CONFIG;
  }
}

function resolveHostConfig(cfg: Config): string {
  return resolve(cfg.config_dir.replace(/^~/, homedir()));
}

// opencode's own paths inside the mounted config dir
function opencodeConfigDir(cfg: Config): string {
  return join(resolveHostConfig(cfg), ".config", "opencode");
}

function opencodeDataDir(cfg: Config): string {
  return join(resolveHostConfig(cfg), ".local", "share", "opencode");
}

function opencodeDbPath(cfg: Config): string {
  return join(opencodeDataDir(cfg), "opencode.db");
}

// ──────────────── session tracking ────────────────

// sessions.json maps host cwd -> last session id
type SessionMap = Record<string, string>;

function sessionsFile(cfg: Config): string {
  return join(resolveHostConfig(cfg), "sessions.json");
}

function loadSessions(cfg: Config): SessionMap {
  const f = sessionsFile(cfg);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return {}; }
}

function saveSessions(cfg: Config, map: SessionMap): void {
  const f = sessionsFile(cfg);
  mkdirSync(resolveHostConfig(cfg), { recursive: true });
  writeFileSync(f, JSON.stringify(map, null, 2));
}

function getLastSessionId(cfg: Config, cwd: string): string | null {
  return loadSessions(cfg)[cwd] ?? null;
}

function setLastSessionId(cfg: Config, cwd: string, id: string): void {
  const map = loadSessions(cfg);
  map[cwd] = id;
  saveSessions(cfg, map);
}

// discover all sessions by reading opencode's own store
// opencode keeps them in SQLite (<config_dir>/.local/share/opencode/opencode.db),
// not one file per session, so this reads the `session` table read-only.
// inside the container cwd is always /home/dev/work, so every host directory
// lands in the same opencode project — the host path mapping lives in
// sessions.json instead.
type SessionRow = { id: string; title: string; mtime: Date };

function listSessions(cfg: Config): SessionRow[] {
  const db = opencodeDbPath(cfg);
  if (!existsSync(db)) return [];
  try {
    const conn = new Database(db, { readonly: true });
    try {
      const rows = conn
        .query(
          `SELECT id, title, time_created, time_updated
             FROM session
            WHERE parent_id IS NULL AND time_archived IS NULL
            ORDER BY time_updated DESC`,
        )
        .all() as Array<{ id: string; title: string; time_created: number; time_updated: number }>;
      return rows.map(r => ({
        id: r.id,
        title: r.title ?? "",
        mtime: toDate(r.time_updated ?? r.time_created),
      }));
    } finally {
      conn.close();
    }
  } catch (e) {
    if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] could not read ${db}: ${e}`);
    return [];
  }
}

// opencode writes epoch milliseconds; tolerate seconds in case that changes
function toDate(stamp: number): Date {
  if (!stamp) return new Date(0);
  return new Date(stamp < 1e12 ? stamp * 1000 : stamp);
}

function sessionMeta(cfg: Config, id: string): { hostCwd?: string } {
  // host cwd — reverse lookup from sessions.json (container cwd is always /home/dev/work)
  const map = loadSessions(cfg);
  for (const [k, v] of Object.entries(map)) {
    if (v === id) return { hostCwd: k };
  }
  return {};
}

// ──────────────── runtime detection ────────────────

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function detectRuntime(pref: Config["runtime"]): "docker" | "podman" {
  if (pref === "docker" || pref === "podman") {
    if (!which(pref)) throw new Error(`runtime '${pref}' not found in PATH`);
    return pref;
  }
  if (which("podman")) return "podman";
  if (which("docker")) return "docker";
  throw new Error("neither docker nor podman found in PATH");
}

function detectSelinux(pref: Config["selinux"]): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  const r = spawnSync("getenforce", [], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const mode = r.stdout.trim().toLowerCase();
  return mode === "enforcing" || mode === "permissive";
}

function getUid(): number { return process.getuid?.() ?? 1000; }
function getGid(): number { return process.getgid?.() ?? 1000; }

// ──────────────── run args builder ────────────────

function buildRunArgs(opts: {
  runtime: "docker" | "podman";
  cfg: Config;
  selinux: boolean;
  interactive: boolean;
  opencodeArgs: string[];
  secure?: boolean;
  readOnly?: boolean;
  model?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  publish?: string[];
}): string[] {
  const {
    runtime, cfg, selinux, interactive, opencodeArgs,
    secure = false, readOnly = false, model, systemPrompt, systemPromptFile, publish = [],
  } = opts;
  const cwd = process.cwd();

  // NEVER use :Z/:z here. Those relabel the mount source recursively on the host,
  // and the workdir can be any directory the user happens to be in — including $HOME.
  // Relabeling a home dir with a container-private label locks other apps out of it,
  // and it fails half-way on any root-owned file, leaving the tree inconsistent.
  // Turning off label confinement for this container touches nothing on the host.
  const z = "";
  // read-only applies to the workdir mount only — config stays writable
  const workMnt = readOnly ? ":ro" : "";
  const args: string[] = ["run", "-it", "--rm"];
  if (selinux) args.push("--security-opt", "label=disable");

  if (secure) {
    // least privilege: drop all caps, no privilege escalation
    args.push("--cap-drop=ALL");
    args.push("--security-opt=no-new-privileges");
  }

  if (runtime === "podman") {
    args.push("--userns=keep-id");
  } else {
    args.push("--user", `${getUid()}:${getGid()}`);
  }

  // only opencode-related paths persist; everything else ephemeral (container --rm wipes it)
  const ocConfig = opencodeConfigDir(cfg);
  const ocData = opencodeDataDir(cfg);
  mkdirSync(ocConfig, { recursive: true });
  mkdirSync(ocData, { recursive: true });

  args.push("-v", `${ocConfig}:/home/dev/.config/opencode${z}`);
  args.push("-v", `${ocData}:/home/dev/.local/share/opencode${z}`);
  // --secure leaves the workdir unmounted — container never sees host cwd
  if (!secure) {
    args.push("-v", `${cwd}:/home/dev/work${workMnt}`);
  }
  args.push("-w", "/home/dev/work");

  // a prompt file on the host has to be visible inside the container
  let containerPromptFile = "";
  if (systemPromptFile) {
    const hostFile = resolve(systemPromptFile.replace(/^~/, homedir()));
    if (!existsSync(hostFile)) throw new Error(`system prompt file not found: ${hostFile}`);
    containerPromptFile = "/opencode-system-prompt.md";
    args.push("-v", `${hostFile}:${containerPromptFile}:ro`);
  }

  // host.docker.internal isn't automatic on Linux — map it to the bridge gateway.
  // needs docker 20.10+; podman 4.7+ adds it itself but the explicit entry is harmless.
  args.push("--add-host=host.docker.internal:host-gateway");

  for (const p of publish) args.push("-p", p);

  args.push("-e", `TERM=${process.env.TERM || "xterm-256color"}`);
  if (process.env.ZHIPU_API_KEY) {
    args.push("-e", `ZHIPU_API_KEY=${process.env.ZHIPU_API_KEY}`);
  }
  // every GLM provider on models.dev reads ZHIPU_API_KEY; these are the usual
  // suspects for anything else the user authenticated with
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"]) {
    if (process.env[key]) args.push("-e", `${key}=${process.env[key]}`);
  }
  if (model) args.push("-e", `OPENCODE_MODEL=${model}`);
  if (systemPrompt) args.push("-e", `OPENCODE_SYSTEM_PROMPT=${systemPrompt}`);
  if (containerPromptFile) args.push("-e", `OPENCODE_SYSTEM_PROMPT_FILE=${containerPromptFile}`);

  args.push(...cfg.extra_args);

  if (interactive) {
    args.push("--entrypoint=/bin/bash");
    args.push(cfg.image);
  } else {
    args.push(cfg.image);
    args.push(...opencodeArgs);
  }

  return args;
}

// ──────────────── help ────────────────

function printHelp() {
  console.log(`${BIN_NAME} — run opencode in a container

Usage:
  ${BIN_NAME}                      Resume last session in this dir (or start fresh)
  ${BIN_NAME} --new                Start a new session (don't resume)
  ${BIN_NAME} --sessions           List all sessions for this dir
  ${BIN_NAME} --sessions -v        List sessions with the host path they were used in
  ${BIN_NAME} --sessions <id>      Resume specific session by id (or prefix)
  ${BIN_NAME} --model <id>         Model for this run, e.g. zai/glm-5.3
  ${BIN_NAME} --system-prompt <s>  Extra system prompt text for this run
  ${BIN_NAME} --system-prompt-file <f>
                                   Extra system prompt file for this run
  ${BIN_NAME} --login [provider]   Log in once; the credential persists in config_dir
  ${BIN_NAME} --web [port]         Run \`opencode web\` and publish the port (default 4096)
  ${BIN_NAME} --secure             Don't mount cwd + least privilege (config still mounted)
  ${BIN_NAME} --read-only          Mount cwd read-only
  ${BIN_NAME} -i, --shell          Drop into interactive bash inside container
  ${BIN_NAME} -h, --help           Show this help
  ${BIN_NAME} --cli-version        Print this wrapper's own version
  ${BIN_NAME} --config             Print config file path and current values
  ${BIN_NAME} --edit-config        Open config in $EDITOR
  ${BIN_NAME} [...args]            Pass extra args to opencode (e.g. --version, models, stats)

Isolation:
  --secure     Host cwd is not mounted — container gets an empty workdir.
               Config dir still mounted, so auth and sessions keep working.
               Adds --cap-drop=ALL and --security-opt=no-new-privileges.
  --read-only  Host cwd mounted ro — container can read your files but not
               write them. Config dir stays writable.

Session tracking:
  Per-directory. Last session id stored in sessions.json in your config_dir.
  Sessions themselves are stored by opencode in
  config_dir/.local/share/opencode/opencode.db and resumed with 'opencode -s <id>'.

Auth:
  Either forward a key or log in once — you don't need both.
  ZHIPU_API_KEY is forwarded when set; it covers zai, zai-coding-plan, zhipuai
  and zhipuai-coding-plan. The one-off alternative is '${BIN_NAME} --login zai'
  (or '/connect' in the TUI), which stores the credential in the 'credential'
  table of config_dir/.local/share/opencode/opencode.db — a mounted host path,
  so every later run already has it and no -e is needed again.

Config file: ${CONFIG_FILE}
Default host config dir: ${DEFAULT_CONFIG.config_dir}
`);
}

function printSessions(cfg: Config, cwd: string, verbose = false) {
  const sessions = listSessions(cfg);
  const last = getLastSessionId(cfg, cwd);

  if (sessions.length === 0) {
    console.log("no sessions found.");
    console.log(`(looked in: ${opencodeDbPath(cfg)})`);
    return;
  }

  console.log(`sessions (${sessions.length}) — * = last used here:\n`);
  for (const s of sessions) {
    const marker = s.id === last ? "*" : " ";
    const preview = (s.title || "(untitled session)").replace(/\s+/g, " ").slice(0, 80);
    const short = s.id.slice(0, 8);
    const when = s.mtime.toISOString().slice(0, 16).replace("T", " ");
    console.log(`${marker} ${short}  ${when}  ${preview}`);
    if (verbose) {
      const meta = sessionMeta(cfg, s.id);
      const path = meta.hostCwd ?? "(unknown — not tracked in sessions.json)";
      console.log(`             path: ${path}`);
    }
  }
  console.log(`\nresume: ${BIN_NAME} --sessions <id-or-prefix>`);
}

function resolveSessionByPrefix(cfg: Config, prefix: string): string | null {
  const all = listSessions(cfg);
  const matches = all.filter(s => s.id.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.id;
  console.error(`[${BIN_NAME}] prefix '${prefix}' ambiguous (${matches.length} matches):`);
  for (const m of matches) console.error(`  ${m.id}`);
  process.exit(1);
}

// ──────────────── arg helpers ────────────────

// pulls "--flag value" out of argv and returns the value
function takeOption(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    console.error(`[${BIN_NAME}] ${flag} needs a value`);
    process.exit(1);
  }
  argv.splice(i, 2);
  return value;
}

function takeFlag(argv: string[], ...names: string[]): boolean {
  let found = false;
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i !== -1) {
      argv.splice(i, 1);
      found = true;
    }
  }
  return found;
}

// ──────────────── main ────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) { printHelp(); return; }

  // --version belongs to opencode; this one reports the wrapper
  if (argv.includes("--cli-version")) {
    console.log(`${BIN_NAME} ${pkg.version}`);
    return;
  }

  const cfg = loadConfig();
  const cwd = process.cwd();

  if (argv.includes("--config")) {
    console.log(`${BIN_NAME} ${pkg.version}`);
    console.log(`config file: ${CONFIG_FILE}`);
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (argv.includes("--edit-config")) {
    const editor = process.env.EDITOR || "nano";
    spawnSync(editor, [CONFIG_FILE], { stdio: "inherit" });
    return;
  }

  const secure = takeFlag(argv, "--secure");
  const readOnly = takeFlag(argv, "--read-only");
  const interactive = takeFlag(argv, "-i", "--shell");
  const forceNew = takeFlag(argv, "--new");

  const model = takeOption(argv, "--model") ?? (cfg.model || undefined);
  const systemPrompt = takeOption(argv, "--system-prompt");
  const systemPromptFile = takeOption(argv, "--system-prompt-file") ?? (cfg.system_prompt_file || undefined);

  const runtime = detectRuntime(cfg.runtime);
  const selinux = detectSelinux(cfg.selinux);
  const shared = { runtime, cfg, selinux, secure, readOnly, model, systemPrompt, systemPromptFile };

  const run = (runArgs: string[]): never => {
    if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
    const r = spawnSync(runtime, runArgs, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  };

  // --sessions [id]
  const sessionsIdx = argv.indexOf("--sessions");
  if (sessionsIdx !== -1) {
    // -v means "verbose listing" here; outside --sessions it is opencode's own --version
    const verbose = takeFlag(argv, "-v", "--verbose");
    const arg = argv[sessionsIdx + 1];
    if (!arg || arg.startsWith("-")) {
      printSessions(cfg, cwd, verbose);
      return;
    }
    // resume specific
    const resolved = resolveSessionByPrefix(cfg, arg);
    if (!resolved) {
      console.error(`[${BIN_NAME}] no session matching '${arg}'`);
      process.exit(1);
    }
    setLastSessionId(cfg, cwd, resolved);
    const rest = argv.filter((_, i) => i !== sessionsIdx && i !== sessionsIdx + 1);
    run(buildRunArgs({ ...shared, interactive: false, opencodeArgs: ["-s", resolved, ...rest] }));
  }

  // --login [provider]: hand over to opencode's interactive login. The container
  // already mounts the data dir, so the stored credential outlives it.
  const loginIdx = argv.indexOf("--login");
  if (loginIdx !== -1) {
    const next = argv[loginIdx + 1];
    const provider = next && !next.startsWith("-") ? next : undefined;
    const opencodeArgs = ["auth", "login"];
    if (provider) opencodeArgs.push("--provider", provider);
    run(buildRunArgs({ ...shared, interactive: false, opencodeArgs }));
  }

  // --web [port]: serve the web UI instead of the TUI, publishing the port
  const webIdx = argv.indexOf("--web");
  if (webIdx !== -1) {
    const maybePort = argv[webIdx + 1];
    const port = maybePort && /^\d+$/.test(maybePort) ? maybePort : "4096";
    const rest = argv.filter((_, i) => i !== webIdx && !(i === webIdx + 1 && port === maybePort));
    const opencodeArgs = ["web", "--hostname", "0.0.0.0", "--port", port, ...rest];
    console.error(`[${BIN_NAME}] web ui on http://localhost:${port}`);
    run(buildRunArgs({ ...shared, interactive: false, opencodeArgs, publish: [`${port}:${port}`] }));
  }

  const passthrough = [...argv];

  // session resolution: --new wins, else last session id if it still exists
  const opencodeArgs: string[] = [];
  if (!interactive && !forceNew) {
    const last = getLastSessionId(cfg, cwd);
    if (last) {
      if (listSessions(cfg).some(s => s.id === last)) {
        opencodeArgs.push("-s", last);
        if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] resuming session ${last}`);
      } else if (process.env.OC_DEBUG) {
        console.error(`[${BIN_NAME}] stored session ${last} gone, starting fresh`);
      }
    }
  }
  opencodeArgs.push(...passthrough);

  const runArgs = buildRunArgs({ ...shared, interactive, opencodeArgs });

  if (process.env.OC_DEBUG) {
    console.error(`[${BIN_NAME}] runtime=${runtime} selinux=${selinux} new=${forceNew} secure=${secure} read-only=${readOnly}`);
    console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
  }

  const result = spawnSync(runtime, runArgs, { stdio: "inherit" });

  // after exit, if a new session was created, update tracking
  // find most recent session, if different from what we resumed, save it
  if (!interactive) {
    const sessions = listSessions(cfg);
    if (sessions.length > 0) {
      const newest = sessions[0]!.id;
      const last = getLastSessionId(cfg, cwd);
      if (newest !== last) {
        setLastSessionId(cfg, cwd, newest);
        if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] saved session ${newest} for ${cwd}`);
      }
    }
  }

  process.exit(result.status ?? 1);
}

main().catch(e => {
  console.error(`[${BIN_NAME}] error: ${e.message}`);
  process.exit(1);
});
