import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { palette, radii, spacing, type } from '../../theme';
import { getDevices, type Device } from '../../services/api';
import { relativeTime } from '../../lib/relativeTime';
import { reportInternalError } from '../../lib/errorReporting';
import type { SystemsStackParamList } from '../../navigation/MainNavigator';
// Imported from the sibling detail screen so the raw osType -> display name
// mapping (windows -> Windows, macos -> macOS, ...) lives in one place.
import { osLabel } from '../../lib/osLabel';

import {
  shapeDeviceList,
  statusCounts,
  type DeviceStatusFilter,
} from './deviceListFilters';

type Nav = NativeStackNavigationProp<SystemsStackParamList, 'SystemsDevices'>;
type ScreenRoute = RouteProp<SystemsStackParamList, 'SystemsDevices'>;

function statusColor(status: Device['status']): string {
  if (status === 'online') return palette.approve.base;
  if (status === 'offline') return palette.dark.textLo;
  return palette.warning.base;
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function DeviceRow({ device, onPress }: { device: Device; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.row}>
      <View style={[styles.statusDot, { backgroundColor: statusColor(device.status) }]} />
      <View style={styles.rowBody}>
        <Text style={styles.name} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[device.os ? osLabel(device.os) : null, device.siteName]
            .filter(Boolean)
            .join(' · ') || '—'}
        </Text>
      </View>
      <Text style={styles.seen}>
        {device.status === 'online' ? 'online' : relativeTime(device.lastSeen)}
      </Text>
    </Pressable>
  );
}

/**
 * Browsable fleet list.
 *
 * The Systems screen surfaces issues and org rollups but has never had a plain
 * "show me my machines" view — devices were reachable only through search or an
 * org drill-down, so a tech who wanted to scan the fleet had nowhere to go.
 */
export function DevicesListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<ScreenRoute>();
  const orgId = route.params?.orgId ?? null;
  const orgName = route.params?.orgName ?? null;

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DeviceStatusFilter>('all');
  const [query, setQuery] = useState('');

  // Focus and pull-to-refresh can overlap, so an older response must never
  // replace a newer one — and nothing may write state after unmount.
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => mounted.current && loadGeneration.current === generation;
    try {
      if (isCurrent()) setError(null);
      // Scope server-side: paging the whole fleet and filtering locally would
      // miss an org whose devices sit past the first pages.
      const rows = await getDevices(orgId);
      if (!isCurrent()) return;
      setDevices(rows);
    } catch (err: unknown) {
      reportInternalError(err, 'devices-list');
      if (isCurrent()) setError('Could not load devices.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const counts = useMemo(() => statusCounts(devices), [devices]);
  const shaped = useMemo(
    () => shapeDeviceList(devices, { status, query, orgId }),
    [devices, status, query, orgId]
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing['2'] }]}>
      <Text style={styles.title}>{orgName ?? 'Devices'}</Text>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Filter by name, site or OS"
        placeholderTextColor={palette.dark.textLo}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        style={styles.search}
        accessibilityLabel="Filter devices"
      />

      <View style={styles.filters}>
        <Chip label={`All ${counts.all}`} active={status === 'all'} onPress={() => setStatus('all')} />
        <Chip
          label={`Online ${counts.online}`}
          active={status === 'online'}
          onPress={() => setStatus('online')}
        />
        <Chip
          label={`Offline ${counts.offline}`}
          active={status === 'offline'}
          onPress={() => setStatus('offline')}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={shaped}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <DeviceRow
            device={item}
            onPress={() => navigation.navigate('SystemsDeviceDetail', { device: item })}
          />
        )}
        contentContainerStyle={[styles.list, shaped.length === 0 && styles.listEmpty]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.dark.textLo}
          />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <Text style={styles.empty}>
              {query.trim() ? 'No devices match that filter.' : 'No devices to show.'}
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  title: { ...type.title, color: palette.dark.textHi, paddingHorizontal: spacing['4'] },
  search: {
    ...type.body,
    color: palette.dark.textHi,
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    marginHorizontal: spacing['4'],
    marginTop: spacing['3'],
  },
  filters: {
    flexDirection: 'row',
    gap: spacing['2'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['3'],
  },
  chip: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['1'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  chipActive: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  chipText: { ...type.meta, color: palette.dark.textMd },
  chipTextActive: { color: palette.dark.textHi },
  list: { paddingHorizontal: spacing['4'], paddingBottom: spacing['8'] },
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginBottom: spacing['2'],
  },
  statusDot: { width: 10, height: 10, borderRadius: radii.full },
  rowBody: { flex: 1 },
  name: { ...type.bodyMd, color: palette.dark.textHi },
  meta: { ...type.meta, color: palette.dark.textLo, marginTop: spacing['1'] },
  seen: { ...type.meta, color: palette.dark.textLo },
  error: {
    ...type.meta,
    color: palette.deny.base,
    paddingHorizontal: spacing['4'],
    paddingBottom: spacing['2'],
  },
  empty: { ...type.meta, color: palette.dark.textLo, textAlign: 'center' },
});
