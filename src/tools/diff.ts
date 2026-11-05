import { truncateMiddle } from "../util.ts";

type Op = { type: " " | "-" | "+"; text: string; a?: number; b?: number };

function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = 600;
  if (n > max || m > max) {
    return [
      ...a.map((text) => ({ type: "-" as const, text })),
      ...b.map((text) => ({ type: "+" as const, text })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", text: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", text: a[i], a: i + 1 });
      i++;
    } else {
      ops.push({ type: "+", text: b[j], b: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", text: a[i], a: i + 1 }), i++;
  while (j < m) ops.push({ type: "+", text: b[j], b: j + 1 }), j++;
  return ops;
}

/** Compact unified diff; returns "" when the texts are equal. */
export function makeDiff(oldText: string, newText: string, context = 2): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldText === newText) return "";
  const ops = diffOps(oldLines, newLines);
  const changed = ops.map((op, i) => (op.type !== " " ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return "";

  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((o) => o.type !== "+").length;
    const newCount = slice.filter((o) => o.type !== "-").length;
    const oldStart = slice.find((o) => o.type !== "+")?.a ?? 1;
    const newStart = slice.find((o) => o.type !== "-")?.b ?? 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.type}${op.text}`);
  }
  return truncateMiddle(out.join("\n"), 20_000);
}
