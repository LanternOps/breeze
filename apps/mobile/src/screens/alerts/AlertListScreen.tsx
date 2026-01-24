import React from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { Text, useTheme, ActivityIndicator } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { AlertsStackParamList } from '../../navigation/MainNavigator';
import { AlertCard } from '../../components/AlertCard';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  fetchAlerts,
  selectFilteredAlerts,
  selectAlertsLoading,
  selectAlertsError,
} from '../../store/alertsSlice';

type Props = NativeStackScreenProps<AlertsStackParamList, 'AlertList'>;

export function AlertListScreen({ navigation }: Props) {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const alerts = useAppSelector(selectFilteredAlerts);
  const isLoading = useAppSelector(selectAlertsLoading);
  const error = useAppSelector(selectAlertsError);

  React.useEffect(() => {
    dispatch(fetchAlerts());
  }, [dispatch]);

  const handleRefresh = () => {
    dispatch(fetchAlerts());
  };

  if (isLoading && alerts.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (error && alerts.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.colors.background }]}>
        <Text style={{ color: theme.colors.error }}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={alerts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <AlertCard
            alert={item}
            onPress={() => navigation.navigate('AlertDetail', { alert: item })}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={handleRefresh}
            colors={[theme.colors.primary]}
          />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text>No alerts found</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    padding: 16,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
  },
});
