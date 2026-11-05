import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ToolContext, ToolImpl } from "./types.ts";
import { capOutput, denied, failure } from "./types.ts";
import { optBool, optInt, optString, reqArray, reqString, reqText } from "./args.ts";
import { makeDiff } from "./diff.ts";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".turbo",
  ".harness2",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function displayPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cfg.cwd, abs);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : abs;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

async function* walkFiles(root: string, maxFiles = 20_000): AsyncGenerator<string> {
  let seen = 0;
  async function* recur(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* recur(abs);
        if (seen >= maxFiles) return;
      } else if (entry.isFile()) {
        yield abs;
        seen++;
        if (seen >= maxFiles) return;
      }
    }
  }
  yield* recur(root);
}

function escapeReChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

 function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end > i) {
        out += `(?:${p.slice(i + 1, end).split(",").map((s) => [...s].map(escapeReChar).join("")).join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += escapeReChar(c);
    }
  }
  return new RegExp(`${out}$`);
}

const read: ToolImpl = {
  spec: {
    name: "read",
    description:
      "Read a text file with line numbers. Use offset/limit for large files. Outside the working directory requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory or absolute." },
        offset: { type: "integer", description: "1-based first line to read (default 1)." },
        limit: { type: "integer", description: "Maximum lines to read (default 2000, max 5000)." },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx) {
    const target = reqString(args, "path");
    const offset = Math.max(1, optInt(args, "offset", 1));
    const limit = Math.min(5000, Math.max(1, optInt(args, "limit", 2000)));
    const g = await ctx.guard.check("read", target, "read tool");
    if (!g.ok) return denied(g.reason);

    const s = await stat(g.path).catch(() => null);
    if (!s) return failure(`file not found: ${target}`);
    if (s.isDirectory()) return failure(`${target} is a directory; use ls or glob`);
    if (!s.isFile()) return failure(`${target} is not a regular file`);

    const maxBytes = Math.min(ctx.cfg.safety.readMaxBytes, Math.max(1, s.size));
    const fh = await open(g.path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    await fh.close();
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, 8192).includes(0)) {
      return { ok: false, output: `binary file: ${target} (${s.size} bytes)` };
    }

    const text = new TextDecoder().decode(data);
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) return { ok: true, output: `${displayPath(ctx, g.path)} is empty`, meta: { lines: 0 } };
    if (offset > lines.length) {
      return failure(`offset ${offset} is past the end of ${target} (${lines.length} lines)`);
    }

    const end = Math.min(lines.length, offset - 1 + limit);
    const width = Math.max(4, String(lines.length).length);
    const out: string[] = [];
    const truncatedRead = s.size > bytesRead;
    out.push(
      `${displayPath(ctx, g.path)} (${lines.length} lines${truncatedRead ? `, read truncated at ${maxBytes} bytes` : ""})`,
    );
    for (let i = offset - 1; i < end; i++) {
      out.push(`${String(i + 1).padStart(width)}| ${lines[i]}`);
    }
    if (end < lines.length) out.push(`… (${lines.length - end} more lines; use offset=${end + 1})`);

    return {
      ok: true,
      output: capOutput(out.join("\n"), ctx.cfg.safety.toolOutputChars),
      meta: { lines: lines.length, offset, shown: end - offset + 1, truncated: truncatedRead },
    };
  },
};

const write: ToolImpl = {
  spec: {
    name: "write",
    description:
      "Create or overwrite a file with exactly the given content. Creates parent directories. Outside the working directory requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full file content. Use an empty string for an empty file." },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx) {
    const target = reqString(args, "path");
    const content = reqText(args, "content");
    const g = await ctx.guard.check("write", target, "write tool");
    if (!g.ok) return denied(g.reason);

    const existing = await stat(g.path).catch(() => null);
    const old = existing && existing.size <= 500_000 ? await readFile(g.path, "utf8").catch(() => null) : null;
    await mkdir(dirname(g.path), { recursive: true });
    await writeFile(g.path, content, "utf8");
    ctx.conv.changedFiles.add(g.path);
    const diff = old !== null ? makeDiff(old, content) : existing ? "" : makeDiff("", content);
    const lines = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
    return {
      ok: true,
      output: `${existing ? "Overwrote" : "Created"} ${displayPath(ctx, g.path)} (${lines} lines, ${content.length} chars).`,
      meta: { diff, created: existing === null, bytes: content.length, lines },
    };
  },
};

const edit: ToolImpl = {
  spec: {
    name: "edit",
    description:
      "Replace exact strings in an existing file. Each oldText must match uniquely unless replaceAll is true. All edits are applied atomically; the file is not written if any edit fails. Prefer this over write for modifying files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          description: "Edits applied in order.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  async execute(args, ctx) {
    const target = reqString(args, "path");
    const rawEdits = reqArray(args, "edits");
    if (rawEdits.length === 0) return failure("edits must not be empty");
    if (rawEdits.length > 50) return failure("at most 50 edits per call");

    const edits: Array<{ oldText: string; newText: string; replaceAll: boolean }> = [];
    for (let i = 0; i < rawEdits.length; i++) {
      const e = rawEdits[i];
      if (!isRecord(e)) return failure(`edits[${i}] must be an object`);
      if (typeof e.oldText !== "string" || !e.oldText) return failure(`edits[${i}].oldText must be a non-empty string`);
      if (typeof e.newText !== "string") return failure(`edits[${i}].newText must be a string`);
      edits.push({ oldText: e.oldText, newText: e.newText, replaceAll: e.replaceAll === true });
    }

    const g = await ctx.guard.check("write", target, "edit tool");
    if (!g.ok) return denied(g.reason);
    const st = await stat(g.path).catch(() => null);
    if (!st) return failure(`file not found: ${target}`);
    if (st.size > 2_000_000) return failure(`file is too large to edit (${st.size} bytes); use bash with a targeted tool instead`);
    const old = await readFile(g.path, "utf8").catch(() => null);
    if (old === null) return failure(`file not found: ${target}`);

    let next = old;
    let replacements = 0;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      const count = next.split(e.oldText).length - 1;
      if (count === 0) return failure(`edits[${i}]: oldText not found in ${displayPath(ctx, g.path)}`);
      if (count > 1 && !e.replaceAll) {
        return failure(
          `edits[${i}]: oldText matches ${count} times in ${displayPath(ctx, g.path)}; include more context or set replaceAll:true`,
        );
      }
      next = e.replaceAll ? next.split(e.oldText).join(e.newText) : next.replace(e.oldText, e.newText);
      replacements += e.replaceAll ? count : 1;
    }

    if (next === old) return { ok: true, output: `No changes to ${displayPath(ctx, g.path)} (content identical).` };
    await writeFile(g.path, next, "utf8");
    ctx.conv.changedFiles.add(g.path);
    const diff = old.length <= 500_000 ? makeDiff(old, next) : "";
    return {
      ok: true,
      output: `Edited ${displayPath(ctx, g.path)} (${replacements} replacement${replacements === 1 ? "" : "s"}).`,
      meta: { diff, replacements, bytes: next.length },
    };
  },
};

const ls: ToolImpl = {
  spec: {
    name: "ls",
    description: "List a directory. Includes sizes for files. Outside the working directory requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: working directory)." },
        all: { type: "boolean", description: "Include dotfiles (default false)." },
      },
    },
  },
  async execute(args, ctx) {
    const target = optString(args, "path") ?? ".";
    const all = optBool(args, "all", false);
    const g = await ctx.guard.check("read", target, "ls tool");
    if (!g.ok) return denied(g.reason);
    const s = await stat(g.path).catch(() => null);
    if (!s) return failure(`not found: ${target}`);
    if (!s.isDirectory()) return { ok: true, output: `${displayPath(ctx, g.path)} (file, ${fmtSize(s.size)})` };

    const entries = await readdir(g.path, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out: string[] = [];
    for (const entry of entries) {
      if (!all && entry.name.startsWith(".")) continue;
      const kind = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f";
      const abs = join(g.path, entry.name);
      const es = await stat(abs).catch(() => null);
      const size = entry.isDirectory() ? "" : es ? ` ${fmtSize(es.size)}` : "";
      out.push(`${kind} ${entry.name}${entry.isDirectory() ? "/" : ""}${size}`);
      if (out.length >= 1000) {
        out.push(`… (truncated at 1000 entries)`);
        break;
      }
    }
    if (!out.length) return { ok: true, output: `${displayPath(ctx, g.path)} is empty`, meta: { count: 0 } };
    return {
      ok: true,
      output: capOutput(out.join("\n"), ctx.cfg.safety.toolOutputChars),
      meta: { count: out.length },
    };
  },
};

const glob: ToolImpl = {
  spec: {
    name: "glob",
    description:
      "Find files by glob pattern relative to the working directory (e.g. src/**/*.ts). Directories like .git and node_modules are skipped.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.test.ts or src/*.ts." },
        path: { type: "string", description: "Base directory (default: working directory)." },
      },
      required: ["pattern"],
    },
  },
  async execute(args, ctx) {
    const pattern = reqString(args, "pattern");
    const base = optString(args, "path") ?? ".";
    const g = await ctx.guard.check("read", base, "glob tool");
    if (!g.ok) return denied(g.reason);
    const s = await stat(g.path).catch(() => null);
    if (!s?.isDirectory()) return failure(`not a directory: ${base}`);

    const re = globToRegExp(pattern);
    const results: string[] = [];
    for await (const file of walkFiles(g.path)) {
      const rel = relative(g.path, file).split(sep).join("/");
      if (re.test(rel)) {
        results.push(rel);
        if (results.length >= 500) break;
      }
    }
    if (!results.length) return { ok: true, output: `No files match ${pattern}`, meta: { count: 0 } };
    const truncated = results.length >= 500;
    const out = results.sort();
    if (truncated) out.push("… (truncated at 500 results)");
    return {
      ok: true,
      output: capOutput(out.join("\n"), ctx.cfg.safety.toolOutputChars),
      meta: { count: results.length, truncated },
    };
  },
};

const grep: ToolImpl = {
  spec: {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Returns path:line:text. Skips binary files and common build directories.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        path: { type: "string", description: "Base directory (default: working directory)." },
        glob: { type: "string", description: "Optional file glob filter, e.g. **/*.ts." },
        ignoreCase: { type: "boolean", description: "Case-insensitive search." },
        maxResults: { type: "integer", description: "Maximum matches (default 100, max 500)." },
      },
      required: ["pattern"],
    },
  },
  async execute(args, ctx) {
    const pattern = reqString(args, "pattern");
    const base = optString(args, "path") ?? ".";
    const globFilter = optString(args, "glob");
    const ignoreCase = optBool(args, "ignoreCase", false);
    const maxResults = Math.min(500, Math.max(1, optInt(args, "maxResults", 100)));
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      return failure(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
    const g = await ctx.guard.check("read", base, "grep tool");
    if (!g.ok) return denied(g.reason);
    const s = await stat(g.path).catch(() => null);
    if (!s?.isDirectory()) return failure(`not a directory: ${base}`);
    const fileRe = globFilter ? globToRegExp(globFilter) : null;

    const results: string[] = [];
    let truncated = false;
    for await (const file of walkFiles(g.path)) {
      const rel = relative(g.path, file).split(sep).join("/");
      if (fileRe && !fileRe.test(rel)) continue;
      const st = await stat(file).catch(() => null);
      if (!st || st.size > 2_000_000) continue;
      const buf = await readFile(file).catch(() => null);
      if (!buf || buf.subarray(0, 2048).includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    if (!results.length) return { ok: true, output: `No matches for /${pattern}/`, meta: { matches: 0 } };
    const out = results.slice();
    if (truncated) out.push(`… (truncated at ${maxResults} matches)`);
    return {
      ok: true,
      output: capOutput(out.join("\n"), ctx.cfg.safety.toolOutputChars),
      meta: { matches: results.length, truncated },
    };
  },
};

export const fsTools: ToolImpl[] = [read, write, edit, ls, glob, grep];
