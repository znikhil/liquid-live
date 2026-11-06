// Your camera, floating on the call tile. Drag it anywhere; double-click puts it back.

import { useEffect, useRef, useState } from "react";
import { prefs, type SelfPos } from "../prefs";

/** Gap kept between the tile's edges and your camera, in px. */
const MARGIN = 16;

export function SelfView({ stream }: { stream: MediaStream }) {
  const video = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState<SelfPos>(prefs.selfPos.get);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  function save(next: SelfPos) {
    setPos(next);
    prefs.selfPos.set(next);
  }

  function drag(e: React.PointerEvent<HTMLDivElement>) {
    const self = e.currentTarget;
    const box = self.parentElement?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    self.setPointerCapture(e.pointerId);
    const me = self.getBoundingClientRect();
    const grab = { x: e.clientX - me.left, y: e.clientY - me.top };
    const free = { x: box.width - 2 * MARGIN - me.width, y: box.height - 2 * MARGIN - me.height };
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    let next = pos;
    const move = (ev: PointerEvent) => {
      next = {
        x: free.x > 0 ? clamp((ev.clientX - grab.x - box.left - MARGIN) / free.x) : 0,
        y: free.y > 0 ? clamp((ev.clientY - grab.y - box.top - MARGIN) / free.y) : 0,
      };
      setPos(next);
    };
    const up = () => {
      self.removeEventListener("pointermove", move);
      self.removeEventListener("pointerup", up);
      self.removeEventListener("pointercancel", up);
      save(next);
    };
    self.addEventListener("pointermove", move);
    self.addEventListener("pointerup", up);
    self.addEventListener("pointercancel", up);
  }

  const style = pos
    ? {
        left: `calc(${MARGIN}px + (100% - ${2 * MARGIN}px) * ${pos.x})`,
        top: `calc(${MARGIN}px + (100% - ${2 * MARGIN}px) * ${pos.y})`,
        right: "auto",
        transform: `translate(${-pos.x * 100}%, ${-pos.y * 100}%)`,
      }
    : undefined;

  return (
    <div className="self-view" style={style} onPointerDown={drag} onDoubleClick={() => save(null)} title="Drag to move · double-click to put back">
      <video ref={video} autoPlay muted playsInline />
      <span>You</span>
    </div>
  );
}
