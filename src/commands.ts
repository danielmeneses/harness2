export type SlashCommand = {
  name: string;
  args?: string;
  description: string;
};

/** Single source of truth for slash command discovery, /help and type-ahead. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "show all commands and key bindings" },
  { name: "/quit", description: "exit (aliases: /exit, /q)" },
  { name: "/login", args: "[provider]", description: "choose and authenticate a native provider" },
  { name: "/logout", description: "clear the active saved provider" },
  { name: "/model", args: "[name]", description: "choose a model from all saved providers" },
  { name: "/models", description: "list models from every saved provider" },
  { name: "/context-size", description: "list model context sizes reported by the API" },
  { name: "/mode", args: "[mode]", description: "choose the transport mode" },
  { name: "/effort", args: "[effort]", description: "choose the reasoning effort" },
  { name: "/thinking", description: "expand or collapse all thinking" },
  { name: "/loop", args: "[show|edit|reset|preset|changes]", description: "inspect or edit the loop spec" },
  { name: "/compact", description: "compact the conversation now" },
  { name: "/clear", description: "start a new conversation and session" },
  { name: "/sessions", description: "list recent sessions" },
  { name: "/resume", args: "<n|path>", description: "resume a session" },
  { name: "/session", description: "show the current session file" },
  { name: "/export", args: "[path]", description: "export the transcript as markdown" },
  { name: "/approvals", args: "[on|off]", description: "choose approval prompts" },
  { name: "/sandbox", args: "[on|off]", description: "choose the bash sandbox" },
  { name: "/network", args: "[ask|allow|deny]", description: "choose the network policy" },
  { name: "/tools", description: "list registered tools" },
];

export function commandLabel(command: SlashCommand): string {
  return command.name + (command.args ? ` ${command.args}` : "");
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  const matches = SLASH_COMMANDS.filter((command) => command.name.slice(1).toLowerCase().startsWith(q));
  const exact = matches.find((command) => command.name === `/${q}`);
  return exact ? [exact, ...matches.filter((command) => command !== exact)] : matches;
}
