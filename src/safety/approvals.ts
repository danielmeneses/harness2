import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import type { ApprovalKind, Emit } from "../events.ts";
import { randomId } from "../util.ts";
import { harnessPath } from "../home.ts";

export type Decision = "once" | "session" | "always" | "deny";

export type ApprovalRequest = {
  kind: ApprovalKind;
  title: string;
  detail?: string;
  key: string;
  /** Conversation that asked; approval events are attributed to its stream. */
  stream?: string;
  options?: string[];
};

/** Grants are bound to the workspace they were issued for. */
function grantKey(cwd: string, stream: string | undefined, key: string): string {
  return `${cwd}\u0000${stream ?? "main"}\u0000${key}`;
}

export type ApprovalResponse = {
  decision: Decision;
  reason?: string;
};

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResponse>;

function grantsPath(): string {
  return harnessPath("grants.json");
}

export class Approvals {
  #cfg: Config;
  #emit: Emit;
  #cwd: string;
  #handler: ApprovalHandler | null = null;
  #session = new Set<string>();
  #always = new Set<string>();
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(cfg: Config, emit: Emit) {
    this.#cfg = cfg;
    this.#emit = emit;
    this.#cwd = cfg.cwd;
  }

  get interactive(): boolean {
    return this.#handler !== null;
  }

  setHandler(handler: ApprovalHandler | null): void {
    this.#handler = handler;
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(grantsPath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) if (value === true) this.#always.add(key);
    } catch {
      // no grants yet
    }
  }

  async request(req: ApprovalRequest): Promise<ApprovalResponse> {
    if (this.#cfg.safety.approvals === "off" || this.#cfg.safety.approveAll) {
      return { decision: "once" };
    }
    const scoped = grantKey(this.#cwd, req.stream, req.key);
    if (this.#session.has(scoped) || this.#always.has(scoped)) {
      return { decision: "once" };
    }
    if (!this.#handler) {
      return { decision: "deny", reason: "no interactive user is available to approve this action" };
    }

    const id = randomId("ap_");
    const stream = req.stream ?? "main";
    this.#emit(stream, { t: "approval.request", id, kind: req.kind, title: req.title, detail: req.detail });
    let res: ApprovalResponse;
    try {
      res = await this.#handler(req);
    } catch (e) {
      res = { decision: "deny", reason: e instanceof Error ? e.message : String(e) };
    }
    if (res.decision === "session") this.#session.add(scoped);
    if (res.decision === "always") {
      this.#always.add(scoped);
      this.#persist(scoped);
    }
    this.#emit(stream, { t: "approval.result", id, decision: res.decision, reason: res.reason });
    return res;
  }

  async ask(question: string, options?: string[], stream = "main"): Promise<string | null> {
    if (!this.#handler) return null;
    const id = randomId("ask_");
    this.#emit(stream, {
      t: "approval.request",
      id,
      kind: "ask",
      title: question,
      detail: options?.length ? options.join(" / ") : undefined,
    });
    const res = await this.#handler({
      kind: "ask",
      title: question,
      detail: options?.length ? options.join(" / ") : undefined,
      key: `ask:${id}`,
      options,
    });
    const answer = res.decision === "deny" ? null : (res.reason ?? "");
    this.#emit(stream, { t: "approval.result", id, decision: answer === null ? "deny" : "answered", reason: answer ?? undefined });
    return answer;
  }

  #persist(key: string): void {
    this.#saveQueue = this.#saveQueue
      .then(async () => {
        let grants: Record<string, boolean> = {};
        try {
          grants = JSON.parse(await readFile(grantsPath(), "utf8")) as Record<string, boolean>;
        } catch {
          // start fresh
        }
        grants[key] = true;
        await mkdir(dirname(grantsPath()), { recursive: true, mode: 0o700 });
        await writeFile(grantsPath(), `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
        await chmod(grantsPath(), 0o600).catch(() => {});
      })
      .catch(() => {
        // failing to persist a grant is not fatal
      });
  }
}
