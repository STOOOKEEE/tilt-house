import { describe, expect, it } from "vitest";
import { parseOptions } from "../src/args.ts";

describe("parseOptions", () => {
  it("defaults to the testnet house and token, no relayer, no funder", () => {
    expect(parseOptions([], {})).toEqual({
      house: "house.tilthouse.testnet",
      token: "tusdc.tilthouse.testnet",
      relayer: undefined,
      rpcUrl: "https://test.rpc.fastnear.com",
      funder: undefined,
      dryRun: false,
      relayed: false,
    });
  });

  it("reads flags, which win over env", () => {
    const env = { HOUSE_CONTRACT: "env-house.testnet", RELAYER_URL: "http://env:1" };
    const options = parseOptions(
      ["--house", "h.testnet", "--token=t.testnet", "--relayer", "https://relay.example/", "--dry-run"],
      env,
    );
    expect(options).toMatchObject({
      house: "h.testnet",
      token: "t.testnet",
      relayer: "https://relay.example",
      dryRun: true,
    });
  });

  it("falls back to env and skips a leading --", () => {
    const env = { HOUSE_CONTRACT: "env-house.testnet", RELAYER_URL: "http://127.0.0.1:8787" };
    expect(parseOptions(["--", "--dry-run"], env)).toMatchObject({
      house: "env-house.testnet",
      relayer: "http://127.0.0.1:8787",
      dryRun: true,
    });
  });

  it("reads the funder from env, both or neither", () => {
    const env = { FUNDER_ACCOUNT: "me.testnet", FUNDER_KEY: "ed25519:abc" };
    expect(parseOptions([], env).funder).toEqual({ accountId: "me.testnet", key: "ed25519:abc" });
    expect(() => parseOptions([], { FUNDER_ACCOUNT: "me.testnet" })).toThrow(/both/);
    expect(() => parseOptions([], { ...env, FUNDER_KEY: "secret" })).toThrow(/ed25519/);
  });

  it("refuses mainnet or invalid accounts and bad URLs", () => {
    expect(() => parseOptions(["--house", "house.near"], {})).toThrow(/testnet/);
    expect(() => parseOptions(["--token", "Bad..id"], {})).toThrow(/account id/);
    expect(() => parseOptions(["--relayer", "ftp://x"], {})).toThrow(/http/);
    expect(() => parseOptions(["--relayer", "not a url"], {})).toThrow(/URL/);
    expect(() => parseOptions([], { FUNDER_ACCOUNT: "me.near", FUNDER_KEY: "ed25519:a" })).toThrow(/testnet/);
  });

  it("accepts --relayed only with a relayer", () => {
    expect(parseOptions(["--relayer", "http://127.0.0.1:8787", "--relayed"], {}).relayed).toBe(true);
    expect(parseOptions(["--relayed"], { RELAYER_URL: "http://127.0.0.1:8787" }).relayed).toBe(true);
    expect(() => parseOptions(["--relayed"], {})).toThrow(/relayer/);
  });

  it("refuses unknown flags and positionals", () => {
    expect(() => parseOptions(["--mainnet"], {})).toThrow();
    expect(() => parseOptions(["play"], {})).toThrow();
  });
});
