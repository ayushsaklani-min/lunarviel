import { describe, expect, it } from "vitest";
import { journeyProgress, moonCursorSpin, moonTravelPosition, spaceTravelPose } from "./spaceJourney";

describe("space journey", () => {
  it("maps horizontal cursor motion to a bounded axial rotation only", () => {
    expect(moonCursorSpin(-1, 0, false)).toBe(-.9);
    expect(moonCursorSpin(1, 0, false)).toBe(.9);
    expect(moonCursorSpin(0, 0, false)).toBe(0);
    expect(moonCursorSpin(10, 0, false)).toBe(.9);
    expect(moonCursorSpin(Number.NaN, 0, false)).toBe(0);
  });
  it("disables cursor spin beyond the top-right phase and for reduced motion", () => {
    expect(moonCursorSpin(1, 1 / 18, false)).toBe(0);
    expect(moonCursorSpin(1, .5, false)).toBe(0);
    expect(moonCursorSpin(1, 0, true)).toBe(0);
    expect(moonCursorSpin(1, 1 / 36, false)).toBeCloseTo(.45);
  });
  it("moves the moon left once, then holds there through the footer", () => {
    expect(moonTravelPosition(0, false, false)).toEqual({ x: 1.9, y: 0, z: 0 });
    const arrived = moonTravelPosition(1 / 6, false, false);
    expect(arrived.x).toBeCloseTo(-1.8);
    for (const progress of [2 / 6, .5, .75, 1]) {
      expect(moonTravelPosition(progress, false, false)).toEqual(arrived);
      expect(moonTravelPosition(progress, true, false)).toEqual(moonTravelPosition(1 / 6, true, false));
    }
  });
  it("keeps moon depth constant and bounds the smaller mobile path", () => {
    for (let index = 0; index <= 100; index++) {
      const pose = moonTravelPosition(index / 100, true, false);
      expect(pose.z).toBe(0);
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(.66);
    }
    expect(moonTravelPosition(.9, true, true)).toEqual({ x: .2, y: .75, z: 0 });
    expect(moonTravelPosition(-1, false, false)).toEqual(moonTravelPosition(0, false, false));
  });
  it("clamps browser overscroll and handles a page without scrolling", () => {
    expect(journeyProgress(-20, 100)).toBe(0);
    expect(journeyProgress(200, 100)).toBe(1);
    expect(journeyProgress(50, 100)).toBe(.5);
    expect(journeyProgress(50, 0)).toBe(0);
    expect(journeyProgress(Number.NaN, 100)).toBe(0);
  });
  it("travels in both directions without changing scale or camera distance", () => {
    const start = spaceTravelPose(0, 0, false);
    const middle = spaceTravelPose(.5, 0, false);
    const end = spaceTravelPose(1, 0, false);
    expect(start.yaw).toBeLessThan(middle.yaw);
    expect(middle.yaw).toBeLessThan(end.yaw);
    expect(spaceTravelPose(0, 0, false)).toEqual(start);
    expect(Object.keys(end).sort()).toEqual(["pitch", "roll", "yaw"]);
    for (let index = 0; index <= 100; index++) {
      const pose = spaceTravelPose(index / 100, 0, false);
      expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(.08);
      expect(Math.abs(pose.roll)).toBeLessThanOrEqual(.025);
    }
  });
  it("disables ambient and scroll motion when reduced motion is requested", () => {
    expect(spaceTravelPose(.8, 20, true)).toEqual(spaceTravelPose(0, 0, true));
  });
});
