import { describe, it, expect } from "vitest";
import { redactHeartbeatUrl } from "../src/commands/heartbeat";

describe("heartbeat output", () => {
  it("never prints the heartbeat token", () => {
    expect(redactHeartbeatUrl("https://app.uptimewarden.online/api/heartbeat/01M4X4C0G3K7K2XCM320Z3P8BJ/ping"))
      .toBe("https://app.uptimewarden.online/api/heartbeat/***/ping");
    expect(redactHeartbeatUrl("https://x.test/api/heartbeat/TOKEN/fail?state=failure"))
      .toBe("https://x.test/api/heartbeat/***/fail?state=failure");
  });
});
