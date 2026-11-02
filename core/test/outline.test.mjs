import assert from "node:assert/strict";
import test from "node:test";
import { editedFunctions, outline, writtenFunctions } from "../lib/outline.mjs";

const CART_TS = `import { round } from './money'

export function applyDiscount(total: number, code: string): number {
  if (code) {
    return total * 0.9
  }
  return total
}

export const formatPrice = (value: number) => \`$\${round(value)}\`

export class Cart {
  total(): number {
    const add = (a: number) => { return a }
    return add(0)
  }

  async count(): Promise<number> {
    return 1 // }
  }
}
`;

const BILLING_PY = `import math


def charge(amount):
    def inner():
        return 1
    return inner() + amount


class Invoice:
    rate = 0.2

    def total(self):
        return math.ceil(self.rate)

    @property
    def due(self):
        return 3
`;

test("outlines TypeScript functions, arrow functions, classes and methods", () => {
  const names = outline(CART_TS, "billing/cart.ts").map((u) => `${u.name}:${u.start}-${u.end}`);
  assert.deepEqual(names, ["applyDiscount:3-8", "formatPrice:10-10", "Cart:12-21", "Cart.total:13-16", "Cart.count:18-20"]);
});

test("outlines Python functions and methods; inner functions belong to their outer one", () => {
  const names = outline(BILLING_PY, "billing.py").map((u) => `${u.name}:${u.start}-${u.end}`);
  assert.deepEqual(names, ["charge:4-7", "Invoice:10-18", "Invoice.total:13-14", "Invoice.due:17-18"]);
});

test("an Edit names the functions its old text sits in, or <module> outside them", () => {
  assert.deepEqual(editedFunctions("billing/cart.ts", CART_TS, [{ old_string: "return total * 0.9" }]), ["applyDiscount"]);
  assert.deepEqual(editedFunctions("billing/cart.ts", CART_TS, [{ old_string: "return 1 // }" }]), ["Cart.count"]);
  assert.deepEqual(editedFunctions("billing/cart.ts", CART_TS, [{ old_string: "import { round }" }]), ["<module>"]);
  assert.deepEqual(editedFunctions("billing.py", BILLING_PY, [{ old_string: "rate = 0.2" }]), ["Invoice"]);
  assert.deepEqual(editedFunctions("billing.py", BILLING_PY, [{ old_string: "return 1" }, { old_string: "return 3" }]), ["Invoice.due", "charge"]);
  assert.deepEqual(editedFunctions("billing/cart.ts", CART_TS, [{ old_string: "return total", replace_all: true }]), ["applyDiscount"]);
  assert.equal(editedFunctions("billing/cart.ts", CART_TS, [{ old_string: "not in the file" }]), null);
  assert.equal(editedFunctions("README.md", "# hi", [{ old_string: "hi" }]), null);
  assert.deepEqual(editedFunctions("billing/cart.ts", CART_TS.replace(/\n/g, "\r\n"), [{ old_string: "return total * 0.9" }]), ["applyDiscount"]);
});

test("a Write names the functions whose text changed, appeared or disappeared", () => {
  const after = CART_TS.replace("return 1 // }", "return 2").replace("export const formatPrice", "export const showPrice");
  assert.deepEqual(writtenFunctions("billing/cart.ts", CART_TS, after), ["Cart.count", "formatPrice", "showPrice"]);
  assert.deepEqual(writtenFunctions("billing/cart.ts", CART_TS, `// header\n${CART_TS}`), ["<module>"]);
  assert.deepEqual(writtenFunctions("billing/cart.ts", CART_TS, CART_TS), []);
  assert.equal(writtenFunctions("billing/cart.ts", null, CART_TS), null);
});
