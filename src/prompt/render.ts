import type { Msg } from "../types.ts";

export type RenderTemplate = "chatml" | "plain";

function sanitizeChatml(s: string): string {
  return s
    .replaceAll("<|im_start|>", "<|im_start| >")
    .replaceAll("<|im_end|>", "<|im_end| >")
    .replaceAll("<|endoftext|>", "<|endoftext| >");
}

function sanitizePlain(s: string): string {
  return s.replace(/\n### (System|User|Assistant|Tool)/g, "\n\\### $1");
}

function toolCallText(call: { name: string; args: Record<string, unknown>; argError?: string }): string {
  if (call.argError) return `\n<tool_call>{"name":"invalid_tool_call","arguments":${JSON.stringify(call.args)}}</tool_call>`;
  return `\n<tool_call>${JSON.stringify({ name: call.name, arguments: call.args })}</tool_call>`;
}

function assistantBody(m: Extract<Msg, { role: "assistant" }>): string {
  let body = m.content;
  for (const call of m.toolCalls ?? []) body += toolCallText(call);
  return body;
}

export function renderCompletions(template: RenderTemplate, system: string, messages: Msg[]): string {
  if (template === "plain") {
    const parts: string[] = [`### System\n${system}`, ""];
    for (const m of messages) {
      if (m.role === "user") {
        parts.push(`### User\n${sanitizePlain(m.content)}`, "");
      } else if (m.role === "assistant") {
        parts.push(`### Assistant\n${sanitizePlain(assistantBody(m))}`, "");
      } else {
        const name = m.name.replace(/[^\w.-]/g, "_");
        parts.push(`### Tool result: ${name} (${m.ok ? "ok" : "failed"})\n${sanitizePlain(m.content)}`, "");
      }
    }
    parts.push("### Assistant\n");
    return parts.join("\n");
  }

  const parts: string[] = [`<|im_start|>system\n${system}<|im_end|>`];
  for (const m of messages) {
    if (m.role === "user") {
      parts.push(`<|im_start|>user\n${sanitizeChatml(m.content)}<|im_end|>`);
    } else if (m.role === "assistant") {
      parts.push(`<|im_start|>assistant\n${sanitizeChatml(assistantBody(m))}<|im_end|>`);
    } else {
      const name = m.name.replace(/[^\w.-]/g, "_");
      parts.push(
        `<|im_start|>user\n<tool_response name="${name}" ok="${m.ok ? "true" : "false"}">\n${sanitizeChatml(m.content)}\n</tool_response><|im_end|>`,
      );
    }
  }
  parts.push("<|im_start|>assistant\n");
  return parts.join("\n");
}
