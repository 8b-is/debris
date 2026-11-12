import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORCED_FILTERS,
  MANIFEST,
  SUBTITLE_LANGUAGES,
  addonsFor,
  createBundle,
} from "../src/manifest.ts";

test("every manifest addon that touches streams is cached-only", () => {
  // The one rule that keeps peer traffic off family devices.
  const streamAddons = MANIFEST.filter((a) => a.id !== "opensubtitles" && a.id !== "youtube");
  for (const addon of streamAddons) {
    assert.equal(addon.cached_only, true, `${addon.id} must be cached-only`);
  }
});

test("the free tier gets no addons at all", () => {
  assert.deepEqual(addonsFor("free"), []);
  assert.equal(createBundle({ plan: "free", email: "a@b.c" }), null);
});

test("family gets the four stream addons plus subtitles, not YouTube", () => {
  const ids = addonsFor("family").map((a) => a.id);
  assert.deepEqual(ids, ["torrentio", "comet", "mediafusion", "jackettio", "opensubtitles"]);
});

test("household adds the YouTube addon", () => {
  const ids = addonsFor("household").map((a) => a.id);
  assert.ok(ids.includes("youtube"));
  assert.equal(ids.length, 6);
});

test("patron sees everything the manifest has", () => {
  assert.equal(addonsFor("patron").length, MANIFEST.length);
});

test("a bundle never carries the debrid credential", () => {
  const bundle = createBundle({ plan: "household", email: "dra@bundle.test" });
  assert.ok(bundle);
  const serialised = JSON.stringify(bundle).toLowerCase();
  for (const forbidden of ["token", "credential", "secret", "api_key", "apikey", "password"]) {
    assert.equal(
      serialised.includes(forbidden),
      false,
      `a bundle must never carry ${forbidden}`,
    );
  }
});

test("a bundle expires one hour out", () => {
  const now = 1_760_000_000;
  const bundle = createBundle({ plan: "family", email: "a@b.c", now });
  assert.ok(bundle);
  const expiry = new Date(bundle.expires_at).getTime();
  assert.equal(expiry - now * 1000, 3600 * 1000);
});

test("an unknown plan yields no bundle", () => {
  assert.equal(createBundle({ plan: "enterprise", email: "a@b.c" }), null);
  assert.equal(createBundle({ plan: undefined, email: "a@b.c" }), null);
});

test("forced filters and subtitle languages are present on every paid bundle", () => {
  const bundle = createBundle({ plan: "family", email: "a@b.c" });
  assert.ok(bundle);
  assert.deepEqual([...bundle.forced_filters], [...FORCED_FILTERS]);
  assert.deepEqual([...bundle.subtitle_languages], [...SUBTITLE_LANGUAGES]);
});

test("the manifest is frozen", () => {
  assert.equal(Object.isFrozen(MANIFEST), true);
});