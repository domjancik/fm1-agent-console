import { readBody, typeCodeOf, writeBody } from "./bodies";
import { CHECKSUM_XOR, FRAME_OVERHEAD, MAX_BODY, SEQ_MODULO } from "./constants";
import { BodyError } from "./fields";
import { originOf, type Message, type Role } from "./messages";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DecodeErrorCode =
  | "bad_length"
  | "not_7bit"
  | "len_too_large"
  | "bad_checksum"
  | "unknown_type"
  | "bad_body";

export interface DecodeError {
  code: DecodeErrorCode;
  detail: string;
  /**
   * Present for `unknown_type` and `bad_body`: the frame itself was intact, so the
   * receiver acknowledges it with a non-ok status.
   */
  frame?: { type: number; seq: number; checksum: number };
}

export interface DecodedFrame<M extends Message = Message> {
  type: number;
  seq: number;
  checksum: number;
  message: M;
}

export function checksum(type: number, seq: number, body: readonly number[]): number {
  let sum = type + seq + body.length;
  for (const b of body) sum += b;
  return (sum & 0x7f) ^ CHECKSUM_XOR;
}

/** Encodes a message as frame payload bytes. Throws RangeError on out-of-range fields or seq. */
export function encode(msg: Message, seq: number): number[] {
  if (!Number.isInteger(seq) || seq < 0 || seq >= SEQ_MODULO) {
    throw new RangeError(`seq ${seq} not in 0..127`);
  }
  const type = typeCodeOf(msg);
  const body = writeBody(msg);
  if (body.length > MAX_BODY) throw new RangeError(`body length ${body.length} > ${MAX_BODY}`);
  return [type, seq, body.length, ...body, checksum(type, seq, body)];
}

const fail = (code: DecodeErrorCode, detail: string, frame?: DecodeError["frame"]) =>
  ({ ok: false, error: frame ? { code, detail, frame } : { code, detail } }) as const;

/**
 * Decodes frame payload bytes. With `from`, a structurally valid frame whose type
 * belongs to the other direction is reported as `unknown_type`.
 */
export function decode(bytes: readonly number[], from?: Role): Result<DecodedFrame, DecodeError> {
  if (bytes.length < FRAME_OVERHEAD) return fail("bad_length", `${bytes.length} bytes < 4`);
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 0x7f)) {
    return fail("not_7bit", "payload byte outside 0..127");
  }
  const [type = 0, seq = 0, len = 0] = bytes;
  if (len > MAX_BODY) return fail("len_too_large", `LEN ${len} > ${MAX_BODY}`);
  if (bytes.length !== len + FRAME_OVERHEAD) {
    return fail("bad_length", `${bytes.length} bytes, LEN ${len} needs ${len + FRAME_OVERHEAD}`);
  }
  const body = bytes.slice(3, 3 + len);
  const ck = bytes[bytes.length - 1] ?? 0;
  const expected = checksum(type, seq, body);
  if (ck !== expected) return fail("bad_checksum", `checksum ${ck} != ${expected}`);

  const frame = { type, seq, checksum: ck };
  let message: Message | undefined;
  try {
    message = readBody(type, body);
  } catch (err) {
    if (err instanceof BodyError) return fail("bad_body", err.message, frame);
    throw err;
  }
  if (!message) return fail("unknown_type", `type 0x${type.toString(16)}`, frame);
  if (from && originOf(message) !== from) {
    return fail("unknown_type", `type 0x${type.toString(16)} is not sent by ${from}`, frame);
  }
  return { ok: true, value: { ...frame, message } };
}
