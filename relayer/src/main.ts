import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { nearChain } from "./chain.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig(process.env);
const app = createApp({ config, chain: nearChain(config) });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`relayer ${config.relayerAccount} for ${config.house} on :${info.port}`);
});
