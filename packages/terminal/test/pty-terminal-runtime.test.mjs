import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTerminalSize,
  resolveDefaultTerminalShell
} from "../dist/index.js";

test("uses Windows PowerShell by default on Windows", () => {
  const shell = resolveDefaultTerminalShell("win32", {});
  assert.equal(shell.command, "powershell.exe");
  assert.deepEqual(shell.args, ["-NoLogo"]);
  assert.equal(shell.label, "Windows PowerShell");
});

test("honors an explicit Kripl terminal shell override", () => {
  const shell = resolveDefaultTerminalShell("win32", {
    KRIPL_TERMINAL_SHELL: "pwsh.exe"
  });
  assert.equal(shell.command, "pwsh.exe");
  assert.deepEqual(shell.args, []);
});

test("uses SHELL on non-Windows platforms", () => {
  const shell = resolveDefaultTerminalShell("linux", { SHELL: "/bin/zsh" });
  assert.equal(shell.command, "/bin/zsh");
});

test("terminal dimensions are bounded and normalized", () => {
  assert.deepEqual(normalizeTerminalSize(undefined, undefined), { cols: 100, rows: 30 });
  assert.deepEqual(normalizeTerminalSize(1, 9999), { cols: 2, rows: 300 });
  assert.deepEqual(normalizeTerminalSize(120.8, 42.9), { cols: 120, rows: 42 });
});
