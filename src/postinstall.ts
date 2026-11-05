import { ensureHarnessHome } from "./home.ts";

// Keep installs quiet and non-fatal; runtime also ensures the directory.
await ensureHarnessHome().catch(() => {});
