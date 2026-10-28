import { expect, test } from "@playwright/test";

import { installHistory, openHarness } from "./support/history.js";
import { installTouchRig, type TouchRig, type TouchRigOptions } from "./support/touchRig.js";

/**
 * The input layer's touch rules, driven by synthetic pointer events against a recording host
 * (see support/touchRig.ts). The real-browser counterpart is chart-touch-e2e.spec.ts.
 */

type RigFactory = (options?: TouchRigOptions) => TouchRig;

test.beforeEach(async ({ page }) => {
  await installHistory(page);
  await openHarness(page);
  await installTouchRig(page);
});

test("a finger stays put until it leaves the dead zone, then pans from where it landed", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const { fire, log } = rig;
    fire("pointerdown", 1, 100, 100);
    fire("pointermove", 1, 106, 100);
    const inside = [...log];
    fire("pointermove", 1, 112, 100);
    fire("pointermove", 1, 130, 100);
    fire("pointerup", 1, 130, 100);
    const touch = [...log];
    const crosshair = rig.crosshair.visible;
    rig.dispose();

    const mouse = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    mouse.fire("pointerdown", 1, 100, 100, "mouse");
    mouse.fire("pointermove", 1, 104, 100, "mouse");
    mouse.fire("pointerup", 1, 104, 100, "mouse");
    const mouseLog = [...mouse.log];
    mouse.dispose();
    return { inside, touch, crosshair, mouseLog };
  });

  expect(probe.inside).toEqual(["peek touch=true", "down 100 touch=true", "begin"]);
  // Past the slop the pan counts the whole way from the landing point, so the chart stays under the finger.
  expect(probe.touch).toEqual(["peek touch=true", "down 100 touch=true", "begin", "drag 12", "drag 30", "end"]);
  expect(probe.crosshair).toBe(false);
  // A mouse starts dragging after 4px, with its hover crosshair, as it always did.
  expect(probe.mouseLog).toEqual(["down 100 touch=false", "begin", "crosshair 104,100", "drag 4", "end"]);
});

test("a touch never shows a hover crosshair, a mouse still does", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    rig.fire("pointermove", 1, 100, 100);
    const afterTouchMove = { visible: rig.crosshair.visible, log: [...rig.log] };
    rig.fire("pointermove", 2, 120, 90, "mouse");
    const afterMouseMove = { visible: rig.crosshair.visible, log: [...rig.log] };
    rig.dispose();
    return { afterTouchMove, afterMouseMove };
  });

  expect(probe.afterTouchMove).toEqual({ visible: false, log: [] });
  expect(probe.afterMouseMove).toEqual({ visible: true, log: ["crosshair 120,90"] });
});

test("a second finger turns the pan into a pinch around the fingers' midpoint, and the last finger pans on", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const { fire, log } = rig;
    fire("pointerdown", 1, 100, 100);
    fire("pointerdown", 2, 200, 100);
    fire("pointermove", 2, 300, 100); // spread 100 -> 200 around a midpoint that moved 150 -> 200
    fire("pointermove", 1, 60, 100); // 200 -> 240, midpoint 200 -> 180
    fire("pointerdown", 3, 300, 200); // a third finger takes no part
    fire("pointermove", 3, 320, 220);
    fire("pointerup", 3, 320, 220);
    const pinching = [...log];
    fire("pointerup", 2, 300, 100);
    fire("pointermove", 1, 64, 100); // 4px: inside the dead zone of the resumed pan
    fire("pointermove", 1, 80, 100);
    fire("pointerup", 1, 80, 100);
    const all = [...log];
    rig.dispose();
    return { pinching, all };
  });

  expect(probe.pinching).toEqual([
    "peek touch=true", "down 100 touch=true", "begin",
    "end",
    "panX 50", "zoom 2 @200 of 10",
    "panX -20", "zoom 1.2 @180 of 10",
  ]);
  expect(probe.all.slice(probe.pinching.length)).toEqual(["begin", "drag 20", "end"]);
});

