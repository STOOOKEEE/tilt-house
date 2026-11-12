import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig, type AlertThresholds, type SalaryMode } from "./config.ts";
import { errorMessage, houseViews, sendFor, sleep, type House, type Send } from "./near.ts";

/** core/src/gambler_rules.rs: `GAMBLER_SALARY_PER_HOUR`, `GAMBLER_MAX_BALANCE` and `LINEUP`. */
export const SALARY_PER_HOUR = 5_000_000n;
export const MAX_BALANCE = 200_000_000n;
export const GAMBLERS = [
  "mia", "noah", "zoe", "liam", "ines", "omar", "kai", "lea", "hugo", "nina", "theo", "ava",
  "yuki", "sam", "iris", "max", "rosa", "ezra", "vera", "paul", "june", "ravi", "lola", "tom",
] as const;
const HOUR_MS = 3_600_000;
/** Low-balance checks run this often: frequent enough to warn a day ahead, rare enough not to spam. */
const ALERT_INTERVAL_MS = 15 * 60_000;
const ALERT_TIMEOUT_MS = 10_000;
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
  salaryMode: SalaryMode;
  log: (line: string) => void;
}

/** An account whose NEAR balance must stay above `min`. */
export interface Watch {
  role: keyof AlertThresholds;
  account: string;
  min: bigint;
}

/** Raises one low-balance alert (error log, plus the webhook when configured). */
export type Alert = (fields: Record<string, unknown>) => Promise<void>;

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
 * One keeper pass: settle the floor's rent, then let each seated autopilot table reprice and each
 * NPC dealer decide its rent bid. Tables off the floor draw no gamblers, so repricing them only
 * burns the keeper's gas (one tx per table per pass); they reprice once seated again. One
 * failing call never stops the others.
 */
