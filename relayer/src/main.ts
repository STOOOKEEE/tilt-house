import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { nearChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { fetchJwks, privyJwksUrl, privyVerifier } from "./privy.ts";
import { StateStore } from "./state.ts";

const config = loadConfig(process.env);
const jwksUrl = privyJwksUrl(config.privyAppId);
const app = createApp({
  config,
  chain: nearChain(config),
  verifyToken: privyVerifier(config.privyAppId, () => fetchJwks(jwksUrl)),
  store: new StateStore(join(config.dataDir, "state.json")),
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const status = config.paused ? "PAUSED" : "live";
  console.log(
    `relayer ${config.relayerAccount} for ${config.house} on ${config.network}, ${config.host}:${info.port}, faucet ${config.faucetMode} (${status})`,
  );
});
