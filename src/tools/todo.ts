import type { ToolImpl } from "./types.ts";
import { failure } from "./types.ts";
import { optInt, optString } from "./args.ts";

function render(items: Array<{ text: string; done: boolean }>): string {
  if (!items.length) return "(todo list is empty)";
  return items.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n");
}

const todo: ToolImpl = {
  spec: {
    name: "todo",
    description:
      "Maintain a short task list for multi-step work. set replaces the list; add appends; done marks an item complete (1-based); list shows it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "add", "done", "list"] },
        items: { type: "array", items: { type: "string" }, description: "For set: task texts." },
        text: { type: "string", description: "For add: task text." },
        index: { type: "integer", description: "For done: 1-based item index." },
      },
      required: ["action"],
    },
  },
  async execute(args, ctx) {
    const action = optString(args, "action") ?? "";
    if (action === "set") {
      if (!Array.isArray(args.items) || args.items.some((x) => typeof x !== "string")) {
        return failure("items must be an array of strings");
      }
      ctx.conv.todos = (args.items as string[]).slice(0, 50).map((text) => ({ text: text.slice(0, 300), done: false }));
    } else if (action === "add") {
      const text = optString(args, "text");
      if (!text?.trim()) return failure("text is required for add");
      if (ctx.conv.todos.length >= 50) return failure("todo list is full (50 items)");
      ctx.conv.todos.push({ text: text.slice(0, 300), done: false });
    } else if (action === "done") {
      const index = optInt(args, "index", 0);
      if (index < 1 || index > ctx.conv.todos.length) return failure(`index must be 1..${ctx.conv.todos.length}`);
      ctx.conv.todos[index - 1].done = true;
    } else if (action === "list") {
      // no mutation
    } else {
      return failure(`unknown action "${action}"`);
    }
    ctx.emit(ctx.conv.id, { t: "todo", items: ctx.conv.todos });
    return { ok: true, output: render(ctx.conv.todos), meta: { count: ctx.conv.todos.length } };
  },
};

export const todoTools: ToolImpl[] = [todo];