export async function keeperPass(deps: KeeperDeps): Promise<void> {
  const call = (method: string, args: Record<string, unknown>) => () => deps.send({ signer: deps.keeper, method, args });
  await attempt(deps, { action: "collect_rent" }, call("collect_rent", {}));
  for (const dealer of await deps.house.lobby()) {
    const args = { dealer_id: dealer.id };
    if (dealer.autopilot && dealer.seated) await attempt(deps, { action: "reprice", dealer: dealer.id }, call("reprice", args));
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
 * The NPC gamblers: in `credit_npc` mode the floor's registered list (the only ones it credits),
 * otherwise the lineup on this account suffix.
 */
export async function npcAccounts(deps: Pick<KeeperDeps, "house" | "salaryMode" | "accountSuffix">): Promise<string[]> {
  if (deps.salaryMode === "credit_npc") return deps.house.npcs();
  return GAMBLERS.map((name) => `g-${name}.${deps.accountSuffix}`);
}

/**
 * Pays each NPC gambler its hourly salary (docs/tycoon.md), the economy's only outside money.
 *
 * `credit_npc` (contract v3): the keeper deposits the salary straight into the NPC's in-contract
 * balance; the floor accepts it only from its keeper, for a registered NPC, up to the cap.
 *
 * `deposit` (contract v2): the house only credits the sender of a deposit, so the keeper sends
 * tUSDC to the gambler's wallet and the gambler deposits it with its own key. A deposit that
 * failed before (the gambler's key was refused) left tUSDC in the wallet: it is deposited first,
 * so a broken gambler never piles up a salary per hour.
 */
export async function salaryPass(deps: KeeperDeps): Promise<void> {
  for (const gambler of await npcAccounts(deps)) {
    await attempt(deps, { action: "salary", gambler }, async () => {
      const amount = salaryFor(await deps.house.balance(gambler));
      if (amount === 0n) return { skipped: "at the cap" };
      const token = { receiver: deps.token };
      if (deps.salaryMode === "credit_npc") {
        const msg = JSON.stringify({ credit_npc: gambler });
        await deps.send({ ...token, signer: deps.keeper, method: "ft_transfer_call", args: { receiver_id: deps.houseId, amount: amount.toString(), msg }, deposit: ONE_YOCTO });
        return { credited: amount.toString() };
      }
      const inWallet = await deps.house.wallet(gambler);
      if (inWallet < amount) {
        await deps.send({ ...token, signer: deps.keeper, method: "storage_deposit", args: { account_id: gambler, registration_only: true }, deposit: STORAGE_DEPOSIT });
        await deps.send({ ...token, signer: deps.keeper, method: "ft_transfer", args: { receiver_id: gambler, amount: (amount - inWallet).toString() }, deposit: ONE_YOCTO });
      }
      await deps.send({ ...token, signer: gambler, method: "ft_transfer_call", args: { receiver_id: deps.houseId, amount: amount.toString(), msg: "" }, deposit: ONE_YOCTO });
      return { paid: amount.toString() };
    });
  }
}

/** Who must keep NEAR: the keeper, the session server's signer, the relayer and every NPC. */
export async function watchList(deps: KeeperDeps, thresholds: AlertThresholds, sessions: string, relayer: string): Promise<Watch[]> {
  const npcs = await npcAccounts(deps);
  return [
    { role: "keeper", account: deps.keeper, min: thresholds.keeper },
    { role: "sessions", account: sessions, min: thresholds.sessions },
    { role: "relayer", account: relayer, min: thresholds.relayer },
    ...npcs.map((account): Watch => ({ role: "npc", account, min: thresholds.npc })),
  ];
}

/** Alerts for every watched account below its threshold (or missing); one failing read never hides the others. */
export async function balancePass(deps: KeeperDeps, watches: readonly Watch[], alert: Alert): Promise<void> {
  for (const { role, account, min } of watches) {
    try {
      const balance = await deps.house.nearBalance(account);
      if (balance !== null && balance >= min) continue;
      await alert({ alert: "low_near", role, account, balance: balance?.toString() ?? "missing", min: min.toString() });
    } catch (error) {
      await alert({ alert: "balance_unreadable", role, account, error: errorMessage(error) });
    }
  }
}

/** Logs the alert as an error line and, if configured, POSTs it to the webhook; a webhook failure is only logged. */
export function alertFor(webhookUrl: string | null, logError: (line: string) => void): Alert {
  return async (fields) => {
    const line = JSON.stringify({ at: new Date().toISOString(), level: "error", ...fields });
    logError(line);
    if (!webhookUrl) return;
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `text` for Slack, `content` for Discord.
        body: JSON.stringify({ text: `Tilt House keeper: ${line}`, content: `Tilt House keeper: ${line}` }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      if (!response.ok) logError(JSON.stringify({ level: "error", webhook: response.status }));
    } catch (error) {
      logError(JSON.stringify({ level: "error", webhook: errorMessage(error) }));
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const deps: KeeperDeps = {
    house: houseViews(provider, config.house, config.token),
    send: sendFor(config.dryRun, provider, config.house, config.keysDir),
    houseId: config.house,
    token: config.token,
    keeper: config.keeper,
    accountSuffix: config.accountSuffix,
    salaryMode: config.salaryMode,
    log: console.log,
  };
  const alert = alertFor(config.alertWebhookUrl, console.error);
  const balances = async () =>
    balancePass(deps, await watchList(deps, config.alertThresholds, config.sessionsAccount, config.relayerAccount), alert);
  logLine(deps, { start: config.network, house: config.house, salary: config.salaryMode, dry_run: config.dryRun });
  if (config.dryRun) {
    await keeperPass(deps);
    await salaryPass(deps);
    return balances();
  }
  let lastSalary = 0;
  let lastAlertCheck = 0;
  for (;;) {
    try {
      await keeperPass(deps);
      if (Date.now() - lastSalary >= HOUR_MS) {
        lastSalary = Date.now();
        await salaryPass(deps);
      }
      if (Date.now() - lastAlertCheck >= ALERT_INTERVAL_MS) {
        lastAlertCheck = Date.now();
        await balances();
      }
    } catch (error) {
      logLine(deps, { error: errorMessage(error) });
    }
    await sleep(config.keeperIntervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
