import { describe, expect, it } from "vitest";
import { deriveLinkSecret, makeExportToken, makeReportToken, verifyExportToken, verifyReportToken } from "../src/export";

const SECRET = "test-link-secret";
const NOW = 1_800_000_000;
const FUTURE = NOW + 900;

function swapMac(token: string, mac: string): string {
  const parts = token.split(".");
  parts[parts.length - 1] = mac;
  return parts.join(".");
}

describe("export tokens", () => {
  it("round-trips", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    expect(await verifyExportToken(SECRET, t, NOW)).toBe(42);
  });

  it("rejects expired tokens", async () => {
    const t = await makeExportToken(SECRET, 42, NOW - 1);
    expect(await verifyExportToken(SECRET, t, NOW)).toBeNull();
  });

  it("rejects the wrong key", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    expect(await verifyExportToken("other-secret", t, NOW)).toBeNull();
  });

  it("rejects a tampered id", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    const [, exp, mac] = t.split(".");
    expect(await verifyExportToken(SECRET, `43.${exp}.${mac}`, NOW)).toBeNull();
  });

  it("rejects a MAC of the wrong length", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    const mac = t.split(".")[2]!;
    expect(await verifyExportToken(SECRET, swapMac(t, mac.slice(0, 62)), NOW)).toBeNull();
    expect(await verifyExportToken(SECRET, swapMac(t, mac + "00"), NOW)).toBeNull();
    expect(await verifyExportToken(SECRET, swapMac(t, mac.slice(0, 63)), NOW)).toBeNull();
  });

  it("rejects a MAC with non-hex characters", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    expect(await verifyExportToken(SECRET, swapMac(t, "z".repeat(64)), NOW)).toBeNull();
  });
});

describe("report tokens", () => {
  it("round-trips", async () => {
    const t = await makeReportToken(SECRET, 7, "month", FUTURE);
    expect(await verifyReportToken(SECRET, t, NOW)).toEqual({ standupId: 7, range: "month" });
  });

  it("rejects expired tokens", async () => {
    const t = await makeReportToken(SECRET, 7, "week", NOW - 1);
    expect(await verifyReportToken(SECRET, t, NOW)).toBeNull();
  });

  it("rejects the wrong key", async () => {
    const t = await makeReportToken(SECRET, 7, "week", FUTURE);
    expect(await verifyReportToken("other-secret", t, NOW)).toBeNull();
  });

  it("rejects a tampered id", async () => {
    const t = await makeReportToken(SECRET, 7, "week", FUTURE);
    const [tag, , range, exp, mac] = t.split(".");
    expect(await verifyReportToken(SECRET, [tag, "8", range, exp, mac].join("."), NOW)).toBeNull();
  });

  it("rejects a MAC of the wrong length", async () => {
    const t = await makeReportToken(SECRET, 7, "week", FUTURE);
    const mac = t.split(".")[4]!;
    expect(await verifyReportToken(SECRET, swapMac(t, mac.slice(0, 62)), NOW)).toBeNull();
    expect(await verifyReportToken(SECRET, swapMac(t, mac + "00"), NOW)).toBeNull();
  });

  it("rejects a MAC with non-hex characters", async () => {
    const t = await makeReportToken(SECRET, 7, "week", FUTURE);
    expect(await verifyReportToken(SECRET, swapMac(t, "g".repeat(64)), NOW)).toBeNull();
  });

  it("rejects an export token presented as a report token", async () => {
    const t = await makeExportToken(SECRET, 42, FUTURE);
    expect(await verifyReportToken(SECRET, t, NOW)).toBeNull();
  });

  it("rejects a report token presented as an export token", async () => {
    const t = await makeReportToken(SECRET, 7, "week", FUTURE);
    expect(await verifyExportToken(SECRET, t, NOW)).toBeNull();
  });
});

describe("deriveLinkSecret", () => {
  it("is deterministic 64-char hex", async () => {
    const a = await deriveLinkSecret("signing-secret");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveLinkSecret("signing-secret")).toBe(a);
  });

  it("differs for different inputs and from the input itself", async () => {
    const a = await deriveLinkSecret("one");
    expect(await deriveLinkSecret("two")).not.toBe(a);
    expect(a).not.toBe("one");
  });
});