test("a pinch that closes the fingers zooms out, and fingers pressed together do not zoom at all", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const { fire, log } = rig;
    fire("pointerdown", 1, 100, 100);
    fire("pointerdown", 2, 300, 100);
    log.length = 0;
    fire("pointermove", 2, 200, 100); // 200 -> 100
    const closing = [...log];
    log.length = 0;
    fire("pointermove", 2, 110, 100); // 100 -> 10: the end sample is under the minimum distance
    fire("pointermove", 2, 220, 100); // 10 -> 120: the start sample was
    const tight = [...log];
    log.length = 0;
    fire("pointermove", 2, 320, 100); // 120 -> 220 is a normal step again
    const after = [...log];
    rig.dispose();
    return { closing, tight, after };
  });

  expect(probe.closing).toEqual(["panX -50", "zoom 0.5 @150 of 10"]);
  expect(probe.tight).toEqual([]);
  expect(probe.after).toEqual(["panX 50", "zoom 1.83 @210 of 10"]);
});

test("a pinch leaves the price scale alone when auto scale is on and follows the midpoint when it is off", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const make = (autoScale: boolean) => {
      const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({ autoScale });
      rig.fire("pointerdown", 1, 100, 100);
      rig.fire("pointerdown", 2, 200, 100);
      rig.fire("pointermove", 2, 200, 140); // the midpoint moves down 20px
      const priceTop = rig.view.priceTop;
      rig.dispose();
      return priceTop;
    };
    return { auto: make(true), manual: make(false) };
  });

  expect(probe.auto).toBe(0);
  expect(probe.manual).toBe(20);
});

test("a long press swaps the pan for the crosshair, which follows the finger inside the plot and closes on lift", async ({ page }) => {
  const probe = await page.evaluate(async () => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const { fire, log } = rig;
    fire("pointerdown", 1, 100, 100);
    await rig.wait(520);
    const held = { visible: rig.crosshair.visible, x: rig.crosshair.x, y: rig.crosshair.y };
    fire("pointermove", 1, 140, 130);
    const moved = { x: rig.crosshair.x, y: rig.crosshair.y };
    fire("pointermove", 1, 500, 400); // far outside the plot
    const clamped = { x: rig.crosshair.x, y: rig.crosshair.y };
    fire("pointerdown", 2, 200, 100); // a second finger is ignored while inspecting
    fire("pointerup", 2, 200, 100);
    const stillInspecting = rig.crosshair.visible;
    fire("pointerup", 1, 500, 400);
    const lifted = rig.crosshair.visible;
    const all = [...log];
    rig.dispose();
    return { held, moved, clamped, stillInspecting, lifted, all };
  });

  expect(probe.held).toEqual({ visible: true, x: 100, y: 100 });
  expect(probe.moved).toEqual({ x: 140, y: 130 });
  expect(probe.clamped).toEqual({ x: 350, y: 250 });
  expect(probe.stillInspecting).toBe(true);
  expect(probe.lifted).toBe(false);
  // The pan ends when the crosshair opens; nothing is dragged while it moves.
  expect(probe.all).toEqual([
    "peek touch=true", "down 100 touch=true", "begin",
    "end",
    "crosshair 100,100", "crosshair 140,130", "crosshair 350,250",
    "crosshair off",
  ]);
});

test("a press that moves or lifts before the long-press delay never opens the crosshair", async ({ page }) => {
  const probe = await page.evaluate(async () => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const { fire } = rig;
    fire("pointerdown", 1, 100, 100);
    fire("pointermove", 1, 100, 125); // a drag
    await rig.wait(520);
    const dragged = rig.crosshair.visible;
    fire("pointerup", 1, 100, 125);

    fire("pointerdown", 2, 100, 100); // a tap
    await rig.wait(150);
    fire("pointerup", 2, 100, 100);
    await rig.wait(520);
    const tapped = rig.crosshair.visible;

    fire("pointerdown", 3, 100, 100); // a press the browser cancels
    await rig.wait(150);
    fire("pointercancel", 3, 100, 100);
    await rig.wait(520);
    const cancelled = rig.crosshair.visible;

    fire("pointerdown", 4, 100, 100); // a pinch cancels the pending long press of the first finger
    fire("pointerdown", 5, 200, 100);
    await rig.wait(520);
    const pinched = rig.crosshair.visible;
    rig.dispose();
    return { dragged, tapped, cancelled, pinched };
  });

  expect(probe).toEqual({ dragged: false, tapped: false, cancelled: false, pinched: false });
});

