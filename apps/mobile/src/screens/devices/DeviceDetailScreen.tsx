import React, { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { Text, useTheme, Surface, Button, ActivityIndicator, Chip } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { DevicesStackParamList } from '../../navigation/MainNavigator';
import { StatusBadge } from '../../components/StatusBadge';
import { getDeviceMetrics, sendDeviceAction, type Device, type DeviceAction } from '../../services/api';

type Props = NativeStackScreenProps<DevicesStackParamList, 'DeviceDetail'>;

export function DeviceDetailScreen({ route }: Props) {
  const theme = useTheme();
  const { device } = route.params;
  const [metrics, setMetrics] = useState<Device['metrics']>(device.metrics);
  const [isLoadingMetrics, setIsLoadingMetrics] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<DeviceAction | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchMetrics = async () => {
      try {
        setIsLoadingMetrics(true);
        setMetricsError(null);
        const data = await getDeviceMetrics(device.id);
        if (isMounted) setMetrics(data);
      } catch (err) {
        // Keep existing metrics on error but show indicator
        if (isMounted) {
          const message = err instanceof Error ? err.message : 'Failed to load metrics';
          setMetricsError(message);
        }
      } finally {
        if (isMounted) setIsLoadingMetrics(false);
      }
    };

    fetchMetrics();
    return () => { isMounted = false; };
  }, [device.id]);

  const handleAction = async (action: DeviceAction) => {
    try {
      setActionLoading(action);
      await sendDeviceAction(device.id, action);
      Alert.alert('Success', `${action} command sent successfully`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      Alert.alert('Error', message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Surface style={styles.card} elevation={1}>
        <View style={styles.header}>
          <Text variant="headlineSmall">{device.name}</Text>
          <StatusBadge severity={device.status} />
        </View>

        <View style={styles.details}>
          {device.hostname && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Hostname
              </Text>
              <Text variant="bodyMedium">{device.hostname}</Text>
            </View>
          )}

          {device.ipAddress && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                IP Address
              </Text>
              <Text variant="bodyMedium">{device.ipAddress}</Text>
            </View>
          )}

          {device.os && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Operating System
              </Text>
              <Text variant="bodyMedium">{device.os}</Text>
            </View>
          )}

          {device.agentVersion && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Agent Version
              </Text>
              <Text variant="bodyMedium">{device.agentVersion}</Text>
            </View>
          )}

          {device.lastSeen && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Last Seen
              </Text>
              <Text variant="bodyMedium">
                {new Date(device.lastSeen).toLocaleString()}
              </Text>
            </View>
          )}

          {device.organizationName && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Organization
              </Text>
              <Text variant="bodyMedium">{device.organizationName}</Text>
            </View>
          )}

          {device.siteName && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Site
              </Text>
              <Text variant="bodyMedium">{device.siteName}</Text>
            </View>
          )}
        </View>
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <View style={styles.metricsHeader}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Metrics
          </Text>
          {metricsError && (
            <Text variant="labelSmall" style={{ color: theme.colors.error }}>
              Failed to refresh
            </Text>
          )}
        </View>
        {isLoadingMetrics ? (
          <ActivityIndicator size="small" />
        ) : metrics ? (
          <View style={styles.metricsContainer}>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                CPU
              </Text>
              <Chip compact>{metrics.cpuUsage?.toFixed(1) ?? '--'}%</Chip>
            </View>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Memory
              </Text>
              <Chip compact>{metrics.memoryUsage?.toFixed(1) ?? '--'}%</Chip>
            </View>
            <View style={styles.metricItem}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Disk
              </Text>
              <Chip compact>{metrics.diskUsage?.toFixed(1) ?? '--'}%</Chip>
            </View>
          </View>
        ) : (
          <Text>No metrics available</Text>
        )}
      </Surface>

      <Surface style={styles.card} elevation={1}>
        <Text variant="titleMedium" style={styles.sectionTitle}>
          Actions
        </Text>
        <View style={styles.actionsContainer}>
          <Button
            mode="outlined"
            onPress={() => handleAction('reboot')}
            loading={actionLoading === 'reboot'}
            disabled={actionLoading !== null || device.status === 'offline'}
            style={styles.actionButton}
          >
            Reboot
          </Button>
          <Button
            mode="outlined"
            onPress={() => handleAction('shutdown')}
            loading={actionLoading === 'shutdown'}
            disabled={actionLoading !== null || device.status === 'offline'}
            style={styles.actionButton}
          >
            Shutdown
          </Button>
          <Button
            mode="outlined"
            onPress={() => handleAction('lock')}
            loading={actionLoading === 'lock'}
            disabled={actionLoading !== null || device.status === 'offline'}
            style={styles.actionButton}
          >
            Lock
          </Button>
          <Button
            mode="outlined"
            onPress={() => handleAction('wake')}
            loading={actionLoading === 'wake'}
            disabled={actionLoading !== null}
            style={styles.actionButton}
          >
            Wake
          </Button>
        </View>
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  card: {
    padding: 16,
    borderRadius: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  details: {
    gap: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    marginBottom: 12,
  },
  metricsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metricsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  metricItem: {
    alignItems: 'center',
    gap: 4,
  },
  actionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    minWidth: 100,
  },
});
