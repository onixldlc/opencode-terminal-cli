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
  retry: string;
  retry_cap: string;
  extra_args: string[];
};

const DEFAULT_CONFIG: Config = {
  image: "ghcr.io/onixldlc/opencode-terminal:latest",
  config_dir: join(homedir(), ".local", "share", "opencode-terminal-cli", "config"),
  runtime: "auto",
  selinux: "auto",
  model: "",
  system_prompt_file: "",
  // retry attempts and the per-attempt ceiling in seconds. empty = the image's
  // own defaults (200 attempts, 60s). set "5" and "30" for stock opencode.
  retry: "",
  retry_cap: "",
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

// sessions.json records, per host directory, every session that was started or
// resumed from it, newest first. v1 of the file was a flat
// `{ "<host cwd>": "<session id>" }` map holding only the last id; it is
// migrated on read. The list is never filtered by directory — this only feeds
// the * marker and the host dir shown by -v.
type DirRecord = { last: string; ids: string[] };
type SessionMapV2 = { version: 2; dirs: Record<string, DirRecord> };

function sessionsFile(cfg: Config): string {
  return join(resolveHostConfig(cfg), "sessions.json");
}

function loadSessions(cfg: Config): SessionMapV2 {
  const f = sessionsFile(cfg);
  const empty: SessionMapV2 = { version: 2, dirs: {} };
  if (!existsSync(f)) return empty;
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (raw && raw.version === 2 && raw.dirs) return raw as SessionMapV2;
    // v1: flat cwd -> id
    const dirs: Record<string, DirRecord> = {};
    for (const [dir, id] of Object.entries(raw ?? {})) {
      if (typeof id === "string") dirs[dir] = { last: id, ids: [id] };
    }
    return { version: 2, dirs };
  } catch {
    return empty;
  }
}

function saveSessions(cfg: Config, map: SessionMapV2): void {
  const f = sessionsFile(cfg);
  mkdirSync(resolveHostConfig(cfg), { recursive: true });
  writeFileSync(f, JSON.stringify(map, null, 2));
}

function getLastSessionId(cfg: Config, cwd: string): string | null {
  return loadSessions(cfg).dirs[cwd]?.last ?? null;
}

// remembers the ids as belonging to this directory, newest first, and makes the
// first one the resume target
function rememberSessions(cfg: Config, cwd: string, ids: string[]): void {
  if (ids.length === 0) return;
  const map = loadSessions(cfg);
  const rec = map.dirs[cwd] ?? { last: ids[0]!, ids: [] };
  rec.last = ids[0]!;
  rec.ids = [...new Set([...ids, ...rec.ids])];
  map.dirs[cwd] = rec;
  saveSessions(cfg, map);
}

function dirForId(cfg: Config, id: string): string | undefined {
  for (const [dir, rec] of Object.entries(loadSessions(cfg).dirs)) {
    if (rec.ids.includes(id)) return dir;
  }
  return undefined;
}

// discover all sessions by reading opencode's own store
// opencode keeps them in SQLite (<config_dir>/.local/share/opencode/opencode.db),
// not one file per session, so this reads it read-only. Verified against the
// 1.19.0 binary's own migrations:
//   session(id, slug, title, directory, time_created, time_updated, cost, ...)
//   message(id, session_id, time_created, data json {role, modelID, providerID})
//   part(id, message_id, time_created, data json {type, text, synthetic})
// `session.time_updated` is NOT bumped when a message lands (checked live: it
// still equalled time_created after a tool call) and a projection rebuild
// restamps every row with the same value — which is why every session looked
// like it was last used at the same minute. Activity is derived from `message`.
// inside the container cwd is always /home/dev/work, so `session.directory` is
// the same for every host directory; the host path mapping lives in
// sessions.json instead.
type SessionRow = {
  id: string;
  slug: string;
  title: string;
  created: Date;
  active: Date;      // last real activity: newest message, else created
  messages: number;
  model: string;     // "providerID/modelID" of the last assistant reply
  cost: number;
  preview: string;   // first thing the user actually typed
  detail: boolean;   // false when the message tables could not be read
};

