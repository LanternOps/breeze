import { useEffect, useRef, useCallback, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

const PING_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_TICKET_RETRIES = 5;

interface EventStreamEvent {
  type: string;
  orgId: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface EventStreamOptions {
  onEvent: (event: EventStreamEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useEventStream(options: EventStreamOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Array<{ action: string; types: string[] }>>([]);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimerRef.current) return;

    const delay = Math.min(1000 * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
    retriesRef.current++;

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWs();
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ticketFailuresRef = useRef(0);

  const connectWs = useCallback(async () => {
    if (stoppedRef.current) return;

    try {
      const res = await fetchWithAuth('/events/ws-ticket', { method: 'POST' });
      if (!res.ok) {
        ticketFailuresRef.current++;
        // Stop retrying after repeated ticket failures to avoid burning refresh tokens
        if (ticketFailuresRef.current >= MAX_TICKET_RETRIES) {
          console.warn('[useEventStream] Giving up after', MAX_TICKET_RETRIES, 'ticket failures');
          return;
        }
        throw new Error(`Ticket request failed: ${res.status}`);
      }
      ticketFailuresRef.current = 0;
      const { ticket } = await res.json();

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const apiHost = import.meta.env.PUBLIC_API_URL || '';
      let wsUrl: string;
      if (apiHost) {
        const parsed = new URL(apiHost);
        wsUrl = `${proto}//${parsed.host}/api/v1/events/ws?ticket=${ticket}`;
      } else {
        wsUrl = `${proto}//${window.location.host}/api/v1/events/ws?ticket=${ticket}`;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
        setConnected(true);
        optionsRef.current.onConnected?.();

        if (subscribedRef.current.size > 0) {
          send({ action: 'subscribe', types: Array.from(subscribedRef.current) });
        }

        for (const msg of pendingRef.current) {
          send(msg);
        }
        pendingRef.current = [];

        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          send({ action: 'ping' });
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        let msg: { type?: string; data?: unknown };
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn('[useEventStream] Received malformed message from server');
          return;
        }
        if (msg.type === 'event' && msg.data) {
          try {
            optionsRef.current.onEvent(msg.data as EventStreamEvent);
          } catch (err) {
            console.error('[useEventStream] Event handler error:', err);
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        optionsRef.current.onDisconnected?.();
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        console.warn('[useEventStream] WebSocket error:', err);
      };
    } catch (err) {
      console.warn('[useEventStream] Connection failed, scheduling reconnect:', err instanceof Error ? err.message : err);
      scheduleReconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, scheduleReconnect]);

  const subscribe = useCallback((types: string[]) => {
    for (const t of types) subscribedRef.current.add(t);
    const msg = { action: 'subscribe' as const, types };
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send(msg);
    } else {
      pendingRef.current.push(msg);
    }
  }, [send]);

  const unsubscribe = useCallback((types: string[]) => {
    for (const t of types) subscribedRef.current.delete(t);
    const msg = { action: 'unsubscribe' as const, types };
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send(msg);
    } else {
      pendingRef.current.push(msg);
    }
  }, [send]);

  useEffect(() => {
    stoppedRef.current = false;
    connectWs();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs]);

  return { connected, subscribe, unsubscribe };
}
