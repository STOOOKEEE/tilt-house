import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const TESTNET = {
  HOUSE_CONTRACT: "floor.tilthouse.testnet",
  TOKEN_CONTRACT: "tusdc.tilthouse.testnet",
  RELAYER_ACCOUNT: "relayer.tilthouse.testnet",
  RELAYER_PRIVATE_KEY: "ed25519:x",
};
const MAINNET = {
  NETWORK: "mainnet",
  HOUSE_CONTRACT: "floor.tilthouse.near",
  TOKEN_CONTRACT: "tusdc.tilthouse.near",
  RELAYER_ACCOUNT: "relayer.tilthouse.near",
  RELAYER_PRIVATE_KEY: "ed25519:x",
  DAILY_BUDGET_NEAR: "2",
};

describe("loadConfig", () => {
  it("defaults to testnet, unpaused, 0.02 NEAR activations and a 5 NEAR daily budget", () => {
    const config = loadConfig(TESTNET);
    expect(config).toMatchObject({ network: "testnet", paused: false, rpcUrls: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] });
    expect(config.activationYocto).toBe(20_000_000_000_000_000_000_000n);
    expect(config.dailyBudgetYocto).toBe(5_000_000_000_000_000_000_000_000n);
    expect(config.dataDir).toMatch(/relayer-testnet$/);
  });

  it("mainnet: mainnet RPC, 0.01 NEAR activations, its own data dir", () => {
    const config = loadConfig(MAINNET);
    expect(config).toMatchObject({ network: "mainnet", rpcUrls: ["https://rpc.mainnet.fastnear.com"] });
    expect(config.activationYocto).toBe(10_000_000_000_000_000_000_000n);
    expect(config.dailyBudgetYocto).toBe(2_000_000_000_000_000_000_000_000n);
    expect(config.dataDir).toMatch(/relayer-mainnet$/);
  });

  it("anonymous activations: on by default on testnet, can be turned off, refused on mainnet", () => {
    expect(loadConfig(TESTNET).anonymousActivation).toBe(true);
    expect(loadConfig({ ...TESTNET, ANONYMOUS_ACTIVATION: "0" }).anonymousActivation).toBe(false);
    expect(loadConfig(MAINNET).anonymousActivation).toBe(false);
    expect(loadConfig({ ...MAINNET, ANONYMOUS_ACTIVATION: "0" }).anonymousActivation).toBe(false);
    expect(() => loadConfig({ ...MAINNET, ANONYMOUS_ACTIVATION: "1" })).toThrow(/testnet only/);
  });

  it("mainnet has no default daily budget", () => {
    expect(() => loadConfig({ ...MAINNET, DAILY_BUDGET_NEAR: undefined })).toThrow(/DAILY_BUDGET_NEAR/);
  });

  it("refuses accounts of the other network", () => {
    expect(() => loadConfig({ ...MAINNET, HOUSE_CONTRACT: "floor.tilthouse.testnet" })).toThrow(/HOUSE_CONTRACT must be a .near/);
    expect(() => loadConfig({ ...TESTNET, RELAYER_ACCOUNT: "relayer.tilthouse.near" })).toThrow(/RELAYER_ACCOUNT/);
  });

  it("refuses an unknown network", () => {
    expect(() => loadConfig({ ...TESTNET, NETWORK: "betanet" })).toThrow(/NETWORK/);
  });

  it.each([["1", true], ["true", true], ["YES", true], ["0", false], ["", false], ["false", false]])("RELAYER_PAUSED=%j is %s", (value, paused) => {
    expect(loadConfig({ ...TESTNET, RELAYER_PAUSED: value }).paused).toBe(paused);
  });

  it("mint faucet and no TILT token by default", () => {
    expect(loadConfig(TESTNET)).toMatchObject({ faucetMode: "mint", tilt: null });
    expect(loadConfig({ ...TESTNET, TILT_CONTRACT: "tilt.tilthouse.testnet" }).tilt).toBe("tilt.tilthouse.testnet");
  });

  it("the TILT floor's relayer: welcome faucet on the TILT token", () => {
    const tilt = { ...TESTNET, HOUSE_CONTRACT: "floor-tilt.tilthouse.testnet", TOKEN_CONTRACT: "tilt.tilthouse.testnet", TILT_CONTRACT: "tilt.tilthouse.testnet", FAUCET_MODE: "welcome" };
    expect(loadConfig(tilt)).toMatchObject({ faucetMode: "welcome", token: "tilt.tilthouse.testnet", tilt: "tilt.tilthouse.testnet" });
    expect(() => loadConfig({ ...tilt, TILT_CONTRACT: undefined })).toThrow(/TILT_CONTRACT = TOKEN_CONTRACT/);
    expect(() => loadConfig({ ...tilt, TOKEN_CONTRACT: "tusdc.tilthouse.testnet" })).toThrow(/TILT_CONTRACT = TOKEN_CONTRACT/);
    expect(() => loadConfig({ ...tilt, FAUCET_MODE: "airdrop" })).toThrow(/FAUCET_MODE/);
    expect(() => loadConfig({ ...tilt, TILT_CONTRACT: "tilt.tilthouse.near" })).toThrow(/TILT_CONTRACT must be a .testnet/);
  });

  it("refuses to guess an unknown RELAYER_PAUSED spelling", () => {
    expect(() => loadConfig({ ...TESTNET, RELAYER_PAUSED: "maybe" })).toThrow(/RELAYER_PAUSED/);
  });

  it("refuses an invalid amount", () => {
    expect(() => loadConfig({ ...TESTNET, ACTIVATION_NEAR: "-1" })).toThrow(/ACTIVATION_NEAR/);
    expect(() => loadConfig({ ...TESTNET, DAILY_BUDGET_NEAR: "lots" })).toThrow(/DAILY_BUDGET_NEAR/);
  });
});
