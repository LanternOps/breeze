import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
} from 'react-native';
import {
  Text,
  useTheme,
  Searchbar,
  Chip,
  ActivityIndicator,
  SegmentedButtons,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';

import { DeviceCard } from '../../components/DeviceCard';
import { getDevices, Device } from '../../services/api';
import type { DevicesStackParamList } from '../../navigation/MainNavigator';

type NavigationProp = NativeStackNavigationProp<DevicesStackParamList, 'DeviceList'>;

const STATUS_FILTERS = ['all', 'online', 'offline', 'warning'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

export function DeviceListScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp>();

  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data = await getDevices();
      setDevices(data);
    } catch (err) {
      setError('Failed to load devices');
      console.error('Error fetching devices:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchDevices();
    setRefreshing(false);
  }, [fetchDevices]);

  const handleDevicePress = (device: Device) => {
    navigation.navigate('DeviceDetail', { device });
  };

  const filteredDevices = React.useMemo(() => {
    let result = devices;

    // Apply status filter
    if (statusFilter !== 'all') {
      result = result.filter((device) => device.status === statusFilter);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (device) =>
          device.name.toLowerCase().includes(query) ||
          device.hostname?.toLowerCase().includes(query) ||
          device.ipAddress?.toLowerCase().includes(query) ||
          device.os?.toLowerCase().includes(query)
      );
    }

    return result;
  }, [devices, statusFilter, searchQuery]);

  const getStatusCounts = () => {
    return {
      all: devices.length,
      online: devices.filter((d) => d.status === 'online').length,
      offline: devices.filter((d) => d.status === 'offline').length,
      warning: devices.filter((d) => d.status === 'warning').length,
    };
  };

  const counts = getStatusCounts();

  const renderDevice = ({ item }: { item: Device }) => {
    return <DeviceCard device={item} onPress={() => handleDevicePress(item)} />;
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
          No devices found
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
          {statusFilter !== 'all'
            ? `No ${statusFilter} devices`
            : 'No devices registered'}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <View style={styles.searchContainer}>
        <Searchbar
          placeholder="Search devices..."
          onChangeText={setSearchQuery}
          value={searchQuery}
          style={styles.searchbar}
        />
      </View>

      <View style={styles.filterContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={STATUS_FILTERS}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.filterList}
          renderItem={({ item }) => (
            <Chip
              selected={statusFilter === item}
              onPress={() => setStatusFilter(item)}
              style={styles.filterChip}
              mode={statusFilter === item ? 'flat' : 'outlined'}
            >
              {item.charAt(0).toUpperCase() + item.slice(1)} ({counts[item]})
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
        data={filteredDevices}
        keyExtractor={(item) => item.id}
        renderItem={renderDevice}
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
    paddingBottom: 16,
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
});
