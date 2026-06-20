// apps/helper/src/windows/ConsentDialog.tsx
import { useEffect, useRef, useState } from "react";

export interface ConsentRequest {
  sessionId: string;
  technicianName: string | null;   // null => "A technician"
  technicianEmail: string | null;  // null => omit line
  orgName: string | null;
  timeoutMs: number;
  onTimeout: "proceed" | "block";
}

export function ConsentDialog({
  req, onDecision,
}: { req: ConsentRequest; onDecision: (allow: boolean, reason: "user" | "timeout") => void }) {
  const [remainingMs, setRemainingMs] = useState(req.timeoutMs);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => denyRef.current?.focus(), []);

  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => {
      const left = req.timeoutMs - (performance.now() - started);
      if (left <= 0) { window.clearInterval(id); setRemainingMs(0); onDecision(req.onTimeout === "proceed", "timeout"); }
      else setRemainingMs(left);
    }, 200);
    return () => window.clearInterval(id);
  }, [req, onDecision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDecision(false, "user"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecision]);

  const secs = Math.ceil(remainingMs / 1000);
  const countdown = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const urgent = secs <= 5;
  const label = req.onTimeout === "proceed"
    ? `Connecting automatically in ${countdown}`
    : `Declining automatically in ${countdown}`;
  const name = req.technicianName ?? "A technician";
  const initials = req.technicianName
    ? req.technicianName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "◐";

  return (
    <div className="helper-consent-overlay" role="alertdialog"
         aria-labelledby="consent-title" aria-describedby="consent-body">
      <div className="helper-consent-card">
        <div className="helper-consent-header">
          <span className="helper-consent-icon" aria-hidden>▣</span>
          <span id="consent-title" className="helper-consent-title">Remote support request</span>
        </div>
        <div className="helper-consent-body">
          <div className="helper-consent-identity">
            <span className="helper-consent-avatar" aria-hidden>{initials}</span>
            <div className="helper-consent-who">
              <span className="helper-consent-name">{name}</span>
              {req.technicianEmail && <span className="helper-consent-email">{req.technicianEmail}</span>}
            </div>
          </div>
          <p id="consent-body" className="helper-consent-desc">
            wants to start a remote session on this computer.
          </p>
          {req.orgName && <div className="helper-consent-meta">{req.orgName} · requested just now</div>}
        </div>
        <div className="helper-consent-footer">
          <span className={`helper-consent-countdown${urgent ? " is-urgent" : ""}`}>{label}</span>
          <div className="helper-consent-actions">
            <button ref={denyRef} className="helper-btn helper-btn-deny"
                    onClick={() => onDecision(false, "user")}>Deny</button>
            <button className="helper-btn helper-btn-accept"
                    onClick={() => onDecision(true, "user")}>Allow</button>
          </div>
        </div>
      </div>
    </div>
  );
}
