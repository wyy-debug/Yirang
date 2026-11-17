import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  enableRenderMetrics,
  recordDesktopCommit,
  renderMetricsEnabled,
  takeRenderMetrics,
} from './render-metrics.js';
import './render-performance.css';

// Production React builds do not expose Profiler actualDuration. This measures
// our Desktop render entry -> layout effect, including React scheduling/commit.
export function useDesktopCommitTiming() {
  const start = renderMetricsEnabled() ? performance.now() : null;
  useLayoutEffect(() => {
    if (start !== null) recordDesktopCommit(performance.now() - start);
  });
}
type Sample = {
  fps: number;
  mean: number;
  p95: number;
  max: number;
  slow: number;
  longTasks: number | null;
  longestTask: number | null;
  heap: number | null;
  render: ReturnType<typeof takeRenderMetrics>;
};
const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toFixed(1) + ' ms';
export const RenderPerformance = React.memo(function RenderPerformance() {
  const [open, setOpen] = useState(() => {
      try {
        return localStorage.getItem('yirang:render-performance') === 'on';
      } catch {
        return false;
      }
    }),
    [paused, setPaused] = useState(false),
    [hidden, setHidden] = useState(document.hidden),
    [sample, setSample] = useState<Sample | null>(null),
    [epoch, setEpoch] = useState(0),
    [copied, setCopied] = useState('');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null),
    drag = useRef<{
      x: number;
      y: number;
      left: number;
      top: number;
      width: number;
      height: number;
    } | null>(null);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!open || paused || hidden) {
      enableRenderMetrics(false);
      return;
    }
    enableRenderMetrics(true);
    setSample(null);
    let frame = 0,
      last = 0,
      started = performance.now(),
      intervals: number[] = [],
      count = 0,
      total = 0,
      max = 0,
      slow = 0,
      longTasks = 0,
      longestTask = 0,
      observer: PerformanceObserver | undefined;
    try {
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks++;
            longestTask = Math.max(longestTask, entry.duration);
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    } catch {
      observer = undefined;
    }
    const tick = (now: number) => {
      if (last) {
        const delta = now - last;
        count++;
        total += delta;
        max = Math.max(max, delta);
        if (delta > 32) slow++;
        intervals.push(delta);
        if (intervals.length > 480) intervals.shift();
      }
      last = now;
      if (now - started >= 1000) {
        const sorted = [...intervals].sort((a, b) => a - b),
          memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setSample({
          fps: (count * 1000) / (now - started),
          mean: count ? total / count : 0,
          p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0,
          max,
          slow,
          longTasks: observer ? longTasks : null,
          longestTask: observer ? longestTask : null,
          heap: memory ? memory.usedJSHeapSize / 1048576 : null,
          render: takeRenderMetrics(),
        });
        started = now;
        count = 0;
        total = 0;
        max = 0;
        intervals = [];
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      enableRenderMetrics(false);
    };
  }, [open, paused, hidden, epoch]);
  const toggle = (value: boolean) => {
    setOpen(value);
    try {
      localStorage.setItem('yirang:render-performance', value ? 'on' : 'off');
    } catch {}
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            scope: 'Yirang desktop panel; not GPU or independent browser renderer',
            capturedAt: new Date().toISOString(),
            paused,
            hidden,
            sample,
          },
          null,
          2,
        ),
      );
      setCopied('已复制');
    } catch {
      setCopied('复制不可用');
    }
  };
  return createPortal(
    open ? (
      <aside
        className="render-performance"
        style={position ? { left: position.x, top: position.y, bottom: 'auto' } : undefined}
        aria-label="渲染耗时"
        data-canvas-toolbar
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as Element).closest('button')) return;
            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d)
              setPosition({
                x: Math.max(0, Math.min(window.innerWidth - d.width, d.left + e.clientX - d.x)),
                y: Math.max(0, Math.min(window.innerHeight - d.height, d.top + e.clientY - d.y)),
              });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onLostPointerCapture={() => (drag.current = null)}
        >
          <strong>渲染耗时</strong>
          <small>{hidden ? '后台暂停' : paused ? '已暂停' : '每秒更新'}</small>
          <button aria-label="收起耗时组件" onClick={() => toggle(false)}>
            ×
          </button>
        </header>
        <div className="render-performance-stats">
          <div>
            <span>rAF 帧率</span>
            <b>
              {sample ? sample.fps.toFixed(0) : '—'}
              <small> FPS</small>
            </b>
          </div>
          <div>
            <span>帧间隔 · 平均 / P95</span>
            <b>
              {ms(sample?.mean)} / {ms(sample?.p95)}
            </b>
          </div>
          <div>
            <span>本秒最长帧间隔</span>
            <b>{ms(sample?.max)}</b>
          </div>
          <div title="从桌面组件进入渲染到 layout effect，包含调度与提交，不是纯 React CPU 或 GPU 绘制耗时">
            <span>桌面更新→提交 · 平均</span>
            <b>
              {sample?.render.commits ? ms(sample.render.commitTotal / sample.render.commits) : '—'}
            </b>
          </div>
          <div>
            <span>提交次数 / 最长</span>
            <b>
              {sample ? sample.render.commits : '—'} /{' '}
              {sample?.render.commits ? ms(sample.render.commitMax) : '—'}
            </b>
          </div>
          <div title="仅统计一壤共用帧调度器的同步布局读取与更新回调，不含后续 React 绘制">
            <span>布局批次 JS · 最长</span>
            <b>{sample?.render.batches ? ms(sample.render.batchMax) : '—'}</b>
          </div>
          <div>
            <span>批次 / 合并回调数</span>
            <b>{sample ? `${sample.render.batches} / ${sample.render.jobs}` : '—'}</b>
          </div>
          <div title="采样期间累计，不是精确掉帧数">
            <span>长帧 &gt;32ms · 累计</span>
            <b>{sample?.slow ?? '—'}</b>
          </div>
          <div title="浏览器 Long Tasks API；不可用时显示横线">
            <span>长任务 &gt;50ms · 累计</span>
            <b>
              {sample?.longTasks ?? '—'} / {ms(sample?.longestTask)}
            </b>
          </div>
          <div title="浏览器提供的 JS 堆估算，不是整个渲染进程内存">
            <span>JS 堆 · 估算</span>
            <b>
              {sample?.heap !== null && sample?.heap !== undefined
                ? sample.heap.toFixed(0) + ' MiB'
                : '—'}
            </b>
          </div>
        </div>
        <footer>
          <button onClick={() => setPaused((v) => !v)}>{paused ? '继续' : '暂停'}</button>
          <button
            onClick={() => {
              setCopied('');
              setSample(null);
              setEpoch((v) => v + 1);
            }}
          >
            重置
          </button>
          <button disabled={!sample} onClick={() => void copy()}>
            {copied || '复制数据'}
          </button>
        </footer>
        <p>仅当前桌面页面采样；不含独立浏览器进程的 GPU 耗时。</p>
      </aside>
    ) : (
      <button className="render-performance-open" data-canvas-toolbar onClick={() => toggle(true)}>
        耗时
      </button>
    ),
    document.body,
  );
});
