import React from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Text, Surface, useTheme, IconButton, ProgressBar } from 'react-native-paper';

import { StatusBadge } from './StatusBadge';
import type { Device } from '../services/api';

interface DeviceCardProps {
  device: Device;
  onPress?: () => void;
}

export function DeviceCard({ device, onPress }: DeviceCardProps) {
  const theme = useTheme();

  const formatLastSeen = (dateString: string | undefined) => {
    if (!dateString) return 'Never';

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

  const getOsIcon = (os: string | undefined) => {
    if (!os) return 'laptop';
    const lower = os.toLowerCase();
    if (lower.includes('windows')) return 'microsoft-windows';
    if (lower.includes('mac') || lower.includes('darwin')) return 'apple';
    if (lower.includes('linux') || lower.includes('ubuntu')) return 'linux';
    return 'laptop';
  };

  return (
    <Pressable onPress={onPress}>
      <Surface
        style={[
          styles.container,
          { backgroundColor: theme.colors.surface },
        ]}
        elevation={1}
      >
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <IconButton
              icon={getOsIcon(device.os)}
              size={24}
              iconColor={theme.colors.primary}
              style={styles.osIcon}
            />
            <View style={styles.titleContainer}>
              <Text
                variant="titleMedium"
                numberOfLines={1}
                style={{ color: theme.colors.onSurface }}
              >
                {device.name}
              </Text>
              <Text
                variant="bodySmall"
                numberOfLines={1}
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {device.hostname || device.ipAddress || 'No hostname'}
              </Text>
            </View>
          </View>
          <StatusBadge
            severity={device.status as 'online' | 'offline' | 'warning'}
            size="small"
          />
        </View>

        <View style={styles.infoRow}>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {device.os || 'Unknown OS'}
          </Text>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Last seen: {formatLastSeen(device.lastSeen)}
          </Text>
        </View>

        {device.metrics && device.status === 'online' && (
          <View style={styles.metricsContainer}>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                CPU {device.metrics.cpuUsage?.toFixed(0)}%
              </Text>
              <ProgressBar
                progress={(device.metrics.cpuUsage || 0) / 100}
                color={theme.colors.primary}
                style={styles.progressBar}
              />
            </View>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                RAM {device.metrics.memoryUsage?.toFixed(0)}%
              </Text>
              <ProgressBar
                progress={(device.metrics.memoryUsage || 0) / 100}
                color={theme.colors.secondary}
                style={styles.progressBar}
              />
            </View>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Disk {device.metrics.diskUsage?.toFixed(0)}%
              </Text>
              <ProgressBar
                progress={(device.metrics.diskUsage || 0) / 100}
                color={
                  device.metrics.diskUsage && device.metrics.diskUsage > 90
                    ? theme.colors.error
                    : theme.colors.tertiary
                }
                style={styles.progressBar}
              />
            </View>
          </View>
        )}

        {device.organizationName && (
          <View style={styles.orgRow}>
            <IconButton
              icon="office-building"
              size={14}
              iconColor={theme.colors.onSurfaceVariant}
              style={styles.orgIcon}
            />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {device.organizationName}
              {device.siteName && ` / ${device.siteName}`}
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
    alignItems: 'flex-start',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  osIcon: {
    margin: 0,
    marginLeft: -8,
    marginRight: 4,
  },
  titleContainer: {
    flex: 1,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  metricsContainer: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  metricItem: {
    flex: 1,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    marginTop: 4,
  },
  orgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb20',
  },
  orgIcon: {
    margin: 0,
    marginLeft: -8,
  },
});
