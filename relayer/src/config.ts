import { nearToYocto } from "near-api-js";

export interface Config {
  house: string;
  token: string;
  relayerAccount: string;
  relayerPrivateKey: string;
  rpcUrl: string;
  /** Interface to listen on: loopback unless a deployment says otherwise. */
  host: string;
  port: number;
  activationYocto: bigint;
}

const TESTNET_RPC = "https://test.rpc.fastnear.com";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ACTIVATION_NEAR = "0.02";
export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_AMOUNT = /^\d+(\.\d{1,24})?$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function accountId(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!ACCOUNT_ID.test(value)) throw new Error(`env ${name} is not a NEAR account id`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("env PORT is invalid");
  const activation = env.ACTIVATION_NEAR ?? DEFAULT_ACTIVATION_NEAR;
  if (!NEAR_AMOUNT.test(activation)) throw new Error("env ACTIVATION_NEAR is not a NEAR amount");
  return {
    house: accountId(env, "HOUSE_CONTRACT"),
    token: accountId(env, "TOKEN_CONTRACT"),
    relayerAccount: accountId(env, "RELAYER_ACCOUNT"),
    relayerPrivateKey: required(env, "RELAYER_PRIVATE_KEY"),
    rpcUrl: env.NEAR_RPC_URL ?? TESTNET_RPC,
    host: env.HOST ?? DEFAULT_HOST,
    port,
    activationYocto: nearToYocto(activation as `${number}`),
  };
}
