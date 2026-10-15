import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
const openers = readFileSync(new URL("../../web/src/components/Openers.tsx", import.meta.url), "utf8");

function mobileBlock(): string {
  const start = css.indexOf("@media (max-width: 820px)");
  assert.ok(start >= 0, "mobile media query is missing");
  return css.slice(start, css.indexOf("\n}", start));
}

test("mobile grid track cannot grow wider than the screen (390 px demo 15.10: page was 41-57 px wider)", () => {
  // A plain 1fr track has min-content as its minimum, so the candidates table widened the page.
  assert.match(mobileBlock(), /\.grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(css, /grid-template-columns:\s*1fr\s*;/);
});

test("the candidates table scrolls inside its own container", () => {
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(openers, /<div className="table-wrap">\s*<table className="openers">/);
});
