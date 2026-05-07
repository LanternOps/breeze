import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTheme, Icon } from 'react-native-paper';

import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { HomeScreen } from '../screens/chat/HomeScreen';
import { SystemsScreen } from '../screens/systems/SystemsScreen';
import type { Alert, Device } from '../services/api';

export type SettingsStackParamList = {
  Settings: undefined;
};

export type SystemsStackParamList = {
  Systems: undefined;
  SystemsAlertDetail: { alert: Alert };
  SystemsDeviceDetail: { device: Device };
};

export type MainTabParamList = {
  HomeTab: undefined;
  SystemsTab: undefined;
  SettingsTab: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const SystemsStack = createNativeStackNavigator<SystemsStackParamList>();

function SystemsStackNavigator() {
  const theme = useTheme();
  return (
    <SystemsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
      }}
    >
      <SystemsStack.Screen
        name="Systems"
        component={SystemsScreen}
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

function SettingsStackNavigator() {
  const theme = useTheme();

  return (
    <SettingsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
      }}
    >
      <SettingsStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
    </SettingsStack.Navigator>
  );
}

export function MainNavigator() {
  const theme = useTheme();

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.outline,
        },
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Icon source="message-text" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="SystemsTab"
        component={SystemsStackNavigator}
        options={{
          tabBarLabel: 'Systems',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Icon source="view-dashboard" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsStackNavigator}
        options={{
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }: { color: string; size: number }) => (
            <Icon source="cog" color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
