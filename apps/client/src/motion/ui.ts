// Choreographed UI motion. Every DOM element that moves goes through anime.js timelines here.
import { animate, createTimeline, stagger, type JSAnimation, type Timeline } from 'animejs';

export const motion = {
  /** Panel or card arriving: drop in with a little overshoot. */
  enter(el: Element | Element[], delay = 0): Timeline {
    return createTimeline({ defaults: { ease: 'outBack(1.6)' } }).add(el, {
      translateY: [-12, 0],
      opacity: [0, 1],
      duration: 360,
      delay: Array.isArray(el) ? stagger(60, { start: delay }) : delay,
    });
  },

  leave(el: Element, then?: () => void): JSAnimation {
    return animate(el, { translateY: [0, 8], opacity: [1, 0], duration: 200, ease: 'inQuad', onComplete: () => then?.() });
  },

  /** Screen transition: slide the whole layer. */
  slideIn(el: Element, from: 'left' | 'right' | 'up' | 'down' = 'up'): JSAnimation {
    const axis = from === 'left' || from === 'right' ? 'translateX' : 'translateY';
    const d = from === 'left' || from === 'up' ? -24 : 24;
    return animate(el, { [axis]: [d, 0], opacity: [0, 1], duration: 420, ease: 'outCubic' });
  },

  /** Button or number pop. */
  pop(el: Element, scale = 1.25): JSAnimation {
    return animate(el, { scale: [scale, 1], duration: 320, ease: 'outElastic(1, .5)' });
  },

  /** Rubber squash for presses. */
  squash(el: Element): Timeline {
    return createTimeline()
      .add(el, { scaleX: 1.15, scaleY: 0.85, duration: 70, ease: 'outQuad' })
      .add(el, { scaleX: 1, scaleY: 1, duration: 260, ease: 'outElastic(1, .4)' });
  },

  /** The deal stamp: slams from big and tilted, settles, holds, then lifts away. */
  stamp(el: Element, onImpact: () => void, onDone: () => void): Timeline {
    return createTimeline({ onComplete: onDone })
      .add(el, { scale: [3.2, 1], rotate: [-28, -8], opacity: [0, 1], duration: 170, ease: 'inQuad', onComplete: onImpact })
      .add(el, { scale: [1.12, 1], duration: 220, ease: 'outElastic(1, .45)' })
      .add(el, { opacity: [1, 0], translateY: [0, -10], duration: 260, delay: 650, ease: 'inQuad' });
  },

  /** Count a number from one value to another, calling onValue each frame. */
  count(from: number, to: number, ms: number, onValue: (v: number) => void): JSAnimation {
    const box = { v: from };
    return animate(box, { v: to, duration: ms, ease: 'outExpo', onUpdate: () => onValue(box.v) });
  },

  /** A coin or egg flying along an arc between two points in the 640x360 space. */
  arc(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, ms: number, lift = 40, delay = 0): JSAnimation {
    const box = { p: 0 };
    const place = () => {
      const p = box.p;
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p - lift * 4 * p * (1 - p);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    place();
    return animate(box, { p: 1, duration: ms, delay, ease: 'inOutQuad', onUpdate: place, onComplete: () => el.remove() });
  },

  /** Ticker crash: drop, shudder, settle. */
  crash(el: Element): Timeline {
    return createTimeline()
      .add(el, { translateY: [0, 4], duration: 90, ease: 'inQuad' })
      .add(el, { translateX: [-3, 3, -2, 2, 0], duration: 360, ease: 'linear' })
      .add(el, { translateY: 0, duration: 400, ease: 'outElastic(1, .5)' });
  },

  /** Endless horizontal scroll for the ticker track. */
  scroll(el: Element, width: number, pxPerSecond = 28): JSAnimation {
    return animate(el, { translateX: [0, -width], duration: (width / pxPerSecond) * 1000, ease: 'linear', loop: true });
  },

  /** Idle bob for prompts. */
  bob(el: Element): JSAnimation {
    return animate(el, { translateY: [0, -2], duration: 520, alternate: true, loop: true, ease: 'inOutSine' });
  },
};
