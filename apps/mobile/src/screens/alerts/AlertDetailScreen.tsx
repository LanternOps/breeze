import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Text, useTheme, Button, Surface, Chip } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { AlertsStackParamList } from '../../navigation/MainNavigator';
import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';

type Props = NativeStackScreenProps<AlertsStackParamList, 'AlertDetail'>;

const severityColors: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
};

export function AlertDetailScreen({ route }: Props) {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { alert } = route.params;

  const handleAcknowledge = () => {
    dispatch(acknowledgeAlertAsync(alert.id));
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Surface style={styles.card} elevation={1}>
        <View style={styles.header}>
          <Chip
            style={{ backgroundColor: severityColors[alert.severity] || theme.colors.primary }}
            textStyle={{ color: '#fff' }}
          >
            {alert.severity.toUpperCase()}
          </Chip>
          {alert.acknowledged && (
            <Chip icon="check" style={styles.acknowledgedChip}>
              Acknowledged
            </Chip>
          )}
        </View>

        <Text variant="headlineSmall" style={styles.title}>
          {alert.title}
        </Text>

        <Text variant="bodyLarge" style={styles.message}>
          {alert.message}
        </Text>

        <View style={styles.details}>
          <View style={styles.detailRow}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Type
            </Text>
            <Text variant="bodyMedium">{alert.type}</Text>
          </View>

          {alert.deviceName && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Device
              </Text>
              <Text variant="bodyMedium">{alert.deviceName}</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Created
            </Text>
            <Text variant="bodyMedium">
              {new Date(alert.createdAt).toLocaleString()}
            </Text>
          </View>

          {alert.acknowledgedAt && (
            <View style={styles.detailRow}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Acknowledged At
              </Text>
              <Text variant="bodyMedium">
                {new Date(alert.acknowledgedAt).toLocaleString()}
              </Text>
            </View>
          )}
        </View>

        {!alert.acknowledged && (
          <Button
            mode="contained"
            onPress={handleAcknowledge}
            style={styles.acknowledgeButton}
          >
            Acknowledge Alert
          </Button>
        )}
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
  },
  card: {
    padding: 16,
    borderRadius: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  acknowledgedChip: {
    backgroundColor: '#22c55e',
  },
  title: {
    marginBottom: 8,
  },
  message: {
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
  acknowledgeButton: {
    marginTop: 24,
  },
});
