// Only time observed by this host is charged. Persist cumulative samples so
// retries cannot double-charge and a restarted host starts a separate segment.
export function createActivityClock(clock = () => performance.now()) {
  let previous = clock(), elapsed = 0, waiting = false;
  return {
    sample() {
      const now = clock();
      if (!waiting) elapsed += Math.max(0, now - previous);
      previous = now;
      return elapsed;
    },
    waiting(value) { this.sample(); waiting = value; },
  };
}
