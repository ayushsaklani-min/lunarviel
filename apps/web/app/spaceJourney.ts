/** Presentation-only travel coordinates: rotation, never camera/texture zoom. */
export function journeyProgress(scrollTop: number, scrollRange: number): number {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollRange) || scrollRange <= 0) return 0;
  return Math.max(0, Math.min(1, scrollTop / scrollRange));
}

/** Cursor controls axial spin only, fading out before the moon moves left. */
export function moonCursorSpin(pointerX: number, progress: number, reducedMotion: boolean): number {
  if (reducedMotion || !Number.isFinite(pointerX)) return 0;
  const strength = 1 - journeyProgress(progress, 1 / 18);
  return Math.max(-1, Math.min(1, pointerX)) * .9 * strength;
}

export function spaceTravelPose(progress: number, drift: number, reducedMotion: boolean) {
  if (reducedMotion) return { pitch: 0, yaw: 1.27, roll: 0 };
  const position = journeyProgress(progress, 1);
  return {
    pitch: Math.sin(position * Math.PI * 2) * 0.08,
    yaw: 1.27 + drift + position * 0.95,
    roll: Math.sin(position * Math.PI) * 0.025,
  };
}

// Move left during the opening scroll, then hold that viewport position through
// the footer. Smoothstep keeps arrival soft; scrolling back reverses the path.
export function moonTravelPosition(progress: number, mobile: boolean, reducedMotion: boolean) {
  const from = mobile ? [.2, .75] : [1.9, 0];
  const to = mobile ? [-.65, .25] : [-1.8, .35];
  const fraction = reducedMotion ? 0 : journeyProgress(progress, 1 / 6);
  const blend = fraction * fraction * (3 - 2 * fraction);
  return { x: from[0] + (to[0] - from[0]) * blend, y: from[1] + (to[1] - from[1]) * blend, z: 0 };
}
