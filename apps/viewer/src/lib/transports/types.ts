export type TransportKind = 'webrtc' | 'websocket' | 'vnc';

export interface TransportCapabilities {
  monitors: boolean;
  bitrateControl: boolean;
  audio: boolean;
  sas: boolean;
  sessionSwitch: boolean;
  clipboardChannel: boolean;
}

export interface TransportSession {
  kind: TransportKind;
  capabilities: TransportCapabilities;
  close(): void;
  inputChannel?: { send(json: string): void; readyState?: string };
  controlChannel?: {
    send(json: string): void;
    addEventListener(event: 'open' | 'message' | 'close', cb: (e: unknown) => void): void;
    removeEventListener(event: 'open' | 'message' | 'close', cb: (e: unknown) => void): void;
    readyState: string;
  };
  videoElement?: HTMLVideoElement;
  canvasElement?: HTMLCanvasElement;
  vncContainer?: HTMLDivElement;
}

export function capabilitiesFor(kind: TransportKind): TransportCapabilities {
  switch (kind) {
    case 'webrtc':
      return { monitors: true, bitrateControl: true, audio: true, sas: true, sessionSwitch: true, clipboardChannel: true };
    case 'websocket':
      return { monitors: false, bitrateControl: false, audio: false, sas: false, sessionSwitch: false, clipboardChannel: false };
    case 'vnc':
      return { monitors: false, bitrateControl: false, audio: false, sas: false, sessionSwitch: false, clipboardChannel: true };
  }
}