function openDb(cfg: Config): Database | null {
  const db = opencodeDbPath(cfg);
  if (!existsSync(db)) return null;
  try {
    return new Database(db, { readonly: true });
  } catch (e) {
    if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] could not open ${db}: ${e}`);
    return null;
  }
}

function listSessions(cfg: Config): SessionRow[] {
  const conn = openDb(cfg);
  if (!conn) return [];
  try {
    const rows = conn
      .query(
        `SELECT id, slug, title, cost, time_created, time_updated
           FROM session
          WHERE parent_id IS NULL AND time_archived IS NULL`,
      )
      .all() as Array<{
        id: string; slug: string | null; title: string | null;
        cost: number | null; time_created: number; time_updated: number;
      }>;

    // message-derived columns. the table is optional as far as this wrapper is
    // concerned — an opencode that renamed it should degrade, not crash.
    const stats = new Map<string, { n: number; last: number }>();
    const preview = new Map<string, string>();
    const model = new Map<string, string>();
    let detail = true;
    try {
      for (const r of conn
        .query(
          `SELECT session_id AS sid, COUNT(*) AS n, MAX(time_created) AS last
             FROM message GROUP BY session_id`,
        )
        .all() as Array<{ sid: string; n: number; last: number }>) {
        stats.set(r.sid, { n: r.n, last: r.last });
      }
      // first non-synthetic user text in each session — synthetic parts are the
      // "The following tool was executed by the user" wrappers opencode injects
      for (const r of conn
        .query(
          `SELECT m.session_id AS sid, json_extract(p.data, '$.text') AS text
             FROM message m JOIN part p ON p.message_id = m.id
            WHERE json_extract(m.data, '$.role') = 'user'
              AND json_extract(p.data, '$.type') = 'text'
              AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
            ORDER BY m.time_created ASC, p.time_created ASC`,
        )
        .all() as Array<{ sid: string; text: string | null }>) {
        if (!preview.has(r.sid) && r.text) preview.set(r.sid, r.text);
      }
      for (const r of conn
        .query(
          `SELECT session_id AS sid,
                  json_extract(data, '$.providerID') AS provider,
                  json_extract(data, '$.modelID')    AS model
             FROM message
            WHERE json_extract(data, '$.role') = 'assistant'
            ORDER BY time_created DESC`,
        )
        .all() as Array<{ sid: string; provider: string | null; model: string | null }>) {
        if (!model.has(r.sid) && r.model) model.set(r.sid, `${r.provider ?? "?"}/${r.model}`);
      }
    } catch (e) {
      detail = false;
      if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] no message detail: ${e}`);
    }

    const out = rows.map(r => {
      const st = stats.get(r.id);
      const created = toDate(r.time_created);
      return {
        id: r.id,
        slug: r.slug ?? "",
        title: r.title ?? "",
        created,
        active: st ? toDate(st.last) : created,
        messages: st?.n ?? 0,
        model: model.get(r.id) ?? "",
        cost: r.cost ?? 0,
        preview: preview.get(r.id) ?? "",
        detail,
      };
    });
    out.sort((a, b) => b.active.getTime() - a.active.getTime());
    return out;
  } catch (e) {
    if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] could not read sessions: ${e}`);
    return [];
  } finally {
    conn.close();
  }
}

// opencode writes epoch milliseconds; tolerate seconds in case that changes
function toDate(stamp: number): Date {
  if (!stamp) return new Date(0);
  return new Date(stamp < 1e12 ? stamp * 1000 : stamp);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// the id is `ses_` + a reverse-time prefix + random tail, so every session cut
// in the same minute shares its first ~10 characters. this returns the shortest
// prefix that is still unique across the shown set (never shorter than the
// `ses_` + 12 timestamp characters, so it stays unambiguous after new sessions).
function bareId(id: string): string {
  return id.startsWith("ses_") ? id.slice(4) : id;
}

function shortIdLength(rows: SessionRow[]): number {
  for (let n = 8; n <= 40; n++) {
    const seen = new Set(rows.map(r => bareId(r.id).slice(0, n)));
    if (seen.size === rows.length) return n;
  }
  return 40;
}

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function msgCount(s: SessionRow): string {
  if (!s.detail) return "";
  if (s.messages === 0) return "empty";
  return s.messages === 1 ? "1 msg" : `${s.messages} msgs`;
}

// the auto title opencode gives a session that was never named
const AUTO_TITLE = /^New session - \d{4}-\d{2}-\d{2}T/;

function describe(s: SessionRow): string {
  if (s.preview) return oneLine(s.preview, 100);
  if (s.title && !AUTO_TITLE.test(s.title)) return oneLine(s.title, 100);
  return "(no user message yet)";
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
  retry?: string;
  retryCap?: string;
  publish?: string[];
}): string[] {
  const {
    runtime, cfg, selinux, interactive, opencodeArgs,
    secure = false, readOnly = false, model, systemPrompt, systemPromptFile,
    retry, retryCap, publish = [],
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
  // retry knobs for the image's retry proxy. forwarded when set on the host so
  // `OC_RETRY_MAX=120 opencode-terminal` works without touching extra_args
  for (const key of ["OC_RETRY_MAX", "OC_RETRY_CAP", "OC_RETRY_BASE", "OC_RETRY_DEADLINE", "OC_PROXY", "OC_PROXY_INSECURE"]) {
    if (process.env[key]) args.push("-e", `${key}=${process.env[key]}`);
  }
  // --retry / --retry-cap win over the env. cap is seconds here, ms in the container
  if (retry) args.push("-e", `OC_RETRY_MAX=${retry}`);
  if (retryCap) args.push("-e", `OC_RETRY_CAP=${Number(retryCap) * 1000}`);
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
  ${BIN_NAME} --sessions           List every session, newest activity first
  ${BIN_NAME} --sessions -v        Add slug, message count, model, cost and host dir
  ${BIN_NAME} --sessions <slug>    Resume by slug (or by id / id prefix)
  ${BIN_NAME} --model <id>         Model for this run, e.g. zai/glm-5.3
  ${BIN_NAME} --system-prompt <s>  Extra system prompt text for this run
  ${BIN_NAME} --system-prompt-file <f>
                                   Extra system prompt file for this run
  ${BIN_NAME} --retry <n>          Retry a busy provider n times (image default 200)
  ${BIN_NAME} --retry-cap <sec>    Ceiling between attempts (image default 60)
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
  --sessions lists every session, whichever directory it came from. The * marks
  the one this directory auto-resumes; sessions.json in your config_dir records
  which sessions came from where (-v prints it).
  Resume by id prefix or by the slug opencode gives each session ('swift-forest'):
  ids are reverse-time encoded, so their first characters all look alike and the
  list prints the shortest prefix that is still unique.
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

  const idLen = shortIdLength(sessions);
  const width = process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 100;
  // marker + id + "  " + "YYYY-MM-DD HH:MM" + "  " + preview
  const room = Math.max(20, width - (2 + idLen + 2 + 16 + 2));

  for (const s of sessions) {
    const marker = s.id === last ? "*" : " ";
    console.log(`${marker} ${bareId(s.id).slice(0, idLen)}  ${stamp(s.active)}  ${oneLine(describe(s), room)}`);
    if (verbose) {
      const dir = dirForId(cfg, s.id) ?? "(dir not tracked)";
      const bits = [s.slug || "-", msgCount(s), s.model, s.cost > 0 ? `$${s.cost.toFixed(4)}` : "", dir]
        .filter(Boolean).join("  ");
      console.log(`             ${bits}`);
    }
  }
  console.log(`\nresume: ${BIN_NAME} --sessions <id-or-slug>`);
}

// accepts a slug ("swift-forest"), a full id, or any id prefix, with or without
// the `ses_` part — ids are reverse-time encoded, so bare prefixes collide a lot
// and the error has to show enough to tell the matches apart
function resolveSession(cfg: Config, want: string): string | null {
  const all = listSessions(cfg);
  const exact = all.find(s => s.id === want || s.slug === want);
  if (exact) return exact.id;

  const bare = want.startsWith("ses_") ? want.slice(4) : want;
  const matches = all.filter(s => s.id.startsWith(want) || s.id.slice(4).startsWith(bare) || s.slug.startsWith(want));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.id;

  console.error(`[${BIN_NAME}] '${want}' matches ${matches.length} sessions:`);
  const idLen = shortIdLength(matches);
  for (const m of matches) {
    console.error(`  ${bareId(m.id).slice(0, idLen)}  ${(m.slug || "-").padEnd(16)}  ${oneLine(describe(m), 60)}`);
  }
  console.error(`use the slug, it is unique.`);
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

  // --sessions reads the host-side sqlite file, so both the listing and the
  // "no such session" error are answered before detectRuntime() can throw
  let resumeSession: string | undefined;
  if (argv.includes("--sessions")) {
    // -v means "verbose listing" here; outside --sessions it is opencode's own --version
    const verbose = takeFlag(argv, "-v", "--verbose");
    // the flags above are spliced out, so the index has to be read after them
    const idx = argv.indexOf("--sessions");
    const arg = argv[idx + 1];
    if (!arg || arg.startsWith("-")) {
      printSessions(cfg, cwd, verbose);
      return;
    }
    const resolved = resolveSession(cfg, arg);
    if (!resolved) {
      console.error(`[${BIN_NAME}] no session matching '${arg}'`);
      console.error(`[${BIN_NAME}] list them with: ${BIN_NAME} --sessions`);
      process.exit(1);
    }
    argv.splice(idx, 2);
    resumeSession = resolved;
  }

  const secure = takeFlag(argv, "--secure");
  const readOnly = takeFlag(argv, "--read-only");
  const interactive = takeFlag(argv, "-i", "--shell");
  const forceNew = takeFlag(argv, "--new");

  const model = takeOption(argv, "--model") ?? (cfg.model || undefined);
  const systemPrompt = takeOption(argv, "--system-prompt");
  const systemPromptFile = takeOption(argv, "--system-prompt-file") ?? (cfg.system_prompt_file || undefined);
  const retry = takeOption(argv, "--retry") ?? (cfg.retry || undefined);
  const retryCap = takeOption(argv, "--retry-cap") ?? (cfg.retry_cap || undefined);
  for (const [flag, value] of [["--retry", retry], ["--retry-cap", retryCap]] as const) {
    if (value !== undefined && !/^\d+$/.test(value)) {
      console.error(`[${BIN_NAME}] ${flag} takes a whole number, got ${value}`);
      process.exit(1);
    }
  }

  const runtime = detectRuntime(cfg.runtime);
  const selinux = detectSelinux(cfg.selinux);
  const shared = { runtime, cfg, selinux, secure, readOnly, model, systemPrompt, systemPromptFile, retry, retryCap };

  const run = (runArgs: string[]): never => {
    if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
    const r = spawnSync(runtime, runArgs, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  };

  if (resumeSession) {
    // resuming also claims the session for this directory, so the next bare run
    // picks it up and the listing stops hiding it
    rememberSessions(cfg, cwd, [resumeSession]);
    run(buildRunArgs({ ...shared, interactive: false, opencodeArgs: ["-s", resumeSession, ...argv] }));
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

  // snapshot first: a single run can create several sessions (the TUI's own
  // "new session"), and all of them belong to this directory
  const before = interactive ? new Set<string>() : new Set(listSessions(cfg).map(s => s.id));

  const result = spawnSync(runtime, runArgs, { stdio: "inherit" });

  if (!interactive) {
    const after = listSessions(cfg);           // already newest-activity first
    const fresh = after.filter(s => !before.has(s.id)).map(s => s.id);
    const touched = after.length > 0 ? [after[0]!.id] : [];
    const claim = [...new Set([...fresh, ...touched])];
    if (claim.length > 0) {
      rememberSessions(cfg, cwd, claim);
      if (process.env.OC_DEBUG) console.error(`[${BIN_NAME}] claimed ${claim.join(", ")} for ${cwd}`);
    }
  }

  process.exit(result.status ?? 1);
}

main().catch(e => {
  console.error(`[${BIN_NAME}] error: ${e.message}`);
  process.exit(1);
});
