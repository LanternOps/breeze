import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RegistryEditor from './RegistryEditor';

describe('RegistryEditor error handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a visible error and allows retry when registry values fail to load', async () => {
    const onGetValues = vi.fn().mockRejectedValue(new Error('Registry service unavailable'));
    const onGetKeys = vi.fn().mockResolvedValue([]);

    render(
      <RegistryEditor
        deviceId="device-1"
        deviceName="WIN-DEV-01"
        onGetKeys={onGetKeys}
        onGetValues={onGetValues}
      />
    );

    await screen.findByText('Failed to load registry values: Registry service unavailable');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(onGetValues).toHaveBeenCalledTimes(2);
    });
  });
});
