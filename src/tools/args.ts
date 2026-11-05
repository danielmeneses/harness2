export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`argument "${key}" must be a non-empty string`);
  return v;
}

export function reqText(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
}

export function optInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`argument "${key}" must be an integer`);
  return v;
}

export function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`argument "${key}" must be a boolean`);
  return v;
}

export function optRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`argument "${key}" must be an object`);
  return v as Record<string, unknown>;
}

export function reqArray(args: Record<string, unknown>, key: string): unknown[] {
  const v = args[key];
  if (!Array.isArray(v)) throw new Error(`argument "${key}" must be an array`);
  return v;
}
