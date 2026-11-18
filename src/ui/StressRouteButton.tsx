import { engine } from '../core/engine';
import { app } from '../core/app';
import { useEngine, useRouterStatus } from './hooks';

/** Estimated time to road-map all pending legs at the public server's ~1 request/sec pace. */
export function routeEta(pending: number) {
  const reqs = Math.ceil(pending / Math.max(1, app.queue.provider.maxWaypoints - 1));
  const sec = Math.ceil((reqs * Math.max(app.queue.provider.minIntervalMs, 300)) / 1000);
  return sec < 90 ? `~${sec} s` : sec < 5400 ? `~${Math.round(sec / 60)} min` : `~${(sec / 3600).toFixed(1)} h`;
}

/** Start / stop road-mapping of the stress-test trip (off by default to protect the free server). */
export function StressRouteButton({ className = 'sm' }: { className?: string }) {
  useEngine();
  const status = useRouterStatus();
  const pending = engine.pendingLegs;
  const on = app.queue.autoRoute;
  if (!pending) return null;
  if (on && status !== 'paused') {
    return <button className={className} onClick={() => app.queue.setAuto(false)}>⏸ Stop mapping ({pending.toLocaleString('en-IN')} left, {routeEta(pending)})</button>;
  }
  return <button className={`${className} primary`} onClick={() => app.queue.setAuto(true)}>🛣 Map test stops on roads ({routeEta(pending)})</button>;
}
