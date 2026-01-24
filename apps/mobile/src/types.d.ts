/**
 * Type declarations to fix React types version mismatch between
 * @types/react 19.x and React Native's expected React 18.x types.
 *
 * This fixes the "X cannot be used as a JSX component" errors caused by
 * bigint being included in ReactNode in React 19 but not in React Native's types.
 *
 * React 19 uses an experimental interface to add bigint to ReactNode.
 * By re-declaring this interface as empty, we effectively remove bigint.
 */

declare module 'react' {
  // This interface is used by React 19 to add bigint to ReactNode.
  // By declaring it as empty, we remove bigint from the allowed types.
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_REACT_NODES {}
}

// Declare process.env for React Native environment variables
declare global {
  const process: {
    env: {
      EXPO_PUBLIC_API_URL?: string;
      NODE_ENV?: string;
      [key: string]: string | undefined;
    };
  };
}

// Fix expo-notifications trigger input types
declare module 'expo-notifications' {
  export enum SchedulableTriggerInputTypes {
    TIME_INTERVAL = 'timeInterval',
    DATE = 'date',
    DAILY = 'daily',
    WEEKLY = 'weekly',
    YEARLY = 'yearly',
    CALENDAR = 'calendar',
  }

  interface TimeIntervalTriggerInput {
    type?: SchedulableTriggerInputTypes.TIME_INTERVAL;
    seconds: number;
    repeats?: boolean;
  }
}

export {};
