import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAnonymously, RELAYER_BUSY } from "../src/demo.ts";

const ACCOUNT = "a".repeat(64);

function relayerAnswers(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activateAnonymously", () => {
  it("says the relayer is busy on a rate limit", async () => {
    relayerAnswers(429, { error: "rate_limited" });
    await expect(activateAnonymously("https://relayer.test", ACCOUNT)).rejects.toThrow(RELAYER_BUSY);
  });

  it("keeps other refusals as they are", async () => {
    relayerAnswers(403, { error: "anonymous_disabled" });
    await expect(activateAnonymously("https://relayer.test", ACCOUNT)).rejects.toThrow("relayer refused (403): anonymous_disabled");
  });

  it("accepts an account activated before", async () => {
    relayerAnswers(409, { error: "already_activated" });
    await expect(activateAnonymously("https://relayer.test", ACCOUNT)).resolves.toBeUndefined();
  });
});
