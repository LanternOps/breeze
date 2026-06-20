// apps/helper/src/windows/SessionBanner.tsx
import { useEffect, useState } from "react";

export function SessionBanner({ label, startedAt }: { label: string; startedAt: number }) {
  const [elapsed, setElapsed] = useState("0:00");
  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      setElapsed(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div className="helper-sessionbanner" role="status" aria-live="polite">
      <span className="helper-sessionbanner-dot" aria-hidden />
      <span className="helper-sessionbanner-label">{label}</span>
      <span className="helper-sessionbanner-sep" aria-hidden>·</span>
      <span className="helper-sessionbanner-time">{elapsed}</span>
    </div>
  );
}