test("the long press waits for a finger on the plot, not on an axis", async ({ page }) => {
  const probe = await page.evaluate(async () => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    rig.fire("pointerdown", 1, 375, 100); // price axis
    await rig.wait(520);
    const onAxis = rig.crosshair.visible;
    rig.fire("pointerup", 1, 375, 100);
    rig.dispose();
    return onAxis;
  });

  expect(probe).toBe(false);
});

test("a tap on a price-scale button works with the wobble of a finger but not of a mouse", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const options: TouchRigOptions = { priceControl: (x, y) => (x > 350 && y > 200 ? "autoScale" : null) };
    const touch = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
    touch.fire("pointerdown", 1, 375, 220);
    touch.fire("pointermove", 1, 375, 228);
    touch.fire("pointerup", 1, 375, 228);
    const touchLog = [...touch.log];
    touch.dispose();

    const mouse = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
    mouse.fire("pointerdown", 1, 375, 220, "mouse");
    mouse.fire("pointermove", 1, 375, 228, "mouse");
    mouse.fire("pointerup", 1, 375, 228, "mouse");
    const mouseLog = [...mouse.log];
    mouse.dispose();
    return { touchLog, mouseLog };
  });

  expect(probe.touchLog).toEqual(["price start 220", "price end", "autoScale false"]);
  expect(probe.mouseLog).toEqual(["price start 220", "crosshair 375,228", "price scale 228", "price end"]);
});

test("a touch may start a time-axis scale just above the thin strip, a mouse may not", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const touch = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    touch.fire("pointerdown", 1, 100, 245);
    const touchLog = [...touch.log];
    touch.fire("pointerup", 1, 100, 245);
    touch.dispose();
    const mouse = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    mouse.fire("pointerdown", 1, 100, 245, "mouse");
    const mouseLog = [...mouse.log];
    mouse.fire("pointerup", 1, 100, 245, "mouse");
    mouse.dispose();
    return { touchLog, mouseLog };
  });

  expect(probe.touchLog).toEqual(["time start 100"]);
  expect(probe.mouseLog).toEqual(["down 100 touch=false", "begin"]);
});

test("the corner menu button opens the context menu on a tap, anchored under the button", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const menuButton = { x: 284, y: 44, w: 36, h: 36 };
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({ menuButton, selectedIds: ["a", "b"] });
    rig.fire("pointerdown", 1, 300, 60);
    const pressedLog = [...rig.log];
    rig.fire("pointerup", 1, 300, 60);
    const tap = { menus: rig.contextMenus.map((menu) => ({ ...menu })), log: [...rig.log] };

    rig.contextMenus.length = 0;
    rig.fire("pointerdown", 2, 300, 60);
    rig.fire("pointermove", 2, 300, 90);
    rig.fire("pointerup", 2, 300, 90);
    const dragged = { menus: rig.contextMenus.length, log: [...rig.log] };

    rig.fire("pointerdown", 3, 300, 60);
    rig.fire("pointercancel", 3, 300, 60);
    const cancelled = rig.contextMenus.length;

    rig.fire("pointerdown", 4, 100, 150); // anywhere else it is a plain pan
    rig.fire("pointerup", 4, 100, 150);
    const elsewhere = rig.contextMenus.length;
    rig.dispose();
    return { pressedLog, tap, dragged, cancelled, elsewhere };
  });

  // Pressing the button starts no pan and no drawing press.
  expect(probe.pressedLog).toEqual([]);
  expect(probe.tap.menus).toEqual([{
    target: "plot", x: 302, y: 62, clientX: 284, clientY: 84,
    panelId: "touch-rig", market: "BTCUSDT", timeframe: "15m", linkGroup: null,
    drawingSelectionCount: 2, tpoProfile: null, indicatorPaneId: null, indicatorAxis: false,
    paneFocus: { hasIndicatorPanes: false, indicatorsHidden: false, panel: { available: false, maximized: false } },
  }]);
  expect(probe.tap.log).toEqual([]);
  expect(probe.dragged).toEqual({ menus: 0, log: [] });
  expect(probe.cancelled).toBe(0);
  expect(probe.elsewhere).toBe(0);
});

