// One-off setup of the house test owners (README, Disclosure): two labeled accounts run by the
// team, each owning one table on floor.tilthouse.testnet. Re-runnable: done steps are skipped.
//
//   systemctl --user stop th-keeper th-keeper-tilt   # the root signs here: no nonce clash
//   node src/owner-setup.ts
//   systemctl --user start th-keeper th-keeper-tilt
//
// The root (tilthouse.testnet) creates `test-owner-<n>.tilthouse.testnet` with a fresh
// full-access key (~/.near-credentials/testnet, mode 600), 0.5 NEAR and 500 tUSDC from its own
// wallet. Each owner then deposits into the floor, opens its table (200 tUSDC seed), invests 250
// and keeps 50 in its balance for the bot's top-ups (owner-bot.ts), then bids for a seat.
// Nothing here opens a session or touches $TILT.
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, nearToYocto } from "near-api-js";
import { CALL_GAS, houseViews, loadKeyPair } from "./near.ts";
import { FailoverProvider } from "./rpc.ts";

const ROOT = "tilthouse.testnet";
const HOUSE = "floor.tilthouse.testnet";
const TOKEN = "tusdc.tilthouse.testnet";
const KEYS_DIR = join(homedir(), ".near-credentials", "testnet");
const TUSDC = 1_000_000n;
const FUNDING_NEAR = nearToYocto("0.5");
const TOKEN_STORAGE = nearToYocto("0.00125");
const FUNDING_TUSDC = 500n * TUSDC;
const SEED = 200n * TUSDC;
const INVEST = 250n * TUSDC;

const TABLES = [
  { owner: "test-owner-1.tilthouse.testnet", id: "test-1", name: "Team test 1", game: "dice", temperament: "promoter", look: "beanie" },
  { owner: "test-owner-2.tilthouse.testnet", id: "test-2", name: "Team test 2", game: "roulette", temperament: "cautious", look: "top-hat" },
] as const;

const provider = new FailoverProvider(["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]);
const house = houseViews(provider, HOUSE, TOKEN);
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));

async function call(signer: Account, receiver: string, method: string, args: Record<string, unknown>, deposit = 0n): Promise<void> {
  const outcome = await signer.callFunctionRaw({ contractId: receiver, methodName: method, args, gas: CALL_GAS, deposit });
  log({ signer: signer.accountId, receiver, method, args, tx: outcome.transaction.hash });
}

async function createOwner(root: Account, owner: string): Promise<void> {
  if ((await house.nearBalance(owner)) !== null) return log({ skip: "account exists", owner });
  const key = KeyPair.fromRandom("ed25519");
  const file = { account_id: owner, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await writeFile(join(KEYS_DIR, `${owner}.json`), JSON.stringify(file), { mode: 0o600, flag: "wx" });
  const outcome = await root.createAccount({ newAccountId: owner, publicKey: key.getPublicKey(), nearToTransfer: FUNDING_NEAR });
  log({ created: owner, tx: outcome.transaction.hash });
  await call(root, TOKEN, "storage_deposit", { account_id: owner, registration_only: true }, TOKEN_STORAGE);
  await call(root, TOKEN, "ft_transfer", { receiver_id: owner, amount: String(FUNDING_TUSDC) }, 1n);
}

async function openTable(table: (typeof TABLES)[number]): Promise<void> {
  const owner = new Account(table.owner, provider, new KeyPairSigner(await loadKeyPair(KEYS_DIR, table.owner)));
  if ((await house.lobby()).some((d) => d.id === table.id)) return log({ skip: "table exists", table: table.id });
  const wallet = await house.wallet(table.owner);
  if (wallet > 0n) await call(owner, TOKEN, "ft_transfer_call", { receiver_id: HOUSE, amount: String(wallet), msg: "" }, 1n);
  const { id, name, game, temperament, look } = table;
  await call(owner, HOUSE, "open_table", { id, name, game, temperament, look, seed_amount: String(SEED) });
  await call(owner, HOUSE, "invest", { dealer_id: id, amount: String(INVEST) });
  const floor: unknown = await provider.callFunction({ contractId: HOUSE, method: "get_floor", args: {} });
  const outbidMin = typeof floor === "object" && floor !== null && "outbid_min" in floor ? floor.outbid_min : null;
  if (typeof outbidMin !== "string") throw new Error("get_floor: no outbid_min");
  await call(owner, HOUSE, "bid_for_seat", { dealer_id: id, rent_per_hour: outbidMin });
}

const root = new Account(ROOT, provider, new KeyPairSigner(await loadKeyPair(KEYS_DIR, ROOT)));
for (const table of TABLES) await createOwner(root, table.owner);
for (const table of TABLES) await openTable(table);
