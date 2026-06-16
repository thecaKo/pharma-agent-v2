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

  // hex / base64 via Buffer
  const buf = Buffer.from(value, encoding);
  if (buf.length === 0 && value.length > 0) {
    return { ok: false, encoding, errorCode: "DECODE_FAILED" };
  }
  if (isBinary(buf)) {
    return { ok: false, encoding, errorCode: "DECODE_FAILED" };
  }
  return { ok: true, encoding, decoded: buf.toString("utf8") };
}
