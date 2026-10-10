import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the renderer sources with the existing build toolchain, without a
// browser / Electron process or an additional component-testing dependency.
const compiled = buildSync({
  stdin: {
    contents: `
      export { Markdown } from "./Markdown";
      export { CollapsibleDetails } from "./CollapsibleDetails";
      export { tokenizeInline } from "./inline-markdown";
    `,
    resolveDir: fileURLToPath(new URL("../src/renderer/src", import.meta.url)),
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  jsx: "automatic",
  write: false,
  logLevel: "silent"
}).outputFiles[0].text;
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(import.meta.url), componentModule, componentModule.exports
);
const { Markdown, CollapsibleDetails, tokenizeInline } = componentModule.exports;
const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

test("inline markup retains formatting, code delimiters and link labels", () => {
  assert.deepEqual(tokenizeInline("**bold** *em* ~~gone~~ ``code`` [site](https://example.com)"), [
    { kind: "strong", text: "bold" }, { kind: "text", text: " " },
    { kind: "em", text: "em" }, { kind: "text", text: " " },
    { kind: "del", text: "gone" }, { kind: "text", text: " " },
    { kind: "code", text: "code" }, { kind: "text", text: " " },
    { kind: "link", text: "site", href: "https://example.com" }
  ]);
  assert.match(render("**bold `code`**"), /<strong>bold <code>code<\/code><\/strong>/);
  assert.deepEqual(tokenizeInline("`/* comment */`"), [{ kind: "code", text: "/* comment */" }]);
  assert.deepEqual(tokenizeInline("``x`"), [{ kind: "code", text: "x" }]);
  assert.deepEqual(tokenizeInline("`x``"), [{ kind: "code", text: "x`" }]);
  assert.deepEqual(tokenizeInline("***x***"), [
    { kind: "text", text: "*" }, { kind: "strong", text: "x" }, { kind: "text", text: "*" }
  ]);
});

test("unfinished syntax stays literal and formatting does not cross newlines", () => {
  for (const input of ["[[[", "````unclosed", "[name](https://example.com", "*one\ntwo*", "~~one\ntwo~~"]) {
    assert.deepEqual(tokenizeInline(input), [{ kind: "text", text: input }]);
  }
  assert.deepEqual(tokenizeInline("[[name](https://example.com)"), [
    { kind: "link", text: "[name", href: "https://example.com" }
  ]);
  assert.deepEqual(tokenizeInline("[bad](broken url) [ok](https://example.com)"), [
    { kind: "text", text: "[bad](broken url) " },
    { kind: "link", text: "ok", href: "https://example.com" }
  ]);
});

test("untrusted markup remains escaped and only HTTP(S) links are clickable", () => {
  const html = render('<script>alert(1)</script> [bad](javascript:alert) [file](file:///tmp/a) [ok](HTTPS://example.com)');
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[bad\]\(javascript:alert\)/);
  assert.match(html, /\[file\]\(file:\/\/\/tmp\/a\)/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /href="HTTPS:\/\/example.com" target="_blank" rel="noreferrer"/);
});

test("headings, lists, quotes, tables and fenced code retain their structure", () => {
  const html = render([
    "# Heading", "", "## Section", "", "### Detail", "",
    "- One", "- **Two**", "", "1. First", "2. Second", "",
    "> Quoted", "> text", "", "---", "",
    "| Left | Right |", "| :--- | ---: |", "| `code` | **value** |", "",
    "```ts", 'const value = "<tag>";', "```"
  ].join("\n"));
  for (const tag of ["h1", "h2", "h3", "ul", "ol", "blockquote", "table", "thead", "tbody", "pre"]) {
    assert.match(html, new RegExp(`<${tag}[ >]`));
  }
  assert.match(html, /<th>Left<\/th><th>Right<\/th>/);
  assert.match(html, /<td><code>code<\/code><\/td><td><strong>value<\/strong><\/td>/);
  assert.match(html, /const value = &quot;&lt;tag&gt;&quot;;/);
  assert.match(html, /title="Скопировать код"/);
  assert.match(html, /<hr\/>/);
});

test("an unfinished code fence and lone pipe lines do not lose content or stall", () => {
  const code = 'const text = "**literal**";\nreturn text;';
  const html = render("```js\n" + code);
  assert.match(html, /<pre><code class="lang">const text = &quot;\*\*literal\*\*&quot;;\nreturn text;<\/code><\/pre>/);
  const pipes = render("|\n| tree branch\n\nEnd");
  assert.match(pipes, /<p>\|<\/p>/);
  assert.match(pipes, /<p>\| tree branch<\/p>/);
  assert.match(pipes, /<p>End<\/p>/);
});

test("long messages keep all paragraphs and the complete fenced source", () => {
  const paragraphs = Array.from({ length: 1500 }, (_, index) => `Paragraph ${index}: **value ${index}**.`);
  const source = Array.from({ length: 3000 }, (_, index) => `line_${index}();`).join("\n");
  const html = render(paragraphs.join("\n\n") + "\n\n```js\n" + source + "\n```");
  assert.equal((html.match(/<p>/g) ?? []).length, paragraphs.length);
  assert.match(html, /Paragraph 1499: <strong>value 1499<\/strong>/);
  assert.ok(html.includes(source));
});

test("large unfinished delimiters and URL tails complete without quadratic rescans", () => {
  // A separate process enforces the deadline even if a synchronous parser
  // regression blocks its event loop. The budget is generous for slow CI.
  const stress = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const tokenizeInline = (${tokenizeInline.toString()});
    for (const input of ["[".repeat(1_000_000), "\u0060".repeat(1_000_000) + "x", "[x](".repeat(250_000)]) {
      assert.deepEqual(tokenizeInline(input), [{ kind: "text", text: input }]);
    }
  `], { timeout: 10_000, encoding: "utf8" });
  assert.equal(stress.error, undefined, String(stress.error));
  assert.equal(stress.status, 0, stress.stderr);
});

test("closed details do not render hidden child components or prepare lazy bodies", () => {
  function HiddenBody() { throw new Error("A closed body must not render"); }
  const options = { className: "reasoning", summary: "Reasoning" };
  const hidden = renderToStaticMarkup(createElement(CollapsibleDetails, options, createElement(HiddenBody)));
  assert.equal(hidden, '<details class="reasoning"><summary>Reasoning</summary></details>');
  const lazy = renderToStaticMarkup(createElement(CollapsibleDetails, options, () => {
    throw new Error("A closed body must not be prepared");
  }));
  assert.equal(lazy, hidden);
});

test("default-open details render their body and keep controls in the summary", () => {
  let calls = 0;
  const html = renderToStaticMarkup(createElement(CollapsibleDetails, {
    className: "panel",
    bodyClassName: "panel-body",
    defaultOpen: true,
    summary: createElement("button", { type: "button" }, "Action")
  }, () => {
    calls += 1;
    return createElement("p", null, "Full content");
  }));
  assert.equal(calls, 1);
  assert.equal(html, '<details class="panel" open=""><summary><button type="button">Action</button></summary><div class="panel-body"><p>Full content</p></div></details>');
});
