import React from 'react';
import desktopMark from '../assets/yirang.png';
import './desktop-mark.css';

export function DesktopMark({ size = 64 }: { size?: number }) {
  return (
    <img
      className="desktop-mark"
      src={desktopMark}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
