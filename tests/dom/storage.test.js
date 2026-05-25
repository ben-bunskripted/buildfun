// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPrefs, savePrefs, save, load, clear, hasSnapshot, loadAll, MATCH_MODES,
} from "../../projects/benny-card-game/js/storage.js";

beforeEach(() => localStorage.clear());

describe("prefs", () => {
  it("round-trips preferences", () => {
    expect(loadPrefs()).toEqual({});
    savePrefs({ cardStyle: "classic", cardSize: "l" });
    expect(loadPrefs()).toEqual({ cardStyle: "classic", cardSize: "l" });
  });
  it("returns {} on corrupt JSON", () => {
    localStorage.setItem("benny:prefs:v1", "{not json");
    expect(loadPrefs()).toEqual({});
  });
});

describe("per-mode match slots", () => {
  it("saves and loads independently per mode", () => {
    save({ mode: "cpu", state: { a: 1 } });
    save({ mode: "scoring", state: { b: 2 } });
    expect(load("cpu").state).toEqual({ a: 1 });
    expect(load("scoring").state).toEqual({ b: 2 });
    expect(load("multiplayer")).toBeNull();
  });
  it("stamps a version + savedAt", () => {
    save({ mode: "cpu", state: {} });
    const snap = load("cpu");
    expect(snap.version).toBe(1);
    expect(typeof snap.savedAt).toBe("number");
  });
  it("ignores an unknown mode", () => {
    save({ mode: "bogus", state: {} });
    expect(loadAll()).toEqual({});
  });
  it("hasSnapshot + clear behave", () => {
    save({ mode: "cpu", state: {} });
    expect(hasSnapshot("cpu")).toBe(true);
    clear("cpu");
    expect(hasSnapshot("cpu")).toBe(false);
  });
  it("loadAll returns only modes that have a saved game", () => {
    save({ mode: "cpu", state: {} });
    const all = loadAll();
    expect(Object.keys(all)).toEqual(["cpu"]);
    for (const k of Object.keys(all)) expect(MATCH_MODES).toContain(k);
  });
});

describe("legacy migration", () => {
  it("folds a pre-per-mode blob into its mode slot then deletes it", () => {
    localStorage.setItem("benny:match:v1", JSON.stringify({ version: 1, state: { mode: "multiplayer" } }));
    const snap = load("multiplayer");
    expect(snap).toBeTruthy();
    expect(snap.state.mode).toBe("multiplayer");
    expect(localStorage.getItem("benny:match:v1")).toBeNull();
  });
});
