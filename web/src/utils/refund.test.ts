import { describe, expect, it } from "vitest";
import {
  checkRefundAmount,
  classifyRefundRejection,
  normalizeRefundAmount,
  toMinorUnits,
} from "./refund";

describe("toMinorUnits", () => {
  it("reads whole and fractional major units exactly", () => {
    expect(toMinorUnits("10")).toBe(1000);
    expect(toMinorUnits("10.5")).toBe(1050);
    expect(toMinorUnits("10.05")).toBe(1005);
    expect(toMinorUnits(" 0.01 ")).toBe(1);
  });

  it("refuses malformed figures rather than coercing them", () => {
    expect(toMinorUnits("")).toBeNull();
    expect(toMinorUnits("10.005")).toBeNull();
    expect(toMinorUnits("-1.00")).toBeNull();
    expect(toMinorUnits("1,000.00")).toBeNull();
    expect(toMinorUnits("ten")).toBeNull();
  });
});

describe("normalizeRefundAmount", () => {
  it("pads a usable figure to two decimals", () => {
    expect(normalizeRefundAmount("10")).toBe("10.00");
    expect(normalizeRefundAmount("10.5")).toBe("10.50");
    expect(normalizeRefundAmount("10.05")).toBe("10.05");
  });

  it("returns null for a malformed figure", () => {
    expect(normalizeRefundAmount("10.005")).toBeNull();
  });
});

describe("checkRefundAmount", () => {
  it("accepts a figure between zero and the original", () => {
    expect(checkRefundAmount("10.00", "250.00")).toEqual({
      error: null,
      amount: "10.00",
    });
  });

  it("accepts the whole original as a partial entry", () => {
    expect(checkRefundAmount("250.00", "250.00")).toEqual({
      error: null,
      amount: "250.00",
    });
  });

  it("rejects an empty figure", () => {
    expect(checkRefundAmount("  ", "250.00").error).toMatch(/Enter the amount/);
  });

  it("rejects more than two decimals", () => {
    expect(checkRefundAmount("10.005", "250.00").error).toMatch(/two decimal places/);
  });

  it("rejects zero", () => {
    expect(checkRefundAmount("0.00", "250.00").error).toMatch(/more than 0/);
  });

  it("rejects a figure above the original", () => {
    expect(checkRefundAmount("250.01", "250.00").error).toMatch(/cannot be more/);
  });

  it("compares in minor units rather than floats", () => {
    // 0.1 + 0.2 > 0.3 in binary floating point; 10 cents + 20 cents is not.
    expect(checkRefundAmount("0.30", "0.30").error).toBeNull();
  });

  it("still accepts a usable partial when the original is not reported", () => {
    // The server checks the ceiling before the gateway is called; the console
    // must not take the operation away just because it cannot pre-check it.
    expect(checkRefundAmount("10.00", null)).toEqual({ error: null, amount: "10.00" });
    expect(checkRefundAmount("0", null).error).toMatch(/more than 0/);
  });
});

describe("classifyRefundRejection", () => {
  it("keeps the server's own 409 message", () => {
    const failure = classifyRefundRejection({
      status: 409,
      message: "This payment has already been refunded.",
    });
    expect(failure.tone).toBe("error");
    expect(failure.heading).toBe("This payment cannot be refunded");
    expect(failure.message).toBe("This payment has already been refunded.");
  });

  it("treats a books failure as a warning, not an error", () => {
    const failure = classifyRefundRejection({
      status: 502,
      message: "The refund succeeded, but QuickBooks could not be updated.",
    });
    expect(failure.tone).toBe("warning");
    expect(failure.heading).toBe("Refunded, but the books were not updated");
    expect(failure.message).toContain("QuickBooks");
  });

  it("recognises the books failure by its code even with a vague message", () => {
    const failure = classifyRefundRejection({
      status: 502,
      code: "REFUND_BOOKS_UPDATE_FAILED",
      message: "Upstream error",
    });
    expect(failure.tone).toBe("warning");
  });

  it("recognises the server's 'still shows this payment' wording", () => {
    const failure = classifyRefundRejection({
      status: 502,
      message:
        "MONEY REFUNDED, but the accounting system still shows this payment. The accounting record must be reversed by hand.",
    });
    expect(failure.tone).toBe("warning");
  });

  it("treats an ordinary gateway refusal as an error", () => {
    const failure = classifyRefundRejection({
      status: 502,
      message: "The gateway refused the refund.",
    });
    expect(failure.tone).toBe("error");
    expect(failure.message).toBe("The gateway refused the refund.");
  });

  it("states a fallback when the server sent no message", () => {
    const failure = classifyRefundRejection({ status: 409 });
    expect(failure.tone).toBe("error");
    expect(failure.message).toMatch(/already be refunded/);
  });
});
