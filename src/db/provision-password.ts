import { randomBytes } from "node:crypto";

// Alfabeto seguro: sem aspas simples/duplas, crase, barra e contrabarra,
// evitando qualquer interferência com quoting de identificadores/strings SQL.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%*+-_.";
const DEFAULT_LENGTH = 32;

export function generateReadonlyPassword(length: number = DEFAULT_LENGTH): string {
  const target = Math.max(length, 24);
  const bytes = randomBytes(target);
  let out = "";
  for (let i = 0; i < target; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