test("the menu button acts on the selection only when there is one", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const menuButton = { x: 284, y: 44, w: 36, h: 36 };
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({ menuButton, selectedIds: [] });
    rig.fire("pointerdown", 1, 300, 60);
    rig.fire("pointerup", 1, 300, 60);
    const count = rig.contextMenus[0]?.drawingSelectionCount;
    rig.dispose();
    return count;
  });

  expect(probe).toBe(0);
});

test("the contextmenu a long press makes the browser fire opens nothing, while a mouse and the keyboard still do", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const touch = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    touch.fire("pointerdown", 1, 100, 100);
    const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
    touch.canvas.dispatchEvent(native);
    const afterNative = { menus: touch.contextMenus.length, prevented: native.defaultPrevented, log: [...touch.log] };
    // The keyboard route inside the same window still opens the menu.
    touch.canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    const afterKey = touch.contextMenus.length;
    touch.fire("pointerup", 1, 100, 100);
    touch.dispose();

    const mouse = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    mouse.canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    const afterMouse = mouse.contextMenus.length;
    mouse.dispose();
    return { afterNative, afterKey, afterMouse };
  });

  expect(probe.afterNative.menus).toBe(0);
  expect(probe.afterNative.prevented).toBe(true);
  // The long press did not end the pan; the crosshair timer does that later.
  expect(probe.afterNative.log).toEqual(["peek touch=true", "down 100 touch=true", "begin"]);
  expect(probe.afterKey).toBe(1);
  expect(probe.afterMouse).toBe(1);
});

