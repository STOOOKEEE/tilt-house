import { parseCommand, USAGE, type Command } from "./args.ts";
import { runDemo } from "./demo.ts";
import { runPoker } from "./poker.ts";
import { printFloor, readFloor } from "./floor.ts";
import { BAD, errorMessage } from "./ui.ts";
import { latestClosedSession, verifySessionById } from "./verify-session.ts";

async function run(command: Command): Promise<boolean> {
  switch (command.name) {
    case "help":
      console.log(USAGE);
      return true;
    case "demo":
      return runDemo(command);
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
