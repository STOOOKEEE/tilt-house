import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig } from "./config.ts";
import { errorMessage, houseViews, sendFor, sleep, type House, type Send } from "./near.ts";

/** core/src/gambler_rules.rs: `GAMBLER_SALARY_PER_HOUR`, `GAMBLER_MAX_BALANCE` and `LINEUP`. */
export const SALARY_PER_HOUR = 5_000_000n;
export const MAX_BALANCE = 200_000_000n;
export const GAMBLERS = [
  "mia", "noah", "zoe", "liam", "ines", "omar", "kai", "lea", "hugo", "nina", "theo", "ava",
  "yuki", "sam", "iris", "max", "rosa", "ezra", "vera", "paul", "june", "ravi", "lola", "tom",
] as const;
const HOUR_MS = 3_600_000;
const ONE_YOCTO = 1n;
// NEP-145 registration on tUSDC; the token refunds what it doesn't need.
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

export interface KeeperDeps {
  house: House;
  send: Send;
  houseId: string;
  token: string;
  keeper: string;
  accountSuffix: string;
  log: (line: string) => void;
}

function logLine(deps: KeeperDeps, fields: Record<string, unknown>): void {
  deps.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

async function attempt(deps: KeeperDeps, fields: Record<string, unknown>, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    logLine(deps, { ...fields, result: result ?? null });
  } catch (error) {
    logLine(deps, { ...fields, error: errorMessage(error) });
  }
}

/**
 * One keeper pass: settle the floor's rent, then let each autopilot table reprice and each NPC
 * dealer decide its rent bid. One failing call never stops the others.
 */
export async function keeperPass(deps: KeeperDeps): Promise<void> {
  const call = (method: string, args: Record<string, unknown>) => () => deps.send({ signer: deps.keeper, method, args });
  await attempt(deps, { action: "collect_rent" }, call("collect_rent", {}));
  for (const dealer of await deps.house.lobby()) {
    const args = { dealer_id: dealer.id };
    if (dealer.autopilot) await attempt(deps, { action: "reprice", dealer: dealer.id }, call("reprice", args));
    if (dealer.npc) await attempt(deps, { action: "rent_bid", dealer: dealer.id }, call("rent_bid", args));
  }
}

/** What one hour of salary adds to a gambler's in-contract balance: never past the cap. */
export function salaryFor(balance: bigint): bigint {
  if (balance >= MAX_BALANCE) return 0n;
  const room = MAX_BALANCE - balance;
  return room < SALARY_PER_HOUR ? room : SALARY_PER_HOUR;
}

/**
 * Pays each NPC gambler its hourly salary (docs/tycoon.md), the economy's only outside money.
 * The house only credits the sender of a deposit, so the keeper sends tUSDC to the gambler's
 * wallet and the gambler deposits it with its own key.
 */
export async function salaryPass(deps: KeeperDeps): Promise<void> {
  for (const name of GAMBLERS) {
    const gambler = `g-${name}.${deps.accountSuffix}`;
    await attempt(deps, { action: "salary", gambler }, async () => {
      const amount = salaryFor(await deps.house.balance(gambler));
      if (amount === 0n) return { skipped: "at the cap" };
      const token = { receiver: deps.token };
      await deps.send({ ...token, signer: deps.keeper, method: "storage_deposit", args: { account_id: gambler, registration_only: true }, deposit: STORAGE_DEPOSIT });
      await deps.send({ ...token, signer: deps.keeper, method: "ft_transfer", args: { receiver_id: gambler, amount: amount.toString() }, deposit: ONE_YOCTO });
      await deps.send({ ...token, signer: gambler, method: "ft_transfer_call", args: { receiver_id: deps.houseId, amount: amount.toString(), msg: "" }, deposit: ONE_YOCTO });
      return { paid: amount.toString() };
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const deps: KeeperDeps = {
    house: houseViews(provider, config.house),
    send: sendFor(config.dryRun, provider, config.house, config.keysDir),
    houseId: config.house,
    token: config.token,
    keeper: config.keeper,
    accountSuffix: config.accountSuffix,
    log: console.log,
  };
  if (config.dryRun) {
    await keeperPass(deps);
    return salaryPass(deps);
  }
  let lastSalary = 0;
  for (;;) {
    try {
      await keeperPass(deps);
      if (Date.now() - lastSalary >= HOUR_MS) {
        lastSalary = Date.now();
        await salaryPass(deps);
      }
    } catch (error) {
      logLine(deps, { error: errorMessage(error) });
    }
    await sleep(config.keeperIntervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
