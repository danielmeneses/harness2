import { test } from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, commandLabel, filterCommands } from "../src/commands.ts";

test("command registry is well formed", () => {
  const names = SLASH_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name.startsWith("/")));
  assert.ok(SLASH_COMMANDS.every((command) => command.description.trim().length > 0));
  assert.ok(names.includes("/login"));
  assert.ok(names.includes("/logout"));
  assert.ok(names.includes("/model"));
  assert.ok(names.includes("/effort"));
});

test("commands filter by prefix as the user types", () => {
  assert.equal(filterCommands("").length, SLASH_COMMANDS.length);
  assert.deepEqual(filterCommands("th").map((command) => command.name), ["/thinking"]);
  assert.deepEqual(filterCommands("LO").map((command) => command.name), ["/login", "/logout", "/loop"]);
  assert.deepEqual(filterCommands("mode").map((command) => command.name), ["/mode", "/model", "/models"]);
  assert.deepEqual(filterCommands("model").map((command) => command.name), ["/model", "/models"]);
  assert.deepEqual(filterCommands("zz").map((command) => command.name), []);
});

test("command labels include usage", () => {
  assert.equal(commandLabel({ name: "/model", args: "[name]", description: "" }), "/model [name]");
  assert.equal(commandLabel({ name: "/help", description: "" }), "/help");
});