test.describe("drawings", () => {
  test("with a tool active a tap places and a drag pans", async ({ page }) => {
    const probe = await page.evaluate(() => {
      const options: TouchRigOptions = { activeTool: "trend", pointerDownTakesPress: true };
      const tap = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
      tap.fire("pointerdown", 1, 100, 100);
      const pressed = [...tap.log];
      tap.fire("pointerup", 1, 102, 101);
      const tapLog = [...tap.log];
      tap.dispose();

      const drag = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
      drag.fire("pointerdown", 1, 100, 100);
      drag.fire("pointermove", 1, 120, 100);
      drag.fire("pointerup", 1, 120, 100);
      const dragLog = [...drag.log];
      drag.dispose();

      const pinch = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
      pinch.fire("pointerdown", 1, 100, 100);
      pinch.fire("pointerdown", 2, 200, 100);
      pinch.fire("pointerup", 2, 200, 100);
      pinch.fire("pointerup", 1, 100, 100);
      const pinchLog = [...pinch.log];
      pinch.dispose();
      return { pressed, tapLog, dragLog, pinchLog };
    });

    // The press waits for the release, and lands where the finger lifted.
    expect(probe.pressed).toEqual(["begin"]);
    expect(probe.tapLog).toEqual(["begin", "end", "down 102 touch=true", "up"]);
    expect(probe.dragLog).toEqual(["begin", "drag 20", "end"]);
    expect(probe.pinchLog).toEqual(["begin", "end", "begin", "end"]);
  });

  test("with the brush the finger draws at once, as a mouse does", async ({ page }) => {
    const probe = await page.evaluate(() => {
      const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({ activeTool: "brush", pointerDownTakesPress: true, dragActive: true });
      rig.fire("pointerdown", 1, 100, 100);
      rig.fire("pointermove", 1, 150, 120);
      rig.fire("pointerdown", 2, 200, 100); // a second finger does not interrupt the stroke
      rig.fire("pointermove", 2, 260, 100);
      rig.fire("pointerup", 2, 260, 100);
      rig.fire("pointermove", 1, 170, 130);
      rig.fire("pointerup", 1, 170, 130);
      const log = [...rig.log];
      rig.dispose();
      return log;
    });

    expect(probe).toEqual(["down 100 touch=true", "move 150", "move 170", "up"]);
  });

  test("with no tool a tap selects a drawing that is not selected yet, and a drag pans past it", async ({ page }) => {
    const probe = await page.evaluate(() => {
      const options: TouchRigOptions = { peek: { id: "d1", selected: false }, pointerDownTakesPress: true };
      const tap = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
      tap.fire("pointerdown", 1, 100, 100);
      tap.fire("pointerup", 1, 101, 100);
      const tapLog = [...tap.log];
      tap.dispose();

      const drag = (window as unknown as { __touchRig: RigFactory }).__touchRig(options);
      drag.fire("pointerdown", 1, 100, 100);
      drag.fire("pointermove", 1, 120, 100);
      drag.fire("pointerup", 1, 120, 100);
      const dragLog = [...drag.log];
      drag.dispose();
      return { tapLog, dragLog };
    });

    expect(probe.tapLog).toEqual(["peek touch=true", "begin", "end", "down 101 touch=true", "up"]);
    expect(probe.dragLog).toEqual(["peek touch=true", "begin", "drag 20", "end"]);
  });

  test("a drawing that is already selected is edited by the finger right away, and a second finger leaves it alone", async ({ page }) => {
    const probe = await page.evaluate(() => {
      const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({
        peek: { id: "d1", selected: true }, pointerDownTakesPress: true, dragActive: true,
      });
      rig.fire("pointerdown", 1, 100, 100);
      rig.fire("pointermove", 1, 120, 100);
      rig.fire("pointerdown", 2, 200, 100);
      rig.fire("pointermove", 2, 260, 100);
      rig.fire("pointerup", 2, 260, 100);
      rig.fire("pointermove", 1, 130, 100);
      rig.fire("pointerup", 1, 130, 100);
      const log = [...rig.log];
      rig.dispose();
      return log;
    });

    expect(probe).toEqual(["peek touch=true", "down 100 touch=true", "move 120", "move 130", "up"]);
  });

  test("a press on empty chart still clears the selection first and then pans, as with a mouse", async ({ page }) => {
    const probe = await page.evaluate(() => {
      const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig({ peek: null, pointerDownTakesPress: false });
      rig.fire("pointerdown", 1, 100, 100);
      rig.fire("pointermove", 1, 130, 100);
      rig.fire("pointerup", 1, 130, 100);
      const log = [...rig.log];
      rig.dispose();
      return log;
    });

    expect(probe).toEqual(["peek touch=true", "down 100 touch=true", "begin", "drag 30", "end"]);
  });
});

test("a screen that prefers a coarse pointer starts in touch mode, and a mouse takes it back", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const fine = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    const fineAtStart = fine.crosshair.touch;
    fine.dispose();

    const coarse = (window as unknown as { __touchRig: RigFactory }).__touchRig({ coarse: true });
    const atStart = coarse.crosshair.touch;
    coarse.fire("pointermove", 1, 100, 100, "mouse");
    const afterMouse = coarse.crosshair.touch;
    coarse.fire("pointerdown", 2, 100, 100);
    const afterTouch = coarse.crosshair.touch;
    coarse.fire("pointerup", 2, 100, 100);
    coarse.dispose();
    return { fineAtStart, atStart, afterMouse, afterTouch };
  });

  expect(probe.fineAtStart).toBeUndefined();
  expect(probe.atStart).toBe(true);
  expect(probe.afterMouse).toBe(false);
  expect(probe.afterTouch).toBe(true);
});

test("disposing the controller mid-gesture cancels the long press and closes the crosshair", async ({ page }) => {
  const probe = await page.evaluate(async () => {
    const rig = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    rig.fire("pointerdown", 1, 100, 100);
    rig.dispose();
    await rig.wait(520);
    const afterPending = rig.crosshair.visible;

    const inspecting = (window as unknown as { __touchRig: RigFactory }).__touchRig();
    inspecting.fire("pointerdown", 1, 100, 100);
    await inspecting.wait(520);
    const during = inspecting.crosshair.visible;
    inspecting.dispose();
    return { afterPending, during, after: inspecting.crosshair.visible };
  });

  expect(probe).toEqual({ afterPending: false, during: true, after: false });
});
