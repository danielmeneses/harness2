import type { TurnAccumulator } from "./accum.ts";
import { sleep } from "../util.ts";

const THRESHOLD = 40;
const SLICE = 16;
const DELAY_MS = 8;

/**
 * Real token streams arrive in tiny chunks and pass straight through. Some
 * servers batch a whole line (or the whole response) into one chunk; split
 * those for display so the terminal still reveals text progressively.
 */
export async function feedAnimated(
  acc: TurnAccumulator,
  text: string,
  signal: AbortSignal | undefined,
  animate: boolean,
): Promise<void> {
  if (!animate || text.length <= THRESHOLD) {
    acc.feedText(text);
    return;
  }
  for (let i = 0; i < text.length; i += SLICE) {
    acc.feedText(text.slice(i, i + SLICE));
    if (i + SLICE < text.length) await sleep(DELAY_MS, signal);
  }
}
