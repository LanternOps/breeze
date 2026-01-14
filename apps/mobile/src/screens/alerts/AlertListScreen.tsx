import React, { useEffect, useCallback } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
} from 'react-native';
import {
  Text,
  useTheme,
  FAB,
  Searchbar,
  Chip,
  ActivityIndicator,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { useAppDispatch, useAppSelector } from '../../store';
import { fetchAlerts, acknowledgeAlertAsync, setFilter } from '../../store/alertsSlice';
import { AlertCard } from '../../components/AlertCard';
import type { AlertsStackParamList } from '../../navigation/MainNavigator';
import type { Alert } from '../../services/api';

type NavigationProp = NativeStackNavigationProp<AlertsStackParamList, 'AlertList'>;

const SEVERITY_FILTERS = ['all', 'critical', 'high', 'medium', 'low'] as const;

export function AlertListScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp>();
  const dispatch = useAppDispatch();
  const { alerts, isLoading, filter, error } = useAppSelector((state) => state.alerts);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);

  useEffect(() => {
    dispatch(fetchAlerts());
  }, [dispatch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await dispatch(fetchAlerts());
    setRefreshing(false);
  }, [dispatch]);

  const handleAlertPress = (alert: Alert) => {
    navigation.navigate('AlertDetail', { alert });
  };

  const handleAcknowledge = (alertId: string) => {
    dispatch(acknowledgeAlertAsync(alertId));
  };

  const filteredAlerts = React.useMemo(() => {
    let result = alerts;

    // Apply severity filter
    if (filter !== 'all') {
      result = result.filter((alert) => alert.severity === filter);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (alert) =>
          alert.title.toLowerCase().includes(query) ||
          alert.message.toLowerCase().includes(query) ||
          alert.deviceName?.toLowerCase().includes(query)
      );
    }

    return result;
  }, [alerts, filter, searchQuery]);

  const renderSwipeAction = (alertId: string) => {
    return (
      <View style={[styles.swipeAction, { backgroundColor: theme.colors.primary }]}>
        <Text style={{ color: theme.colors.onPrimary }}>Acknowledge</Text>
      </View>
    );
  };

  const renderAlert = ({ item }: { item: Alert }) => {
    return (
      <Swipeable
        renderRightActions={() => renderSwipeAction(item.id)}
        onSwipeableOpen={() => handleAcknowledge(item.id)}
      >
        <AlertCard alert={item} onPress={() => handleAlertPress(item)} />
      </Swipeable>
    );
  };

  const renderEmpty = () => {
    if (isLoading) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" />
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          No alerts found
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
          {filter !== 'all'
            ? `No ${filter} severity alerts`
            : 'All systems are running smoothly'}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <View style={styles.searchContainer}>
        <Searchbar
          placeholder="Search alerts..."
          onChangeText={setSearchQuery}
          value={searchQuery}
          style={styles.searchbar}
        />
      </View>

      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={SEVERITY_FILTERS}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.filterList}
          renderItem={({ item }) => (
            <Chip
              selected={filter === item}
              onPress={() => dispatch(setFilter(item))}
              style={styles.filterChip}
              mode={filter === item ? 'flat' : 'outlined'}
            >
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </Chip>
          )}
        />
      </View>

      {error && (
        <View style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}>
          <Text style={{ color: theme.colors.onErrorContainer }}>{error}</Text>
        </View>
      )}

      <FlatList
        data={filteredAlerts}
        keyExtractor={(item) => item.id}
        renderItem={renderAlert}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
          />
        }
      />

      <FAB
        icon="refresh"
        style={[styles.fab, { backgroundColor: theme.colors.primaryContainer }]}
        color={theme.colors.onPrimaryContainer}
        onPress={onRefresh}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchbar: {
    elevation: 0,
  },
  filterContainer: {
    paddingBottom: 8,
  },
  filterList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterChip: {
    marginRight: 8,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 80,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 64,
  },
  errorBanner: {
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
  },
  swipeAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 100,
    marginVertical: 8,
    borderRadius: 12,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
  },
});
