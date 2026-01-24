import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { Text, useTheme, ActivityIndicator, Searchbar } from 'react-native-paper';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { DevicesStackParamList } from '../../navigation/MainNavigator';
import { DeviceCard } from '../../components/DeviceCard';
import { getDevices, type Device } from '../../services/api';

type Props = NativeStackScreenProps<DevicesStackParamList, 'DeviceList'>;

export function DeviceListScreen({ navigation }: Props) {
  const theme = useTheme();
  const [devices, setDevices] = useState<Device[]>([]);
  const [filteredDevices, setFilteredDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const isMountedRef = useRef(true);

  const fetchDeviceList = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getDevices();
      if (isMountedRef.current) {
        setDevices(data);
        setFilteredDevices(data);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const apiError = err as { message?: string };
        setError(apiError.message || 'Failed to fetch devices');
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchDeviceList();
    return () => { isMountedRef.current = false; };
  }, [fetchDeviceList]);

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setFilteredDevices(devices);
    } else {
      const query = searchQuery.toLowerCase();
      setFilteredDevices(
        devices.filter(
          (device) =>
            device.name.toLowerCase().includes(query) ||
            device.hostname?.toLowerCase().includes(query) ||
            device.ipAddress?.toLowerCase().includes(query)
        )
      );
    }
  }, [searchQuery, devices]);

  if (isLoading && devices.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (error && devices.length === 0) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: theme.colors.background }]}>
        <Text style={{ color: theme.colors.error }}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Searchbar
        placeholder="Search devices..."
        onChangeText={setSearchQuery}
        value={searchQuery}
        style={styles.searchBar}
      />
      <FlatList
        data={filteredDevices}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <DeviceCard
            device={item}
            onPress={() => navigation.navigate('DeviceDetail', { device: item })}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={fetchDeviceList}
            colors={[theme.colors.primary]}
          />
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text>No devices found</Text>
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
  searchBar: {
    margin: 16,
    marginBottom: 8,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
  },
});
