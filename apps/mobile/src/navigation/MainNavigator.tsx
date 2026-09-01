import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  BottomTabBar,
  createBottomTabNavigator,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';

import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen';
import { DevicesListScreen } from '../screens/devices/DevicesListScreen';
import { HomeScreen } from '../screens/chat/HomeScreen';
import { SystemsScreen } from '../screens/systems/SystemsScreen';
import { TicketsScreen } from '../screens/tickets/TicketsScreen';
import { TicketDetailScreen } from '../screens/tickets/TicketDetailScreen';
import { TimesheetScreen } from '../screens/time/TimesheetScreen';
import { TimeSuggestionsScreen } from '../screens/time/TimeSuggestionsScreen';
import { HomeIcon, SystemsIcon, TicketsIcon, TimeIcon } from '../components/TabIcons';
import { TimerBar } from '../components/TimerBar';
import { palette, fontFamily } from '../theme';
import type { Alert, Device } from '../services/api';

export type SystemsStackParamList = {
  Systems: undefined;
  SystemsDevices: { orgId?: string | null; orgName?: string | null } | undefined;
  SystemsAlertDetail: { alert: Alert };
  SystemsDeviceDetail: { device: Device };
};

export type TicketsStackParamList = {
  Tickets: undefined;
  TicketDetail: { ticketId: string };
};

/**
 * W06 (#3900). W05 mounted TimesheetScreen straight onto the tab, so there was
 * no stack to add a second Time screen to. A stack here (rather than hanging
 * TimeSuggestions off TicketsStack) keeps the back gesture landing on the
 * timesheet, which is where the banner that opens it lives.
 */
export type TimeStackParamList = {
  Timesheet: undefined;
  TimeSuggestions: { date?: string } | undefined;
};

export type MainTabParamList = {
  HomeTab: undefined;
  SystemsTab: undefined;
  TicketsTab: undefined;
  TimeTab: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const SystemsStack = createNativeStackNavigator<SystemsStackParamList>();
const TicketsStack = createNativeStackNavigator<TicketsStackParamList>();
const TimeStack = createNativeStackNavigator<TimeStackParamList>();

const stackScreenOptions = {
  headerStyle: { backgroundColor: palette.dark.bg0 },
  headerShadowVisible: false,
  headerTintColor: palette.dark.textHi,
  headerTitleStyle: {
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 17,
    color: palette.dark.textHi,
  },
  contentStyle: { backgroundColor: palette.dark.bg0 },
} as const;

function TicketsStackNavigator() {
  return (
    <TicketsStack.Navigator screenOptions={stackScreenOptions}>
      <TicketsStack.Screen
        name="Tickets"
        component={TicketsScreen}
        options={{ headerShown: false }}
      />
      <TicketsStack.Screen
        name="TicketDetail"
        component={TicketDetailScreen}
        options={{ title: 'Ticket' }}
      />
    </TicketsStack.Navigator>
  );
}

function TimeStackNavigator() {
  return (
    <TimeStack.Navigator screenOptions={stackScreenOptions}>
      <TimeStack.Screen
        name="Timesheet"
        component={TimesheetScreen}
        options={{ headerShown: false }}
      />
      <TimeStack.Screen
        name="TimeSuggestions"
        component={TimeSuggestionsScreen}
        options={{ title: 'Unlogged sessions' }}
      />
    </TimeStack.Navigator>
  );
}

function SystemsStackNavigator() {
  return (
    <SystemsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: palette.dark.bg0 },
        headerShadowVisible: false,
        headerTintColor: palette.dark.textHi,
        headerTitleStyle: {
          fontFamily: fontFamily.sansSemiBold,
          fontSize: 17,
          color: palette.dark.textHi,
        },
        contentStyle: { backgroundColor: palette.dark.bg0 },
      }}
    >
      <SystemsStack.Screen
        name="Systems"
        component={SystemsScreen}
        options={{ headerShown: false }}
      />
      <SystemsStack.Screen
        name="SystemsDevices"
        component={DevicesListScreen}
        options={{ headerShown: false }}
      />
      <SystemsStack.Screen
        name="SystemsAlertDetail"
        component={AlertDetailScreen}
        options={{ title: 'Alert Details' }}
      />
      <SystemsStack.Screen
        name="SystemsDeviceDetail"
        component={DeviceDetailScreen}
        options={{ title: 'Device Details' }}
      />
    </SystemsStack.Navigator>
  );
}

/**
 * The timer bar rides directly above the tab bar rather than inside any one
 * screen: a running timer has to stay visible (and stoppable) wherever the
 * technician navigates, and this is also the mount point that owns replaying
 * the offline queue on reconnect. It renders nothing when no timer is running
 * and nothing is queued, so it costs no vertical space in the common case.
 */
function TabBarWithTimer(props: BottomTabBarProps) {
  return (
    <View>
      {/* The "N time entries need attention" row is only useful if it goes
          somewhere: the timesheet is where the technician re-enters them. */}
      <TimerBar onOpenTimesheet={() => props.navigation.navigate('TimeTab')} />
      <BottomTabBar {...props} />
    </View>
  );
}

export function MainNavigator() {
  return (
    <Tab.Navigator
      tabBar={(props: BottomTabBarProps) => <TabBarWithTimer {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.brand.base,
        tabBarInactiveTintColor: palette.dark.textLo,
        tabBarStyle: {
          backgroundColor: palette.dark.bg0,
          borderTopColor: palette.dark.border,
        },
        tabBarLabelStyle: {
          fontFamily: fontFamily.sansMedium,
          fontSize: 11,
          letterSpacing: 0.4,
        },
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <HomeIcon color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="SystemsTab"
        component={SystemsStackNavigator}
        options={{
          tabBarLabel: 'Systems',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <SystemsIcon color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="TicketsTab"
        component={TicketsStackNavigator}
        options={{
          tabBarLabel: 'Tickets',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <TicketsIcon color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="TimeTab"
        component={TimeStackNavigator}
        options={{
          tabBarLabel: 'Time',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <TimeIcon color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
