import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig } from "./config.ts";
import { errorMessage, houseViews, sendFor, sleep, type DealerView, type House, type Send } from "./near.ts";

export interface KeeperDeps {
  house: House;
  send: Send;
  accountSuffix: string;
  log: (line: string) => void;
}

function offerOf(dealer: DealerView | undefined) {
  if (!dealer) return null;
  const { rake_bp, total_edge_bp, max_bet, boost_until, reason, reason_text, open } = dealer;
  return { rake_bp, total_edge_bp, max_bet, boost_until, reason, reason_text, open };
}

async function repriceOne(deps: KeeperDeps, dealerId: string): Promise<void> {
  const signer = `${dealerId}.${deps.accountSuffix}`;
  try {
    await deps.send({ signer, method: "reprice", args: { dealer_id: dealerId } });
    const after = (await deps.house.lobby()).find((d) => d.id === dealerId);
    deps.log(JSON.stringify({ at: new Date().toISOString(), dealer: dealerId, offer: offerOf(after) }));
  } catch (error) {
    deps.log(JSON.stringify({ at: new Date().toISOString(), dealer: dealerId, error: errorMessage(error) }));
  }
}

/** One keeper pass: each dealer reprices its own table; one dealer failing never stops the others. */
export async function keeperPass(deps: KeeperDeps): Promise<void> {
  const dealers = await deps.house.lobby();
  for (const dealer of dealers) await repriceOne(deps, dealer.id);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const deps: KeeperDeps = {
    house: houseViews(provider, config.house),
    send: sendFor(config.dryRun, provider, config.house, config.dealerKeysDir),
    accountSuffix: config.accountSuffix,
    log: console.log,
  };
  if (config.dryRun) return keeperPass(deps);
  for (;;) {
    try {
      await keeperPass(deps);
    } catch (error) {
      deps.log(JSON.stringify({ at: new Date().toISOString(), error: errorMessage(error) }));
    }
    await sleep(config.keeperIntervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
