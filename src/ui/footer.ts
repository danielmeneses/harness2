import type { Terminal } from "./terminal.ts";
import { controlLines, type ControlPanel } from "./control.ts";
import { sanitizeTerminal } from "../util.ts";

export const FOOTER_ROWS = 5;
const RED = "\x1b[38;5;167m";
const PANEL = "\x1b[48;5;236m\x1b[37m";

export function footerTop(term: Terminal, inputRows = 1): number {
  const rows = Math.max(1, inputRows);
  return Math.max(1, term.height - rows - 3);
}

function clip(text: string, width: number): string {
  if (width <= 1) return "…";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

export type FooterState = {
  inputLines: string[];
  control: ControlPanel | null;
  color: boolean;
};

/** Draw the fixed footer. The caller owns cursor save/restore and positioning. */
export function drawFooter(term: Terminal, state: FooterState): void {
  const inputLines = state.inputLines.length ? state.inputLines : [""];
  const top = footerTop(term, inputLines.length);
  const width = Math.max(20, term.width);
  const red = state.color ? `${RED}${"─".repeat(width)}\x1b[0m` : "─".repeat(width);

  term.moveTo(top, 1);
  term.clearLine();
  term.write(red);

  for (let i = 0; i < inputLines.length; i++) {
    const input = clip(sanitizeTerminal(inputLines[i]), Math.max(1, width - 2));
    term.moveTo(top + 1 + i, 1);
    term.clearLine();
    term.write(state.color ? `\x1b[1m${i === 0 ? "> " : "  "}\x1b[0m` : i === 0 ? "> " : "  ");
    term.write(input);
  }

  const redRow = top + 1 + inputLines.length;
  term.moveTo(redRow, 1);
  term.clearLine();
  term.write(red);

  const panel = state.control ? controlLines(state.control) : ["", ""];
  for (let i = 0; i < 2; i++) {
    const text = clip(sanitizeTerminal(panel[i] ?? ""), width);
    const padded = `${text}${" ".repeat(Math.max(0, width - text.length))}`;
    term.moveTo(redRow + 1 + i, 1);
    term.clearLine();
    term.write(state.color ? `${PANEL}${padded}\x1b[0m` : padded);
  }
}
