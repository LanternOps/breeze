import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

type SeverityType = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'online' | 'offline' | 'warning';

interface StatusBadgeProps {
  severity: SeverityType;
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
}

export function StatusBadge({ severity, size = 'medium', showLabel = true }: StatusBadgeProps) {
  const theme = useTheme();

  const getColors = () => {
    switch (severity) {
      case 'critical':
        return {
          background: '#dc262620',
          text: '#dc2626',
          dot: '#dc2626',
        };
      case 'high':
        return {
          background: '#ea580c20',
          text: '#ea580c',
          dot: '#ea580c',
        };
      case 'medium':
        return {
          background: '#f59e0b20',
          text: '#f59e0b',
          dot: '#f59e0b',
        };
      case 'low':
        return {
          background: '#3b82f620',
          text: '#3b82f6',
          dot: '#3b82f6',
        };
      case 'info':
        return {
          background: '#0ea5e920',
          text: '#0ea5e9',
          dot: '#0ea5e9',
        };
      case 'online':
        return {
          background: '#22c55e20',
          text: '#22c55e',
          dot: '#22c55e',
        };
      case 'offline':
        return {
          background: '#ef444420',
          text: '#ef4444',
          dot: '#ef4444',
        };
      case 'warning':
        return {
          background: '#f59e0b20',
          text: '#f59e0b',
          dot: '#f59e0b',
        };
      default:
        return {
          background: theme.colors.surfaceVariant,
          text: theme.colors.onSurfaceVariant,
          dot: theme.colors.onSurfaceVariant,
        };
    }
  };

  const getSizes = () => {
    switch (size) {
      case 'small':
        return {
          paddingHorizontal: 8,
          paddingVertical: 2,
          fontSize: 10,
          dotSize: 6,
        };
      case 'large':
        return {
          paddingHorizontal: 14,
          paddingVertical: 6,
          fontSize: 14,
          dotSize: 10,
        };
      default:
        return {
          paddingHorizontal: 10,
          paddingVertical: 4,
          fontSize: 12,
          dotSize: 8,
        };
    }
  };

  const colors = getColors();
  const sizes = getSizes();

  const getLabel = () => {
    return severity.charAt(0).toUpperCase() + severity.slice(1);
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingHorizontal: sizes.paddingHorizontal,
          paddingVertical: sizes.paddingVertical,
        },
      ]}
    >
      <View
        style={[
          styles.dot,
          {
            width: sizes.dotSize,
            height: sizes.dotSize,
            backgroundColor: colors.dot,
          },
        ]}
      />
      {showLabel && (
        <Text
          style={[
            styles.label,
            {
              color: colors.text,
              fontSize: sizes.fontSize,
            },
          ]}
        >
          {getLabel()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 100,
    alignSelf: 'flex-start',
  },
  dot: {
    borderRadius: 100,
  },
  label: {
    marginLeft: 6,
    fontWeight: '600',
  },
});
