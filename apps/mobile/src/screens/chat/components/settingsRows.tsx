import { Pressable, Switch, Text, View } from 'react-native';

import { palette, radii, spacing, type, type useApprovalTheme } from '../../../theme';

export function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled,
  theme,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1, marginRight: spacing[3] }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
        {description ? (
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: theme.bg3, true: palette.brand.deep }}
        thumbColor={value ? palette.brand.base : theme.textMd}
      />
    </View>
  );
}

export function SegmentedRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
  theme,
}: {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
      {description ? (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
          {description}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          marginTop: spacing[2],
          borderRadius: radii.md,
          backgroundColor: theme.bg3,
          padding: 2,
        }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: !!disabled }}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={{
                flex: 1,
                paddingVertical: spacing[2],
                alignItems: 'center',
                borderRadius: radii.sm,
                backgroundColor: selected ? palette.brand.deep : 'transparent',
              }}
            >
              <Text style={[type.meta, { color: selected ? palette.brand.base : theme.textMd }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
