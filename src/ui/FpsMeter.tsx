import { useEffect, useState } from 'react';

export function FpsMeter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0, last = performance.now(), raf = 0;
    const tick = (t: number) => {
      frames++;
      if (t - last >= 1000) { setFps(Math.round((frames * 1000) / (t - last))); frames = 0; last = t; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className={`fps glass ${fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'bad'}`}>{fps} fps</div>;
}
