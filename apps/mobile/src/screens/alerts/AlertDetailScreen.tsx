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
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAppDispatch } from '../../store';
import { acknowledgeAlertAsync } from '../../store/alertsSlice';
import { StatusBadge } from '../../components/StatusBadge';
import type { AlertsStackParamList } from '../../navigation/MainNavigator';

type Props = NativeStackScreenProps<AlertsStackParamList, 'AlertDetail'>;

export function AlertDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { alert } = route.params;

  const handleAcknowledge = async () => {
    await dispatch(acknowledgeAlertAsync(alert.id));
    navigation.goBack();
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Surface style={[styles.headerCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.headerRow}>
            <StatusBadge severity={alert.severity} size="large" />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {formatDate(alert.createdAt)}
            </Text>
          </View>

          <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
            {alert.title}
          </Text>

          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            {alert.message}
          </Text>
        </Surface>

        <Surface style={[styles.detailsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Alert Details
          </Text>

          <List.Item
            title="Alert ID"
            description={alert.id}
            left={(props) => <List.Icon {...props} icon="identifier" />}
          />
          <Divider />

          <List.Item
            title="Device"
            description={alert.deviceName || 'Unknown Device'}
            left={(props) => <List.Icon {...props} icon="laptop" />}
          />
          <Divider />

          <List.Item
            title="Type"
            description={alert.type}
            left={(props) => <List.Icon {...props} icon="tag" />}
          />
          <Divider />

          <List.Item
            title="Status"
            description={alert.acknowledged ? 'Acknowledged' : 'Pending'}
            left={(props) => <List.Icon {...props} icon={alert.acknowledged ? 'check-circle' : 'clock-outline'} />}
          />
          <Divider />

          <List.Item
            title="Created"
            description={formatDate(alert.createdAt)}
            left={(props) => <List.Icon {...props} icon="calendar" />}
          />

          {alert.acknowledgedAt && (
            <>
              <Divider />
              <List.Item
                title="Acknowledged"
                description={formatDate(alert.acknowledgedAt)}
                left={(props) => <List.Icon {...props} icon="calendar-check" />}
              />
            </>
          )}
        </Surface>

        {alert.metadata && Object.keys(alert.metadata).length > 0 && (
          <Surface style={[styles.detailsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="titleMedium" style={styles.sectionTitle}>
              Additional Information
            </Text>

            {Object.entries(alert.metadata).map(([key, value]) => (
              <React.Fragment key={key}>
                <List.Item
                  title={key}
                  description={String(value)}
                  left={(props) => <List.Icon {...props} icon="information" />}
                />
                <Divider />
              </React.Fragment>
            ))}
          </Surface>
        )}

        <View style={styles.actionsContainer}>
          {!alert.acknowledged && (
            <Button
              mode="contained"
              onPress={handleAcknowledge}
              style={styles.actionButton}
              contentStyle={styles.buttonContent}
              icon="check"
            >
              Acknowledge Alert
            </Button>
          )}

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
    marginBottom: 8,
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
