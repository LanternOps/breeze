import Svg, { Circle, Path } from 'react-native-svg';

interface Props {
  color: string;
  size: number;
}

// Chat bubble: a rounded rectangle with a tail. Filled when active.
export function HomeIcon({ color, size }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4 6 a2 2 0 0 1 2 -2 h12 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 h-7 l-4 3.5 v-3.5 h-1 a2 2 0 0 1 -2 -2 z"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

// Activity / pulse glyph for the Systems tab. A trace line punctuated by
// a single dot — reads as "fleet status" without resorting to a generic
// dashboard grid.
export function SystemsIcon({ color, size }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M3 12 L7 12 L9 7 L12 17 L15 12 L21 12"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={20} cy={12} r={1.5} fill={color} />
    </Svg>
  );
}

// Ticket stub: a rounded rectangle with a perforation notch on each side.
// Distinct from the Systems trace and the Home bubble at tab-bar size.
export function TicketsIcon({ color, size }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M3 7 a1 1 0 0 1 1 -1 h16 a1 1 0 0 1 1 1 v3 a2 2 0 0 0 0 4 v3 a1 1 0 0 1 -1 1 h-16 a1 1 0 0 1 -1 -1 v-3 a2 2 0 0 0 0 -4 z"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M14 8 L14 16" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeDasharray="2 2.5" />
    </Svg>
  );
}

// Reserved for future use (e.g. when Settings becomes a tab again, or for
// an Alerts-only view). Not currently mounted but kept here so the icon
// vocabulary lives in one file.
export function SettingsIcon({ color, size }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={1.75} fill="none" />
      <Path
        d="M12 3 L12 5 M12 19 L12 21 M3 12 L5 12 M19 12 L21 12 M5.6 5.6 L7 7 M17 17 L18.4 18.4 M5.6 18.4 L7 17 M17 7 L18.4 5.6"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}


// Clock face for the Time tab: a ring with hour and minute hands. Deliberately
// not a stopwatch — the tab is the weekly timesheet, and the running-timer
// affordance is the TimerBar sitting directly above it.
export function TimeIcon({ color, size }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.75} fill="none" />
      <Path
        d="M12 7 L12 12 L15.5 14"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
