import React from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Text, Surface, useTheme, IconButton } from 'react-native-paper';

import { StatusBadge } from './StatusBadge';
import type { Alert } from '../services/api';

interface AlertCardProps {
  alert: Alert;
  onPress?: () => void;
}

export function AlertCard({ alert, onPress }: AlertCardProps) {
  const theme = useTheme();

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString();
  };

  return (
    <Pressable onPress={onPress}>
      <Surface
        style={[
          styles.container,
          {
            backgroundColor: theme.colors.surface,
            opacity: alert.acknowledged ? 0.7 : 1,
          },
        ]}
        elevation={1}
      >
        <View style={styles.header}>
          <StatusBadge severity={alert.severity} size="small" />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {formatTime(alert.createdAt)}
          </Text>
        </View>

        <Text
          variant="titleMedium"
          numberOfLines={1}
          style={[
            styles.title,
            {
              color: theme.colors.onSurface,
              textDecorationLine: alert.acknowledged ? 'line-through' : 'none',
            },
          ]}
        >
          {alert.title}
        </Text>

        <Text
          variant="bodyMedium"
          numberOfLines={2}
          style={{ color: theme.colors.onSurfaceVariant }}
        >
          {alert.message}
        </Text>

        {alert.deviceName && (
          <View style={styles.deviceRow}>
            <IconButton
              icon="laptop"
              size={16}
              iconColor={theme.colors.onSurfaceVariant}
              style={styles.deviceIcon}
            />
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {alert.deviceName}
            </Text>
          </View>
        )}

        {alert.acknowledged && (
          <View style={[styles.acknowledgedBadge, { backgroundColor: theme.colors.primaryContainer }]}>
            <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
              Acknowledged
            </Text>
          </View>
        )}
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 12,
    marginVertical: 6,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    marginBottom: 4,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  deviceIcon: {
    margin: 0,
    marginLeft: -8,
  },
  acknowledgedBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
});
