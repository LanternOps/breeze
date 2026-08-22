import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen';
import { DevicesListScreen } from '../screens/devices/DevicesListScreen';
import { HomeScreen } from '../screens/chat/HomeScreen';
import { SystemsScreen } from '../screens/systems/SystemsScreen';
import { TicketsScreen } from '../screens/tickets/TicketsScreen';
import { TicketDetailScreen } from '../screens/tickets/TicketDetailScreen';
import { HomeIcon, SystemsIcon, TicketsIcon } from '../components/TabIcons';
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

export type MainTabParamList = {
  HomeTab: undefined;
  SystemsTab: undefined;
  TicketsTab: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const SystemsStack = createNativeStackNavigator<SystemsStackParamList>();
const TicketsStack = createNativeStackNavigator<TicketsStackParamList>();

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

export function MainNavigator() {
  return (
    <Tab.Navigator
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
    </Tab.Navigator>
  );
}
