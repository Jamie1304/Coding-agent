import { FakeCodexProvider } from "@agent/codex-provider";

describe("FakeCodexProvider", () => {
  it("supports availability, auth, threads, streamed structured events, and completion", async () => {
    const provider = new FakeCodexProvider();
    expect((await provider.checkAvailability()).available).toBe(true);
    expect((await provider.authenticate()).authenticated).toBe(true);
    const thread = await provider.createThread({ cwd: process.cwd() });
    const events = [];
    for await (const event of provider.sendTurn({
      threadId: thread.id,
      prompt: "Implement approved change",
      cwd: process.cwd(),
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn-started",
        "message",
        "file-change",
        "command",
        "turn-completed"
      ])
    );
  });
});
