import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "relayer-state-")), "nested", "state.json");

describe("StateStore", () => {
  it("persists bindings and the budget, private to the relayer user", () => {
    const path = file();
    const store = new StateStore(path);
    store.bind("did:privy:a", "ab".repeat(32), 5);
    store.setBudget({ day: "2026-11-12", spentYocto: "7", lastBalanceYocto: "9" });
    const reloaded = new StateStore(path);
    expect(reloaded.hasUser("did:privy:a")).toBe(true);
    expect(reloaded.hasAccount("ab".repeat(32))).toBe(true);
    expect(reloaded.state.budget).toEqual({ day: "2026-11-12", spentYocto: "7", lastBalanceYocto: "9" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("unbind forgets both the user and the account", () => {
    const path = file();
    const store = new StateStore(path);
    store.bind("did:privy:a", "acc", 5);
    store.unbind("did:privy:a");
    const reloaded = new StateStore(path);
    expect(reloaded.hasUser("did:privy:a")).toBe(false);
    expect(reloaded.hasAccount("acc")).toBe(false);
  });

  it("persists welcome claims and forgets a failed one", () => {
    const path = file();
    const store = new StateStore(path);
    store.markWelcome("did:privy:a", "acc", 5);
    store.markWelcome("did:privy:b", "acc2", 6);
    store.unmarkWelcome("did:privy:b");
    const reloaded = new StateStore(path);
    expect(reloaded.hasWelcome("did:privy:a")).toBe(true);
    expect(reloaded.hasWelcome("did:privy:b")).toBe(false);
    expect(reloaded.hasWelcome("constructor")).toBe(false);
  });

  it("reads a file written before welcome claims existed", () => {
    const path = file();
    new StateStore(path).bind("did:privy:a", "acc", 5);
    const old = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete old.welcomes;
    writeFileSync(path, JSON.stringify(old));
    const reloaded = new StateStore(path);
    expect(reloaded.hasUser("did:privy:a")).toBe(true);
    expect(reloaded.hasWelcome("did:privy:a")).toBe(false);
  });

  it("does not treat inherited object keys as users", () => {
    expect(new StateStore(null).hasUser("constructor")).toBe(false);
  });

  it("refuses to start on a corrupt file rather than forget who was paid", () => {
    const path = file();
    new StateStore(path).bind("did:privy:a", "acc", 5);
    writeFileSync(path, readFileSync(path, "utf8").replace('"at": 5', '"at": "soon"'));
    expect(() => new StateStore(path)).toThrow(/invalid activation/);
    writeFileSync(path, "{");
    expect(() => new StateStore(path)).toThrow();
  });
});
