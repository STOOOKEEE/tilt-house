import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { nearChain } from "./chain.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig(process.env);
const app = createApp({ config, chain: nearChain(config) });

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`relayer ${config.relayerAccount} for ${config.house} on ${config.host}:${info.port}`);
});
