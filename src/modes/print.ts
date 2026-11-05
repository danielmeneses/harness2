import type { Runner } from "../loop/kernel.ts";
import type { Conversation } from "../loop/state.ts";
import type { EventBus } from "../events.ts";
import { errorMessage } from "../util.ts";

export async function runPrint(args: {
  runner: Runner;
  conv: Conversation;
  prompt: string;
  json: boolean;
  bus: EventBus;
}): Promise<number> {
  const { runner, conv, prompt, json, bus } = args;
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once("SIGINT", onSigint);

  const unsubscribe = json
    ? () => {}
    : bus.subscribe((ev) => {
        if (ev.t === "error") process.stderr.write(`error: ${ev.message}\n`);
        else if (ev.t === "notice" || ev.t === "provider") {
          process.stderr.write(`note: ${ev.t === "notice" ? ev.message : `${ev.mode} provider`}\n`);
        }
      });

  try {
    const result = await runner.run(conv, prompt, { signal: ac.signal });
    if (!json) {
      const out = result.answer.trim() ? result.answer : "(no final text answer)";
      process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    }
    if (result.reason === "aborted") return 130;
    if (result.reason === "error" || result.reason === "max_steps") return 1;
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${errorMessage(e)}\n`);
    return 1;
  } finally {
    unsubscribe();
    process.off("SIGINT", onSigint);
  }
}
