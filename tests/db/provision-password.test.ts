import { describe, expect, it } from "vitest";
import { generateReadonlyPassword } from "../../src/db/provision-password.js";

describe("generateReadonlyPassword", () => {
  it("gera senha com pelo menos 24 caracteres", () => {
    const pwd = generateReadonlyPassword();
    expect(pwd.length).toBeGreaterThanOrEqual(24);
  });

  it("usa apenas caracteres do alfabeto seguro (sem aspas, barra ou crase)", () => {
    for (let i = 0; i < 50; i += 1) {
      const pwd = generateReadonlyPassword();
      expect(pwd).toMatch(/^[A-Za-z0-9!#%*+\-_.]+$/);
    }
  });

  it("produz valores distintos a cada chamada (entropia)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(generateReadonlyPassword());
    }
    expect(seen.size).toBe(100);
  });
});
