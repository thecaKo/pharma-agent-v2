import { describe, expect, it } from "vitest";
import { utilDecode } from "../../src/discovery/util-decode.js";

describe("utilDecode", () => {
  it("decodifica hex válido", () => {
    const result = utilDecode("68656c6c6f", "hex");
    expect(result).toEqual({ ok: true, encoding: "hex", decoded: "hello" });
  });

  it("decodifica base64 válido", () => {
    const result = utilDecode("aGVsbG8=", "base64");
    expect(result).toEqual({ ok: true, encoding: "base64", decoded: "hello" });
  });

  it("decodifica url válido", () => {
    const result = utilDecode("host%3Dlocalhost", "url");
    expect(result).toEqual({ ok: true, encoding: "url", decoded: "host=localhost" });
  });

  it("rejeita encoding inválido", () => {
    const result = utilDecode("abc", "ascii");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita valor vazio", () => {
    const result = utilDecode("", "hex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita resultado binário em hex", () => {
    // sequência com byte NUL
    const result = utilDecode("0048656c6c6f", "hex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("DECODE_FAILED");
  });

  it("rejeita resultado binário em base64", () => {
    // Buffer.from([0x00, 0x41]).toString('base64') = 'AEE='
    const result = utilDecode("AEE=", "base64");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("DECODE_FAILED");
  });

  it("rejeita URL malformada", () => {
    const result = utilDecode("%zz", "url");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("DECODE_FAILED");
  });

  it("rejeita valor maior que 64KB", () => {
    const big = "a".repeat(65 * 1024);
    const result = utilDecode(big, "hex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("INVALID_INPUT");
  });
});
