import { useLayoutEffect, useState } from 'react';
import { useStoreApi } from '@xyflow/react';
import { scheduleRenderFrame, cancelRenderFrame } from '../ui/render-frame.js';

// React Flow owns the immediate canvas transform; desktop overlays consume the
// latest transform once per animation frame, not every store notification.
export function useFrameViewport() {
  const store = useStoreApi();
  const [viewport, setViewport] = useState(() => {
    const [x, y, zoom] = store.getState().transform;
    return { x, y, zoom };
  });
  useLayoutEffect(() => {
    const key = {};
    let active = true;
    const schedule = () =>
      scheduleRenderFrame(key, () => {
        const [x, y, zoom] = store.getState().transform;
        return () => {
          if (active)
            setViewport((old) =>
              old.x === x && old.y === y && old.zoom === zoom ? old : { x, y, zoom },
            );
        };
      });
    const off = store.subscribe((state, previous) => {
      if (state.transform !== previous.transform) schedule();
    });
    schedule();
    return () => {
      active = false;
      off();
      cancelRenderFrame(key);
    };
  }, [store]);
  return viewport;
}
