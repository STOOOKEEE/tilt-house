import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const TESTNET = { HOUSE_CONTRACT: "floor.tilthouse.testnet" };
const MAINNET = { NETWORK: "mainnet", HOUSE_CONTRACT: "floor.tilthouse.near", ACCOUNT_SUFFIX: "tilthouse.near" };

describe("loadConfig", () => {
  it("testnet defaults: v2 deposit salaries, accounts under tilthouse.testnet", () => {
    expect(loadConfig(TESTNET, [])).toMatchObject({
      network: "testnet",
      salaryMode: "deposit",
      keeper: "tilthouse.testnet",
      token: "tusdc.tilthouse.testnet",
      sessionsAccount: "sessions.tilthouse.testnet",
      relayerAccount: "relayer.tilthouse.testnet",
      rpcUrls: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
      alertWebhookUrl: null,
      dryRun: false,
    });
  });

  it("testnet can switch to credit_npc once the v3 floor is live", () => {
    expect(loadConfig({ ...TESTNET, SALARY_MODE: "credit_npc" }, []).salaryMode).toBe("credit_npc");
  });

  it("mainnet: credit_npc salaries, mainnet RPC and keys, accounts derived from the root", () => {
    const config = loadConfig(MAINNET, ["--dry-run"]);
    expect(config).toMatchObject({
      network: "mainnet",
      salaryMode: "credit_npc",
      keeper: "tilthouse.near",
      token: "tusdc.tilthouse.near",
      rpcUrls: ["https://rpc.mainnet.fastnear.com"],
      dryRun: true,
    });
    expect(config.keysDir).toMatch(/\.near-credentials\/mainnet$/);
  });

  it("mainnet refuses the deposit mode (NPC keys cannot touch the token)", () => {
    expect(() => loadConfig({ ...MAINNET, SALARY_MODE: "deposit" }, [])).toThrow(/credit_npc/);
  });

  it("mainnet has no default root and refuses testnet accounts", () => {
    expect(() => loadConfig({ ...MAINNET, ACCOUNT_SUFFIX: undefined }, [])).toThrow(/ACCOUNT_SUFFIX/);
    expect(() => loadConfig({ ...MAINNET, KEEPER_ACCOUNT: "tilthouse.testnet" }, [])).toThrow(/KEEPER_ACCOUNT must be a .near/);
  });

  it("reads alert thresholds in NEAR and an https webhook", () => {
    const config = loadConfig({ ...TESTNET, ALERT_NPC_NEAR: "0.5", ALERT_WEBHOOK_URL: "https://hooks.example/x" }, []);
    expect(config.alertThresholds.npc).toBe(500_000_000_000_000_000_000_000n);
    expect(config.alertThresholds.keeper).toBe(2_000_000_000_000_000_000_000_000n);
    expect(config.alertWebhookUrl).toBe("https://hooks.example/x");
    expect(() => loadConfig({ ...TESTNET, ALERT_WEBHOOK_URL: "http://hooks.example/x" }, [])).toThrow(/https/);
    expect(() => loadConfig({ ...TESTNET, ALERT_KEEPER_NEAR: "lots" }, [])).toThrow(/ALERT_KEEPER_NEAR/);
  });

  it("TILT floor: salaries off; USD floor: close_day on", () => {
    expect(loadConfig({ ...TESTNET, SALARY_MODE: "off" }, []).salaryMode).toBe("off");
    expect(loadConfig({ ...MAINNET, SALARY_MODE: "off" }, []).salaryMode).toBe("off");
    expect(loadConfig(TESTNET, []).closeDay).toBe(false);
    expect(loadConfig({ ...TESTNET, CLOSE_DAY: "1" }, []).closeDay).toBe(true);
    expect(() => loadConfig({ ...TESTNET, CLOSE_DAY: "daily" }, [])).toThrow(/CLOSE_DAY/);
  });

  it("refuses an unknown network or salary mode", () => {
    expect(() => loadConfig({ ...TESTNET, NETWORK: "betanet" }, [])).toThrow(/NETWORK/);
    expect(() => loadConfig({ ...TESTNET, SALARY_MODE: "airdrop" }, [])).toThrow(/SALARY_MODE/);
  });
});
