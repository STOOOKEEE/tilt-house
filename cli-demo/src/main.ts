import { int, record, str } from "../../web/src/near/views";
import { parseCommand, USAGE, type Command, type Targets } from "./args.ts";
import { view } from "./chain.ts";
import { runDemo } from "./demo.ts";
import { runPoker } from "./poker.ts";
import { printFloor, readFloor } from "./floor.ts";
import { BAD, errorMessage, useToken } from "./ui.ts";
import { latestClosedSession, verifySessionById } from "./verify-session.ts";

/** Amounts are formatted with 6 decimals (USDC base units) everywhere. */
const TOKEN_DECIMALS = 6;

/** The chip token's symbol, from `ft_metadata`; refuses a token the amounts would misprint. */
async function readToken(t: Targets): Promise<void> {
  const meta = record(await view(t, t.token, "ft_metadata"), "ft_metadata");
  const decimals = int(meta.decimals, "ft_metadata.decimals");
  if (decimals !== TOKEN_DECIMALS) throw new Error(`${t.token} has ${decimals} decimals; this CLI prints amounts with ${TOKEN_DECIMALS}`);
  useToken(str(meta.symbol, "ft_metadata.symbol"));
}

async function run(command: Command): Promise<boolean> {
  if (command.name === "help") {
    console.log(USAGE);
    return true;
  }
  await readToken(command.targets);
  switch (command.name) {
    case "demo":
      return (await runDemo(command)).ok;
    case "poker":
      return runPoker(command);
    case "floor":
      printFloor(await readFloor(command.targets));
      return true;
    case "verify-session": {
      const t = command.targets;
      const { which } = command;
      const sessionId = "sessionId" in which ? which.sessionId : await latestClosedSession(t, which.player);
      return verifySessionById(t, sessionId);
    }
  }
}

let command: Command;
try {
  command = parseCommand(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`${errorMessage(error)}\n\n${USAGE}`);
  process.exit(2);
}
run(command).then(
  (ok) => {
    process.exitCode = ok ? 0 : 1;
  },
  (error: unknown) => {
    console.error(`\n  ${BAD} stopped: ${errorMessage(error)}`);
    process.exitCode = 1;
  },
);
