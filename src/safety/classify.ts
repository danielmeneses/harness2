import { basename, isAbsolute, resolve } from "node:path";
import type { Config } from "../config.ts";
import { expandHome } from "../util.ts";
import { isInsideAny } from "./paths.ts";

const NET_COMMANDS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "ping",
  "dig",
  "nslookup",
  "host",
  "traceroute",
  "ngrok",
  "tor",
  "npx",
  "uvx",
]);

const GIT_NET = new Set(["clone", "fetch", "pull", "push", "remote", "ls-remote", "submodule"]);
const DOCKER_NET = new Set(["pull", "push", "login", "logout", "run", "create", "build", "compose", "search"]);

const PKG_NET: Record<string, Set<string> | null> = {
  npm: new Set(["install", "i", "ci", "add", "update", "up", "publish", "audit", "exec", "dlx"]),
  pnpm: new Set(["install", "i", "add", "update", "up", "publish", "dlx", "audit"]),
  yarn: new Set(["install", "add", "up", "upgrade", "publish", "dlx", "audit"]),
  bun: new Set(["install", "i", "add", "update", "publish", "x"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  uv: new Set(["pip", "add", "sync", "lock", "tool"]),
  poetry: new Set(["add", "install", "update", "publish"]),
  cargo: new Set(["install", "publish", "search", "add", "update"]),
  go: new Set(["get", "install"]),
  gem: new Set(["install", "update", "push"]),
  composer: new Set(["install", "require", "update"]),
  apt: null,
  "apt-get": null,
  dnf: null,
  yum: null,
  pacman: null,
  zypper: null,
  snap: null,
  brew: null,
  winget: null,
  choco: null,
  gh: null,
  hub: null,
};

function roots(cfg: Config): string[] {
  return [cfg.cwd, ...cfg.safety.readRoots, ...cfg.safety.writeRoots, ...cfg.safety.allowedPaths];
}

function resolvePathToken(token: string, cwd: string): string | null {
  const t = token.replace(/^[("'`]+|[)"'`,]+$/g, "");
  if (!t) return null;
  if (t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr") return null;
  if (t.startsWith("//") || t.includes("://")) return null;
  const expanded = expandHome(t);
  if (!isAbsolute(expanded) && !t.startsWith("../") && t !== "..") return null;
  return resolve(cwd, expanded);
}

export function classifyBash(command: string, cfg: Config): string[] {
  const reasons = new Set<string>();
  const cwd = cfg.cwd;
  const within = roots(cfg);

  const pathRe = /(?:^|[\s"'`=:;,|&(){}<>])((?:\/[^\s"'`;|&(){}<>]+)|(?:~(?:\/[^\s"'`;|&(){}<>]*)?))/g;
  for (const m of command.matchAll(pathRe)) {
    const abs = resolvePathToken(m[1], cwd);
    if (abs && !isInsideAny(abs, within)) reasons.add(`path outside working directory: ${m[1]}`);
  }

  if (/\bhttps?:\/\/[^\s"'`]+/i.test(command)) reasons.add("network URL in command");
  if (/(^|[\s"'`(])\$(\{?HOME\}?)([\s"'`)/]|$)/.test(command)) reasons.add("uses $HOME");

  for (const segment of command.split(/\n|;|&&|\|\|?/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => basename(t.replace(/^["'`]+|["'`,]+$/g, "")).replace(/^.*\//, ""));
    if (!tokens.length) continue;

    for (const token of tokens) {
      if (NET_COMMANDS.has(token)) reasons.add(`network command: ${token}`);
    }
    for (const [manager, allowed] of Object.entries(PKG_NET)) {
      const idx = tokens.indexOf(manager);
      if (idx < 0) continue;
      if (allowed === null) {
        reasons.add(`network command: ${manager}`);
        continue;
      }
      const found = tokens.slice(idx + 1).find((t) => allowed.has(t));
      if (found) reasons.add(`network command: ${manager} ${found}`);
    }
    const gitIdx = tokens.indexOf("git");
    if (gitIdx >= 0) {
      const found = tokens.slice(gitIdx + 1).find((t) => GIT_NET.has(t));
      if (found) reasons.add(`network command: git ${found}`);
    }
    const dockerIdx = tokens.findIndex((t) => t === "docker" || t === "podman");
    if (dockerIdx >= 0) {
      const found = tokens.slice(dockerIdx + 1).find((t) => DOCKER_NET.has(t));
      if (found) reasons.add(`network command: ${tokens[dockerIdx]} ${found}`);
    }
  }

  const traversal = /(?:^|[\s"'`=:;,|&(){}<>])([^\s"'`;|&(){}<>]*\.\.[^\s"'`;|&(){}<>]*)/g;
  for (const m of command.matchAll(traversal)) {
    const token = m[1];
    const abs = resolve(cwd, token);
    if (!isInsideAny(abs, within)) reasons.add(`parent-directory access: ${token}`);
  }

  return [...reasons];
}
