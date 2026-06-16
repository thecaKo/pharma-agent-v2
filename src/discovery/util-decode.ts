import { isBinary } from "./fs-primitives.js";

const MAX_INPUT_BYTES = 64 * 1024;

export type DecodeEncoding = "hex" | "base64" | "url";

export type DecodeErrorCode = "INVALID_INPUT" | "DECODE_FAILED";

export type DecodeResult =
  | { ok: true; encoding: DecodeEncoding; decoded: string }
  | { ok: false; encoding?: DecodeEncoding; errorCode: DecodeErrorCode };

export function utilDecode(value: string, encoding: string): DecodeResult {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    return { ok: false, errorCode: "INVALID_INPUT" };
  }
  if (encoding !== "hex" && encoding !== "base64" && encoding !== "url") {
    return { ok: false, errorCode: "INVALID_INPUT" };
  }

  if (encoding === "url") {
    try {
      const decoded = decodeURIComponent(value);
      return { ok: true, encoding, decoded };
    } catch {
      return { ok: false, encoding, errorCode: "DECODE_FAILED" };
    }
  }

  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
      return { ok: false, encoding, errorCode: "DECODE_FAILED" };
    }
    const buf = Buffer.from(value, "hex");
    if (isBinary(buf)) return { ok: false, encoding, errorCode: "DECODE_FAILED" };
    return { ok: true, encoding, decoded: buf.toString("utf8") };
  }

  // base64
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0 && value.trim().replace(/={1,2}$/, "").length > 0) {
    return { ok: false, encoding, errorCode: "DECODE_FAILED" };
  }
  // round-trip: garante que o input é base64 válido e não lixo silenciosamente ignorado
  const reEncoded = buf.toString("base64");
  const normalize = (s: string) => s.replace(/[=\s]/g, "");
  if (normalize(reEncoded) !== normalize(value)) {
    return { ok: false, encoding, errorCode: "DECODE_FAILED" };
  }
  if (isBinary(buf)) return { ok: false, encoding, errorCode: "DECODE_FAILED" };
  return { ok: true, encoding, decoded: buf.toString("utf8") };
}
