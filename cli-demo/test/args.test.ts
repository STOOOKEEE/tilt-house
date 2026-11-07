import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/args.ts";

const DEFAULT_TARGETS = {
  floor: "floor.tilthouse.testnet",
  token: "tusdc.tilthouse.testnet",
  relayer: "https://tilt-house-beta.vercel.app/relayer",
  session: "https://tilt-house-beta.vercel.app/session",
  rpcUrl: "https://test.rpc.fastnear.com",
  serverAccount: "sessions.tilthouse.testnet",
  nearblocksApi: "https://api-testnet.nearblocks.io",
};

describe("parseCommand", () => {
  it("defaults to the public testnet deployment", () => {
    expect(parseCommand(["demo"], {})).toEqual({ name: "demo", targets: DEFAULT_TARGETS, funder: undefined, fresh: false });
    expect(parseCommand(["floor"], {})).toEqual({ name: "floor", targets: DEFAULT_TARGETS });
  });

  it("shows help without a command, with help or -h", () => {
    for (const argv of [[], ["help"], ["-h"], ["demo", "--help"]]) expect(parseCommand(argv, {})).toEqual({ name: "help" });
  });

  it("lets flags win over env, env over defaults", () => {
    const env = { FLOOR_CONTRACT: "env-floor.testnet", SESSION_URL: "http://env:1", RELAYER_URL: "http://relay:2/" };
    const cmd = parseCommand(["floor", "--floor", "f.testnet", "--session=https://s.example/"], env);
    expect(cmd).toMatchObject({
      targets: { floor: "f.testnet", session: "https://s.example", relayer: "http://relay:2" },
    });
  });

  it("tolerates the `--` pnpm forwards", () => {
    expect(parseCommand(["demo", "--", "--new"], {})).toMatchObject({ name: "demo", fresh: true });
    expect(parseCommand(["--", "floor"], {})).toMatchObject({ name: "floor" });
  });

  it("reads a session id or a player for verify-session, exactly one", () => {
    expect(parseCommand(["verify-session", "6746c5e4_x-1"], {})).toMatchObject({ which: { sessionId: "6746c5e4_x-1" } });
    expect(parseCommand(["verify-session", "--player", "g-mia.tilthouse.testnet"], {})).toMatchObject({
      which: { player: "g-mia.tilthouse.testnet" },
    });
    expect(() => parseCommand(["verify-session"], {})).toThrow(/session id or --player/);
    expect(() => parseCommand(["verify-session", "s-1", "--player", "a.testnet"], {})).toThrow(/one of them/);
    expect(() => parseCommand(["verify-session", "bad id!"], {})).toThrow(/not a session id/);
    expect(() => parseCommand(["verify-session", "x".repeat(65)], {})).toThrow(/not a session id/);
  });

  it("accepts implicit accounts, refuses mainnet and malformed ids", () => {
    const implicit = "ab".repeat(32);
    expect(parseCommand(["verify-session", "--player", implicit], {})).toMatchObject({ which: { player: implicit } });
    expect(() => parseCommand(["floor", "--floor", "floor.near"], {})).toThrow(/testnet/);
    expect(() => parseCommand(["floor", "--token", "Bad..id"], {})).toThrow(/not a NEAR account id/);
  });

  it("refuses non-http urls, unknown commands, stray arguments and misplaced flags", () => {
    expect(() => parseCommand(["floor", "--rpc", "ftp://x"], {})).toThrow(/http/);
    expect(() => parseCommand(["floor"], { SESSION_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => parseCommand(["play"], {})).toThrow(/unknown command/);
    expect(() => parseCommand(["floor", "extra"], {})).toThrow(/unexpected argument/);
    expect(() => parseCommand(["floor", "--new"], {})).toThrow(/--new only applies to demo/);
    expect(() => parseCommand(["demo", "--player", "a.testnet"], {})).toThrow(/--player only applies/);
    expect(() => parseCommand(["demo", "--bogus"], {})).toThrow();
  });

  it("needs both funder variables, an ed25519 key and a testnet funder", () => {
    const key = "ed25519:test-only-not-a-real-key";
    expect(parseCommand(["demo"], { FUNDER_ACCOUNT: "me.testnet", FUNDER_KEY: key })).toMatchObject({
      funder: { accountId: "me.testnet", key },
    });
    expect(() => parseCommand(["demo"], { FUNDER_ACCOUNT: "me.testnet" })).toThrow(/both/);
    expect(() => parseCommand(["demo"], { FUNDER_ACCOUNT: "me.testnet", FUNDER_KEY: "secp256k1:x" })).toThrow(/ed25519/);
    expect(() => parseCommand(["demo"], { FUNDER_ACCOUNT: "me.near", FUNDER_KEY: key })).toThrow(/testnet/);
  });
});
