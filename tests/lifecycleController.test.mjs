import test from "node:test";
import assert from "node:assert/strict";
import { LifecycleController } from "../dist/features/controllers/lifecycleController.js";

test("dispose runs registered cleanup exactly once", () => {
  const controller = new LifecycleController();
  let count = 0;
  controller.add(() => count++);
  controller.dispose();
  controller.dispose();
  assert.equal(count, 1);
});
