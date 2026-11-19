import { useEffect, useState } from 'react';
import { mode } from '../core/mode';
import { useUI } from '../ui/state';
import { DailyWidgets } from './DailyWidgets';
import { MarkersBar } from './MarkersBar';
import { QuickActions } from './QuickActions';

/** Everything Daily mode draws over the map (nothing renders in Expedition). */
export function DailyLayer() {
  useUI((s) => s.modePicker);
  const [, tick] = useState(0);
  useEffect(() => { const o = new MutationObserver(() => tick((x) => x + 1)); o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] }); return () => o.disconnect(); }, []);
  if (mode.current !== 'daily') return null;
  return (
    <>
      <DailyWidgets />
      <MarkersBar />
      <QuickActions />
    </>
  );
}
