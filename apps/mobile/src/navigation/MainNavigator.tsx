import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { AlertListScreen } from '../screens/alerts/AlertListScreen';
import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { DeviceListScreen } from '../screens/devices/DeviceListScreen';
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import type { Alert, Device } from '../services/api';

// Stack param lists
export type AlertsStackParamList = {
  AlertList: undefined;
  AlertDetail: { alert: Alert };
};

export type DevicesStackParamList = {
  DeviceList: undefined;
  DeviceDetail: { device: Device };
};

export type SettingsStackParamList = {
  Settings: undefined;
};

// Tab param list
export type MainTabParamList = {
  AlertsTab: undefined;
  DevicesTab: undefined;
  SettingsTab: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();
const AlertsStack = createNativeStackNavigator<AlertsStackParamList>();
const DevicesStack = createNativeStackNavigator<DevicesStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function AlertsStackNavigator() {
  const theme = useTheme();

  return (
    <AlertsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
      }}
    >
      <AlertsStack.Screen
        name="AlertList"
        component={AlertListScreen}
        options={{ title: 'Alerts' }}
      />
      <AlertsStack.Screen
        name="AlertDetail"
        component={AlertDetailScreen}
        options={{ title: 'Alert Details' }}
      />
    </AlertsStack.Navigator>
  );
}

function DevicesStackNavigator() {
  const theme = useTheme();

  return (
    <DevicesStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
      }}
    >
      <DevicesStack.Screen
        name="DeviceList"
        component={DeviceListScreen}
        options={{ title: 'Devices' }}
      />
      <DevicesStack.Screen
        name="DeviceDetail"
        component={DeviceDetailScreen}
        options={{ title: 'Device Details' }}
      />
    </DevicesStack.Navigator>
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
        name="AlertsTab"
        component={AlertsStackNavigator}
        options={{
          tabBarLabel: 'Alerts',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="bell-alert" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="DevicesTab"
        component={DevicesStackNavigator}
        options={{
          tabBarLabel: 'Devices',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="laptop" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsStackNavigator}
        options={{
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="cog" color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
