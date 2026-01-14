import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
} from 'react-native';
import {
  Text,
  useTheme,
  Surface,
  Button,
  Divider,
  List,
  ProgressBar,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { StatusBadge } from '../../components/StatusBadge';
import type { DevicesStackParamList } from '../../navigation/MainNavigator';

type Props = NativeStackScreenProps<DevicesStackParamList, 'DeviceDetail'>;

export function DeviceDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { device } = route.params;

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatBytes = (bytes: number | undefined) => {
    if (bytes === undefined) return 'Unknown';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return theme.colors.primary;
      case 'offline':
        return theme.colors.error;
      case 'warning':
        return '#f59e0b';
      default:
        return theme.colors.onSurfaceVariant;
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Surface style={[styles.headerCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.headerRow}>
            <StatusBadge
              severity={device.status as 'online' | 'offline' | 'warning'}
              size="large"
            />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Last seen: {formatDate(device.lastSeen)}
            </Text>
          </View>

          <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
            {device.name}
          </Text>

          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            {device.hostname || 'No hostname'}
          </Text>
        </Surface>

        <Surface style={[styles.detailsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            System Information
          </Text>

          <List.Item
            title="Operating System"
            description={device.os || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="laptop" />}
          />
          <Divider />

          <List.Item
            title="IP Address"
            description={device.ipAddress || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="ip-network" />}
          />
          <Divider />

          <List.Item
            title="Agent Version"
            description={device.agentVersion || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="information" />}
          />
          <Divider />

          <List.Item
            title="Serial Number"
            description={device.serialNumber || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="barcode" />}
          />
        </Surface>

        {device.metrics && (
          <Surface style={[styles.detailsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="titleMedium" style={styles.sectionTitle}>
              System Metrics
            </Text>

            <View style={styles.metricContainer}>
              <View style={styles.metricHeader}>
                <Text variant="bodyMedium">CPU Usage</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.primary }}>
                  {device.metrics.cpuUsage?.toFixed(1)}%
                </Text>
              </View>
              <ProgressBar
                progress={(device.metrics.cpuUsage || 0) / 100}
                color={theme.colors.primary}
                style={styles.progressBar}
              />
            </View>

            <View style={styles.metricContainer}>
              <View style={styles.metricHeader}>
                <Text variant="bodyMedium">Memory Usage</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.primary }}>
                  {device.metrics.memoryUsage?.toFixed(1)}%
                </Text>
              </View>
              <ProgressBar
                progress={(device.metrics.memoryUsage || 0) / 100}
                color={theme.colors.secondary}
                style={styles.progressBar}
              />
            </View>

            <View style={styles.metricContainer}>
              <View style={styles.metricHeader}>
                <Text variant="bodyMedium">Disk Usage</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.primary }}>
                  {device.metrics.diskUsage?.toFixed(1)}%
                </Text>
              </View>
              <ProgressBar
                progress={(device.metrics.diskUsage || 0) / 100}
                color={device.metrics.diskUsage && device.metrics.diskUsage > 90 ? theme.colors.error : theme.colors.tertiary}
                style={styles.progressBar}
              />
            </View>
          </Surface>
        )}

        <Surface style={[styles.detailsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Organization
          </Text>

          <List.Item
            title="Organization"
            description={device.organizationName || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="office-building" />}
          />
          <Divider />

          <List.Item
            title="Site"
            description={device.siteName || 'Unknown'}
            left={(props) => <List.Icon {...props} icon="map-marker" />}
          />
          <Divider />

          <List.Item
            title="Device Group"
            description={device.groupName || 'Ungrouped'}
            left={(props) => <List.Icon {...props} icon="folder" />}
          />
        </Surface>

        <View style={styles.actionsContainer}>
          <Button
            mode="contained"
            onPress={() => {/* TODO: Implement remote actions */}}
            style={styles.actionButton}
            contentStyle={styles.buttonContent}
            icon="console"
          >
            Remote Shell
          </Button>

          <Button
            mode="outlined"
            onPress={() => navigation.goBack()}
            style={styles.actionButton}
            contentStyle={styles.buttonContent}
          >
            Go Back
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  headerCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    marginBottom: 4,
  },
  detailsCard: {
    borderRadius: 12,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionTitle: {
    padding: 16,
    paddingBottom: 8,
  },
  metricContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  metricHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
  },
  actionsContainer: {
    marginTop: 8,
    gap: 12,
  },
  actionButton: {
    borderRadius: 8,
  },
  buttonContent: {
    paddingVertical: 8,
  },
});
